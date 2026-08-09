// A multi-carrier modem for acoustic links between two independent devices.
//
// The design choice that matters: symbols are long and carriers are widely
// spaced, and every symbol is preceded by a guard interval longer than a normal
// room's echo tail. Speed comes from occupying bandwidth — hundreds of carriers
// in parallel — rather than from shortening symbols, which is what breaks in a
// reverberant room.
//
// Frame layout:
//   [chirp sweep] [silence] [pilot symbol] [header symbol] [data symbols…]
//
// The chirp finds the frame and gives a coarse channel picture, the pilot
// symbol measures every carrier's amplitude and phase, and scattered pilots
// inside the data symbols track the phase drift that two unsynchronised sample
// clocks produce.

import { fft, ifft, correlate } from './fft.js';
import * as rs from './rs.js';

const RS_BLOCK = 64; // payload bytes per Reed-Solomon block

export const BANDS = {
  audible: { fLow: 2000, fHigh: 8000, label: 'hörbar, 2–8 kHz' },
  ultrasonic: { fLow: 15000, fHigh: 19500, label: 'fast unhörbar, 15–19,5 kHz' },
  wide: { fLow: 1500, fHigh: 19000, label: 'alles, 1,5–19 kHz' },
};

const PILOT_EVERY = 8; // one tracking pilot per eight carriers inside data symbols

export class Modem {
  constructor(opts = {}) {
    this.sampleRate = opts.sampleRate || 48000;
    // The guard interval is a copy of the symbol's own tail, so it can never be
    // longer than the symbol. Wanting a 64 ms guard against room echo therefore
    // forces a useful symbol of at least that length — which is why the FFT is
    // this large and the carriers sit this close together.
    this.fftSize = opts.fftSize || 4096;
    this.cpMs = opts.cpMs === undefined ? 64 : opts.cpMs;
    this.bitsPerCarrier = opts.bitsPerCarrier || 2;
    // Parity bytes per 64-byte block. Reed-Solomon repairs half that many wrong
    // bytes, so 32 parity survives 16 bad bytes out of every 96 sent.
    // Measured, not guessed: 48 parity bytes cover a table-top link, 64 buy
    // roughly a metre of room. There is no fallback channel here, so the
    // default sits on the robust side of that trade.
    this.parity = opts.parity === undefined ? 64 : opts.parity;
    // Off by default: flagging weak carriers costs one parity byte per flagged
    // byte, and measurement says that trade only pays once the flags are more
    // selective than a flat quantile can be.
    this.useErasures = opts.useErasures === true;
    // Share of carriers whose bits get flagged as unreliable. Every flagged
    // byte spends one parity byte, so this trades repair capacity for the
    // knowledge of where the damage sits.
    this.weakFraction = opts.weakFraction === undefined ? 0.1 : opts.weakFraction;
    this.chirpMs = opts.chirpMs === undefined ? 150 : opts.chirpMs;
    // Silence between the sync sweep and the first symbol. It has to outlast
    // the sweep's own reverberation, or the room's memory of the chirp
    // corrupts the channel measurement that everything else depends on.
    this.gapMs = opts.gapMs === undefined ? 200 : opts.gapMs;

    const band = typeof opts.band === 'string' ? BANDS[opts.band] : opts.band;
    if (!band) throw new Error('Unbekanntes Band');
    this.band = band;

    this.df = this.sampleRate / this.fftSize;
    this.kLow = Math.ceil(band.fLow / this.df);
    this.kHigh = Math.min(Math.floor(band.fHigh / this.df), this.fftSize / 2 - 2);
    this.carriers = this.kHigh - this.kLow + 1;
    if (this.carriers < 16) throw new Error('Zu wenige Träger für dieses Band');

    this.cp = Math.round((this.cpMs / 1000) * this.sampleRate);
    if (this.cp > this.fftSize) {
      throw new Error(
        `Schutzpause ${this.cpMs} ms passt nicht in ein Symbol von ` +
        `${((this.fftSize / this.sampleRate) * 1000).toFixed(1)} ms — größere FFT wählen`
      );
    }
    this.symbolLen = this.fftSize + this.cp;
    this.chirpLen = Math.round((this.chirpMs / 1000) * this.sampleRate);
    this.gapLen = Math.round((this.gapMs / 1000) * this.sampleRate);

    // Which carriers carry tracking pilots inside data symbols.
    this.pilotIdx = new Set();
    for (let i = 0; i < this.carriers; i += PILOT_EVERY) this.pilotIdx.add(i);
    this.dataCarriers = this.carriers - this.pilotIdx.size;

    this.reference = this.#referenceSymbols();
    this.chirp = this.#buildChirp();
  }

