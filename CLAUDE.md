# Random Access Jam — build context

## What this is
A vanilla-JS + Vite, client-side browser music app. We are adding a
Fortnite-Festival / Fuser–style stem jam engine, then a subscription store.

## THE CORE MODEL (most important rule — never violate)
The jam is a **4-position rack**, NOT a two-deck DJ crossfader.
- Four fixed positions: vocals, drums, bass, lead.
- Each position is sourced INDEPENDENTLY from any loaded track.
- All active positions play SIMULTANEOUSLY, summed into one loop (additive —
  A and B and C and D, never A or B).
- Any position may be empty; two positions may reference the same track.
- Single user controls all four positions (this equals Fortnite's solo Jam mode).
The old crossfader is retired as the core; keep the module unwired as an optional
later feature only.

## Non-negotiable conventions
- ES modules, no framework, no runtime npm dependencies. The ONLY exception is a
  single vendored WASM asset for time-stretch, and only after the human approves it.
- ALL audio scheduling uses `AudioContext.currentTime`. Never `Date.now`,
  `setInterval`, or `requestAnimationFrame` for sample-accurate timing. (The one
  shared rAF ticker in src/ticker.js is for visuals only.)
- No localStorage/sessionStorage. Persistence is IndexedDB via src/library/store.js.
- Before editing a file, read it and state your plan. After editing, give exact
  browser steps to test the change.
- Preserve existing accessibility (keyboard, ARIA, prefers-reduced-motion),
  Safari audio-unlock, and IndexedDB quota handling.
- Match the existing design system in src/styles/tokens.css and src/styles/hud.css.

## Signal graph (target)
per position (×4): assignedTrack.stem[role] → looped BufferSource (grid-locked)
  → posGain (mute/solo/volume) → posEQ → jam bus → FX → master compressor
  → limiter → analyser → destination.
A master Transport (AudioContext clock) drives all loop restarts + quantized
downbeat launches in lockstep.

## File map (after this build)
- src/audio/transport.js  master clock, bar grid, look-ahead scheduler
- src/audio/jamRack.js    the 4-position board (replaces deck.js)
- src/audio/timestretch.js  vendored-WASM stretch + pitch, offline pre-render
- src/audio/mastering.js  glue compressor/limiter + per-position EQ
- src/audio/engine.js     master graph wiring (edit)
- src/library/store.js    IndexedDB, stem-set schema (edit)
- src/library/intake.js   group stems on upload (edit)
- src/ui/rackCard.js      4-slot rack UI (replaces deckCard.js)
- src/ui/tempo.js         master tempo/key control (edit)

## Working agreement
One phase per turn. Build, then stop and let the human verify audio before moving
on. If a change would add a runtime dependency or break the client-side/no-backend
nature of the app, STOP and ask first.
