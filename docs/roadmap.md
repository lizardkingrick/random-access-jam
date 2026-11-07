# Roadmap

[← Back to the README](../README.md)

## Audio engine

What's left from the audio audit, roughly in order of what users would notice. Effort: S is under
an hour, M a few hours, L a day or more. What's done is at the bottom, and in the
[changelog](../CHANGELOG.md).

**Test first**

- [ ] **Safari (Mac, iPhone, iPad) and Firefox.** Everything so far was measured in Chromium only.
  Check that layers stay in sync on Safari (it now runs at the device's sample rate with a wider
  scheduling margin and loads the FLAC stems), the limiter (`js/limiter-worklet.js`) and its
  compressor fallback, WAV export through the limiter, Stutter / Tape stop / Wah / Phaser,
  recordings saving as `.m4a` on Safari, and on an iPhone: sound with the silent switch on and
  coming back after a call.
- [ ] **A real Android phone (a Galaxy S23 Ultra reported stutter when switching).** Phones now
  get two stretch workers, no background hq renders, a cheaper limiter and `latencyHint:
  'playback'`, all only tried in Chromium's phone emulation. Time a switch, and listen for
  dropouts while a pick renders.
- [ ] **A phone over HTTPS.** The limiter only runs on HTTPS or localhost; a phone opening the
  `-Lan` address over plain HTTP always gets the fallback compressor.

**Loading and downloads**

- [ ] **First pick on Safari and phones (M).** At the device's 48 kHz the worker also converts the
  sample rate, so a first pick takes about 0.45 s against 0.3 s on a desktop. Splitting the
  conversion across both workers, or a 16-tap filter, would win back some of it.
- [ ] **Less data on iPhones and Macs (M).** WebKit loads the FLAC stems (about 4.5x the Ogg) to be
  exact to the sample. Once Safari's Ogg decoding is checked on real devices, the length and
  mark check in `exactDecode` could let it use the Ogg when it matches.
- [ ] **Smaller downloads from the Windows server (L).** Serve FLAC instead of WAV: about 55% of
  the size, so a stem over the internet takes about half as long. `getOriginal` already treats
  `.flac` as lossless.

**Needs a UI change (talk to whoever owns the UI)**

- [ ] **Show when a pick will be heard (M).** The engine knows when a swap lands; the layer card
  could say "Downloading", "Stretching" and "Joins on the next bar" instead of looking like it
  already plays.
- [ ] **An auto-tempo switch (S).** Auto tempo re-stretches every layer when a pick moves the
  average; a lock next to the tempo could keep the tempo you set instead.
- [ ] **Lossless recording (M).** A WAV option for Rec, taken from the mix with an AudioWorklet.
- [ ] **Volume sliders that feel even (S).** Map the slider to gain with a taper (`v * v`), so the
  top half isn't only 6 dB. Changes the default slider position and old share links' levels.
- [ ] **Steadier meters (S).** Per-layer levels flicker and the bass band misses the kick's low
  end. The 3D visualizer reads `meters()`, so change it together with whoever tunes the visuals.
- [ ] **Export extras (S-M).** A 24-bit option, and exporting each layer as its own file.

**Done**

- [x] Hosted site on older Safari: FLAC copies built by `tools/build-stems.mjs`, used when Ogg
  won't decode, and a plain message when nothing plays.
- [x] Safari sync: native sample rate, a wider scheduling margin where `baseLatency` is missing,
  late starts moved to the next beat, and decodes checked against `frames` / `marks` in
  `stems.json`.
- [x] Phones: fewer stretch workers, no background hq, a cheaper limiter, no long tasks during a
  switch.
- [x] Sound sooner on the first pick: a near-unity path in the worker (20-30 ms) instead of
  playing the original first; one worker starts on the first tap.
- [x] Prefetch that pays off: the hovered song, and the layers it would re-key or re-tempo, are
  stretched ahead.
- [x] The current mix's renders kept across reloads (IndexedDB, `KEEP.version`).
- [x] Less memory per stem: 16-bit originals, worker input with room at the end.
- [x] Loudness, frame counts and alignment marks in `stems.json`.
- [x] Phase vocoder for held chords and pads, swapped in on a bar (desktops only).
- [x] Natural voices when the key shifts (formant correction on sung leads).
- [x] Stutter that follows the tempo (Auto length) and auto tempo from the stems' average.