  /** Raw payload bits carried per second, ignoring the frame overhead. */
  get peakBitrate() {
    return (this.dataCarriers * this.bitsPerCarrier * this.sampleRate) / this.symbolLen;
  }

  describe() {
    return {
      band: this.band.label,
      carriers: this.carriers,
      dataCarriers: this.dataCarriers,
      spacingHz: +this.df.toFixed(2),
      usefulMs: +((this.fftSize / this.sampleRate) * 1000).toFixed(1),
      guardMs: +((this.cp / this.sampleRate) * 1000).toFixed(1),
      bitsPerCarrier: this.bitsPerCarrier,
      peakBitrate: Math.round(this.peakBitrate),
    };
  }

  // ---- deterministic reference constellation, known to both sides ----

  #referenceSymbols() {
    // xorshift32 with a fixed seed: both sides generate the same sequence
    // without shipping a table.
    let state = 0x9e3779b9;
    const next = () => {
      state ^= state << 13; state >>>= 0;
      state ^= state >>> 17;
      state ^= state << 5; state >>>= 0;
      return state;
    };
    const re = new Float64Array(this.carriers);
    const im = new Float64Array(this.carriers);
    const s = Math.SQRT1_2;
    for (let i = 0; i < this.carriers; i++) {
      const r = next();
      re[i] = (r & 1) ? s : -s;
      im[i] = (r & 2) ? s : -s;
    }
    return { re, im };
  }

  #buildChirp() {
    const n = this.chirpLen;
    const out = new Float64Array(n);
    const f0 = this.band.fLow;
    const f1 = this.band.fHigh;
    const T = n / this.sampleRate;
    for (let i = 0; i < n; i++) {
      const t = i / this.sampleRate;
      // Linear sweep: instantaneous frequency rises from f0 to f1 over T.
      const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * T)) * t * t);
      // Raised-cosine edges keep the sweep from clicking.
      const edge = Math.min(1, Math.min(i, n - 1 - i) / (0.05 * n));
      out[i] = Math.sin(phase) * (0.5 - 0.5 * Math.cos(Math.PI * edge));
    }
    return out;
  }

  // ---- bit and symbol mapping ----

  #mapBits(bits, offset, count, re, im) {
    const b = this.bitsPerCarrier;
    if (b === 1) {
      for (let i = 0; i < count; i++) {
        re[i] = bits[offset + i] ? -1 : 1;
        im[i] = 0;
      }
      return count;
    }
    if (b === 2) {
      const s = Math.SQRT1_2;
      for (let i = 0; i < count; i++) {
        re[i] = bits[offset + 2 * i] ? -s : s;
        im[i] = bits[offset + 2 * i + 1] ? -s : s;
      }
      return count * 2;
    }
    // 16-QAM, Gray-coded on both axes.
    const levels = [-3, -1, 3, 1];
    const norm = 1 / Math.sqrt(10);
    for (let i = 0; i < count; i++) {
      const o = offset + 4 * i;
      re[i] = levels[(bits[o] << 1) | bits[o + 1]] * norm;
      im[i] = levels[(bits[o + 2] << 1) | bits[o + 3]] * norm;
    }
    return count * 4;
  }

  #demapBits(re, im, count, out, offset) {
    const b = this.bitsPerCarrier;
    if (b === 1) {
      for (let i = 0; i < count; i++) out[offset + i] = re[i] < 0 ? 1 : 0;
      return count;
    }
    if (b === 2) {
      for (let i = 0; i < count; i++) {
        out[offset + 2 * i] = re[i] < 0 ? 1 : 0;
        out[offset + 2 * i + 1] = im[i] < 0 ? 1 : 0;
      }
      return count * 2;
    }
    const norm = Math.sqrt(10);
    const bitsFor = (v) => {
      const x = v * norm;
      if (x < -2) return [0, 0];
      if (x < 0) return [0, 1];
      if (x < 2) return [1, 1];
      return [1, 0];
    };
    for (let i = 0; i < count; i++) {
      const o = offset + 4 * i;
      const a = bitsFor(re[i]);
      const c = bitsFor(im[i]);
      out[o] = a[0]; out[o + 1] = a[1];
      out[o + 2] = c[0]; out[o + 3] = c[1];
    }
    return count * 4;
  }

  // ---- transmit ----

  #renderSymbol(carrierRe, carrierIm, into, at) {
    const N = this.fftSize;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < this.carriers; i++) {
      const k = this.kLow + i;
      re[k] = carrierRe[i];
      im[k] = carrierIm[i];
      // Hermitian mirror keeps the time-domain signal real.
      re[N - k] = carrierRe[i];
      im[N - k] = -carrierIm[i];
    }
    ifft(re, im);
    // Cyclic prefix: the tail of the symbol repeated in front of it, so an echo
    // arriving up to `cp` samples late still lands inside a whole period.
    for (let i = 0; i < this.cp; i++) into[at + i] = re[N - this.cp + i];
    for (let i = 0; i < N; i++) into[at + this.cp + i] = re[i];
    return at + this.symbolLen;
  }

  /**
   * Encode a payload into a Float32Array waveform at this modem's sample rate.
   */
  encode(payload) {
    const bytes = payload instanceof Uint8Array ? payload : new TextEncoder().encode(String(payload));
    const withCrc = new Uint8Array(bytes.length + 2);
    withCrc.set(bytes);
    const crc = crc16(bytes);
    withCrc[bytes.length] = (crc >> 8) & 0xff;
    withCrc[bytes.length + 1] = crc & 0xff;

    // The checksum travels inside the protected block, so it judges what came
    // out of the repair rather than what came off the air.
    const coded = this.parity > 0
      ? rs.encode(withCrc, this.parity, RS_BLOCK).bytes
      : withCrc;

    const bits = bytesToBits(coded);
    const perSymbol = this.dataCarriers * this.bitsPerCarrier;
    const dataSymbols = Math.ceil(bits.length / perSymbol);
    const padded = new Uint8Array(dataSymbols * perSymbol);
    padded.set(bits);

    const total = this.chirpLen + this.gapLen + this.symbolLen * (2 + dataSymbols);
    const out = new Float64Array(total);
    out.set(this.chirp, 0);
    let at = this.chirpLen + this.gapLen;

    // Pilot symbol: the reference constellation, unmodulated.
    at = this.#renderSymbol(this.reference.re, this.reference.im, out, at);

    // Header symbol: payload length and the carrier mapping, sent at one bit
    // per carrier and repeated three times, because everything after it is
    // unreadable if this is wrong.
    at = this.#renderSymbol(...this.#headerCarriers(bytes.length), out, at);

    const cRe = new Float64Array(this.carriers);
    const cIm = new Float64Array(this.carriers);
    const dRe = new Float64Array(this.dataCarriers);
    const dIm = new Float64Array(this.dataCarriers);
    for (let s = 0; s < dataSymbols; s++) {
      this.#mapBits(padded, s * perSymbol, this.dataCarriers, dRe, dIm);
      let d = 0;
      for (let i = 0; i < this.carriers; i++) {
        if (this.pilotIdx.has(i)) {
          cRe[i] = this.reference.re[i];
          cIm[i] = this.reference.im[i];
        } else {
          cRe[i] = dRe[d];
          cIm[i] = dIm[d];
          d++;
        }
      }
      at = this.#renderSymbol(cRe, cIm, out, at);
    }

    // Chirp and data are levelled separately. A sum of hundreds of carriers has
    // a far higher peak than a single swept tone, so one shared normalisation
    // would bury the chirp — and with it the receiver's only way of finding
    // where the frame starts.
    const dataStart = this.chirpLen + this.gapLen;
    let dataPeak = 0;
    for (let i = dataStart; i < out.length; i++) dataPeak = Math.max(dataPeak, Math.abs(out[i]));
    const dataGain = dataPeak > 0 ? 0.7 / dataPeak : 1;

    const wave = new Float32Array(out.length);
    for (let i = 0; i < this.chirpLen; i++) wave[i] = out[i] * 0.9;
    for (let i = dataStart; i < out.length; i++) wave[i] = out[i] * dataGain;
    return wave;
  }

  /** Block lengths after coding — both sides derive these, they are not sent. */
  #blockLengths(payloadLength) {
    const n = payloadLength + 2; // payload plus checksum
    const lengths = [];
    for (let i = 0; i < n; i += RS_BLOCK) {
      lengths.push(Math.min(RS_BLOCK, n - i) + this.parity);
    }
    if (lengths.length === 0) lengths.push(this.parity);
    return lengths;
  }

  #headerCarriers(length) {
    const header = new Uint8Array(5);
    header[0] = (length >> 8) & 0xff;
    header[1] = length & 0xff;
    header[2] = this.bitsPerCarrier;
    header[3] = this.parity;
    header[4] = crc8(header.subarray(0, 4));
    const bits = bytesToBits(header); // 40 bits, repeated across all carriers
    const re = new Float64Array(this.carriers);
    const im = new Float64Array(this.carriers);
    for (let i = 0; i < this.carriers; i++) {
      re[i] = bits[i % bits.length] ? -1 : 1;
      im[i] = 0;
    }
    return [re, im];
  }

  #readHeader(re) {
    const nbits = 40;
    const votes = new Float64Array(nbits);
    // Soft voting: a carrier sitting deep in one half counts for more than one
    // that landed near the decision line.
    for (let i = 0; i < this.carriers; i++) votes[i % nbits] -= re[i];
    const bits = new Uint8Array(nbits);
    for (let i = 0; i < nbits; i++) bits[i] = votes[i] > 0 ? 1 : 0;
    const header = bitsToBytes(bits);
    if (crc8(header.subarray(0, 4)) !== header[4]) return null;
    return {
      length: (header[0] << 8) | header[1],
      bitsPerCarrier: header[2],
      parity: header[3],
    };
  }

  // ---- receive ----

  /**
   * Decode a waveform. Returns {ok, payload, text, ber…} — `ok` only when the
   * checksum matches, so a garbled frame is never mistaken for a good one.
   */
  decode(samples) {
    const signal = samples instanceof Float64Array ? samples : Float64Array.from(samples);
    const corr = correlate(signal, this.chirp);

    let peakIdx = 0;
    let peakVal = 0;
    let sum = 0;
    for (let i = 0; i < corr.length; i++) {
      sum += corr[i];
      if (corr[i] > peakVal) { peakVal = corr[i]; peakIdx = i; }
    }
    const mean = sum / corr.length;
    const sharpness = mean > 0 ? peakVal / mean : 0;
    if (sharpness < 8) return { ok: false, reason: 'kein Rahmenanfang gefunden', sharpness };

    const start = peakIdx + this.chirpLen + this.gapLen;
    // Reading the window a little into the guard interval costs nothing: it is
    // a linear phase ramp, and the channel estimate absorbs it.
    const windowOffset = Math.floor(this.cp * 0.75);

    const grab = (index) => {
      const at = start + index * this.symbolLen + windowOffset;
      if (at < 0 || at + this.fftSize > signal.length) return null;
      const re = new Float64Array(this.fftSize);
      const im = new Float64Array(this.fftSize);
      for (let i = 0; i < this.fftSize; i++) re[i] = signal[at + i];
      fft(re, im);
      return { re, im };
    };

    const pilot = grab(0);
    if (!pilot) return { ok: false, reason: 'Signal endet vor dem Pilotsymbol', sharpness };

    // Channel estimate: what the room did to every carrier, amplitude and phase.
    const hRe = new Float64Array(this.carriers);
    const hIm = new Float64Array(this.carriers);
    for (let i = 0; i < this.carriers; i++) {
      const k = this.kLow + i;
      const pr = this.reference.re[i];
      const pi = this.reference.im[i];
      const denom = pr * pr + pi * pi;
      hRe[i] = (pilot.re[k] * pr + pilot.im[k] * pi) / denom;
      hIm[i] = (pilot.im[k] * pr - pilot.re[k] * pi) / denom;
    }

    const equalise = (sym) => {
      const re = new Float64Array(this.carriers);
      const im = new Float64Array(this.carriers);
      for (let i = 0; i < this.carriers; i++) {
        const k = this.kLow + i;
        const d = hRe[i] * hRe[i] + hIm[i] * hIm[i];
        if (d < 1e-12) { re[i] = 0; im[i] = 0; continue; }
        re[i] = (sym.re[k] * hRe[i] + sym.im[k] * hIm[i]) / d;
        im[i] = (sym.im[k] * hRe[i] - sym.re[k] * hIm[i]) / d;
      }
      return { re, im };
    };

    const headerSym = grab(1);
    if (!headerSym) return { ok: false, reason: 'Signal endet vor dem Kopfsymbol', sharpness };
    const headerEq = equalise(headerSym);
    const head = this.#readHeader(headerEq.re);
    if (!head) return { ok: false, reason: 'Kopfsymbol unlesbar', sharpness };
    if (head.bitsPerCarrier !== this.bitsPerCarrier) {
      return { ok: false, reason: `Gegenseite sendet ${head.bitsPerCarrier} Bit je Träger, hier sind ${this.bitsPerCarrier} eingestellt`, sharpness };
    }
    if (head.parity !== this.parity) {
      return { ok: false, reason: `Gegenseite sendet mit ${head.parity} Prüfbytes, hier sind ${this.parity} eingestellt`, sharpness };
    }

    const lengths = this.#blockLengths(head.length);
    const codedBytes = this.parity > 0
      ? lengths.reduce((a, b) => a + b, 0)
      : head.length + 2;
    const wantBits = codedBytes * 8;
    const perSymbol = this.dataCarriers * this.bitsPerCarrier;
    const dataSymbols = Math.ceil(wantBits / perSymbol);
    const bits = new Uint8Array(dataSymbols * perSymbol);

    // The channel estimate already says which carriers the room notched out.
    // Flagging their bits as erasures rather than trusting them doubles what
    // the same parity can repair, because knowing where the damage is worth
    // twice as much as guessing.
    const gains = [];
    for (let i = 0; i < this.carriers; i++) {
      if (!this.pilotIdx.has(i)) gains.push(Math.hypot(hRe[i], hIm[i]));
    }
    const sorted = Float64Array.from(gains).sort();
    const weakThreshold = sorted[Math.floor(sorted.length * this.weakFraction)];
    const weakCarrier = [];
    {
      let d = 0;
      for (let i = 0; i < this.carriers; i++) {
        if (this.pilotIdx.has(i)) continue;
        weakCarrier[d] = Math.hypot(hRe[i], hIm[i]) <= weakThreshold;
        d++;
      }
    }
    const suspectBit = new Uint8Array(dataSymbols * perSymbol);

    const dRe = new Float64Array(this.dataCarriers);
    const dIm = new Float64Array(this.dataCarriers);
    for (let s = 0; s < dataSymbols; s++) {
      const sym = grab(2 + s);
      if (!sym) return { ok: false, reason: 'Signal endet mitten in den Daten', sharpness };
      const eq = equalise(sym);

      // Two unsynchronised sample clocks do two things to a symbol, and only
      // one of them is a plain rotation. The other is a timing slip, which
      // tilts the phase across the band — a little at the low carriers, a lot
      // at the high ones — and it grows with every symbol. Correcting only the
      // rotation is why long messages used to fall apart halfway through. So
      // the tracking pilots are fitted for both: the tilt and the offset.
      const pilots = [...this.pilotIdx];
      const errRe = [];
      const errIm = [];
      for (const i of pilots) {
        const pr = this.reference.re[i];
        const pi = this.reference.im[i];
        errRe.push(eq.re[i] * pr + eq.im[i] * pi);
        errIm.push(eq.im[i] * pr - eq.re[i] * pi);
      }

      // Slope: the average phase step from one pilot to the next, taken as a
      // vector sum so that noisy pilots simply weigh less.
      let stepRe = 0;
      let stepIm = 0;
      for (let j = 0; j + 1 < pilots.length; j++) {
        stepRe += errRe[j + 1] * errRe[j] + errIm[j + 1] * errIm[j];
        stepIm += errIm[j + 1] * errRe[j] - errRe[j + 1] * errIm[j];
      }
      const spacing = pilots.length > 1 ? pilots[1] - pilots[0] : 1;
      const slope = Math.atan2(stepIm, stepRe) / spacing;

      // Offset: what is left once the tilt is taken out.
      let offRe = 0;
      let offIm = 0;
      for (let j = 0; j < pilots.length; j++) {
        const a = -slope * pilots[j];
        const c = Math.cos(a);
        const s = Math.sin(a);
        offRe += errRe[j] * c - errIm[j] * s;
        offIm += errIm[j] * c + errRe[j] * s;
      }
      const offset = Math.atan2(offIm, offRe);

      let d = 0;
      for (let i = 0; i < this.carriers; i++) {
        if (this.pilotIdx.has(i)) continue;
        const a = -(offset + slope * i);
        const c = Math.cos(a);
        const s = Math.sin(a);
        dRe[d] = eq.re[i] * c - eq.im[i] * s;
        dIm[d] = eq.im[i] * c + eq.re[i] * s;
        d++;
      }
      this.#demapBits(dRe, dIm, this.dataCarriers, bits, s * perSymbol);

      for (let d = 0; d < this.dataCarriers; d++) {
        if (!weakCarrier[d]) continue;
        const at = s * perSymbol + d * this.bitsPerCarrier;
        for (let b = 0; b < this.bitsPerCarrier; b++) suspectBit[at + b] = 1;
      }
    }

    // A byte is only as trustworthy as its worst bit.
    const suspectByte = new Uint8Array(Math.ceil(bits.length / 8));
    for (let i = 0; i < suspectBit.length; i++) {
      if (suspectBit[i]) suspectByte[i >> 3] = 1;
    }

    const received = bitsToBytes(bits.subarray(0, wantBits));

    let bytes = received;
    let repaired = 0;
    if (this.parity > 0) {
      const fixed = rs.decode(received, this.parity, lengths, this.useErasures ? suspectByte : null);
      if (!fixed) {
        return { ok: false, reason: 'zu viele Fehler für die Fehlerkorrektur', sharpness };
      }
      bytes = fixed.bytes;
      repaired = fixed.repaired;
    }

    const payload = bytes.subarray(0, head.length);
    const got = (bytes[head.length] << 8) | bytes[head.length + 1];
    if (got !== crc16(payload)) {
      return { ok: false, reason: 'Prüfsumme stimmt nicht', sharpness, payload, text: safeText(payload) };
    }
    return { ok: true, payload, text: safeText(payload), sharpness, symbols: dataSymbols, repaired };
  }
}

// ---- helpers ----

function safeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); } catch { return ''; }
}

export function bytesToBits(bytes) {
  const bits = new Uint8Array(bytes.length * 8);
  for (let i = 0; i < bytes.length; i++) {
    for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
  }
  return bits;
}

export function bitsToBytes(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) bytes[i >> 3] |= 1 << (7 - (i & 7));
  }
  return bytes;
}

export function crc16(bytes) {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

export function crc8(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let b = 0; b < 8; b++) {
      crc = (crc & 0x80) ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}
