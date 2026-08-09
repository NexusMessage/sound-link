# Data over sound in the browser — research for an Android-Chrome, audible-band, sub-100-byte link

Research date: **2026-08-09**. Target case: both ends Android Chrome, audible band ~1–8 kHz,
payload < 100 bytes, range 1–3 m in a normal room, bidirectional with acoustic ACK planned,
~3 s per successful transfer, no fallback channel, deliverable a single self-contained HTML page
on GitHub Pages.

**How to read this document.** Every factual claim carries a URL. Claims from reading library or
browser-engine source are marked **[source]** and name the file. Claims that are arithmetic on top
of cited constants are marked **[derived]**. Claims resting on a blog, vendor page, press coverage,
or a search-result summary rather than a document I could open are marked **[secondary]**. Where
something could not be verified there is an explicit **[UNVERIFIED]** note rather than a smoothed
sentence. §7 collects every gap in one place.

---

## 0. The headline, before the detail

Four findings dominate, and three of them cut against the premise of the target case.

1. **Only one serious candidate exists.** ggwave is the only maintained, browser-capable,
   send-*and*-receive data-over-sound library with a working receive path in Chrome. Everything else
   is abandoned (quiet-js, frozen 2021), dormant (QRtone, 2022), transmit-only (euphony.js), or gone
   (Chirp). §1.

2. **At 1–3 m you are inside the reverberant field, not the direct field.** For an ordinary room
   the critical distance is ~0.5–1.2 m; at 3 m the reflected energy exceeds the direct path by
   roughly 8–15 dB. The channel is not "direct path plus echoes" — it *is* the room. §2.1.

3. **The one peer-reviewed on-device evaluation says the audible band fails at exactly your target
   range.** Putz et al. (ACM TIoT 2026) measured ggwave audible (1.8–6.3 kHz) working **only to
   1 m** in an office, while ggwave ultrasonic (15–19.5 kHz) worked **to 20 m** — yet *both* were
   near-perfect to 5 m in an anechoic chamber. The cause is the room, not path loss. Worse: under
   café/station/marketplace ambient recordings the audible variant was *"completely unusable."*
   §2.6.

4. **But that measurement almost certainly used ggwave's *least* robust profile — and theory says
   the robust one is right at the threshold.** The paper's 268 bps net rate matches
   `AUDIBLE_FASTEST` (64 ms symbols) to within rounding (§2.7). Independently, the delay-spread
   arithmetic says a non-equalised system needs **Ts ≥ 10·σ_τ ≈ 145–290 ms**. `AUDIBLE_FASTEST` at
   64 ms is far below that. **`AUDIBLE_NORMAL` at 192 ms lands inside it.** Nobody has published a
   measurement of `AUDIBLE_NORMAL` at 1–3 m.

**So the harness has one job above all others: measure `AUDIBLE_NORMAL` at 1–3 m, with
`AUDIBLE_FASTEST` as the literature-reproducing control and `ULTRASOUND_NORMAL` as the
"does anything work here" control.** That single experiment decides whether the audible band is
viable for this product. Everything else in this document is supporting detail.

---

## 1. Library landscape

### 1.1 Summary table

| Library | License | Last commit (verified) | Stars | Modulation | FEC | Browser TX/RX | Audio API | Bundle |
|---|---|---|---|---|---|---|---|---|
| **ggwave** | MIT | **2026-04-16** | 7,792 | MFSK (6-of-96 tones) | Reed-Solomon GF(256) | **both** | ScriptProcessorNode (its own demo) | **148 KB / 59 KB gz**, single file |
| quiet-js | BSD-3 + LGPL dep | 2021-05-19 | 2,264 | GMSK / OFDM-QAM / FSK / DSSS | conv. v27/v29 + RS | both | SPN + legacy `getUserMedia` | ~838 KB, asm.js |
| QRtone | BSD-3 | 2022-02-07 | 48 | 32-tone dual-tone MFSK | Reed-Solomon (ZXing) | both | ScriptProcessorNode | **53 KB** (30 KB wasm) |
| euphony.js | Apache-2.0 | 2021-10-12 | 6 | 32-tone FSK 18–20.7 kHz | none documented | **TX only** | AudioWorklet (pass-through) | — |
| AudioNetwork | MIT | 2018-05-16 | 211 | FSK | **none** | both | ScriptProcessorNode | — |
| WebAudio-Modem | MIT asserted, **no LICENSE file** | 2025-06-28 | 34 | FSK 300 baud (Bell 103) | CRC-16 + **stop-and-wait ARQ** | both | **AudioWorklet** | — |
| WebJack | GPL-3.0 | 2023-01-16 | 138 | FSK 1225 bit/s | — | cable, not air | ScriptProcessorNode | — |
| Chirp | — | **dead** | — | — | — | — | — | — |
| gibberlink | MIT | 2025-07-28 | 4,879 | *(wraps ggwave)* | — | — | — | — |
| cyrinx | Apache-2.0 | 2026-07-27 | 10 | OFDM + QAM + conv./Viterbi | conv. + CRC | **no browser build** | — | — |

### 1.2 ggwave — the protocol table, read from the C source

