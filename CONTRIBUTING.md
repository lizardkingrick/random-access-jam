# Contributing to Dream Chamber Remixed

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Reporting a bug or asking for a feature

Open an [issue](https://github.com/lizardkingrick/dream-chamber-remixed/issues/new/choose). For a bug,
include these if you can:

- The **share link** of the mix you were playing. Press **Share** in the app and paste the link.
  It recreates your exact layers, tempo and key.
- Your device, browser and its version. Some audio features act differently in Safari and Firefox.
- What you expected to happen and what happened instead.

## Getting set up

You need [Node.js](https://nodejs.org) 18 or newer. Nothing else is required to start.

```bash
git clone https://github.com/lizardkingrick/dream-chamber-remixed.git
cd dream-chamber-remixed
node tools/serve-live.mjs     # http://localhost:8138/
```

`serve-live.mjs` serves your working copy and streams the stems and covers from the live site,
so you can work on the code without the audio files. To run with your own stems instead, see
[docs/self-hosting.md](docs/self-hosting.md).

There's no build step. The app is plain HTML, CSS and ES modules, so you edit a file and reload
the page. To work on the background, `tools/stage-lab.html` drives the stage with a simulated song
and needs no audio.

## Making a change

1. Fork the repo and create a branch from `main`.
2. Keep each pull request to one change. A focused PR is reviewed faster.
3. Test it in the browser on desktop **and** at a phone size. DevTools device mode is fine. If
   you change audio, also try Safari or Firefox if you have one.
4. Add a line to the **Unreleased** section of [CHANGELOG.md](CHANGELOG.md) in plain language:
   what a player will notice.
5. Open the pull request and describe what changed and how you tested it.

### Ground rules

- **Never commit audio or album art.** `.gitignore` keeps out stems (`*.wav`, `*.ogg`, `*.flac`,
  `stems-ogg/`, `stems-flac/`) and `covers/`. Don't force them in.
- **No new runtime dependencies** without talking about it in an issue first. The app loads
  nothing from npm at runtime. Three.js is vendored and trimmed.
- Keep the layout working on every screen. The whole UI scales from one size unit (`--u` in
  `style.css`). Use it instead of fixed pixel sizes.

## Project layout

| Path | What it is |
|---|---|
| `index.html`, `style.css` | Layout and styling. Under 960px wide it stacks vertically for phones. |
| `solid.css` | The look on top of `style.css`: colours, type and shapes (grey surfaces, the layer colours, Geist). It changes no sizes |
| `js/engine.js` | Audio graph, stem loading and conforming, transport, FX, record and export |
| `js/stretch-worker.js` | WSOLA time-stretch and pitch-shift (MuscularCrab), with drum hits pinned to the beat |
| `js/loudness.js` | Measures each stem's integrated loudness (BS.1770) for the level trims |
| `js/limiter-worklet.js` | The look-ahead true-peak limiter at the end of the mix |
| `js/manifest.js` | Song catalogue; builds the song list from a local folder listing |
| `js/wheel.js` | SVG radial song wheel |
| `js/stage.js` | Picks the background: the pyramid stage, or a starfield fallback (the stage contract is documented at the top) |
| `js/stage-pyramid.js` | The pyramid stage: Three.js scene, shaders, cue sequencer, camera shots, post-processing |
| `js/figures/` | Head and body silhouettes for the two figures (built by `tools/build-figures.py`) |
| `js/vendor/three.min.js` | Trimmed Three.js bundle (rebuilt by `tools/build-three.mjs`) |
| `js/catalog.js` | Album pages, album badge art, layer icons |
| `js/main.js` | UI wiring, keyboard and pointer input, share links |
| `js/version.js` | App version |
| `tools/build-stems.mjs` | WAV → Ogg and FLAC copies, and the `stems.json` manifest (with loudness) |
| `tools/deploy.mjs` | Builds `dist/` and deploys it with Wrangler |
| `wrangler.jsonc` | Cloudflare config: Worker name, assets folder, custom domain |
| `serve.mjs` | Zero-dependency local dev server (Node) |
| `tools/serve-live.mjs` | Local dev server that streams the stems and covers from the live site |
| `tools/stage-lab.html` | Stage preview driven by a simulated song (no audio needed) |
| `start.cmd`, `tools/serve.ps1` | Windows local server: no installs, plays the WAVs straight from your folders |
| `tools/allow-lan.ps1` | One-time admin setup for `start.cmd -Lan` / `-Public` (port reservation + firewall rule) |
| `_headers` | Cache rules for the hosted site |

## License

By contributing, you agree that your code is released under the project's [MIT license](LICENSE).
