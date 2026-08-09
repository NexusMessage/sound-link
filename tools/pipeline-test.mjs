// Test the path the browser actually takes: encode at the modem's rate, play it
// out through a device running at some other rate, capture it in 128-sample
// blocks, resample back, and decode from a rolling window.
//
// The modem passing on its own says nothing about this path — the first version
// of the resampler dropped one sample per block and broke everything downstream
// while every unit test stayed green.

import { Modem } from '../modem/ofdm.js';
import { Resampler } from '../modem/resample.js';
import { throughRoom } from '../modem/channel.js';

const MODEM_RATE = 48000;
const MESSAGE = 'K7Q2-M4X8-P1R6';

function deviceResample(wave, from, to) {
  const r = new Resampler(from, to);
  const out = [];
  for (let i = 0; i < wave.length; i += 4096) {
    r.push(wave.subarray(i, Math.min(i + 4096, wave.length)), (v) => out.push(v));
  }
  return Float64Array.from(out);
}

function run(deviceRate, room, opts) {
  const modem = new Modem({ sampleRate: MODEM_RATE, ...opts });
  const wave = modem.encode(MESSAGE);

  // Playback: the browser resamples the buffer to the device's output rate.
  const played = deviceRate === MODEM_RATE ? Float64Array.from(wave) : deviceResample(wave, MODEM_RATE, deviceRate);

  const heard = throughRoom(played, deviceRate, room);

  // Capture: 4096-sample blocks off the worklet, resampled back to 48 kHz.
  const back = new Resampler(deviceRate, MODEM_RATE);
  const ring = [];
  for (let i = 0; i < heard.length; i += 4096) {
    const block = heard.subarray(i, Math.min(i + 4096, heard.length));
    if (block.length < 2) break;
    back.push(block, (v) => ring.push(v));
  }

  return modem.decode(Float64Array.from(ring));
}

const ROOMS = {
  'Labor': { t60: 0, drrDb: 0, snrDb: 60, clockPpm: 0 },
  'Tisch, ~0,5 m': { t60: 0.4, drrDb: 8, snrDb: 30, clockPpm: 50 },
  'Zimmer, ~1 m': { t60: 0.4, drrDb: 3, snrDb: 20, clockPpm: 50 },
};

console.log('\n=== Ganze Kette: Gerät -> Luft -> Gerät ===');
for (const rate of [48000, 44100]) {
  for (const [name, room] of Object.entries(ROOMS)) {
    for (const band of ['audible', 'ultrasonic']) {
      const res = run(rate, room, { band, bitsPerCarrier: 1 });
      console.log(
        `${rate} Hz  ${name.padEnd(15)} ${band.padEnd(11)} ` +
        (res.ok ? `OK  "${res.text}"` : `--  ${res.reason} (Spitze ${res.sharpness ? res.sharpness.toFixed(0) : '-'})`)
      );
    }
  }
}
console.log('');
