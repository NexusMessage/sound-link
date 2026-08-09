// Run the modem against the synthetic room and print what survives.
//   node tools/selftest.mjs
//   node tools/selftest.mjs --sweep

import { Modem } from '../modem/ofdm.js';
import { throughRoom } from '../modem/channel.js';

const PAYLOAD =
  'K7Q2-M4X8-P1R6 — sound-link Testnachricht mit genug Text, um mehrere Symbole zu füllen.';

// The reverberation time says how long a room rings; the direct-to-reverberant
// ratio says how much of what reaches the microphone came straight from the
// speaker rather than off the walls. That second number is the one that falls
// with distance, and it decides far more than the first.
const ROOMS = {
  'Labor (kein Raum)': { t60: 0, drrDb: 0, snrDb: 60, clockPpm: 0 },
  'Tisch, ~0,5 m': { t60: 0.4, drrDb: 8, snrDb: 30, clockPpm: 50 },
  'Zimmer, ~1 m': { t60: 0.4, drrDb: 3, snrDb: 20, clockPpm: 50 },
  'Zimmer, ~2 m': { t60: 0.4, drrDb: 0, snrDb: 20, clockPpm: 50 },
  'Zimmer, ~3 m laut': { t60: 0.5, drrDb: -3, snrDb: 15, clockPpm: 50 },
  'Halle, weit weg': { t60: 0.8, drrDb: -6, snrDb: 10, clockPpm: 50 },
};

function trial(modemOpts, room, payload = PAYLOAD) {
  const modem = new Modem(modemOpts);
  const wave = modem.encode(payload);
  const res = modem.decode(throughRoom(wave, modem.sampleRate, room));
  const seconds = wave.length / modem.sampleRate;
  return {
    ok: res.ok,
    reason: res.reason,
    repaired: res.repaired,
    seconds,
    netBitrate: (payload.length * 8) / seconds,
  };
}

const sweep = process.argv.includes('--sweep');

console.log('\n=== Aufbau ===');
for (const band of ['audible', 'ultrasonic']) {
  for (const bits of [1, 2, 4]) {
    const d = new Modem({ band, bitsPerCarrier: bits }).describe();
    console.log(
      `${band.padEnd(11)} ${bits} Bit/Träger  ${String(d.carriers).padStart(4)} Träger  ` +
      `Abstand ${d.spacingHz} Hz  Nutz ${d.usefulMs} ms  Schutz ${d.guardMs} ms  ` +
      `roh ${d.peakBitrate} bit/s`
    );
  }
}

console.log('\n=== Was in welchem Raum ankommt (hörbares Band) ===');
console.log('Raum                 1 Bit          2 Bit          4 Bit');
for (const [name, room] of Object.entries(ROOMS)) {
  const cells = [1, 2, 4].map((bits) => {
    const t = trial({ band: 'audible', bitsPerCarrier: bits }, room);
    return (t.ok ? `${Math.round(t.netBitrate)} bit/s` : '—').padEnd(14);
  });
  console.log(name.padEnd(20), cells.join(' '));
}

console.log('\n=== Dasselbe im oberen, fast unhörbaren Band ===');
console.log('Raum                 1 Bit          2 Bit          4 Bit');
for (const [name, room] of Object.entries(ROOMS)) {
  const cells = [1, 2, 4].map((bits) => {
    const t = trial({ band: 'ultrasonic', bitsPerCarrier: bits }, room);
    return (t.ok ? `${Math.round(t.netBitrate)} bit/s` : '—').padEnd(14);
  });
  console.log(name.padEnd(20), cells.join(' '));
}

console.log('\n=== Zum Vergleich: ggwave, hörbar, robust ===');
console.log('16 Zeichen in 1,54 s  =  83 bit/s netto   (gemessen, feste Rahmenlänge)');

if (sweep) {
  console.log('\n=== Wie viel Fehlerschutz der Raum verlangt (hörbar, 2 Bit) ===');
  console.log('Raum                 32 Prüfbytes  48            64            96');
  for (const [name, room] of Object.entries(ROOMS)) {
    const cells = [32, 48, 64, 96].map((parity) => {
      const t = trial({ band: 'audible', bitsPerCarrier: 2, parity }, room);
      return (t.ok ? `${Math.round(t.netBitrate)} bit/s` : '—').padEnd(13);
    });
    console.log(name.padEnd(20), cells.join(' '));
  }

  console.log('\n=== Schutzintervall gegen Nachhall (hörbar, 2 Bit, ~2 m) ===');
  for (const [fftSize, cpMs] of [[4096, 32], [4096, 64], [8192, 64], [8192, 128]]) {
    const t = trial({ band: 'audible', bitsPerCarrier: 2, fftSize, cpMs }, ROOMS['Zimmer, ~2 m']);
    console.log(
      `FFT ${String(fftSize).padStart(4)}, Schutz ${String(cpMs).padStart(3)} ms  ->  ` +
      (t.ok ? `OK, ${Math.round(t.netBitrate)} bit/s` : `— (${t.reason})`)
    );
  }

  console.log('\n=== Uhrabweichung zwischen den Geräten (hörbar, 2 Bit, ~1 m) ===');
  for (const ppm of [0, 50, 200, 500, 1000]) {
    const room = { ...ROOMS['Zimmer, ~1 m'], clockPpm: ppm };
    const t = trial({ band: 'audible', bitsPerCarrier: 2 }, room);
    console.log(`${String(ppm).padStart(4)} ppm  ->  ` + (t.ok ? 'OK' : `— (${t.reason})`));
  }
}

console.log('');
