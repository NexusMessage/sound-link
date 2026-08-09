// A synthetic room, so a change to the modem can be measured in a second
// instead of requiring two devices and a walk across a room.
//
// It reproduces the four things that actually break an acoustic link: the echo
// tail of the room, background noise, a speaker and microphone that are not
// flat, and two sample clocks that do not agree.

/**
 * Exponentially decaying random impulse response — the standard stand-in for a
 * room's echo tail. `t60` is the time in seconds for the reverberation to fall
 * by 60 dB; an ordinary living room sits around 0.4 s, a bare office higher.
 */
export function roomImpulse(sampleRate, t60, seed = 12345, drrDb = 0) {
  const n = Math.max(1, Math.round(t60 * sampleRate));
  const h = new Float64Array(n);
  let state = seed >>> 0;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return (state / 0xffffffff) * 2 - 1;
  };

  // Direct path first, then the decaying diffuse tail.
  h[0] = 1;
  const decay = Math.log(1000) / n; // amplitude falls 60 dB over n samples
  for (let i = 1; i < n; i++) h[i] = rand() * Math.exp(-decay * i);

  // The reverberation time alone does not say how loud the echoes are relative
  // to the sound that arrived straight from the speaker — and that ratio is
  // what actually decides whether a link survives. It falls with distance:
  // roughly 0 dB at a metre or two in a living room, deeply negative in a hall
  // or far from the source. Scaling the tail to hit a stated ratio keeps the
  // two knobs independent, so `t60` sets how long the room rings and `drrDb`
  // sets how close you are standing.
  let tailEnergy = 0;
  for (let i = 1; i < n; i++) tailEnergy += h[i] * h[i];
  if (tailEnergy > 0) {
    const wanted = Math.pow(10, -drrDb / 10); // tail energy relative to direct
    const scale = Math.sqrt(wanted / tailEnergy);
    for (let i = 1; i < n; i++) h[i] *= scale;
  }
  return h;
}

function convolve(x, h) {
  const out = new Float64Array(x.length + h.length - 1);
  for (let i = 0; i < x.length; i++) {
    const xi = x[i];
    if (xi === 0) continue;
    for (let j = 0; j < h.length; j++) out[i + j] += xi * h[j];
  }
  return out;
}

/** Linear resampling, used to model a receiver whose clock runs slightly fast. */
function resample(x, ratio) {
  const n = Math.floor(x.length / ratio);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const k = Math.floor(p);
    const f = p - k;
    out[i] = k + 1 < x.length ? x[k] * (1 - f) + x[k + 1] * f : x[k] || 0;
  }
  return out;
}

/**
 * Push a waveform through the simulated room.
 *
 * @param {Object} opts
 *   t60        reverberation time in seconds (0 disables reverb)
 *   snrDb      signal-to-noise ratio of the received signal
 *   clockPpm   how far the receiver's sample clock differs, in parts per million
 *   leadMs     silence in front of the frame, so sync has to actually find it
 *   highpassHz roll-off below this, standing in for the phone speaker's limit
 */
export function throughRoom(wave, sampleRate, opts = {}) {
  const t60 = opts.t60 === undefined ? 0.4 : opts.t60;
  const snrDb = opts.snrDb === undefined ? 20 : opts.snrDb;
  const clockPpm = opts.clockPpm || 0;
  const leadMs = opts.leadMs === undefined ? 120 : opts.leadMs;
  const seed = opts.seed || 12345;

  const drrDb = opts.drrDb === undefined ? 0 : opts.drrDb;
  let x = Float64Array.from(wave);
  if (t60 > 0) x = convolve(x, roomImpulse(sampleRate, t60, seed, drrDb));

  if (clockPpm !== 0) x = resample(x, 1 + clockPpm / 1e6);

  const lead = Math.round((leadMs / 1000) * sampleRate);
  const tail = Math.round(0.1 * sampleRate);
  const out = new Float64Array(lead + x.length + tail);
  out.set(x, lead);

  let power = 0;
  for (let i = 0; i < x.length; i++) power += x[i] * x[i];
  power /= Math.max(1, x.length);
  const noise = Math.sqrt(power / Math.pow(10, snrDb / 10));

  let state = (seed * 2654435761) >>> 0;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return (state / 0xffffffff) * 2 - 1;
  };
  // Two uniforms summed is close enough to gaussian for a noise floor.
  for (let i = 0; i < out.length; i++) out[i] += (rand() + rand()) * 0.5 * noise * 1.7;

  return out;
}
