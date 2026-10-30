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
- **Auto-sync.** Stems are conformed to the master tempo (80–140 BPM) using WSOLA time-stretch,
  rendered in parallel worker threads. Key lock shifts every stem into a single key, treating a
  major key as its relative minor (A major mixes with F♯m untouched). Song swaps land on the next
  bar, and a tempo change keeps your place in the loop.
- **Mastering glue.** A gentle bus compressor and a peak limiter keep three stacked stems from
  clipping. Exported loops go through the same chain.
- **24 songs, 57 stems.** They cover Homework, Discovery, Human After All, Alive 2007,
  Random Access Memories and the Weeknd collaborations.
- **Audio FX (hold).** Drag to sweep a low-pass or high-pass filter and add tempo-synced echo.
- **Reactive stage.** A neon dome, orbiting light strands and a turntable floor. Each active
  layer adds an object: a wire sphere for Groove, a disco ball for Lead and a gold speaker
  cube for Extra.
- **Local extras.** When you run it locally next to the extra rips, the wheel gets an
  **Instrument Guns** page (each song's backing track, melody gun and rhythm gun as Groove,
  Lead and Extra), and the stage shows dotted holograms of the two helmets that nod to the beat.
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

## Contributors

Three of us build this together. It grew out of MuscularCrab's idea and his original
[Dream Chamber Studios Remixed](https://github.com/MuscularCrab/dreamchamberremixed).

- **[MuscularCrab](https://github.com/MuscularCrab)**: the original idea and the audio engine
  (time-stretch and pitch-shift, bar-quantized mixing, mastering, share links, record and export)
- **[Lizardkingrick](https://github.com/lizardkingrick)**: UI, visuals and the web app
- **2Liter** ([@the_peoples_yinzer](https://www.instagram.com/the_peoples_yinzer/) on Instagram)

This is a fan project. It is not affiliated with Daft Punk, Epic Games or Fortnite. The stems
come from The Daft Punk Experience and remain © Daft Punk and their labels. They are **not**
included in this repository.

## Run it locally

### Windows, nothing to install

Double-click **`start.cmd`**. It starts a tiny local server (Windows PowerShell, which every
Windows has) and opens the app in your browser. Close the server window to stop it. The
server only accepts connections from your own computer.

It plays the WAV stems straight from disk, so there is no conversion step. It looks for a
`Stems` folder (or `Stems\Stems`, or `bonus\Stems`) next to the app or up to three folders
above it. It also picks up, when they're there:

- `Instrument Guns & Backing Tracks\<Song>\<Song> - Melody Gun.wav` (and Backing Track,
  Rhythm Gun): adds the **Instrument Guns** page to the wheel
- `Bonus\3D Helmets\TB3 Fortnite.obj` and `GM08 Fortnite.obj` (or the Snapchat versions):
  adds the helmet holograms to the stage

To open it from a phone, tablet or another PC on your network, start it with **`start.cmd -Lan`**.
The server window then lists `On your network: http://<this PC's address>:8137/`; open that on
the other device. The first time, Windows shows an administrator prompt: it reserves the port
for your account and adds a firewall rule that lets in your local subnet only (not the
internet). Undo it with `powershell -ExecutionPolicy Bypass -File tools\allow-lan.ps1 -Remove`
from an administrator PowerShell. If a VPN is running on this PC, its "allow LAN traffic"
setting must be on. Over plain `http` on another device the Share button can't copy to the
clipboard, so copy the address bar instead.

To point it somewhere else: `start.cmd -Stems "D:\Daft Punk\Stems" -Extras "D:\Daft Punk\bonus"`.
`-Port 8200` changes the port and `-NoBrowser` skips opening the browser. Opening
`index.html` directly from disk won't work, because browsers block audio and scripts on
`file://` pages.

### With Node.js and ffmpeg

You need [Node.js](https://nodejs.org) 18+ and [ffmpeg](https://ffmpeg.org) on your PATH.

```
npm install
npm run stems     # converts the WAV stems to Ogg and writes stems.json
npm run dev       # http://localhost:8137/webapp/
```

`npm run stems` looks for the stems in a `Stems/` folder next to this repo by default. To use
a different folder, run `npm run stems -- --stems <path>`. Files must be named
`Stems/<Song>/<Song> - <Groove|Lead|Texture|All> (<Key> <BPM>).wav`, and each one must be a
seamless loop (normally 128 beats; any whole number of bars works). When you add a new song,
also add its album to `CATALOG` in `tools/build-stems.mjs` and to `SONGS` in `js/manifest.js`.

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
| `js/manifest.js` | Song catalogue; builds the song list from a local folder listing |
| `js/wheel.js` | SVG radial song wheel |
| `js/stage.js` | Canvas background visuals |
| `js/helmets.js` | Loads the optional helmet models as point clouds for the stage |
| `js/catalog.js` | Album pages, album badge art, layer icons |
| `js/main.js` | UI wiring, keyboard and gamepad input, share links |
| `js/version.js` | App version |
| `tools/build-stems.mjs` | WAV → Ogg conversion and `stems.json` manifest |
| `tools/deploy.mjs` | Builds `dist/` and deploys it with Wrangler |
| `wrangler.jsonc` | Cloudflare config: Worker name, assets folder, custom domain |
| `serve.mjs` | Zero-dependency local dev server (Node) |
| `start.cmd`, `tools/serve.ps1` | Windows local server: no installs, plays the WAVs straight from your folders |
| `tools/allow-lan.ps1` | One-time admin setup for `start.cmd -Lan` (port reservation + local-subnet firewall rule) |
| `_headers` | Cache rules for the hosted site |

## License

The code is under the [MIT](LICENSE) license. The audio is not covered by it (see Credits).
