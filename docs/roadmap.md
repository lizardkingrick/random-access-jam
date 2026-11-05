# Roadmap

[← Back to the README](../README.md)

## Audio engine

What's left from the audio audit, roughly in order of what users would notice. Effort: S is under
an hour, M a few hours, L a day or more.

**Test first**

- [ ] **Safari (Mac, iPhone, iPad) and Firefox.** Everything so far was measured in Chromium only.
  Check the limiter (`js/limiter-worklet.js`) and its compressor fallback, WAV export through the
  limiter, Stutter / Tape stop / Wah / Phaser, recordings saving as `.m4a` on Safari, and on an
  iPhone: sound with the silent switch on and coming back after a call.
- [ ] **A phone over HTTPS.** The limiter only runs on HTTPS or localhost; a phone opening the
  `-Lan` address over plain HTTP always gets the fallback compressor.

**Loading and downloads**

- [ ] **Hosted site on older Safari (M, high).** The Cloudflare build only has Ogg stems, which
  Safari and iOS before 18.4 can't decode, so they get no sound. Add a FLAC copy of each stem
  in `tools/build-stems.mjs`, fall back to it when Ogg won't decode, and say plainly when nothing
  plays.
- [ ] **Smaller downloads from the Windows server (L).** Serve FLAC instead of WAV: about 55% of
  the size, so a stem over the internet takes about half as long. `getOriginal` must treat
  `.flac` as lossless.
- [ ] **Sound sooner on the first pick (M).** When a pick needs no stretch or key shift, start the
  original straight away and swap in the render on a later bar.
- [ ] **Prefetch that pays off (M).** Pre-render the hovered song at the current tempo and key
  when a worker is idle, and start one worker on the first click.
- [ ] **Keep the current mix's renders across reloads (M).** Store them in IndexedDB so a reload or
  a share link doesn't stretch everything again.
- [ ] **Less memory per stem (S-M).** Keep originals as 16-bit (half the size), and give the
  worker input with room at the end so it doesn't copy it.
- [ ] **Loudness in `stems.json` (S).** Measure at build time so hosted first picks skip it.

**Sound quality**

- [ ] **Phase vocoder for held chords and pads (L).** WSOLA still warbles a little on sustained
  chords at big tempo changes. A phase-locked vocoder for Lead and Texture layers (WSOLA stays for
  drums) removes it, at about 10x the render time, so render WSOLA first and swap the better one
  in on a bar.
- [ ] **Natural voices when the key shifts (L).** Vocals moved up to +5 or -6 semitones sound
  chipmunked or slowed. Correct the spectral envelope on vocal Lead stems (easiest inside the
  phase vocoder above).

**Needs a UI change (talk to whoever owns the UI)**

- [ ] **Show when a pick will be heard (M).** The engine knows when a swap lands; the layer card
  could say "Downloading", "Stretching" and "Joins on the next bar" instead of looking like it
  already plays.
- [ ] **Lossless recording (M).** A WAV option for Rec, taken from the mix with an AudioWorklet.
- [ ] **Volume sliders that feel even (S).** Map the slider to gain with a taper (`v * v`), so the
  top half isn't only 6 dB. Changes the default slider position and old share links' levels.
- [ ] **Steadier meters (S).** Per-layer levels flicker and the bass band misses the kick's low
  end. The 3D visualizer reads `meters()`, so change it together with whoever tunes the visuals.
- [ ] **Export extras (S-M).** A 24-bit option, and exporting each layer as its own file.
