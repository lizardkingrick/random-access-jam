# Random Access Jam

A beginner-friendly, 100% client-side browser **stem jam** app — a
Fortnite-Festival / Fuser–style **4-position rack**. Load stems (vocals,
drums, bass, lead) from *any* combination of tracks, and the engine locks
everything to one master tempo + key with pitch-preserving time-stretch, so
any four loops play together. All assets and demo sounds are original.

Two procedurally synthesized demo stem sets are generated on first run (via
`OfflineAudioContext`) and cached in IndexedDB, so the app is instantly
playable with nothing uploaded — it boots into a cross-track mashup. No
server, no analytics, no network calls at runtime — only Google Fonts, which
the service worker caches for offline use.

## The core model

The jam is a **4-position rack, not a two-deck crossfader**:

- Four fixed positions: **vocals, drums, bass, lead**.
- Each position is sourced **independently from any loaded track** — vocals
  from song A over drums from song B over bass from song C.
- All active positions play **simultaneously, summed** (A *and* B *and* C).
- Any position may be empty; two positions may pull from the same track.
- Every stem is conformed to the **master BPM (90–157) + master key** via
  offline pitch-preserving time-stretch (vendored
  [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/), MIT),
  with a half/double-time guard so extreme ratios never sound stretched.
- Loops launch **quantized to the bar grid** and restart in lockstep on every
  16-bar loop boundary — nothing ever drifts.

## Quick start

```bash
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
npm run preview  # serve the production build locally
```

Regenerate the PWA icons (procedurally drawn, no design tools needed):

```bash
node scripts/make-icons.mjs
```

## How to jam

1. **Tap anywhere** on the start screen (browsers require a gesture to unlock
   audio). A demo mashup loads and starts.
2. Each **rack card** (vocals/drums/bass/lead) has a source-track picker,
   mute/solo, a volume slider, and a live level meter.
3. **Drop stem files anywhere** (or click *+ Add tracks*). Files named like
   `song_drums.wav`, `song_bass.wav` auto-assign roles; a dialog confirms
   roles, title, source BPM and key (BPM/key are auto-detected, editable).
   A single ordinary track becomes a "lead" stem.
4. The **wheel** browses your library — clicking a slot assigns that track to
   the **focused** position; right-click / long-press picks a specific role.
5. Change **master BPM or key** in the transport strip — every position
   re-conforms and swaps on the next loop boundary ("adjusting…").
6. **Hold the Audio FX button** (or Space) for a filter-sweep breakdown.
7. Press **?** for shortcuts and the mastering-glue A/B toggle.

Keyboard: `1–4` focus a position · `M`/`S` mute/solo · `↑↓` volume ·
`←→` master BPM · `Space` FX hold · `?` help.

Tracks live in your browser's IndexedDB only — nothing leaves your machine.

## Architecture

```
src/
  main.js                 bootstrap, audio unlock, library ↔ wheel ↔ rack orchestration
  ticker.js               single shared requestAnimationFrame loop (visuals only)
  audio/
    engine.js             AudioContext + master graph (rack → FX → master → analyser)
    transport.js          master clock: BPM, bar grid, look-ahead scheduler, quantized launch
    jamRack.js            the 4-position board: grid-locked looped sources, mute/solo/volume, EQ
    timestretch.js        offline conform-to-grid via vendored Signalsmith Stretch WASM
    mastering.js          glue compressor + limiter on the master bus (bypassable)
    fx.js                 hold-to-activate lowpass sweep + rhythmic gain duck
    analyze.js/-Worker.js optional BPM + key auto-detect (pure JS, off-thread)
    demoLoops.js          OfflineAudioContext demo stem synthesis + WAV encoding
    crossfader.js         retired from the core path; kept unwired for a future A/B rack fade
  library/
    store.js              IndexedDB stem-set schema (v2, migrates v1 single-file tracks)
    intake.js             drag-drop/picker → role assignment → validate/decode/persist
  ui/                     hud, wheel (track browser), rackCard, tempo (transport strip),
                          toasts, help
  visualizer/             analyser-driven neon tunnel, particles, wireframe props, beat detector
  vendor/
    signalsmith-stretch/  vendored WASM stretch (MIT) — the project's only vendored asset
```

## Deploying

The build is a fully static site — any static host works.

**GitHub Pages**

```bash
npm run build
git subtree push --prefix dist origin gh-pages
```

Then enable Pages for the `gh-pages` branch in the repo settings. Assets use
relative paths (`base: './'`), so any subpath works.

**Netlify** — build command `npm run build`, publish directory `dist`.

## Browser support & Safari caveats

Current Chrome, Edge, and Firefox are fully supported. Safari notes:

- The `webkitAudioContext` fallback is wired; `StereoPannerNode` is
  feature-detected in the demo synth.
- Conform renders need **AudioWorklet on OfflineAudioContext** (Safari 14.1+).
  Where unavailable, a resample fallback keeps tempo right but shifts pitch
  (logged to the console).
- The start overlay guarantees the `AudioContext` resumes inside a gesture.
- iOS Safari caps IndexedDB more tightly, and stem sets are ~4× the data of
  single files — a friendly quota-exceeded message appears when full.

## Accessibility

- Full keyboard operation (see shortcuts above); the wheel is a listbox, the
  rack cards are labeled groups with toggle buttons and sliders exposing
  value text; toasts announce via a polite live region.
- `prefers-reduced-motion` swaps the visualizer for a gentle static gradient.
- Neon-styled visible focus rings; touch targets ≥ 44 px; responsive to 390 px.

## Later horizon (deliberately not built yet)

A/B rack-state crossfade, per-position filter knobs, hot cues/loops, mix
recording via `MediaRecorder`, .zip stem-set import, catalog/subscription
backend (Supabase + Stripe), Tauri desktop wrapper.

## License

[MIT](LICENSE) — contributions welcome. Vendored Signalsmith Stretch is MIT
(see `src/vendor/signalsmith-stretch/VENDORED.md`).