Repository <https://github.com/ggerganov/ggwave> · **MIT** · 7,792 stars · last commit
**2026-04-16** · release `ggwave-v0.4.3` **2026-03-21** · not archived · 65 open issues
(<https://api.github.com/repos/ggerganov/ggwave>,
<https://api.github.com/repos/ggerganov/ggwave/releases>). Note the gap: the previous release was
`v0.4.0` on 2022-07-05, so the project was quiet ~3.5 years and then shipped again in 2026. Putz et
al. call it the *"most-starred 'data-over-sound' project on GitHub."*

**Governing constants**, from
[`include/ggwave/ggwave.h:423-436`](https://github.com/ggerganov/ggwave/blob/master/include/ggwave/ggwave.h)
**[source]**:

```
kSampleRateMin  = 1000     kDefaultSampleRate           = 48000
kSampleRateMax  = 96000    kDefaultSamplesPerFrame      = 1024
kMaxDataSize    = 256      kDefaultVolume               = 10
kMaxLengthVariable = 140   kDefaultSoundMarkerThreshold = 3.0
kMaxLengthFixed    = 64    kDefaultMarkerFrames         = 16
kMaxSamplesPerFrame = 1024 kDefaultEncodedDataOffset    = 3
```

**Maximum payload: 140 bytes variable-length, 64 bytes fixed-length.** Both clear your <100-byte
requirement; the 64-byte fixed ceiling is the binding one if you use the faster framing (§1.2.3).

**The protocol table**, verbatim from
[`ggwave.h:521-533`](https://github.com/ggerganov/ggwave/blob/master/include/ggwave/ggwave.h)
**[source]** — fields are `{ name, freqStart, framesPerTx, bytesPerTx, extra, enabled }`:

```c
protocols.data[GGWAVE_PROTOCOL_AUDIBLE_NORMAL]     = { "Normal",       40,  9, 3, 1, true, };
protocols.data[GGWAVE_PROTOCOL_AUDIBLE_FAST]       = { "Fast",         40,  6, 3, 1, true, };
protocols.data[GGWAVE_PROTOCOL_AUDIBLE_FASTEST]    = { "Fastest",      40,  3, 3, 1, true, };
protocols.data[GGWAVE_PROTOCOL_ULTRASOUND_NORMAL]  = { "[U] Normal",   320, 9, 3, 1, true, };
protocols.data[GGWAVE_PROTOCOL_ULTRASOUND_FAST]    = { "[U] Fast",     320, 6, 3, 1, true, };
protocols.data[GGWAVE_PROTOCOL_ULTRASOUND_FASTEST] = { "[U] Fastest",  320, 3, 3, 1, true, };
protocols.data[GGWAVE_PROTOCOL_DT_NORMAL]          = { "[DT] Normal",  24,  9, 1, 1, true, };
protocols.data[GGWAVE_PROTOCOL_DT_FAST]            = { "[DT] Fast",    24,  6, 1, 1, true, };
protocols.data[GGWAVE_PROTOCOL_DT_FASTEST]         = { "[DT] Fastest", 24,  3, 1, 1, true, };
protocols.data[GGWAVE_PROTOCOL_MT_NORMAL]          = { "[MT] Normal",  24,  9, 1, 2, true, };
protocols.data[GGWAVE_PROTOCOL_MT_FAST]            = { "[MT] Fast",    24,  6, 1, 2, true, };
protocols.data[GGWAVE_PROTOCOL_MT_FASTEST]         = { "[MT] Fastest", 24,  3, 1, 2, true, };
```

Conversion rules, also from source **[source]**:

- `hzPerSample = sampleRate / samplesPerFrame` → **46.875 Hz** at 48 kHz / 1024
  ([`ggwave.cpp:488`](https://github.com/ggerganov/ggwave/blob/master/src/ggwave.cpp))
- `freq_hz = (freqStart + tone) * hzPerSample` (`ggwave.h:552`)
- `txDuration_ms = framesPerTx * (1000 * samplesPerFrame / sampleRate)` (`ggwave.h:457-459`)
  → one frame = **21.3333 ms**
- `nTones() = (2 * bytesPerTx) / extra` (`ggwave.h:455`); tone-index space is `2*bytesPerTx*16` bins
  (`ggwave.cpp:856`) → **96 bins** for the 3-byte protocols, **32** for the 1-byte ones

**Derived per-protocol figures** at 48 kHz / 1024 **[derived]**:

| Protocol | f₀ (Hz) | f_max (Hz) | span | bins | **symbol** | tones at once | raw B/s |
|---|---|---|---|---|---|---|---|
| Audible Normal | 1875.0 | 6328.1 | 4500 | 96 | **192.00 ms** | 6 | 15.62 |
| Audible Fast | 1875.0 | 6328.1 | 4500 | 96 | **128.00 ms** | 6 | 23.44 |
| Audible Fastest | 1875.0 | 6328.1 | 4500 | 96 | **64.00 ms** | 6 | 46.88 |
| [U] Normal | 15000.0 | 19453.1 | 4500 | 96 | 192.00 ms | 6 | 15.62 |
| [U] Fast | 15000.0 | 19453.1 | 4500 | 96 | 128.00 ms | 6 | 23.44 |
| [U] Fastest | 15000.0 | 19453.1 | 4500 | 96 | 64.00 ms | 6 | 46.88 |
| [DT] Normal | 1125.0 | 2578.1 | 1500 | 32 | 192.00 ms | 2 | 5.21 |
| [DT] Fast | 1125.0 | 2578.1 | 1500 | 32 | 128.00 ms | 2 | 7.81 |
| [DT] Fastest | 1125.0 | 2578.1 | 1500 | 32 | 64.00 ms | 2 | 15.62 |
| [MT] Normal | 1125.0 | 2578.1 | 1500 | 32 | 192.00 ms | **1** | 2.60 |
| [MT] Fast | 1125.0 | 2578.1 | 1500 | 32 | 128.00 ms | 1 | 3.91 |
| [MT] Fastest | 1125.0 | 2578.1 | 1500 | 32 | 64.00 ms | 1 | 7.81 |

`raw B/s` includes ECC and header bytes; useful payload rate is lower (§1.2.4).

**Two things to notice.**

- **The audible family sits at 1875–6328 Hz — squarely inside your 1–8 kHz band.** No retuning
  needed to satisfy the band constraint.
- **The README is wrong about DT/MT.** It says "For non-ultrasonic protocols: `F0 = 1875.000 Hz`"
  (<https://github.com/ggerganov/ggwave/blob/master/README.md>), but DT/MT use `freqStart = 24` →
  **1125 Hz**. The source is authoritative. **[source]**

README on the modulation: *"The data to be transmitted is first split into 4-bit chunks. At each
moment of time, 3 bytes are transmitted using 6 tones … in a 4.5kHz range divided in 96
equally-spaced frequencies."* So it is **6 parallel 16-ary FSK channels**, each nibble selecting one
of 16 adjacent bins, the six carriers stacked 16 bins apart — not one 96-ary channel.

#### 1.2.1 Error correction — the exact rule

[`src/ggwave.cpp:284-286`](https://github.com/ggerganov/ggwave/blob/master/src/ggwave.cpp) **[source]**:

```c
int getECCBytesForLength(int len) {
    return len < 4 ? 2 : GG_MAX(4, 2*(len/5));
}
```

Integer division, so ECC is a step function of length. The codec is Mike Lubinets' GF(256)
byte-oriented Reed-Solomon, vendored under MIT at
[`src/reed-solomon/`](https://github.com/ggerganov/ggwave/tree/master/src/reed-solomon). `n` parity
bytes correct up to `n/2` byte errors.

| payload | ECC bytes | overhead | corrects |
|---|---|---|---|
| 8 B | 4 | 50 % | 2 byte errors |
| 16 B | 6 | 38 % | 3 byte errors |
| 32 B | 12 | 38 % | 6 byte errors |
| 64 B | 24 | 38 % | 12 byte errors |
| 100 B | 40 | 40 % | 20 byte errors |
| 140 B | 56 | 40 % | 28 byte errors |

**[derived]**

**The ECC ratio is fixed at ~38–40 % and is not tunable via any public API** — it is a free function
in the `.cpp`, not a configurable policy. Changing it means forking.

**There is no interleaver.** Grepping the whole source for `interleav|shuffle|permut` returns only a
commented-out `std::shuffle` of phase offsets with the maintainer's note
`// note : what is the purpose of this shuffle ? I forgot .. :(` (`ggwave.cpp:889-893`) **[source]**.
Encoded bytes map to consecutive transmit slots in order, so a time-burst maps to a burst of
consecutive RS symbols. That is RS's home ground — but it bounds what survives: at `Audible Fast`
(128 ms per 3 bytes) a **250 ms interruption destroys ~6 bytes**, already past the `t = 3` capacity
of a 16-byte payload **[derived]**. Contrast Dolphin, which added an explicit **inter-symbol erasure
code** on top of its per-symbol RS precisely for this (§2.4).

**There is no CRC.** Grepping `crc|checksum|retransmi` in `ggwave.h`/`ggwave.cpp` returns nothing
**[source]**. The library *does* check the RS return value for both the length header and the
payload (`ggwave.cpp:1697`, `1726`) and validates the observed frame count against the length-implied
expectation (`ggwave.cpp:1702-1709`), so uncorrectable blocks are rejected rather than returned as
garbage. But RS can still mis-correct into a wrong-but-valid codeword. **Put your own CRC inside the
payload** — engineering judgement, not a documented ggwave limitation.

#### 1.2.2 Framing and preamble

[`ggwave.cpp:492-497`](https://github.com/ggerganov/ggwave/blob/master/src/ggwave.cpp) **[source]**:

```c
m_nBitsInMarker        = 16;
m_nMarkerFrames        = parameters.payloadLength > 0 ? 0 : kDefaultMarkerFrames;      // 16
m_encodedDataOffset    = parameters.payloadLength > 0 ? 0 : kDefaultEncodedDataOffset; // 3
m_isFixedPayloadLength = parameters.payloadLength > 0;
```

Variable-length transmission:

```
[16 marker frames] [ceil((3 + payload + ECC)/bytesPerTx) * framesPerTx data frames] [16 marker frames]
```

- The 3-byte header is one length byte with its own RS code:
  `RS::ReedSolomon rsLength(1, m_encodedDataOffset - 1, ...)` → 1 data + 2 parity (`ggwave.cpp:809`).
- Markers are 16 tones from the first 32 bins in an alternating even/odd pattern; the end marker is
  the complement (`ggwave.cpp:824-827`, `861-864`).
- Detection compares **neighbouring bins**, not an absolute threshold, with
  `kDefaultSoundMarkerThreshold = 3.0` (`ggwave.cpp:1789-1791`).

Maintainer's own account (<https://github.com/ggerganov/ggwave/discussions/13>): the encoding makes
markers easy to detect; it is robust *"because we are comparing the relative strength of two
neighboring frequencies"*, so *"no background noise estimation is necessary"*; and *"The shorter
amount of time - the lower probability to detect the marker."*

**Marker overhead is fixed and large: 32 frames = 0.683 s per transmission** **[derived]**,
independent of payload size or profile. On a 3-second budget that is 23 % gone before a data byte
moves.

**Symbol shaping**: each symbol is amplitude-ramped linearly over its first and last 15 %, flat
between (`addAmplitudeSmooth`, `frac = 0.15f`, `ggwave.cpp:261-282`) **[source]**. This limits
spectral splatter and softens transitions, but it is **not a silent guard interval** — there is no
gap in which reverberation can decay. Compare QRtone, which inserts an explicit 10 ms silence after
each 60 ms symbol (§1.4).

#### 1.2.3 Fixed-length mode is the biggest single win available

`payloadLength > 0` removes **both** the 0.683 s of markers **and** the 3-byte header. Your payload
size is a design choice, so this is nearly free.

**Total airtime, variable-length** (48 kHz / 1024) **[derived]**:

| payload | ECC | Audible Normal | Audible Fast | Audible Fastest |
|---|---|---|---|---|
| 8 B | 4 | 1.643 s | 1.323 s | 1.003 s |
| 16 B | 6 | 2.411 s | 1.835 s | 1.259 s |
| 32 B | 12 | 3.755 s | 2.731 s | 1.707 s |
| 64 B | 24 | 6.635 s | 4.651 s | 2.667 s |
| 100 B | 40 | 9.899 s | 6.827 s | 3.755 s |
| 140 B | 56 | 13.547 s | 9.259 s | 4.971 s |

**Total airtime, fixed-length** (no markers, no header) **[derived]**:

| payload | ECC | Audible Normal | Audible Fast | Audible Fastest |
|---|---|---|---|---|
| 8 B | 4 | 0.768 s | 0.512 s | 0.256 s |
| 16 B | 6 | **1.536 s** | **1.024 s** | 0.512 s |
| 32 B | 12 | 2.880 s | 1.920 s | 0.960 s |
| 64 B | 24 | 5.760 s | 3.840 s | 1.920 s |

Fixed-length is **1.6–2.4× faster** for small payloads. The receiver must be configured with the
same `payloadLength`.

**Against the 3-second budget including a 2-byte acoustic ACK** (data + ACK airtime, no turnaround
margin — see §3.6 for why you must add one) **[derived]**:

| payload | mode | Audible Normal | Audible Fast | Audible Fastest |
|---|---|---|---|---|
| 16 B | variable | 3.67 s ✗ | 2.90 s ✓ | 2.13 s ✓ |
| 16 B | **fixed** | **1.92 s ✓** | **1.28 s ✓** | 0.64 s ✓ |
| 32 B | fixed | 3.26 s ✗ | 2.18 s ✓ | 1.09 s ✓ |
| 64 B | fixed | 6.14 s ✗ | 4.10 s ✗ | 2.05 s ✓ |

**This is the core design constraint.** If you want the most reverb-tolerant profile (`Normal`,
192 ms) *and* an acoustic ACK inside 3 s, your payload must be ~16 bytes in fixed-length mode. That
leaves ~1.1 s of slack for turnaround — which §3.6's Android latency figures say you will need.

#### 1.2.4 What the "8–16 bytes/sec" README figure means

The README's *"bandwidth rate is between 8-16 bytes/sec"* is *effective* throughput including
markers and ECC for larger payloads: 140 B in 13.547 s = 10.3 B/s at `Normal`, 140 B in 9.259 s =
15.1 B/s at `Fast` **[derived]**. Consistent with the source, just a different quantity from the
15.6/23.4/46.9 B/s raw column.

#### 1.2.5 The "DSS" mode is not spread spectrum

`GGWAVE_OPERATING_MODE_USE_DSS` is documented as *"Enable the built-in Direct Sequence Spread (DSS)
algorithm"* (`ggwave.h:93-94`). The implementation is a byte-wise XOR with a fixed 64-byte table
(`ggwave.cpp:235-249`, `732-733`, `1728-1731`), and the source comment says what it really does
**[source]**:

> `// magic numbers used to XOR the Rx / Tx data`
> `// this achieves more homogeneous distribution of the sound energy across the spectrum`

**It is a whitener, not spreading.** No change to symbol rate, bandwidth, or processing gain.
For contrast, Google's Nearby uses a real 127-chip PN code giving **21 dB** of processing gain
**[derived]** (§2.2). Do not budget for spreading gain from this flag.

#### 1.2.6 The WASM build — and a trap in which build you vendor

Built with emscripten `--bind` and `-s SINGLE_FILE=1`, so the WASM is embedded as a base64 data URI
in one `.js`
([`bindings/javascript/CMakeLists.txt`](https://github.com/ggerganov/ggwave/blob/master/bindings/javascript/CMakeLists.txt))
— ideal for a self-contained page.

**Measured sizes** (I downloaded both builds and decoded the embedded WASM) **[derived]**:

| build | JS bytes | gzipped | embedded WASM |
|---|---|---|---|
| npm `ggwave@0.4.0` (2022-07-05) | 153,955 | 60,864 | 83,370 |
| GitHub `master` `bindings/javascript/ggwave.js` | **148,131** | **59,135** | 81,281 |

**The npm package is missing APIs you will want.** Searching the embind name table inside each
decoded WASM **[derived]**:

| API | npm 0.4.0 | master |
|---|---|---|
| `payloadLength` (fixed-length mode) | present | present |
| `rxToggleProtocol` / `txToggleProtocol` | present | present |
| `GGWAVE_OPERATING_MODE_USE_DSS` | present | present |
| **`txProtocolSetFreqStart` / `rxProtocolSetFreqStart`** | **absent** | **present** |
| **`rxDurationFrames`** | **absent** | **present** |
| **`GGWAVE_PROTOCOL_MT_*`** | **absent** | **present** |

npm `ggwave` is still **0.4.0, published 2022-07-05** (<https://registry.npmjs.org/ggwave>) while the
C library is at 0.4.3. **Vendor `bindings/javascript/ggwave.js` from master, not npm.**

**The variable-length API is exposed in WASM.**
[`bindings/javascript/emscripten.cpp`](https://github.com/ggerganov/ggwave/blob/master/bindings/javascript/emscripten.cpp)
exposes `Parameters` as a value object with all nine fields including `payloadLength`,
`sampleRateInp/Out`, `sampleRate`, `samplesPerFrame`, `soundMarkerThreshold`, `sampleFormatInp/Out`,
`operatingMode`, plus `getDefaultParameters`, `init`, `free`, `encode`, `decode`, the protocol
toggles and (on master) the `freqStart` setters **[source]**. Both framings are reachable from JS.

**What you can and cannot retune from JS.** You can move a protocol's `freqStart` and
enable/disable protocols. You **cannot** set `framesPerTx` or `bytesPerTx` — there is no C API for
it at all (the full `GGWAVE_API` surface is `setLogFile`, `getDefaultParameters`, `init`, `free`,
`encode`, `decode`, `ndecode`, `rxToggleProtocol`, `txToggleProtocol`, `rxProtocolSetFreqStart`,
`txProtocolSetFreqStart`, `rxDurationFrames`, `ggwave.h:163-344`) **[source]**. The
`GGWAVE_PROTOCOL_CUSTOM_0..9` slots exist but are initialised `name = nullptr, enabled = false`
(`ggwave.h:508-511`) and can only be populated from C++. **Symbol duration is therefore selectable
only among Normal/Fast/Fastest unless you rebuild the WASM** — and per §2.3 that is the one
parameter you most want to push further.

**Where the audible block can be moved inside 1–8 kHz** (96 bins × 46.875 Hz = 4500 Hz) **[derived]**:

| freqStart | band |
|---|---|
| 22 (lowest that fits) | 1031 – 5484 Hz |
| **40 (default)** | **1875 – 6328 Hz** |
| 56 | 2625 – 7078 Hz |
| 75 (highest that fits) | 3516 – 7969 Hz |

A cheap, real tuning axis — and per §2.6, moving *up* also moves away from where ambient noise and
reverberation are worst.

#### 1.2.7 Receiver behaviour worth knowing

- **The receiver brute-forces every enabled protocol on every frame** (`ggwave.cpp:1619-1623`,
  `1914-1920`) **[source]**. Disable all but the one in use via `rxToggleProtocol` — cuts CPU and
  false-positive risk.
- **Sample-rate mismatch is handled internally.** `m_hzPerSample = m_sampleRate / m_samplesPerFrame`
  uses the *operating* rate, not the device rate (`ggwave.cpp:488`), and a windowed-sinc resampler
  (`kWidth = 64`, 32 samples per zero crossing, `ggwave.h:831-861`) bridges `sampleRateInp/Out`
  **[source]**. Set those two from `context.sampleRate`, leave `sampleRate` at 48000, and the tone
  grid stays canonical whatever Android hands you (§3.4 — it may well hand you 44100).
- **`decode()` accepts buffers larger than one frame**; it loops internally over `samplesNeeded`
  chunks (`ggwave.cpp:1071-1084`) **[source]**, so a worklet handing over 2048 samples is fine.
- **It refuses to decode while transmitting**:
  `if (m_tx.hasData) { "Cannot decode while transmitting"; return false; }` (`ggwave.cpp:1063-1066`)
  **[source]**. In the WASM build `encode()` builds the whole waveform synchronously and clears the
  flag (`ggwave.cpp:983`), so it is not a practical blocker — but it documents the library's own
  half-duplex assumption. Use **separate RX-only and TX-only instances**
  (`GGWAVE_OPERATING_MODE_RX`/`_TX`); it also halves each instance's memory (`ggwave.h:126-129`).

#### 1.2.8 The reference browser implementation uses ScriptProcessorNode

[`examples/ggwave-js/index-tmpl.html`](https://github.com/ggerganov/ggwave/blob/master/examples/ggwave-js/index-tmpl.html)
**[source]**:

```js
context = new AudioContext({sampleRate: 48000});
parameters.sampleRateInp = context.sampleRate;
parameters.sampleRateOut = context.sampleRate;
...
let constraints = { audio: {
    // not sure if these are necessary to have
    echoCancellation: false, autoGainControl: false, noiseSuppression: false
}};
...
recorder = context.createScriptProcessor(1024, 1, 1);
```

Three takeaways. The 1024 buffer matches `samplesPerFrame` exactly. The comment ("not sure if these
are necessary") shows the author never established what Chrome does with them — §3.1 now answers
that from Chromium source. And on transmit the demo calls `captureStop.click()` with the comment
`// pause audio capture during transmission` — **the reference implementation is explicitly
half-duplex** (§3.6).

A real AudioWorklet integration exists in the wild:
[Cliff3c/Cipherbrick-Pro](https://github.com/Cliff3c/Cipherbrick-Pro) (MIT) ships
`js/ggwave-worklet.js`, an `AudioWorkletProcessor` accumulating 128-frame render quanta into a
2048-sample `Float32Array` and `postMessage`-ing it to the main thread, with a note that the module
is loaded same-origin "not a blob — CSP-safe". I found essentially no other public ggwave+AudioWorklet
code; GitHub code search is not exhaustive, so read that as "rare", not "unique" **[UNVERIFIED as
exhaustive]**.

#### 1.2.9 Serious real-world use

[seemoo-lab/pairsonic](https://github.com/seemoo-lab/pairsonic) (Apache-2.0, 73★, last push
2025-03-10, Flutter/Android) is a group contact-exchange protocol on the SafeSlinger secure
foundation whose README states: *"PairSonic internally uses the ggwave library for acoustic
communication."* A security protocol with a multi-round exchange choosing ggwave as its substrate is
the strongest available evidence the library holds up under a real bidirectional design. Repo topics
include `ultrasound`; I did not read which protocol constant it selects **[UNVERIFIED]**.

### 1.3 quiet-js / libquiet — most capable non-ggwave option, and abandoned

- [quiet/quiet-js](https://github.com/quiet/quiet-js), BSD-3-Clause, 2,264★. **master HEAD
  2021-05-19**; **no releases ever** (`/releases` returns `[]`); 29 open issues.
- [quiet/quiet](https://github.com/quiet/quiet) (C library), **master HEAD 2019-11-15**, and its last
  three commits are README cosmetics.
- **npm is a dead end**: <https://registry.npmjs.org/quiet-js> is a name reservation — v1.0.0, empty
  description, no repository. Vendor by `<script>` tag.

**Licensing catch.** README: *"It is strongly recommended to also include libfec.js … If libfec is
not included, then quiet.js will not be able to use any profiles which use convolutional codes or
Reed-Solomon error correction"*, and *"libfec is licensed under LGPL."* Every profile except
`wideband-dsss` uses one of those, so **libfec is effectively mandatory and you inherit LGPL-2.1**
(<https://registry.npmjs.org/libfec>, last published 2016-02-25).

**Audible-band profiles** (from
[`quiet-profiles.json`](https://github.com/quiet/quiet-js/blob/master/quiet-profiles.json)):

| Profile | modulation | inner FEC | outer FEC | centre | sps |
|---|---|---|---|---|---|
| `audible` | GMSK | v27 (conv. r=1/2 K=7) | — | 4200 Hz | 10 |
| `audible-fsk` / `-robust` | FSK-8 | — | v29 (r=1/2 K=9) | 8000 Hz | 40 |
| `audible-fsk-fast` | FSK-8 | rs8 | v29 | 8000 Hz | 40 |
| `audible-7k-channel-0` | OFDM-48 arb16opt | v29 | rs8 | 9200 Hz | 6 |
| `ultrasonic` | GMSK | v27 | — | 19000 Hz | 14 |
| `ultrasonic-whisper` | GMSK | v27 | — | 19500 Hz | 30 |
| `wideband-dsss` | DSSS | — | — | 17000 Hz | 20 |

FEC semantics from liquid-dsp's own docs (<https://liquidsdr.org/doc/fec/>).

**There is no documented byte-rate table anywhere in the project.** Only *"For transmission via
cable, quiet.js has profiles which offer speeds of at least 40 kbps"* and, for speakers, no rate at
all. Derived at 44.1 kHz **[derived]**: `audible` ≈ 276 B/s, `ultrasonic` ≈ 197 B/s,
`ultrasonic-whisper` ≈ 92 B/s, excluding preamble and header. The OFDM profiles were not derived.

**Browser API — both deprecated paths.** Grepping the shipped `quiet.js` **[source]**:
`createScriptProcessor(16384, 2, 1)` and legacy
`navigator.getUserMedia || webkitGetUserMedia || mozGetUserMedia`, with **zero** occurrences of
`audioWorklet` or `navigator.mediaDevices`. 16384 samples at 44.1 kHz ≈ 372 ms of main-thread
latency.

**Bundle**: 672,029 + 46,188 + 37,444 + 69,995 ≈ **838 KB uncompressed, asm.js**. Issue
[#18 "wasm"](https://github.com/quiet/quiet-js/issues/18) open since 2017, no comments.

**Does receive still work in Chrome?** The APIs exist — MDN browser-compat-data shows no
`version_removed` for
[`ScriptProcessorNode`](https://github.com/mdn/browser-compat-data/blob/main/api/ScriptProcessorNode.json)
or `Navigator.getUserMedia`. But there is an unbroken record of unfixed receive failures:
[#50](https://github.com/quiet/quiet-js/issues/50) (2024),
[#46](https://github.com/quiet/quiet-js/issues/46) (2022),
[#43](https://github.com/quiet/quiet-js/issues/43) (2021),
[#37](https://github.com/quiet/quiet-js/issues/37) (2020),
[#21](https://github.com/quiet/quiet-js/issues/21) (2018). **[UNVERIFIED]**: nobody drove the demo
with a real microphone; "the APIs exist" is proven, "the demodulator still locks" is not.

### 1.4 QRtone — small, clean, in your exact band, and slow

[Universite-Gustave-Eiffel/qrtone](https://github.com/Universite-Gustave-Eiffel/qrtone)
(`Ifsttar/qrtone` redirects there; `NicolasFortin/qrtone` is a 404). **BSD-3-Clause**, 48★, **last
commit 2022-02-07**.

**It is not chirp/CSS.** From `src/qrtone.c` **[source]**:

```c
#define QRTONE_NUM_FREQUENCIES 32
#define QRTONE_WORD_TIME 0.06f
#define QRTONE_WORD_SILENCE_TIME 0.01f
#define QRTONE_GATE_TIME 0.12f
#define QRTONE_AUDIBLE_FIRST_FREQUENCY 1720
#define QRTONE_MULT_SEMITONE 1.0472941228206267f   // = 2^(1/15)
#define QRTONE_DEFAULT_TRIGGER_SNR 15
```

**32-tone dual-tone MFSK on a 15-per-octave ladder from 1720 Hz to 1720 × 2^(31/15) ≈ 7205 Hz**
**[derived]** — almost exactly your target band, and **audible only; there is no ultrasonic
profile.** Detection uses the generalized Goertzel algorithm (Sysel & Rajmic, *EURASIP J. Adv. Signal
Process.* 2012:56).

**The design detail that matters here:** each symbol is **60 ms of tone plus 10 ms of silence** — an
explicit inter-symbol guard interval, exactly the thing ggwave lacks (§1.2.2). If your hypothesis is
that reverberation kills the audible band, this is the most interesting alternative design in the
landscape.

**FEC: Reed-Solomon**, four levels (`ECC_SYMBOLS[][2] = {{14,2},{14,4},{12,6},{10,6}}`, default
`QRTONE_ECC_Q`), ported from ZXing's QR-code RS. Max payload "should be less than 255 bytes."

**Rate: "about 50 bits per second"** (README) ≈ 6.25 B/s → 16 bytes ≈ **2.6 s one-way**
**[derived]**, inside a 3 s one-way budget but with no room for an ACK.

**Browser build**: `-Os` emscripten; artefacts on `gh-pages` are `qrtone_emscripten.wasm`
**30,331 B** + `qrtone_emscripten.js` 22,862 B = **~53 KB**, genuine WASM, ~16× smaller than
quiet-js. Live demo with send *and* receive: <https://universite-gustave-eiffel.github.io/qrtone/>.
Its ScriptProcessorNode glue is a thin `--pre-js` layer over a clean
`_qrtone_push_samples` / `_qrtone_get_samples` WASM API, so an AudioWorklet port touches only glue.

### 1.5 Chirp — gone

`https://chirp.io/` and `https://developers.chirp.io/` both **HTTP 301 → `https://sonos.com/home/`**.
The [github.com/chirp](https://github.com/orgs/chirp/repos) org has 11 repos, none browser-facing,
several archived; `chirp-arduino` has master HEAD 2019-12-09 and a README stating *"This software is
copyright © 2011-2019, Asio Ltd. All rights reserved."* — no open-source grant, and it needed an app
key from the dead console. Sonos announced the acquisition 2020-02-13, console reportedly closed
2020-03-01 **[secondary]**
(<https://audioxpress.com/news/data-over-sound-pioneer-chirp-acquired-by-sonos>). **Nothing
survives.**

### 1.6 gibberlink — a demo, not a library

[PennyroyalTea/gibberlink](https://github.com/PennyroyalTea/gibberlink), MIT, **4,879★**, last commit
2025-07-28. The whole repository is `LICENSE`, `README.md`, and one `hackathon_demo/` — a Next.js app
whose `package.json` declares `"name": "my-app"` and depends on `"ggwave": "^0.4.0"` plus
`@11labs/client`, `openai`, `groq-sdk`. **No DSP, no protocol, no reusable module.** Its stars
measure a viral video. Same for [bennjordan/Wavest](https://github.com/bennjordan/Wavest).

### 1.7 Other browser-capable candidates

- **[cho45/WebAudio-Modem](https://github.com/cho45/WebAudio-Modem)** — the only actively-maintained
  **AudioWorklet-native** implementation found (master HEAD 2025-06-28,
  `src/webaudio/processors/fsk-processor.ts`). FSK, **300 baud Bell 103** ≈ 37 B/s, audible only.
  Uniquely it has **CRC-16 + stop-and-wait ARQ** — directly relevant as a reference for your
  stage-two design. **License risk**: `package.json` says MIT but the GitHub API reports
  `license: null` and **there is no LICENSE file**. A personal research repo, not a product.
- **[euphony-io/euphony.js](https://github.com/euphony-io/euphony.js)** — Apache-2.0, 32-tone FSK
  18,001–20,667 Hz, **transmit only**: no `getUserMedia`/`mediaDevices`/`createAnalyser` anywhere,
  and `createScriptProcessor(BUFFERSIZE, 0, 2)` — zero input channels. Its "AudioWorklet support"
  loads a pass-through processor from a hardcoded jsDelivr URL. Not viable.
- **[robertrypula/AudioNetwork](https://github.com/robertrypula/AudioNetwork)** — MIT, 211★, last
  commit **2018-05-16**, FSK, **no error correction at all**.
- **[publiclab/webjack](https://github.com/publiclab/webjack)** — GPL-3.0, FSK 1225 bit/s, designed
  for browser↔Arduino **over a cable**; the browser-to-browser profile is "a planned feature and not
  working yet".

### 1.8 Newer entrants (2024–2026) — nothing has replaced ggwave

- **[dweekly/cyrinx](https://github.com/dweekly/cyrinx)** (Apache-2.0, last commit 2026-07-27) is the
  best new engineering — OFDM, cyclic prefixes, pilot tracking, 64-QAM, K=7 convolutional FEC with
  puncturing, two-mic MRC — reporting *"65.875 kbps of verified payload"*. **Read the conditions
  before quoting that**: the phone was *"face-up on 0.5-inch soft cloth above the MacBook left
  function-key area, with the bottom microphone near the built-in left speaker"* — **~1 cm, not
  1–3 m.** Its own degradation curve is the useful part: 46.915 kbps clean → **11.366 kbps
  reverberant** → **138 bps shadowed**. Ultrasonic was *"functional but slow as measured
  (<0.3 kbps OTA)"* and never shipped. **No browser build.**
- **beeping-io** (<https://github.com/orgs/beeping-io/repos>) — Apache-2.0, C++20 core with
  Android/iOS bindings, **no JS/WASM/browser SDK**, zero adoption.
- The 2026 cohort (`topic:acoustic-modem`: 8 repos, 7 created in 2026 with 0–1 stars) is hobby
  projects. **`topic:chirp-modem` contains zero repositories.**
- **Audio watermarking is a different problem**
  ([audioseal](https://github.com/facebookresearch/audioseal) MIT 765★,
  [audiowmark](https://github.com/swesterfeld/audiowmark) GPL-3.0 575★) — embeds a few bits into
  existing content, Python/C++ CLI, no browser path.
- **npm has nothing relevant beyond ggwave packages** (`ggwave` 0.4.0; `@vpalmisano/ggwave` 0.4.3-2
  published 2025-04-01 — possibly a fresher route, **[UNVERIFIED]** I did not inspect its exports;
  `ggwave-napi` 0.0.3).
- **minimodem** (981★) is a Linux CLI tool; **no emscripten port exists**.

---

## 2. Method fundamentals

### 2.1 The number that reframes the whole problem: you are in the reverberant field

Critical distance (reverberation radius) — where direct and reflected energy are equal — for an
omnidirectional source in a diffuse field:

  r_c ≈ 0.056 · √(V / T₆₀)   [m, m³, s]

— Mašović, *Room Acoustics* lecture notes, eq. (5.36), <https://arxiv.org/abs/2111.01900> (full text
verified; the 0.161 constant in Sabine is derived there analytically as 8·ln(10³)/c₀).

**[derived]** For an ordinary furnished room, V = 30–60 m³, T₆₀ = 0.35–0.5 s → **r_c ≈ 0.5–0.6 m**.
Direct-to-reverberant ratio DRR = 20·log₁₀(r_c/d):

| distance | DRR (omni source) |
|---|---|
| 0.5 m | ≈ +1 dB |
| 1 m | ≈ −5 dB |
| 2 m | ≈ −11 dB |
| **3 m** | **≈ −15 dB** |

A phone speaker has some directivity at 1–8 kHz (Q ≈ 2–4), raising r_c by √Q to ~0.8–1.2 m. Even
then, at 3 m the reverberant field carries roughly **8–11 dB more energy than the direct path**.
Mašović states the general case: *"in most of the common rooms listeners are located in the zone
where direct sound is much weaker than reflected sound and the room affects the field profoundly."*

**This single fact explains almost every measured result in §2.6.** At 1–3 m the channel is not a
direct path with echoes; it is predominantly the room. Any scheme assuming a resolvable dominant tap
will underperform, and your 1 m→3 m step is not a small extrapolation — it is a ~10 dB swing in DRR.

### 2.2 The modulation families, and what each costs here

| Family | Buys | Costs | Fit at 1–3 m |
|---|---|---|---|
| **MFSK** (ggwave, QRtone, PriWhisper, Digital Voices) | Non-coherent energy-per-bin detection: no phase reference, no equaliser, no channel estimate. Long symbols are structurally cheap. | Spectrally inefficient (log₂M bits per M tones); non-coherent orthogonality needs Δf ≥ k/T rather than k/2T, halving usable tone density. | **Best default.** Its robustness comes from being able to lengthen symbols at no structural cost. |
| **OFDM / QAM** (cyrinx, Gonçalves) | Highest spectral efficiency; flat-fading sub-channels with cheap FFT equalisation *if* the CP covers the delay spread. | CP must exceed *maximum* excess delay; tight frequency/clock sync; coherent phase tracking; very high PAPR. | **Poor at range** — see the squeeze in §2.3. |
| **Chirp / CSS** (Lee et al., HRCSS) | Matched-filter processing gain; Doppler shifts an LFM correlation peak in *time* rather than destroying it. | Very low rate — one chirp occupies the whole band per symbol. | **Most robust measured.** Lee et al. held zero error across all distances at **15 bps**. |
| **DSSS** (Google Nearby, quiet `wideband-dsss`) | Processing gain against narrowband interference; energy spread below perceptual thresholds. | Rate divided by spreading factor; code acquisition cost. | Nearby: 127-chip PN code per symbol → **21 dB** gain **[derived]**, 94.5 b/s raw, *"reliable at 2 m … often works at 10 m."* |

Sources: Putz et al. Table 2 <https://arxiv.org/html/2602.02249v1>; Getreuer, Gnegy, Lyon & Saurous,
*IEEE Trans. Multimedia* 20(6):1277–1290, 2018, <https://getreuer.info/papers/getreuer2018ultrasonic/index.html>
(DOI 10.1109/TMM.2017.2766049); Bernard et al., *Sensors* 20(5):1527,
<https://doi.org/10.3390/s20051527> (CSS, **underwater**); Otnes et al., *Underwater Acoustic
Networking Techniques*, SpringerBriefs 2012, <https://signet.dei.unipd.it/underwater/media/download/378>.

The underwater-acoustics community reached the same conclusion for single-receiver systems:
*"If the use of a receive array is impractical, as in multinode networks, then frequency-shift
keying (FSK) is often used as a fairly robust modulation for single-receiver systems… However, the
corresponding data rates are of the order of 100 bit/s."* (Otnes et al. §1). **That is an underwater
result** — but the 100 bps figure matches in-air measurements almost exactly (§2.6).

**PAPR, and why it bites on a phone.** **[derived]** N equal-amplitude sinusoids give worst-case
PAPR = 2N: **10.8 dB for ggwave's 6 tones**, vs 3 dB for a single tone; ~23 dB for a 100-subcarrier
OFDM symbol. This matters because Putz et al. **measured** that *"most devices suffer from nonlinear
distortions at volume settings above approximately 75%"* — high PAPR forces back-off, which spends
exactly the SNR the waveform was meant to earn. It is also an argument for ggwave's `[MT]`
(single-tone) protocols on paper, though their rate (§1.2) rules them out in practice.

### 2.3 Why reverberation punishes OFDM more than long-symbol FSK

**Reverberation time.** ISO 3382-2:2008 covers ordinary rooms — offices, classrooms, dwellings
(<https://www.iso.org/standard/36201.html>); T20 and T30 are extrapolations from the 5→25 dB and
5→35 dB portions of the decay. Sabine: T₆₀ = 0.161·V/A (Mašović eq. 5.34). Measured values for
furnished dwellings, all **[secondary]** (I could not open the papers):

- *The acoustics of domestic rooms*, Applied Acoustics 1972,
  <https://doi.org/10.1016/0003-682X(72)90030-8> — 50 living rooms + 50 kitchens, RT falling
  **0.69 s @125 Hz → 0.51 s @1 kHz → 0.40 s @8 kHz**.
- Díaz & Pedrero, Applied Acoustics 66:945–956 (2005),
  <https://doi.org/10.1016/j.apacoust.2004.12.002> — 11,457 furnished rooms; RT decreases uniformly
  with frequency.
- Bradley, 602 Canadian multiple-residence homes — mean RT ≈ **0.4 s** over 100–4000 Hz.

**Design range: RT₆₀ ≈ 0.3–0.6 s over 500 Hz–8 kHz, higher at the bottom of the band.**

**From RT₆₀ to RMS delay spread.** **[derived]** Model the reverberant power-delay profile as
one-sided exponential; a 60 dB decay takes 6·ln(10)·τ = 13.8τ, and for an exponential PDP the RMS
delay spread equals τ:

  **σ_τ ≈ T₆₀ / 13.8**

| RT₆₀ | σ_τ |
|---|---|
| 0.3 s | 22 ms |
| 0.4 s | **29 ms** |
| 0.5 s | 36 ms |
| 0.6 s | 43 ms |

**Cross-checks.** Putz et al. §7.3.1: *"Reverberation produces long delay spreads due to multipath
propagation at the relatively slow speed of 343 m/s… Design requirement: Operate correctly with
delay spreads up to tens of milliseconds."* Tabak, Lin & Singer, EUSIPCO 2021,
<https://arxiv.org/abs/2103.11261> **[measured]**: *"delay spread of an indoor acoustic channel
measured in an office space with devices placed 5 m apart could span 70 ms."* The derivation and the
measurements bracket the same regime.

**Note the frequency dependence, because it is the opposite of what you would hope.** **[derived]**
At 1 kHz, RT₆₀ ≈ 0.51 s → σ_τ ≈ 37 ms; at 8 kHz, RT₆₀ ≈ 0.40 s → σ_τ ≈ 29 ms. **The audible band is
the *more* dispersive part of the channel, and its low end is the worst of it.** Air absorption
thins the reverberant tail at 19 kHz but barely touches 1–8 kHz.

**Coherence bandwidth.** **[rule of thumb]** B_c ≈ 1/(5σ_τ) for ~0.5 correlation, 1/(50σ_τ) for
~0.9 (Stanford EE359 Lecture 6, <https://web.stanford.edu/class/ee359/pdfs/lecture6_handout.pdf>).
**[derived]** with σ_τ = 29 ms → **B_c(0.5) ≈ 6.9 Hz, B_c(0.9) ≈ 0.7 Hz**. Schroeder's statistical
theory gives a mean spacing between room-response maxima of ≈ 6.7/T₆₀ → ~17 Hz at 0.4 s (JASA
34(12):1819, 1962, <https://doi.org/10.1121/1.1909136>) **[secondary]** — some sources give 4/T₆₀.
Either way: **the room transfer function has structure on a scale of roughly 1–20 Hz.**

**What that means for tone spacing.** Two constraints pulling opposite ways: orthogonality needs
Δf ≥ 1/T_s (10 Hz at T_s = 100 ms); fading decorrelation wants Δf ≫ B_c (~7–17 Hz) so tones fade
*independently* and a null cannot swallow the whole alphabet. **[derived]** **ggwave's 46.875 Hz
spacing sits at ~3–7× B_c and ~4.7× the orthogonality floor for a 100 ms symbol — a well-chosen
number for this channel**, whether or not it was chosen for this reason. Across 1–8 kHz that spacing
affords ~149 tone slots.

**Minimum usable symbol duration — the number that decides your profile.** **[rule of thumb]** For a
non-equalised single-carrier/FSK system, T_s ≥ 10σ_τ keeps the ISI error floor low; T_s ≥ 5σ_τ is the
aggressive limit. **[derived]** with σ_τ = 29 ms: **T_s ≥ 145–290 ms.**

Put ggwave's profiles against that:

| ggwave profile | symbol | T_s / σ_τ | verdict |
|---|---|---|---|
| Audible Fastest | 64 ms | 2.2 | **far below even the aggressive limit** |
| Audible Fast | 128 ms | 4.4 | at the aggressive limit |
| **Audible Normal** | **192 ms** | **6.6** | **inside the safe band's lower half** |

**The measured evidence lines up monotonically with symbol duration**, across schemes and independent
of modulation family:

| Scheme | symbol / frame | measured behaviour |
|---|---|---|
| PriWhisper | **2 ms** MFSK symbols | *"deteriorated notably beyond 20 cm"* |
| Gonçalves OFDM | 0.4 s frame, 600 bps | 3 % BER @10 cm → 25 % BER @1 m |
| ggwave audible | ≈ 90 ms per 3-byte frame **[derived: 24 bits ÷ 268 bps]** | 0 % TER to 1 m office; near-perfect to 5 m anechoic |
| Dolphin OFDM | **100 ms** symbol + 10 ms CP | 261 bps 0–1 m, 157 bps 2–3 m (real loudspeaker) |
| Lee et al. chirp | 1.1 s frame + long chirp preamble | ~0 % error to 40 m |

**Symbol duration relative to delay spread is the single strongest predictor of measured robustness
in this literature.**

**The specific OFDM penalty.** The CP must cover *maximum* excess delay, not RMS. **[derived]** For
an exponential PDP the tail is x dB down at t = (x/60)·T₆₀: at T₆₀ = 0.4 s, −10 dB → 67 ms, −20 dB →
133 ms, −30 dB → 200 ms. Take CP = 100 ms with ≤10 % overhead → useful symbol T_u = 1 s → subcarrier
spacing 1 Hz. Now what destroys 1 Hz orthogonality **[derived]**:

- hand motion at **1 cm/s** at 4 kHz → f_d = 0.12 Hz → normalised ICI ε = **12 %** (tolerance is
  1–2 %)
- a **20 ppm** clock offset at 4 kHz → 0.08 Hz → ε = **8 %**
- walking at 1 m/s → 11.7 Hz → total destruction

**So the OFDM trap is a squeeze, not one failure:** long CP (forced by 20–40 ms delay spread) →
narrow subcarriers → hypersensitivity to exactly the offsets two unsynchronised handheld phones
guarantee. Dolphin escapes it by deliberately making the **CP shorter than the delay spread** (10 ms
CP, 100 ms symbol) and mopping up with per-symbol pilots plus a two-level erasure code — Wang et al.,
*"Messages Behind the Sound"*, MobiCom'16, <https://doi.org/10.1145/2973750.2973765>, PDF
<https://cse.buffalo.edu/~lusu/papers/MobiCom2016.pdf>.

**Non-coherent MFSK has no equivalent squeeze**: a 0.12 Hz Doppler or 0.08 Hz clock error is
invisible inside a 46.875 Hz bin.

Underwater confirmation of the mechanism (Otnes et al. §1): *"A channel displaying both time-delay
and frequency dispersion is known as a doubly spread channel. If the product of delay spread and
Doppler spread exceeds unity, the channel is known as being overspread, and there is little hope for
reliable communication at useful data rates."* **Underwater, not in-air** — but air at 343 m/s is
*slower-propagating and therefore relatively more dispersive per metre* than water at 1500 m/s.

### 2.4 Error correction, with and without a return channel

**The error pattern is bimodal.** Putz et al. §7.3.4 **[measured]**: *"the acoustic frequency band is
exposed to a wide range of common noise sources—such as traffic, machinery, human speech, and noises
from device handling… **Both burst and stationary noise components are common.** Design requirement:
Maintain link integrity in the presence of continuous and impulsive noise (e.g., using **strong error
correction and time interleaving**)."* Dolphin measured it directly: *"most symbols have errors, but
the number of error bits are typically no more than 3… In some cases, the number of error bits in a
symbol may exceed 10, probably due to high multipath interference."* — a low random floor plus
occasional heavy bursts confined to individual symbols. Their answer was two-level: intra-symbol RS
for the floor, **inter-symbol erasure code** (last m of 30 symbols as parity) for the bursts. **That
architecture is worth copying, and it is exactly what ggwave lacks (§1.2.1).**

| Code | Suits | Overhead | WASM cost | With ACK | Without ACK |
|---|---|---|---|---|---|
| **Reed-Solomon** GF(256) | **bursts** — a burst of B bits corrupts ≤ ⌈B/8⌉+1 symbols, so it is natively burst-tolerant without interleaving | tunable (CCSDS RS(255,223) = 12.5 %) | trivial; ggwave already ships it in WASM | **ideal** inner code | good, over-provision |
| **Convolutional + Viterbi** | random bit errors; **requires interleaving** for bursts | rate 1/2–1/3, puncturable | 2^(K−1) states/bit; K=7 → 64 states, negligible at 100–1000 bps. Soft decisions are free here — MFSK bin magnitudes *are* soft information | fine | fine |
| **LDPC** | near-capacity on memoryless channels, **needs long blocks** | tunable | see gap below | overkill | overkill |
| **Fountain / RaptorQ** | **erasures** — you must be able to *detect* bad symbols (pair with CRC, or use RS decode-failure as the erasure flag) | rateless | modest at these block sizes | **pointless** — the ACK already gives rate adaptation | **genuinely useful** |

- Burst-code canon: MIT 6.02 Ch. 6 §6.5.1, <https://web.mit.edu/6.02/www/f2011/handouts/6.pdf> —
  *"Interleaving is a commonly used technique to recover from burst errors on a channel even when the
  individual blocks are protected with a code that, on the face of it, is not suited for burst
  errors."* The canonical concatenation is DVB-T (ETSI EN 300 744): outer RS(204,188) t=8 → Forney
  convolutional byte interleaver depth I=12 → inner punctured convolutional, precisely to break the
  inner decoder's burst outputs into single-byte errors across RS codewords **[secondary]**.
- **LDPC is the wrong tool here, and not for speed reasons.** **[derived]** a 5 s transmission at
  268 bps is ~1,340 bits total; you never reach the block lengths (DVB-S2 uses 64,800-bit codewords)
  where LDPC beats RS. **[UNVERIFIED]**: no primary benchmark of LDPC/RS/Viterbi decoding in a
  browser/WASM setting was found — the "trivially cheap" claims are order-of-magnitude reasoning.
- **RaptorQ, RFC 6330** (<https://www.rfc-editor.org/rfc/rfc6330>, Proposed Standard, Aug 2011) —
  recovery properties, verified verbatim: with K′ symbols received, average failure ≤ **1 in 100**;
  K′+1 → ≤ **1 in 10,000**; K′+2 → ≤ **1 in 1,000,000**. Two extra symbols buys six nines on a channel
  whose loss rate you cannot predict. **RFC 5053** (R10 Raptor,
  <https://www.rfc-editor.org/rfc/rfc5053>) contains **no** normative failure table and **no** IPR
  section (verified by reading the text).
- **RaptorQ licensing — better than its reputation.** Qualcomm's IETF IPR declaration 2554
  (<https://datatracker.ietf.org/ipr/2554/>) is two-tier: for devices implementing a wireless
  wide-area standard, licensed at standard royalty rates; for devices that do **not**, *"Qualcomm
  will not assert any such claim against any party for making, using, selling, importing or offering
  for sale such device but solely with respect to the implementation of such adopted standards track
  or experimental document."* **Reading for a browser app: non-WWAN → the non-assertion branch
  applies, provided you implement RFC 6330 faithfully rather than a modified variant.**
  **[UNVERIFIED]**: RFC 5053's IPR position — no declaration located. **If you use a fountain layer,
  use RaptorQ/RFC 6330 unmodified.**

**Recommendation matrix**

| | **No return channel** | **With return channel** (your stage two) |
|---|---|---|
| Inner (per frame) | RS GF(256), generous t; CRC per frame as the erasure flag | Same, leaner t |
| Middle | **Time interleaving across frames — mandatory**; this is what turns a door-slam into scattered single-byte errors | Still worth it |
| Outer | **RaptorQ (RFC 6330)** over frames, or fixed 1.5–3× redundancy | CRC + **selective-repeat ARQ** for the tail — cheaper than any FEC in overhead |
| Crude fallback | Repeat the message N times and combine — literally what Google Nearby does (3× repetition, Putz et al. §7.4.5) | — |

**Caveat on ARQ over acoustics:** the return channel is itself acoustic and half-duplex, so each
round trip costs a full preamble + payload + turnaround. Get 95 % of the way with FEC and use ARQ
only for the tail; do **not** build a per-frame stop-and-wait protocol.

### 2.5 Preamble, sync, and two unsynchronised phones

**Synchronisation is the dominant practical failure mode — measured, not asserted.** Putz et al.
§7.4.3 excluded HRCSS (nominally the second-fastest scheme) because *"the high error rates stemmed
from synchronization failures. In particular, the preamble detection algorithm in the implementation
deviates from the method described in the HRCSS paper… errors in the code cause the receiver to
incorrectly calculate and select signal peaks, preventing it from correctly identifying the start of
a transmission."* They proved it by hand-feeding the correct preamble index, which *"substantially
improved the TER."* And their TER metric assigns **100 %** to any transmission where the receiver
returns an error instead of data — **a sync miss is total loss, worse than a high BER.** Budget your
engineering accordingly: a mediocre modulation with a great preamble beats the reverse.

**Preamble families.**

- **Linear-FM chirp + matched filter** — the workhorse. **[derived]** a 100 ms sweep across 1–8 kHz
  has TB = 700 → **28.5 dB** of processing gain and compresses to a peak ~1/B = 143 µs wide (≈7
  samples at 48 kHz). A Doppler shift *translates* the LFM peak in time rather than destroying it;
  an up-chirp followed by a down-chirp separates timing (midpoint) from Doppler (difference). In-air
  precedent: Dolphin uses a 100 ms 17→19→17 kHz sweep plus 50 ms silence, detected by envelope rather
  than full matched filtering, and reports *"synchronization errors within 5 data sampling points."*
  Lee et al. begin each frame with *"a long chirp preamble, followed by 16 individual chirps."*
- **m-sequences / Gold codes / Barker** — sharp autocorrelation, low cross-correlation (Gold), so
  several transmitters coexist. Nearby's 127-chip PN code → **21 dB** gain **[derived]**.
- **Energy detection** — cheapest, worst; use only as a first-stage gate ahead of a correlator.
- **ggwave's marker** (§1.2.2) is a 16-tone alternating pattern over 341 ms with relative-bin
  detection: cheap, noise-floor-independent, and expensive in time.
- **A trick worth stealing**, from Putz et al.'s PriWhisper re-implementation: the sync symbol
  contains *all* tones, so the receiver derives a **per-frequency calibration factor** from it.
  *"Without calibration, [the correlator] might return a lower correlation value for the actual
  frequency present in a symbol due to the frequency-selectivity of the microphone."* One preamble,
  two jobs. Highly relevant given they **measured up to 30 dB SPL spread between phones at the same
  volume index.**

**Sample-rate offset — the number you asked for exists.** Schmalenstroeer, Gburrek & Haeb-Umbach,
*LibriWASN*, ITG Speech Communication 2023, <https://arxiv.org/abs/2308.10682> (full text verified),
nine devices, five of them smartphones, clocks unsynchronised:

- **[measured]** *"the hardware dependent SROs of the devices are in the range between ±20 ppm w.r.t.
  the sampling rate of the soundcard"* — per-device values +16.62, +13.58, +13.73, −0.11, −1.44,
  −10.35, −23.18 ppm.
- **[measured, cited]** *"the SROs of smartphones and audio devices can be in the range between −40
  parts per million (ppm) and 416 ppm, whereby devices from the same vendors have less variation"*,
  and *"values exceeding ±100 ppm are rarely observed."*
- SRO is **time-varying with device temperature**.

For contrast, AES11 holds professional reference clocks to ±1 ppm (Grade 1) / ±10 ppm (Grade 2)
**[secondary]**. Consumer phones are not held to that.

**Design figure: ±20 ppm typical, ±100 ppm worst case, drifting with temperature.** What that does
**[derived]**:

| Effect | 20 ppm | 100 ppm |
|---|---|---|
| Timing drift over a 5 s transmission | 100 µs (4.8 samples @48 kHz) | 500 µs (24 samples) |
| Frequency error at a 4 kHz tone | 0.08 Hz | 0.4 Hz |
| **Accumulated carrier phase drift at 4 kHz** | 28.8°/s → **144° after 5 s** | 4 full cycles in 10 s |

**Read that last row twice.** At audio carrier frequencies a consumer-grade clock offset alone
rotates carrier phase through more than a quadrant in five seconds. Coherent PSK therefore mandates
continuous phase tracking — Tabak et al. do exactly that (8+20 feedforward, **80 feedback taps**,
plus a PLL) and get 4 kbps. That is the price of coherence. Dolphin computed the same from the sync
side: *"the phase shift of a 10 KHz sine signal is π/2 if the synchronization error is 1 sampling
point. Typical preamble synchronization methods result in synchronization errors within 5 sampling
points. Therefore, the imperfect synchronization of the preamble makes phase shift unpredictable and
the phase shift keying (PSK) technique unsuitable for Dolphin."*

**Why non-coherent energy-per-bin detection is so forgiving.** Three independent phase corruptions,
none of which touch |X_k|²: (1) preamble timing error, ±5 samples ≈ ±82° per sample at 10 kHz,
unbounded mod 2π; (2) clock offset, a continuously ramping phase; (3) the room itself — above the
Schroeder frequency the transfer function is a sum of overlapping modes with essentially random
relative phases (Mašović §5.2.3: *"the modal density is high and many (mutually incoherent) modes
overlap with different phases… they sum energetically"*). MFSK ignores all three. The cost is ~1–3 dB
of E_b/N₀ versus coherent detection, plus the factor-2 tone-density penalty. **Against a channel
where a phase reference costs a 108-tap adaptive equaliser and a PLL, that is the cheapest trade in
the whole design.** **[UNVERIFIED]**: no free primary URL found for the 1–3 dB and factor-2 figures;
they are standard textbook results (Proakis).

### 2.6 Rate versus robustness, in measured numbers

The primary reference:

> **Putz, Fortmann, Frank, Haugwitz, Kupnik & Hollick, "Evaluating Acoustic Data Transmission
> Schemes for Ad-Hoc Communication Between Nearby Smart Devices", ACM Transactions on Internet of
> Things 7(1), Article 8, February 2026.** <https://doi.org/10.1145/3779439> ·
> preprint <https://arxiv.org/abs/2602.02249> · HTML <https://arxiv.org/html/2602.02249v1> ·
> replication package (CC-BY-4.0, 11,900 WAV recordings) <https://zenodo.org/records/17661991>
> (DOI 10.5281/zenodo.17661991).

Abstract, in part: *"We systematically reviewed 31 acoustic communication studies for commodity
devices and found that **none provided accessible source code** … Our results show that many
existing schemes face challenges in practical usage, largely due to **severe multipath propagation
indoors** and varying audio characteristics across device models."*

**Setup**: five phones (Pixel 4a, Pixel 6 Pro, Nexus 6P, Oppo Reno 6, Galaxy S20 Ultra); default
transmitter Pixel 4a at volume 19/25, chosen for *"a good trade-off between high volume and low
distortions due to amplifier and speaker non-linearities"*; distances 5 cm–40 m; anechoic chamber
**27.65 dB SPL**, quiet office **53.60 dB SPL**, lecture room **60.01 dB SPL**; ≥20 repetitions per
scheme; **>11,900 transmissions**; messages sized for ≈5 s of air time. TER is measured after error
correction, and *"If the receiver returns an error (e.g., from synchronization failures) instead of
data, we treat the transmission as having a 100% TER."*

**Their scheme table** (Table 2; throughput footnoted as *"the net data rate … after error correction
from the user's perspective"*; the Near/Medium/Far ticks are *claimed* suitability, not their
measurement):

| Scheme | Modulation | Band | Net rate | Near ≤10 cm | Med ≤1 m | Far >1 m |
|---|---|---|---|---|---|---|
| Lee et al. 2015 | Chirp BOK | 19.5–22 kHz | 15 bps | ✗ | ✗ | ✓ |
| Digital Voices (Lopes & Aguiar 2001) | MFSK | **1–3 kHz** | 80 bps | ✗ | ✓ | – |
| Nearby (Getreuer et al. 2018) | DSSS + MFSK | 18.5–20 kHz | 84 bps | ✗ | ✓ | ✓ |
| **ggwave audible** | MFSK | **1.8–6.3 kHz** | 268 bps | ✗ | ✓ | – |
| **ggwave inaudible** | MFSK | 15–19.5 kHz | 268 bps | ✗ | ✓ | – |
| HRCSS (Cai et al. 2022) | OCSS | 18–22 kHz | 500 bps | ✓ | ✓ | ✓ |
| Gonçalves et al. 2017 | OFDM + QPSK | 0.1–4 kHz | 600 bps | ✓ | ✗ | ✗ |
| PriWhisper (Zhang et al. 2014) | MFSK | 9–17 kHz | 729 bps | ✓ | ✗ | ✗ |

HRCSS was **excluded from testing** — it produced *"extremely high TER, which was unexpected"* even
under ideal laboratory conditions (§2.5).

**Results, verbatim:**

- Ideal conditions, professional equipment: Lee et al., Digital Voices, Nearby, PriWhisper and both
  ggwave variants *"achieved a perfect 0% TER"*.
- Anechoic chamber: *"Both ggwave schemes performed nearly perfectly, with slight exceptions at 2 m
  and 5 m."*
- **Office: "The inaudible ggwave variant remained effective up to 20 m, whereas the audible variant
  only worked up to 1 m before failing to decode."**
- ggwave audible under café/train-station/marketplace field recordings: *"affected by ambient noise,
  which made it completely unusable, likely because the ambient noise interfered with the
  transmission bandwidth."*
- Gonçalves OFDM: ~0.5 % TER at 0.2 m office, collapsing past 1 m; its own authors reported *"bit
  error rates of approximately 3% at 10 cm and 25% at 100 cm."*
- PriWhisper (2 ms symbols): *"deteriorated notably beyond 20 cm."*
- Lee et al. chirp: *"maintained a zero error rate across all tested distances"* anechoic;
  *"performed exceptionally across all distances, with only a minor outlier at 5 m"* in the office;
  >98 % packet success at 10, 20 and 40 m; robust across all 21 device pairs.
- Devices: *"the Pixel 6 Pro as the transmitter consistently resulted in the lowest error rates"*;
  *"a large diversity in device characteristics … complicates the generalization of some schemes"*;
  **up to 30 dB SPL spread between phones at the same volume index**; nonlinear distortion above
  ~75 % volume.
- The field generally: *"Commercial products for acoustic data transmission on smart devices
  typically achieve only 10–100 bps… and occasionally up to 200 bps… prioritizing robustness and
  reliability in noisy environments. In contrast, researchers often report much higher throughput up
  to 500–10 000 bps."*

**[UNVERIFIED]**: per-distance TER values exist **only in Figure 5**; the prose gives no numeric TER
for ggwave beyond the statements above, and the paper offers **no explanation** for the audible
variant's degradation.

**Second-best measured curve — Dolphin** (MobiCom'16), 8–20 kHz OFDM, 60 subcarriers, 100 ms symbol +
10 ms CP, chirp preamble, two-level RS + inter-symbol erasure coding. **Transmitter was a HiVi
M200MKIII loudspeaker at 80 dB SPL @1 m**, receiver a Galaxy Note4, corridor. **[measured]** goodput
after error correction:

| distance | goodput |
|---|---|
| 0–1 m | 261.3 bps |
| 1–2 m | 209.1 bps |
| **2–3 m** | **156.8 bps** |
| 3–4 m | 104.5 bps |
| 4–6 m | 52.3 bps |

**Caveat: a real loudspeaker, not a phone speaker, and mostly above your band.** Still the cleanest
published rate-vs-distance curve overlapping your range.

**Other baselines.** Tabak et al. (EUSIPCO 2021, laptops, 18–20 kHz QPSK with a full DFE+PLL):
BER < 2e-4 at 0.5 m and 2 m, but **BER ≈ 0.1 at 5 m** — even heavy coherent processing falls off a
cliff just past your range. ChirpCast (<https://arxiv.org/abs/1508.07099>): 200 bps at ≥90 % accuracy
at 2 m using DPSK above 18 kHz, while its FSK variant managed only 4 bps at >90 % at 1 m.

**The defensible design range for your case** — audible 1–8 kHz, phone→phone, 1–3 m, ordinary room:

- **Safe: 8–16 B/s (64–128 bps)** — ggwave's own stated audible envelope, squarely inside the
  10–100 bps band where every commercial system operates.
- **Stretch: 20–35 B/s (160–280 bps)** — achievable at 1 m in a quiet room; **not demonstrated at
  3 m by anyone.**
- **Above ~40 B/s (320 bps)**: every published audible-band system measured >1 % TER at ≥1 m. Wall.

**[derived] first-principles sanity check**: 1–8 kHz at 46.875 Hz spacing → 149 slots; six
simultaneous 16-ary groups = 24 bits/frame; frame period 100 ms (≈3σ_τ, the empirically survivable
value) → 240 bps gross; take 35–50 % for RS + preamble + guard → **120–160 bps net = 15–20 B/s.**
Independent of the literature, same answer.

**The honest warning.** **No source demonstrates a robust audible-band phone-to-phone link at 3 m in
a furnished room.** The one systematic study measured the audible configuration failing beyond 1 m in
an office while the *same codec* at 15–19.5 kHz reached 20 m — and near-perfectly to 5 m in an
anechoic chamber. That combination isolates the causes to **(i) room multipath and (ii) ambient noise
concentrated in the audible band**, not path loss. Contributing factors, each separately supported:
ambient noise lives in your band (53.6 dB SPL office; "completely unusable" under field recordings);
RT₆₀ and hence σ_τ are *higher* at the bottom of your band (§2.3); phone speakers vary by up to 30 dB
between models; and audibility caps your transmit level in a way 19 kHz does not.

### 2.7 The single most important caveat about that result

**The Putz measurement almost certainly used ggwave's *least* robust profile.** The paper never
states which — I searched the full text, tables and footnotes **[UNVERIFIED as stated by the
authors]**. But the arithmetic pins it **[derived]**:

- ggwave raw on-air rates: Normal 125 bps, Fast 187.5 bps, **Fastest 375 bps**.
- Their throughput column is explicitly the **net** rate after error correction.
- At the maximum variable payload of 140 bytes ggwave spends 56 ECC bytes → net/raw = 140/196.
- **375 × 140/196 = 267.86 ≈ 268 bps** — exactly their figure, for both the audible and inaudible
  rows. Normal gives 89.3 bps net, Fast 133.9 bps. Neither matches.

`AUDIBLE_FASTEST` uses **64 ms symbols = 2.2·σ_τ** — below even the aggressive 5σ_τ limit (§2.3).
`AUDIBLE_NORMAL` uses **192 ms = 6.6·σ_τ**, inside the safe band. **Nobody has published a
measurement of `AUDIBLE_NORMAL` at 1–3 m in an ordinary room.** That gap, and the fact that theory
says the answer might be different, is the reason your harness is worth building.

---

## 3. Browser audio-chain traps

The practical payoff. Most of §3.1 comes from reading Chromium source directly, because the
documentation does not answer the question.

### 3.1 getUserMedia constraints — what Chrome on Android actually does

**The spec is deliberately soft.** <https://www.w3.org/TR/mediacapture-streams/> defines
`noiseSuppression` and `autoGainControl` with the same rationale — *"There are cases where it is not
needed and it is desirable to turn it off **so that the audio is not altered**"* — and
`echoCancellation` as *"remove sound being played from the input signals recorded by the
microphones."* **There is no normative "the UA MUST NOT apply processing when this is false."** These
are best-effort constrainable properties. The Editor's Draft extends `echoCancellation` to
`boolean or DOMString` with `EchoCancellationModeEnum { "all", "remote-only" }`
(<https://w3c.github.io/mediacapture-main/getusermedia.html>); Chrome tracks this as
**echoCancellationMode**, milestone **141**, desktop/Android/WebView
(<https://chromestatus.com/feature/5585747985563648>,
<https://developer.chrome.com/release-notes/141>).

**`getSupportedConstraints()` is worthless as a capability probe.** Chromium's implementation
([`media_devices.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_devices.cc))
**[source]**:

```cpp
MediaTrackSupportedConstraints* MediaDevices::getSupportedConstraints() const {
  return MediaTrackSupportedConstraints::Create();
}
```

**No device probing whatsoever** — a default-constructed dictionary. MDN agrees: every Boolean
property is `true` because unsupported ones are simply omitted. Likewise `getSettings()` reflects
what Chrome *decided*, not what the hardware did
([`media_stream_track_impl.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_stream_track_impl.cc)).

**The full chain for `echoCancellation: false` on Android — traced through Chromium source. It is
better than folklore suggests, with a sting at the end.**

1. **Constraint resolution.**
   [`media_stream_constraints_util_audio.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_stream_constraints_util_audio.cc):
   *"Audio-processing properties are disabled by default for content capture, or if the
   |echo_cancellation| constraint is false."* So `echoCancellation: false` alone already flips the
   **defaults** of the other two. An `exact: false` request **can** legitimately fail with
   `OverconstrainedError`.
2. **Effects-mask computation.**
   [`media_stream_audio_processing_layout.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_stream_audio_processing_layout.cc)
   **[source]**:
   ```cpp
   enabled_platform_effects &= ~media::AudioParameters::ECHO_CANCELLER;
   enabled_platform_effects &= ~media::AudioParameters::AUTOMATIC_GAIN_CONTROL;
   ```
   plus a special case clearing `NOISE_SUPPRESSION` on non-Windows/non-ChromeOS platforms — **on
   Android all three platform bits get cleared.** (Windows/ChromeOS are the restricted ones: *"On
   Windows can only disable platform NS and AGC effects if platform AEC effect is disabled."*)
3. **The mask is written back onto the device.**
   [`processed_local_audio_source.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/processed_local_audio_source.cc)
   sets `modified_device.input.set_effects(processing_layout_.platform_effects())`.
4. **Android's audio manager reads it.**
   [`audio_manager_android.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/audio_manager_android.cc)
   **[source]**:
   ```cpp
   // By default, the audio manager for Android creates streams intended for
   // real-time VoIP sessions and therefore sets the audio mode to
   // MODE_IN_COMMUNICATION. However, the user might have asked for a special
   // mode where all audio input processing is disabled, and if that is the case
   // we avoid changing the mode.
   if (params.effects() != AudioParameters::NO_EFFECTS) {
     communication_mode_is_on_ = true;
     GetJniDelegate().SetCommunicationAudioModeOn(true);
   }
   ```
5. **The Android input preset — the answer to the question.**
   [`aaudio_stream_wrapper.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/aaudio_stream_wrapper.cc)
   **[source]**, verbatim:
   ```cpp
   // Set AAUDIO_INPUT_PRESET_VOICE_COMMUNICATION when we need echo
   // cancellation. Otherwise, we use AAUDIO_INPUT_PRESET_CAMCORDER instead
   // of the platform default of AAUDIO_INPUT_PRESET_VOICE_RECOGNITION, since
   // it supposedly uses a wideband signal.
   //
   // We do not use AAUDIO_INPUT_PRESET_UNPROCESSED, even if
   // `params_.effects() == AudioParameters::NO_EFFECTS` because the lack of
   // automatic gain control results in quiet, sometimes silent, streams.
   AAudioStreamBuilder_setInputPreset(
       builder, params_.effects() & AudioParameters::ECHO_CANCELLER
       ? AAUDIO_INPUT_PRESET_VOICE_COMMUNICATION
       : AAUDIO_INPUT_PRESET_CAMCORDER);
   ```
   The legacy OpenSL ES path does the same
   ([`opensles_input.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/opensles_input.cc):
   `SL_ANDROID_RECORDING_PRESET_CAMCORDER` when effects are off), so the conclusion is
   path-independent. AAudio is the default today (`kUseAAudioDriver`, `kUseAAudioInput`,
   `kAAudioPerStreamDeviceSelection` all `FEATURE_ENABLED_BY_DEFAULT`,
   [`audio_features.cc`](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/media/audio/audio_features.cc)).

**So Chrome on Android switches between exactly two Android input presets — `VOICE_COMMUNICATION`
(effects on) and `CAMCORDER` (effects off). It never uses `MIC`, never `VOICE_RECOGNITION`, and
explicitly never `UNPROCESSED`.**

**The sting: `CAMCORDER` is not raw.** Android's own reference pre-processing config applies **AGC**
to the camcorder stream
(<https://source.android.com/docs/core/audio/implement-pre-processing>):

```xml
<stream type="voice_communication">  <apply effect="aec"/>  <apply effect="ns"/>  </stream>
<stream type="camcorder">            <apply effect="agc"/>                        </stream>
```

and per-source defaults live in vendor-specific `/vendor/etc/audio_effects.xml`. The one source the
Android CDD *guarantees* clean is `VOICE_RECOGNITION` — devices *"MUST disable any noise reduction
audio processing"* and *"MUST disable any automatic gain control"*
(<https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/main/5_multimedia/5_4_audio-recording.md>)
— and the only one with a documented flatness requirement is `UNPROCESSED`. **Chrome uses neither.**

**That is the real Android trap**, and it is not "the hardware AEC can't be turned off". It is:
**Chrome does its part correctly, and then hands you a source whose remaining processing is
vendor-configurable and undocumented.**

Corrections to common folklore, verified: there is **no symbol `kAndroidAcousticEchoCanceler`** in
current Chromium; the actual symbol is `AudioManagerAndroid::AcousticEchoCancelerIsAvailable()`,
which only reports *availability*, with no device blacklist and no comment claiming the platform AEC
is unswitchable. Chrome's published docs on native AEC/NS
(<https://developer.chrome.com/blog/more-native-echo-cancellation>,
<https://developer.chrome.com/blog/disabling-hardware-noise-suppression>) cover **macOS and Windows
only and never mention Android**. **[UNVERIFIED]**: `issues.chromium.org` is sign-in-gated for
automated fetches; issue
[327472528](https://issues.chromium.org/issues/327472528) ("Microphone echoCancellation and
noiseSuppression cannot be disabled via media constraints") is per search metadata resolved
**Won't Fix (Intended Behavior)** with the reported cause being **malformed constraints — the
properties must be nested inside the `audio:` dictionary**. That is metadata, not the issue body.

**The software APM, and why it is lethal above 8 kHz.** With all three false the WebRTC APM is
bypassed entirely ([`media/webrtc/helpers.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/webrtc/helpers.cc):
`if (!settings.NeedWebrtcAudioProcessing()) { return {nullptr, base::TimeDelta()}; }`). When it *is*
on, three things happen **[source]**:

1. **The track is forced to 48 kHz mono** — the sample-rate container becomes
   `webrtc::AudioProcessing::kSampleRate48kHz`
   ([`media/webrtc/constants.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/webrtc/constants.cc)).
2. **The APM splits into three bands** — `kBand0To8kHz`, `kBand8To16kHz`, `kBand16To24kHz`
   ([webrtc `audio_buffer.h`](https://webrtc.googlesource.com/src/+/main/modules/audio_processing/audio_buffer.h)).
3. **Your high-band tone has no say in its own fate.** AEC3 applies a *scalar* `high_bands_gain` to
   the upper bands derived from the low-band analysis
   ([`aec3/echo_remover.cc`](https://webrtc.googlesource.com/src/+/main/modules/audio_processing/aec3/echo_remover.cc)),
   and the noise suppressor's `ComputeUpperBandsGain()` averages speech probability and filter gain
   from **the lowest band's final 32 bins** and applies it to everything above 8 kHz
   ([`ns/noise_suppressor.cc`](https://webrtc.googlesource.com/src/+/main/modules/audio_processing/ns/noise_suppressor.cc)).

**With processing on, a 19 kHz carrier is multiplied by a gain computed from speech activity below
8 kHz — it will be gated on and off by whether someone is talking in the room.** That is not a
channel you can build a protocol on, and it applies directly to your ultrasonic control arm.

Also note Android's software AGC is **not** the desktop one — `helpers.cc` **[source]**:
`gain_controller1.enabled = false; gain_controller2.enabled = true;
gain_controller2.fixed_digital.gain_db = 6.0f; adaptive_digital.enabled = false;` — **a fixed +6 dB
digital gain, not adaptive.** And `autoGainControl: false` is honoured exactly at the Chrome layer
(`if (!settings.automatic_gain_control) { … return; }`). `voiceIsolation` is ChromeOS-only
(the whole block is `#if BUILDFLAG(IS_CHROMEOS)`) — irrelevant on Android.

**Practical recipe.**

```js
navigator.mediaDevices.getUserMedia({ audio: {
  echoCancellation: false, noiseSuppression: false, autoGainControl: false
}})
```

Nest them inside `audio:` — that is the 327472528 failure mode. This gets you: no
`MODE_IN_COMMUNICATION`, `AAUDIO_INPUT_PRESET_CAMCORDER`, no WebRTC APM, device-native sample rate.
It does **not** guarantee a transparent vendor HAL. **Verify on real hardware with a swept sine;
there is no API that will tell you.** Specifically, the harness should:

1. Read back `track.getSettings()` for all three flags and display them.
2. Probe once with `{ exact: false }` to convert a silent refusal into a loud `OverconstrainedError`
   — then use the ideal form for the actual run so a lying device still yields data.
3. Transmit a known steady tone and log received bin energy over time. AGC shows as a slow envelope;
   noise suppression as the tone decaying after ~1 s of steady state; AEC as level-dependent gating.
4. Also worth one arm: `echoCancellation: "remote-only"` (Chrome 141+). With no
   `RTCPeerConnection` in the page it should mean "cancel nothing". **[UNVERIFIED]** on Android.

### 3.2 Secure context and permissions

- `MediaDevices` is `[SecureContext]` at the **interface** level, so `getUserMedia`,
  `enumerateDevices` and `getSupportedConstraints` are all gated
  (<https://w3c.github.io/mediacapture-main/getusermedia.html>; Chromium's
  [`media_devices.idl`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/media_devices.idl)
  matches). In insecure contexts `navigator.mediaDevices` is simply `undefined`.
- Potentially-trustworthy origins: `https`/`wss`, `127.0.0.0/8`, `::1/128`, `localhost`, `file`
  (<https://w3c.github.io/webappsec-secure-contexts/>).
- **GitHub Pages satisfies it**: *"GitHub Pages sites created after June 15, 2016, and using
  `github.io` domains are served over HTTPS automatically"*
  (<https://docs.github.com/en/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https>).
  With a custom domain, enable **Enforce HTTPS**. I also verified a Pages user site sends **no
  `Content-Security-Policy` and no `Permissions-Policy` header** **[derived]**, so neither microphone
  access nor a `blob:` worklet module is blocked by platform policy.
- Permission must be granted per origin, and *"Only a window's top-level document context for a valid
  origin can even request permission"* unless Permissions Policy delegates to an iframe. **Don't run
  the harness in an iframe.**
- **Android permission persistence is uncertain.** One-time permissions rolled out from Chrome 116
  and the Chrome blog is desktop-first: *"will initially be available on desktop for … geolocation,
  camera, and microphone"*, with *"Permission prompts for other capabilities and on the mobile web
  are unchanged for now"* (<https://developer.chrome.com/blog/one-time-permissions>). Google's Android
  help pages do describe "Allow this time" on Android. **[UNVERIFIED]** — treat mic permission on
  Android Chrome as **possibly per-visit**, and don't use the `prompt` state as a first-time-user
  signal (Chrome's own advice).
- **A trap no API surfaces: Android will not let two apps capture audio at once.** *"When two apps
  are capturing concurrently, only one app receives audio and the other gets silence"*, and *"Apps
  with visible foreground UIs have higher priority than background apps"*
  (<https://developer.android.com/media/platform/sharing-audio-input>). If Chrome is backgrounded or
  another app grabs the mic, **your receiver gets digital silence, not an error.** The harness needs
  a liveness check that distinguishes "silence" from "no carrier" — e.g. verifying the input RMS is
  above a plausible noise floor before declaring a failed transfer.

### 3.3 Autoplay and the user gesture — Android *is* stricter

Web Audio spec (<https://www.w3.org/TR/webaudio/>): an `AudioContext` is *"allowed to start"* only
when the relevant global object has **sticky activation**; `"suspended"` means *"context time is not
proceeding, audio hardware may be powered down/released."*

Chrome's policy (<https://developer.chrome.com/blog/autoplay>): *"If an `AudioContext` is created
before the document receives a user gesture, it will be created in the 'suspended' state, and you
will need to call `resume()` after the user gesture."* The three unlock paths are muted autoplay,
user interaction with the domain, **or the Media Engagement Index — and the MEI applies only on
desktop.**

**That is the concrete Android difference: there is no "this user watches a lot of media here" escape
hatch.** A tap (or PWA install / add-to-home-screen) is effectively mandatory before your first tone.
**[UNVERIFIED]**: whether the `getUserMedia` grant itself counts as an activation. Do not rely on it
— put `getUserMedia()` and `ctx.resume()` behind the same explicit tap, on **both** ends.

### 3.4 Sample rates and the practical upper frequency

**Traced in Chromium source [source]:**

- **Output default**: Java `mAudioManager.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE)`
  **with a fallback to 44.1 kHz**
  ([`AudioManagerAndroid.java`](https://chromium.googlesource.com/chromium/src/+/main/media/base/android/java/src/org/chromium/media/AudioManagerAndroid.java)).
  **So yes — Android Chrome genuinely reports 44100 on some devices and 48000 on others.** The newer
  path uses `SelectSampleRate()` with `kDefaultTargetSampleRate = 48000`, picking the closest
  supported rate.
- **Input**: the legacy path derives it from `GetNativeOutputSampleRate()` — **input rate follows the
  native *output* rate**. With per-stream device selection (default on) it targets 48000 among the
  device's supported rates. Input is **mono** by default.
- **Yes, input and output can differ, and there is resampling at every seam**: the APM forces 48 kHz
  when on; the track→AudioContext bridge builds a `media::AudioConverter` that *"resamples from
  source_params_.sample_rate() to sink_params_.sample_rate() and rebuffers"*
  ([`webaudio_media_stream_audio_sink.cc`](https://chromium.googlesource.com/chromium/src/+/main/third_party/blink/renderer/modules/mediastream/webaudio_media_stream_audio_sink.cc));
  and the spec **requires** output resampling — *"The user agent must resample audio output to match
  the output device's sample rate if they differ"*, noting the latency cost. **So
  `new AudioContext({sampleRate: 48000})` is honoured on Android, via resampling, at a latency
  cost.**
- **The practical Nyquist number.** Chromium's resampler deliberately pulls its cutoff below Nyquist
  ([`media/base/sinc_resampler.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/base/sinc_resampler.cc)):
  *"we should adjust the low pass filter cutoff slightly downward to avoid some aliasing at the very
  high-end"* — `sinc_scale_factor *= 0.92` (max kernel) else `*= 0.90`. **[derived]**
  - 44.1 kHz leg → usable to ≈ **19.8–20.3 kHz**
  - 48 kHz leg → usable to ≈ **21.6–22.1 kHz**
  - **A 19 kHz carrier survives a 48↔44.1 resample; a 21 kHz carrier may not.** Applies again at each
    stage. ggwave's `[U]` band tops out at 19,453 Hz — just inside, which is fortunate rather than
    designed.
- **Android's compatibility floor essentially stops caring above 7 kHz.** Even the `UNPROCESSED`
  source is only required to be within **±30 dB from 7000 Hz to 22 kHz** (mid-band ±10 dB from
  100 Hz–7 kHz)
  (<https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/main/5_multimedia/5_11_unprocessed-audio.md>).
  **A conforming Android device may be 30 dB down at 19 kHz and still be conforming.** For
  `VOICE_RECOGNITION` the recommended flatness is only *"±3 dB, from 100 Hz to 4000 Hz"*. **This is a
  real argument in favour of the audible band** — it is the only region with any compatibility
  guarantee at all.
- **[UNVERIFIED]**: no documented low-pass in the Android HAL capture path below the browser was
  found. The WebRTC APM does not discard 16–24 kHz, but it does gate it (§3.1).

### 3.5 AudioWorklet versus ScriptProcessorNode

**As of August 2026 ScriptProcessorNode still works in Chrome, desktop and Android. Libraries built
on it are deprecated, not broken.**

- The Web Audio spec keeps `ScriptProcessorNode` in the **main body (§1.29)**, not a legacy appendix,
  with the deprecation stated inline: *"This method is DEPRECATED, as it is intended to be replaced
  by AudioWorkletNode"* (<https://www.w3.org/TR/webaudio/>).
- **chromestatus has no deprecation or removal entry for ScriptProcessorNode** — a query returns only
  the AudioWorklet shipping entry (*"designed to replace ScriptProcessorNode"*, **Shipped, Chrome 66
  on desktop, Android and WebView**, origin trial 64–65)
  (<https://developer.chrome.com/blog/audio-worklet>). MDN browser-compat-data records no
  `version_removed` for Chrome.
- **[UNVERIFIED]**: `issues.chromium.org` could not be read directly, so "no removal milestone" means
  *not found*, not *proven absent*.

**Build on AudioWorklet anyway.** ScriptProcessorNode runs on the main thread, so page layout, GC and
your own measurement logging inject glitches straight into the demodulator — fatal for a
symbol-timing-sensitive protocol, and your harness will be doing UI work while receiving.

**The render-quantum mismatch is the one real integration detail.** `process()` is called with the
render quantum, default **128 frames**, while ggwave wants 1024 (`kDefaultSamplesPerFrame`).
Accumulate 8 quanta into a `Float32Array(1024)` — or 2048, as the Cipherbrick worklet does — and hand
that over; `decode()` loops internally (§1.2.7), so either works.

**Web Audio 1.1 adds `renderSizeHint`** to `AudioContextOptions` (explicit integer clamped 1–8192,
`"default"` = 128, or `"hardware"`), with a `renderQuantumSize` attribute to read back
(<https://www.w3.org/TR/webaudio-1.1/>). Chrome 145 (stable **2026-02-10**) lists it under **origin
trials**, i.e. not on by default at that version (<https://developer.chrome.com/release-notes/145>).
**[UNVERIFIED]**: whether it shipped default-on by 2026-08 — the Chromium issue
(<https://issues.chromium.org/issues/40637820>) requires sign-in. It is also explicitly *"a hint that
might not be honored"*. **Feature-detect `renderQuantumSize` and fall back to accumulating.**

**`blob:` module URLs work for a single-file page.** A worklet module URL *"must be same-origin with
the caller's document, or a `blob:` or `data:` URL"*
(<https://developer.mozilla.org/en-US/docs/Web/API/Worklet/addModule>), and a blob-sourced worker
script inherits the creating document's CSP. Since Pages sets no CSP (§3.2), a
`URL.createObjectURL(new Blob([...], {type:'text/javascript'}))` worklet keeps the deliverable a
genuinely single file. **[UNVERIFIED]**: the normative `addModule()` text could not be extracted from
the spec — this rests on MDN. Also **[UNVERIFIED]**: what Chrome Android does to an AudioContext when
the tab backgrounds or the screen locks — test it, because a phone that sleeps mid-transfer is a
realistic user action.

### 3.6 Half-duplex reality and the ACK

**Both ggwave's demo and the library itself assume it** (§1.2.7, §1.2.8) **[source]** — that is the
strongest evidence it is real rather than theoretical.

**What the browser gives you.** AEC needs a *reference* signal, so it can only cancel what the
browser itself renders. Chromium models exactly that: `bool use_loopback_aec_reference = false;` set
via `echo_canceller.NeedSystemLoopback()`
([`media/base/audio_processing.h`](https://chromium.googlesource.com/chromium/src/+/main/media/base/audio_processing.h))
**[source]**. **[UNVERIFIED]**: there is a long-standing tracker entry
[40504498 "AEC when using Web Audio API"](https://issues.chromium.org/issues/40504498) whose
historical substance — surfaced only via search metadata — is that Chrome's AEC did **not** cancel
Web Audio output (only media elements), with a community workaround of routing WebAudio through an
`RTCPeerConnection`. Current Android state unknown. **Do not design assuming AEC will clean up after
you.**

**With AEC off, nothing removes anything.** Your speaker is centimetres from your mic; the peer at
1–3 m arrives tens of dB weaker. During your own transmission your receiver sees mostly itself.
*(Engineering reasoning, flagged as such.)*

**Three Android-specific consequences that were verified and that shape the protocol:**

1. **Turning AEC on changes your *output* path too.** With `communication_mode_is_on_`, output
   streams are created as `AAUDIO_USAGE_VOICE_COMMUNICATION` instead of `AAUDIO_USAGE_MEDIA`
   ([`audio_manager_android.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/audio_manager_android.cc))
   **[source]**, and Android usage *"controls routing, focus, and volume decisions"*
   (<https://source.android.com/docs/core/audio/attributes>). **Inference, flagged:** on stock routing
   that can put your tone on the **earpiece at call volume** instead of the loudspeaker at media
   volume. Chrome even saves and restores the speakerphone flag around communication mode.
   **With `echoCancellation: false` the question disappears — Chrome never enters communication
   mode.** This is a second, independent reason to disable AEC.
2. **Stream creation order matters.** Existing output streams are not recreated when the mode flips
   (there is an explicit *"Avoid changing the communication mode if there are existing input
   streams"* guard), so an AudioContext created *before* `getUserMedia` keeps `USAGE_MEDIA`.
3. **Your turnaround budget, from the CDD**
   (<https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/main/5_multimedia/5_6_audio-latency.md>):
   cold output and cold input latency **MUST** be ≤ **500 ms**; STRONGLY RECOMMENDED ≤ 100 ms cold,
   ≤ 45 ms continuous output, ≤ 30 ms continuous input, ≤ 50 ms continuous round-trip.
   **An ACK protocol must tolerate a half-second first-packet turnaround on a conforming device, and
   ~50 ms steady state.** Chrome exposes `AudioContext.baseLatency`, `outputLatency` and
   `getOutputTimestamp()` returning `{contextTime, performanceTime}` (<https://www.w3.org/TR/webaudio/>)
   — **use `getOutputTimestamp()` to anchor transmit timing, not `currentTime`.**

**Design implications** *(reasoning, not citation)*: keep it strictly turn-taking; gate your own
receiver for the whole of your own transmission plus a settling margin (the room's reverberant tail
from the data frame must decay before the ACK preamble starts — the same delay-spread argument as
§2.3, at frame scale); use separate RX/TX ggwave instances; consider a more robust profile for the
ACK than for the data (a 2-byte fixed-length ACK costs 0.38 s at `Normal`, §1.2.3); and put your own
CRC in the payload so the ACK means "decoded correctly", not "RS returned something". **Never rely on
AEC to let you listen while you talk** — and note from §3.1 that with AEC on, AEC3's scalar high-band
gain would suppress the peer's tone during double-talk anyway.

### 3.7 Bluetooth routes

**Chrome does *not* blindly force SCO when you open a mic** —
[`audio_manager_android.cc`](https://chromium.googlesource.com/chromium/src/+/main/media/audio/android/audio_manager_android.cc)
**[source]**: `IsUsingBluetoothSco()` returns true only if the stream's actual device type is
`kBluetoothSco`; global SCO *"is turned on when this set transitions from empty to non-empty, and
turned off when it transitions back to empty"*, and *"Requests for Bluetooth SCO to be enabled or
disabled. This request may fail."* Chrome models the types distinctly (`kBluetoothSco = 7`,
`kBluetoothA2dp = 8`, `kBleHeadset = 26`, `kBleSpeaker = 27`) and knows they are one physical device:
*"when two outputs of these types coexist, they correspond with the same physical Bluetooth Classic
device, and only one of them will be functional at a given time."*

**Detection and control from the page:**

- **Input enumeration**: with `kAAudioPerStreamDeviceSelection` (default on) individual devices are
  enumerated, so you *can* pick a non-Bluetooth mic by `deviceId`; on older Android you cannot.
- **Output selection is the weak spot**: `GetAudioOutputDeviceNames` carries *"We've only returned
  'default' here for quite some time, relying on output device selection being controlled by input
  device selection."* **On Android, choosing the input device is how you choose the output device.**
- `HTMLMediaElement.setSinkId` is **not available on Chrome Android** (*"Not available due to a
  limitation in Android"*, MDN BCD). `AudioContext.setSinkId` **is** listed as shipped on Chrome
  Android since **M110** (BCD and chromestatus agree) — but given the "default only" enumeration,
  **treat it as present-but-probably-useless and test rather than trust.**
- **The reliable tell**: `getSettings()` populates `sampleRate` when available. **A track whose
  `sampleRate` drops to 8000 or 16000 is a strong indication SCO/HFP took the link.**

**Codec bandwidths.** AOSP's profile page lists A2DP 1.2 with SBC/AAC/aptX/LDAC and HFP 1.6/1.7
(<https://source.android.com/docs/core/connect/bluetooth/services>) but says nothing about SCO
codecs; the AMSCO rearchitecture page gives the negotiation preference order **LC3 hw > LC3 sw >
mSBC hw > mSBC sw > CVSD hw > CVSD sw**
(<https://source.android.com/docs/core/audio/sco-audio-mgmt>). **[UNVERIFIED]**: the standard figures
— CVSD 8 kHz sampling (~4 kHz audio bandwidth), mSBC 16 kHz (~8 kHz), A2DP 44.1/48 kHz — were **not**
confirmed from a primary source in this pass and need a citation before publication.

**Defensive design regardless:** if the link collapses to HFP, everything above ~4 kHz (narrowband)
or ~8 kHz (wideband) is gone — which **destroys ggwave's audible band (1875–6328 Hz) outright on a
CVSD route and annihilates any ultrasonic profile.** A2DP is output-only and carries no microphone.
**The harness should refuse to run, loudly, when the capture `sampleRate` is below 44100**, otherwise
a user with earbuds in records a failure that is not the protocol's fault.

### 3.8 Phone speaker and microphone response

- **Android imposes no speaker frequency-response requirement at all.** CDD 5.5 mandates PCM formats,
  channel configurations, sampling rates (8000/11025/16000/22050/32000/44100/48000 plus 96000
  mono/stereo) and certain effects, but contains **no** speaker frequency-response, output-level or
  built-in-speaker requirement
  (<https://android.googlesource.com/platform/compatibility/cdd/+/refs/heads/main/5_multimedia/5_5_audio-playback.md>).
  **There is no floor to design against.** Putz et al.'s measured **30 dB SPL spread between phones
  at the same volume index** is the empirical consequence.
- The only Google-published frequency numbers here are for **test equipment**: the CTS Verifier
  reference microphone is *"Flat frequency response on range 100 Hz to 20 kHz: +/- 2 dB"*
  (<https://source.android.com/docs/compatibility/cts/audio-framework>).
- On the **microphone** side there is a device-level number, for `UNPROCESSED` only: ±10 dB from
  100 Hz–7000 Hz, ±20 dB 5–100 Hz, **±30 dB 7000 Hz–22 kHz**, SNR ≥ 60 dB, THD < 1 % at 1 kHz/90 dB
  SPL (CDD 5.11). **Chrome does not use `UNPROCESSED` (§3.1), so even this floor does not apply to
  what you receive.**
- Independent measurements report smartphone microphones *"relatively flat (±3 dB) up to
  approximately 15,000 Hz"* with low-frequency emphasis around 85–140 Hz **[secondary — search
  summaries of voice-acoustics literature; I could not open the underlying articles]**.
- On **speakers at the low end**: micro-speaker literature describes usable bandwidth extending over
  roughly the voice range upward, with a lower cutoff *"near 125 Hz, which is the frequency below
  which a speaker produces no output"* **[secondary — micro-speaker patent literature]**.

**Practical conclusion for the band choice**: ggwave's audible floor of **1875 Hz sits comfortably
above where phone speakers give out**, and even the DT/MT floor of 1125 Hz is workable. **Going below
~500 Hz is where a phone speaker stops being a transmitter.** The low end is *not* your binding
constraint — reverberation and ambient noise are.

---

## 4. Verdict

### 4.1 Primary choice: ggwave, master WASM build, audible profiles, fixed-length framing

**There is no serious competition, and it is more useful to say that plainly than to manufacture a
horse race.** ggwave is the only library that is simultaneously maintained (release 2026-03, commit
2026-04), permissively licensed (MIT throughout, no LGPL dependency), send *and* receive in the
browser, single-file with embedded WASM at **148 KB / 59 KB gzipped**, and already operating in your
target band with no retuning. It is the substrate a security research group chose for a real
bidirectional protocol (PairSonic, §1.2.9), and one of only two schemes in the Putz study that hit
0 % TER under ideal conditions *and* generalised across five phone models.

**Configure it like this:**

| Setting | Value | Why |
|---|---|---|
| Build | `bindings/javascript/ggwave.js` from **master**, vendored | npm 0.4.0 lacks the `freqStart` setters and MT protocols (§1.2.6) |
| Framing | **fixed-length** (`payloadLength = N`) | removes 0.683 s of markers + 3-byte header (§1.2.3) |
| Payload | **16 bytes** primary | the only size where the robust profile plus an ACK fits 3 s with turnaround slack (§1.2.3, §3.6) |
| Profile | **`AUDIBLE_NORMAL`** primary, `AUDIBLE_FAST` fallback | 192 ms = 6.6·σ_τ, inside the T_s ≥ 10σ_τ safe band; 128 ms is at the aggressive limit (§2.3) |
| Rx protocols | disable all but the one in use | cuts CPU and false positives (§1.2.7) |
| Instances | separate RX-only and TX-only | half-duplex hygiene (§1.2.7, §3.6) |
| Audio path | **AudioWorklet**, 128→1024 accumulation | SPN is main-thread; your page will be doing UI work (§3.5) |
| Constraints | nested `audio:{}`, all three `false`, **read back via `getSettings()`** | the readback is the measurement; also keeps output on `USAGE_MEDIA` (§3.1, §3.6) |
| Timing | `getOutputTimestamp()`, not `currentTime` | §3.6 |
| Integrity | **your own CRC inside the payload** | ggwave has none; RS can mis-correct (§1.2.1) |
| Guard | abort if capture `sampleRate` < 44100; verify input RMS above noise floor | Bluetooth SCO and Android's silent-capture behaviour (§3.7, §3.2) |

### 4.2 The head-to-head: two ggwave profiles, not two libraries

**The most informative comparison available is not ggwave versus another library — it is
`AUDIBLE_NORMAL` versus `AUDIBLE_FASTEST` at 1–3 m.** The one published measurement used `FASTEST`
(§2.7) and reported failure beyond 1 m; the delay-spread arithmetic says `FASTEST` at 2.2·σ_τ *should*
fail and `NORMAL` at 6.6·σ_τ *might not*; and nobody has published the `NORMAL` result. Your harness
can produce a genuinely new data point in an afternoon, and it decides whether the product concept
works in the audible band.

Four arms, same session, same room, same distances {1, 2, 3 m}:

1. **`AUDIBLE_NORMAL`, freqStart 40** (1875–6328 Hz) — the robustness hypothesis.
2. **`AUDIBLE_FASTEST`, freqStart 40** — reproduces the published failure and validates your harness
   against known literature. If this *doesn't* fail at 2 m, distrust your setup before you distrust
   the paper.
3. **`AUDIBLE_NORMAL`, freqStart 75** (3516–7969 Hz) — same profile, moved up, away from where
   ambient noise is loudest and σ_τ largest, still inside 1–8 kHz (§1.2.6, §2.3).
4. **`ULTRASOUND_NORMAL`** (15,000–19,453 Hz) — **the control you cannot skip.** The literature says
   this is the one that works at your range. If the audible arms fail and this succeeds, you have
   learned the most important thing about your product, cheaply. (Note §3.4: it clears the 44.1 kHz
   resampler cutoff at ~19.8 kHz, but only just.)

### 4.3 If you want a genuine second library: QRtone

**QRtone is the only defensible non-ggwave contender**, and better than its 48 stars suggest:
BSD-3-Clause, a **30 KB** real-WASM core, Reed-Solomon with four levels, a working browser demo with
send *and* receive, and a ladder of **1720–7205 Hz** landing almost exactly on your band. Crucially it
makes a *different* choice on the axis you care about: an explicit **10 ms silent guard interval**
after each 60 ms symbol, where ggwave has only 15 % amplitude ramps (§1.2.2, §1.4). If reverberation
is the enemy, that is the most interesting alternative hypothesis in the landscape.

**Its cost is rate**: ~50 bps ≈ 6.25 B/s → 16 bytes in ~2.6 s one-way, so an acoustic ACK does not
fit in 3 s. Treat it as a **robustness reference** — "does *anything* survive at 3 m in this room?" —
not as a candidate for the shipped protocol.

**Do not spend time on**: quiet-js (abandoned 2021, 838 KB asm.js, mandatory LGPL libfec, five
unfixed receive-failure reports), Chirp (dead), gibberlink (a demo wrapping ggwave), cyrinx (no
browser build; its headline number is measured at ~1 cm), euphony.js (transmit only), or the 2026
hobby-modem cohort.

### 4.4 The one thing I would change about the premise

You have fixed the audible band and made ultrasonic a secondary comparison. **The evidence points the
other way, and it is worth being blunt about it.**

- The only peer-reviewed on-device measurement found ggwave audible failing at 1 m and ggwave
  ultrasonic working at 20 m **in the same office**, with both near-perfect in an anechoic chamber —
  localising the cause to the room (§2.6).
- At 1–3 m you are 5–15 dB *inside* the reverberant field (§2.1).
- RT₆₀ and hence delay spread are **higher at the bottom of your band** than at the top (§2.3), so
  the audible band is the more dispersive part of the channel, not the gentler one.
- Ambient noise lives in your band: the audible variant was *"completely unusable"* under real
  café/station/marketplace recordings (§2.6).
- Audibility caps your transmit level in a way 19 kHz does not, and PAPR already forces back-off
  above ~75 % volume (§2.2).
- Google's Nearby, Lee et al., PairSonic and quiet's flagship profiles all chose inaudible bands.

**The counterweights are real, though, and they are why this is worth measuring rather than
conceding:** the published failure used the *fastest, least robust* profile (§2.7); `NORMAL` has 3×
the symbol duration and lands inside the theoretical safe band; **Android's compatibility floor only
guarantees microphone flatness below 7 kHz — a conforming device may be 30 dB down at 19 kHz** (§3.4);
and with any audio processing left on, a 19 kHz carrier gets gated by speech activity below 8 kHz
(§3.1). The ultrasonic band is not free of traps either — it is just differently trapped.

**So: treat the audible band as the hypothesis under test, with `ULTRASOUND_NORMAL` as a
permanently-enabled control arm rather than an afterthought.** If there is a product reason the band
must be audible — perceptibility as a feature, device-compatibility worries, users who mute output —
write it down now, because the measurement may argue against it and you will want to know what you
are trading.

---

## 5. Practical notes for the harness

- Serve from GitHub Pages (HTTPS ⇒ secure context; no CSP or Permissions-Policy to fight). Not in an
  iframe, not from `file://` copies passed around.
- Gate `AudioContext` creation/resume and `getUserMedia` behind the same tap, on both ends (§3.3).
- **Log and display every run**: `context.sampleRate`, `context.renderQuantumSize` if present,
  `track.getSettings()` (all three processing flags plus `sampleRate`, `latency`, `deviceId`),
  `baseLatency`, `outputLatency`, and the device label. Half the failures you will chase are in this
  list.
- Run the `{exact: false}` constraint probe once at startup and record whether it threw (§3.1).
- Abort loudly on capture `sampleRate` < 44100 (Bluetooth SCO) and on input RMS at the digital-silence
  floor (Android concurrent-capture) (§3.7, §3.2).
- Include a **spectrum view during a known steady-tone transmission** — the fastest way to see AGC
  pumping, noise-suppression gating, or a band ceiling, and the only authoritative answer to §3.1 on
  a given handset.
- Sweep per arm: distance {1, 2, 3 m}, payload {8, 16, 32, 64 B}, profile, freqStart, volume (include
  one arm below 75 % to test the distortion claim). Record success/failure **per attempt** plus
  time-to-success, not just aggregates.
- Test **both directions of every device pair** — Putz et al. found transmitter identity matters more
  than receiver identity.
- **Consider measuring your own room impulse response** with a swept sine. It would replace three of
  the estimates in §2.3 with one measurement and is a couple of hours of work.

---

## 6. Full source list for the empirical claims

- Putz, Fortmann, Frank, Haugwitz, Kupnik, Hollick, ACM TIoT 7(1) Art. 8, Feb 2026 —
  <https://doi.org/10.1145/3779439>, <https://arxiv.org/abs/2602.02249>,
  data <https://zenodo.org/records/17661991>
- Wang, Zhang, Chen, Li, Ren, Su ("Dolphin"), MobiCom'16 — <https://doi.org/10.1145/2973750.2973765>
- Getreuer, Gnegy, Lyon, Saurous ("Nearby"), IEEE TMM 20(6), 2018 — DOI 10.1109/TMM.2017.2766049
- Tabak, Lin, Singer, EUSIPCO 2021 — <https://arxiv.org/abs/2103.11261>
- Schmalenstroeer, Gburrek, Haeb-Umbach ("LibriWASN"), 2023 — <https://arxiv.org/abs/2308.10682>
- Mašović, *Room Acoustics* — <https://arxiv.org/abs/2111.01900>
- Otnes et al., *Underwater Acoustic Networking Techniques* —
  <https://signet.dei.unipd.it/underwater/media/download/378>
- RFC 6330 / RFC 5053 — <https://www.rfc-editor.org/rfc/rfc6330>,
  <https://www.rfc-editor.org/rfc/rfc5053>; IPR <https://datatracker.ietf.org/ipr/2554/>
- MIT 6.02 Ch. 6 — <https://web.mit.edu/6.02/www/f2011/handouts/6.pdf>
- Chromium source — `chromium.googlesource.com/chromium/src/+/main/` paths cited inline in §3
- Android CDD — `android.googlesource.com/platform/compatibility/cdd/` sections 5.4, 5.5, 5.6, 5.11
- ggwave source — <https://github.com/ggerganov/ggwave>

---

## 7. Everything that could not be verified

Collected so none of it is mistaken for established fact.

**Browser / Android**

1. **What the OEM HAL does on the `CAMCORDER` path.** Chromium demonstrably clears the platform
   effect bits and selects `AAUDIO_INPUT_PRESET_CAMCORDER`, but AOSP's *own reference config* applies
   AGC to that stream and per-source defaults are vendor-specific. No source — Chromium, AOSP or
   Chrome docs — guarantees a clean capture path on Android. **Only measurement on real hardware
   settles it.**
2. **`issues.chromium.org` and `issues.webrtc.org` are sign-in-gated for automated fetching.** Every
   bug reference (327472528, 40504498, 40637820, 41276355) rests on search metadata or MDN BCD notes,
   not on the issue body. Re-check anything load-bearing by hand.
3. **Whether Chrome Android honours `echoCancellation: "remote-only"`** and whether it disengages
   platform processing.
4. **Whether `renderSizeHint` shipped default-on by 2026-08** (origin trial in Chrome 145).
5. **AudioWorklet on Android specifics**: `addModule()` with `blob:` URLs verified only via MDN, not
   the normative spec text; behaviour on tab backgrounding / screen lock untested.
6. **Whether a `getUserMedia` grant counts as activation for AudioContext.**
7. **Android microphone-permission persistence** — one-time permissions are documented desktop-first
   but Android help pages describe them; could not reconcile into a firm milestone.
8. **Bluetooth HFP codec bandwidths** (CVSD ~4 kHz, mSBC ~8 kHz audio bandwidth) — the Chromium
   routing logic is verified, these numbers are not, and need a primary citation before publication.
9. **Any documented low-pass in the Android HAL capture path** below the browser.
10. **Smartphone speaker/microphone response figures** in §3.8 come from search summaries and patent
    text, not articles I could open.

**Acoustics / theory**

11. **No in-air, audible-band, phone-to-phone measurement at 3 m exists** in the literature found.
    The 1–3 m audible regime is extrapolated from 0.2–1 m measurements plus anechoic data.
12. **No measured RMS delay spread for an in-air room channel in 1–8 kHz.** Everything is "tens of
    milliseconds" asserted, one 70 ms figure at 5 m, or derivation from RT₆₀.
13. **Measured octave-band RT₆₀ figures are [secondary]** — the Applied Acoustics and Bradley papers
    could not be opened; ISO 3382-1/-2 text not read directly (iso.org blocks automated fetch).
14. **Schroeder's 6.7/T₆₀ maxima-spacing constant is [secondary]**; some sources give 4/T₆₀.
15. **ISO 9613-1 atmospheric absorption coefficients** could not be retrieved from a free primary
    source, so the "less reverb at ultrasonic frequencies" mechanism is unquantified here.
16. **The 1–3 dB non-coherent penalty and the factor-2 tone-density penalty** have no free primary
    URL; they are standard textbook results (Proakis).
17. **No primary benchmark of RS / Viterbi / LDPC decoding in a browser or WASM setting.**
18. **RFC 5053 (R10 Raptor) IPR status** — no declaration located. RFC 6330's is clear.
19. **Consumer smartphone audio-clock ppm is empirical, not a spec** — LibriWASN's ±20 ppm measured /
    −40 to +416 ppm cited is the best available; no SoC or codec datasheet figure appears to be
    published.

**Libraries**

20. **Which ggwave protocol Putz et al. configured** — not stated in the paper. The `FASTEST`
    conclusion is a derivation from their 268 bps figure (§2.7): strong, but inferential.
21. **Per-distance TER values for ggwave** exist only in the paper's Figure 5.
22. **Runtime behaviour of any non-ggwave receive path** — nobody drove a browser with a real
    microphone. quiet-js's and QRtone's APIs demonstrably still exist in Chrome; that their
    demodulators still lock is untested.
23. **Whether PairSonic uses ggwave's audible or ultrasonic protocols** — topics say `ultrasound`,
    but the protocol constant was not read from source.
24. **Exhaustiveness of the ggwave+AudioWorklet search** — GitHub code search is not exhaustive.
25. **`@vpalmisano/ggwave` 0.4.3-2 exports** — a possibly-fresher npm route, not inspected.
26. **quiet-lwip's actual licence** — GitHub reports `NOASSERTION`; the LICENSE file was not opened.
