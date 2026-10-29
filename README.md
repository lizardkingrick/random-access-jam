# Dream Chamber Remixed

**Version 1.0 beta** · **Live at [hiddenalchemist.com](https://hiddenalchemist.com)**

A browser jam station inspired by the remix area of **The Daft Punk Experience** in
Fortnite. Fill three layers (**Groove**, **Lead** and **Extra**) with stems from different
Daft Punk songs on a radial song wheel. Every stem is time-stretched to one tempo and
pitch-shifted to one key, so any combination stays in sync. It runs entirely in the browser:
there is no account and no install.

## Features

- **Fortnite-style song wheel.** Each album is a page of the wheel. The hub in the middle
  switches layers and counts through the 32-bar loop.
- **Auto-sync.** Stems are conformed to the master tempo (80–140 BPM) using WSOLA time-stretch.
  Key lock shifts every stem into a single key. Song swaps land on the next bar.
- **24 songs, 57 stems.** They cover Homework, Discovery, Human After All, Alive 2007,
  Random Access Memories and the Weeknd collaborations.
- **Audio FX (hold).** Drag to sweep a low-pass or high-pass filter and add tempo-synced echo.
- **Reactive stage.** A neon dome, orbiting light strands and a turntable floor. Each active
  layer adds an object: a wire sphere for Groove, a disco ball for Lead and a gold speaker
  cube for Extra.
- **Share, record and export.** A share link stores the whole mix in its URL. You can also
  record the jam to a file or export one 32-bar loop as a WAV.
- **Keyboard, mouse, touch and game controllers**, with a layout for phones.

## Controls

| | Keyboard / mouse | Controller |
|---|---|---|
| Pick layer | `1` `2` `3`, `C` to cycle, or click a card / hub icon | `Y` |
| Pick song | click a wheel segment, or `←` `→` + `Enter` | left stick + `A` |
| Albums | `Q` / `E`, or the album tiles | `LB` / `RB` |
| Audio FX | hold the FX button and drag, or hold `Space` and move the mouse | hold `X` + right stick |
| Tempo | `−` / `+`, hold the pill buttons, or scroll on them | D-pad up/down |
| Play / random | `P` / `R` | `Start` / `Back` |
| Mute / clear layer | `M` / `Backspace` | `B` clears |

## Credits

- **[Lizardkingrick](https://github.com/lizardkingrick)**: creator; UI, visuals and web app
- **[MuscularCrab](https://github.com/MuscularCrab)**: contributor. Wrote the audio engine
  (WSOLA time-stretch and pitch-shift, bar-quantized mixing, share links, record and export)
  in [Dream Chamber Studios Remixed](https://github.com/MuscularCrab/dreamchamberremixed),
  which this project builds on
- **2Liter** ([@the_peoples_yinzer](https://www.instagram.com/the_peoples_yinzer/) on Instagram): contributor

Built with help from Claude (Anthropic) via Claude Code.

This is a fan project. It is not affiliated with Daft Punk, Epic Games or Fortnite. The stems
come from The Daft Punk Experience and remain © Daft Punk and their labels. They are **not**
included in this repository.

## Run it locally

You need [Node.js](https://nodejs.org) 18+ and [ffmpeg](https://ffmpeg.org) on your PATH.

```
npm install
npm run stems     # converts the WAV stems to Ogg and writes stems.json
npm run dev       # http://localhost:8137/webapp/
```

`npm run stems` looks for the stems in a `Stems/` folder next to this repo by default. To use
a different folder, run `npm run stems -- --stems <path>`. Files must be named
`Stems/<Song>/<Song> - <Groove|Lead|Texture|All> (<Key> <BPM>).wav`, and each one must be a
seamless 128-beat loop. When you add a new song, also add its album to `CATALOG` in
`tools/build-stems.mjs`.

## Updating the site

The site is hosted on **Cloudflare Workers static assets**, the successor to Cloudflare Pages.
The Worker is named `random-access-jam` and serves the domain `hiddenalchemist.com`. Both are
set in `wrangler.jsonc`. The stems are uploaded straight from your machine; they never go
through git. Unchanged files are skipped on each deploy, so updates that touch only the code
are quick.

```
# one time only
npx wrangler login

# every release
git add -A && git commit -m "What changed"
git push
npm run deploy               # goes live on hiddenalchemist.com
npm run deploy -- preview    # or: upload a preview version first; the live site is unchanged
```

To undo a bad release, roll back to the previous version in the Cloudflare dashboard
(Workers & Pages → random-access-jam → Deployments) or run `npx wrangler rollback`.

### Releasing a new version

1. Bump the version in `package.json` and `js/version.js`. The app shows the version in the
   top bar and the help screen.
2. Add a section to `CHANGELOG.md`.
3. Commit, then tag the release: `git tag v1.1.0 && git push --follow-tags`
4. Run `npm run deploy`.

## Project layout

| | |
|---|---|
| `index.html`, `style.css` | Layout and styling. Under 960px wide it stacks vertically for phones. |
| `js/engine.js` | Audio graph, stem loading and conforming, transport, FX, record and export |
| `js/stretch-worker.js` | WSOLA time-stretch and pitch-shift (MuscularCrab) |
| `js/wheel.js` | SVG radial song wheel |
| `js/stage.js` | Canvas background visuals |
| `js/catalog.js` | Album pages, album badge art, layer icons |
| `js/main.js` | UI wiring, keyboard and gamepad input, share links |
| `js/version.js` | App version |
| `tools/build-stems.mjs` | WAV → Ogg conversion and `stems.json` manifest |
| `tools/deploy.mjs` | Builds `dist/` and deploys it with Wrangler |
| `wrangler.jsonc` | Cloudflare config: Worker name, assets folder, custom domain |
| `serve.mjs` | Zero-dependency local dev server |
| `_headers` | Cache rules for the hosted site |

## License

The code is under the [MIT](LICENSE) license. The audio is not covered by it (see Credits).
