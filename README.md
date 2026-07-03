# Random Access Jam

A beginner-friendly, 100% client-side browser DJ mixer. Upload your own tracks
(MP3/WAV/OGG/M4A), blend two decks with a crossfader, hold the Audio FX button
for a filter-sweep breakdown, and watch the neon tunnel react to your mix.
Inspired by rhythm-game jam HUDs; every asset and sound here is original.

Two procedurally synthesized demo loops are generated on first run (via
`OfflineAudioContext`) and cached in IndexedDB, so the app is instantly
playable with nothing uploaded. No server, no analytics, no network calls at
runtime — only Google Fonts, which the service worker caches for offline use.

## Quick start

```bash
npm install
npm run dev      # local dev server
npm run build    # production build to dist/
npm run preview  # serve the production build locally
```

Regenerate the PWA icons (they're procedurally drawn, no design tools needed):

```bash
node scripts/make-icons.mjs
```

## How to jam

1. **Tap anywhere** on the start screen (browsers require a gesture to unlock audio).
2. Press **play** on Deck A. The demo loops are pre-loaded.
3. Slide the **crossfader** toward Deck B (or press ←/→) and press play on B to blend.
4. **Hold the Audio FX button** (or hold **Space**) for a breakdown; release to sweep back.
5. **Drop audio files anywhere** (or click *+ Add tracks*). Clicking a wheel slot queues
   that track on the deck you are *not* hearing, so your mix never cuts out.
   Right-click / long-press a slot to pick a specific deck or remove the track.
6. Press **?** for all keyboard shortcuts.

Tracks are stored in your browser's IndexedDB only — nothing leaves your machine.

## Architecture

```
src/
  main.js                 bootstrap, audio unlock, library↔wheel↔deck orchestration
  ticker.js               single shared requestAnimationFrame loop
  audio/
    engine.js             AudioContext + master graph (decks → crossfader → FX → analyser)
    deck.js               Deck class: one-shot source management with manual offset tracking
    crossfader.js         equal-power crossfade (cos ramps, never snapped)
    fx.js                 hold-to-activate lowpass sweep + rhythmic gain LFO
    demoLoops.js          OfflineAudioContext demo synthesis + WAV encoding
  library/
    store.js              IndexedDB wrapper (original blobs + metadata, quota-aware)
    intake.js             drag-drop + picker, validate, decode, persist
  ui/                     hud, wheel, deckCard, waveform, tempo, toasts, help
  visualizer/
    visualizer.js         tunnel rings, pooled particles, wireframe props
    beat.js               low-band running-average beat detector
  styles/                 tokens.css (design tokens), hud.css
```

Tempo v1 changes `playbackRate` (vinyl-style pitch shift). The rate mechanism
is isolated in `deck.js` so a pitch-preserving time-stretch (WASM, lazy-loaded)
can replace it later without touching the UI.

## Deploying

The build is a fully static site — any static host works.

**GitHub Pages**

```bash
npm run build
# push dist/ to a gh-pages branch, e.g. with the gh CLI:
git subtree push --prefix dist origin gh-pages
```

Then enable Pages for the `gh-pages` branch in the repo settings. The Vite
config uses relative asset paths (`base: './'`), so it works from any subpath.

**Netlify** — connect the repo and set build command `npm run build`, publish
directory `dist`. (Or drag-and-drop the `dist/` folder onto the Netlify UI.)

## Browser support & Safari caveats

Current Chrome, Edge, and Firefox are fully supported. Tested manually in
Chrome and Firefox. Safari notes:

- The `webkitAudioContext` fallback is wired, and `StereoPannerNode` is
  feature-detected in the demo-loop synth (older Safari skips stereo spread).
- Safari is strict about audio unlock: the start overlay guarantees the
  `AudioContext` resumes inside a user gesture.
- iOS Safari caps IndexedDB storage more aggressively; a friendly
  quota-exceeded message appears if the library fills up.
- `backdrop-filter` uses the `-webkit-` prefix (included).

## Accessibility

- Full keyboard operation: Tab everywhere, Space = FX hold, ←/→ = crossfader,
  arrows navigate the wheel and seek waveforms, `?` opens the shortcut help.
- ARIA: the wheel is a listbox, waveforms and crossfader are sliders with
  value text, toasts announce via a polite live region.
- `prefers-reduced-motion` swaps the visualizer for a gentle static gradient
  and disables UI animation.
- Neon-styled visible focus rings; touch targets ≥ 44 px; responsive to 390 px.

## Later horizon (not built yet, deliberately not precluded)

Pitch-preserving time-stretch, BPM detection + sync, per-deck filters,
hot cues/loops, mix recording via `MediaRecorder`, Tauri desktop wrapper.

## License

[MIT](LICENSE) — contributions welcome.
