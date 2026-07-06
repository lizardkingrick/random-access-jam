# Vendored: signalsmith-stretch v1.3.2

- Source: https://registry.npmjs.org/signalsmith-stretch/-/signalsmith-stretch-1.3.2.tgz
  (official JS/WASM release of Signalsmith Stretch by Geraint Luff / Signalsmith Audio)
- License: **MIT** — compatible with this project's MIT license.
- Contents: `SignalsmithStretch.mjs` is self-contained (the WASM binary and the
  AudioWorklet processor are embedded; the worklet loads via a blob URL), so it
  is the project's single vendored asset — no runtime npm dependency.
- Used by `src/audio/timestretch.js` for pitch-preserving time-stretch and
  key-shift during offline conform renders.

Do not edit `SignalsmithStretch.mjs`; replace it wholesale when upgrading.
