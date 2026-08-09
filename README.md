# sound-link

Send a short code from one phone to another using nothing but the speaker and
the microphone. A single HTML page, no build step, no server.

Live: https://nexusmessage.github.io/sound-link/

## What this is for

An experiment to find out which acoustic transmission scheme actually survives
an ordinary room at 1–3 m, with a payload under 100 bytes and no fallback
channel. The page carries the candidates side by side so the same two phones can
measure them on the same stretch of air.

Both devices open the same page and must be set to the **same scheme**. One
sends, the other listens.

## The candidates

| Setting | Band | Symbol | Notes |
|---|---|---|---|
| ggwave audible, robust | 1875–6328 Hz | 192 ms | Multi-frequency FSK, Reed-Solomon. The untested case — see below. |
| ggwave audible, fast | 1875–6328 Hz | 128 ms | |
| ggwave audible, fastest | 1875–6328 Hz | 64 ms | The profile the published study measured. |
| ggwave near-ultrasonic | 15000–19453 Hz | 192/128/64 ms | Inaudible to most adults. Speaker output up here varies by ~30 dB between phones. |
| QRtone | 1720–7205 Hz | 60 ms + 10 ms guard | The opposite design choice: an explicit silent guard interval between symbols, which is what reverb punishes ggwave for not having. ~6 bytes/s. |

## Why the robust audible profile is the interesting one

Putz et al. (ACM TIoT 7(1) Art. 8, Feb 2026, 11,900 transmissions across five
phones) found ggwave's audible band failed beyond 1 m in an office while the
ultrasonic band carried to 20 m — but both were near-perfect to 5 m in an
anechoic chamber. The room, not the distance, is the adversary. That study used
the 64 ms profile. A normal room's reverberation implies a symbol duration of
roughly 145–290 ms; the robust profile sits at 192 ms and has never been
measured at this range. That is the open question this page exists to answer.

## Traps this page already handles

- **Voice processing is off.** `echoCancellation`, `noiseSuppression` and
  `autoGainControl` are all disabled. With them on, Chrome derives a single
  broadband gain from the 0–8 kHz speech band and applies it to everything
  above — which throttles a 19 kHz carrier based on a decision that never looked
  at it.
- **Bluetooth is detected, not guessed.** A capture sample rate below 44100 Hz
  means Chrome has switched the link to the Bluetooth voice channel, where the
  usable band collapses to 3.4 or 7 kHz. The page says so instead of letting it
  look like poor range.
- **Digital silence is reported.** Android hands out silence rather than an
  error when another app holds the microphone.
- **AudioWorklet, not ScriptProcessorNode.** Demodulation must not share a
  thread with layout and garbage collection. The processor is loaded from a
  `blob:` URL and allocates nothing inside `process()`.
- **`resume()` is not awaited.** Without a user gesture that promise never
  settles — neither resolving nor rejecting. The page watches the context state
  instead.
- **Sample rates are read, never assumed.** Android derives the capture rate
  from the device's output property; context rate and track rate can differ.

## Layout

```
index.html                       the whole application
vendor/ggwave.js                 ggwave master build, WASM embedded (MIT)
vendor/qrtone_emscripten.{js,wasm}  QRtone browser build (BSD-3)
docs/data-over-sound-research.md the primary-source research this is built on
```

## Running it locally

Any static server works, and `localhost` counts as a secure context, so the
microphone is available:

```bash
python -m http.server 8000
```

For two real phones, use the deployed page — a bare LAN address is not a secure
context and the browser will refuse the microphone.

## Credits

- [ggwave](https://github.com/ggerganov/ggwave) — MIT
- [QRtone](https://github.com/Ifsttar/qrtone) — BSD-3, Université Gustave Eiffel
