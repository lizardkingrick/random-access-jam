# Dream Chamber Remixed

**Version 1.0 beta** · **Live at [dreamchamberremixed.xyz](https://dreamchamberremixed.xyz)**

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
- **Even levels, no clipping.** Each stem is measured once (integrated loudness) and trimmed so
  louder and quieter songs sit at the same level, then a look-ahead true-peak limiter keeps the
  mix under -1 dBTP without pumping. Exported loops go through the same chain. Where the browser
  can't run the limiter (no AudioWorklet, or plain HTTP on a network address) a compressor is
  used instead.
- **24 songs, 57 stems.** They cover Homework, Discovery, Human After All, Alive 2007,
  Random Access Memories and the Weeknd collaborations.
- **Audio FX (hold).** Pick one of six effects and hold `F` to play it: Stutter (repeats the last eighth note,
  chopped), Low-pass and High-pass sweeps, Phaser, Wah, and Tape stop. Letting go snaps back in time.
- **Stage.** A neon pyramid concert behind the interface, with the duo bopping their heads in time.
  Each layer you add brings in more of the light show, a new cue lands every 8 bars, and the groove's
  album picks the colours. Devices without a real GPU get a starry night sky instead. What the stage
  gets each frame (levels, spectrum, beat, layout) is documented at the top of `js/stage.js`.
- **Local extras.** When you run it locally next to the extra rips, the wheel gets an
  **Instrument Guns** page (each song's backing track, melody gun and rhythm gun as Groove,
  Lead and Extra).
- **Share, record and export.** A share link stores the whole mix in its URL. You can also
  record the jam to a file or export one 32-bar loop as a WAV.
- **Keyboard, mouse and touch**, with layouts for phones held either way.

## Controls

The keyboard layout follows The Daft Punk Experience on PC.

| | Keyboard / mouse |
|---|---|
| Pick song | hold the mouse button, drag through the songs, let go to pick (or just click); the highlight stays on the last song pointed at. Or `←` `→` + `Enter` |
| Next layer | `Space` (`1` `2` `3` jump straight to Groove / Lead / Extra) |
| Audio FX | pick one in the FX strip (or `Q` / `E`), then hold `F` or the FX button |
| Tempo | `Z` / `C`, or the pill buttons |
| Albums | `A` / `D`, or the album tiles |
| Jam mode | **Enter Jam** (top left) or click empty space: hides the cursor so small mouse flicks steer the wheel and releasing the button picks; `Tab` exits |
| Play / random | `P` / `R` |
| Mute / clear layer | `M` / `Backspace` |

## Contributors

- **[MuscularCrab](https://github.com/MuscularCrab)**: audio engine
- **[Lizardkingrick](https://github.com/lizardkingrick)**: UI, visuals and web app
- **2Liter** ([@the_peoples_yinzer](https://www.instagram.com/the_peoples_yinzer/) on Instagram): contributor

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

In every mode, including `-Public` below, the server does the following:

- It serves only the app (`index.html`, `style.css`, `stems.json`, the web app manifest and icons,
  the scripts and images under `js/`, and `covers/` if you've built them) and the media files it
  lists. It never serves the rest of the repo, links out of the media folders, or anything else on
  disk.
- It sends security headers, including a Content-Security-Policy, and never shows error details
  to the browser.
- It streams files in parallel and drops clients that read slower than 32 KB/s. A third of the
  slots are kept free for the page itself, so stem downloads can't lock it out.
- It limits each visitor to 8 requests at once (4 stem downloads) and 300 requests in a burst,
  then 5 a second. Downloads are limited to 1 GB in a burst, then 2 MB a second. The app waits
  and retries when it hits a limit.
- Locally and with `-Lan`, it only answers addresses that name this PC (`localhost`, its IP
  address or its computer name), so another website can't reach it by pointing its own domain
  at your PC.

### Publish it through a reverse proxy

To put it on the internet, run **`start.cmd -Public`** behind a reverse proxy (nginx, Caddy, IIS,
Cloudflare Tunnel and so on) that faces the internet and handles HTTPS.

- Only the proxy can connect. Everyone else gets a 403, including other devices on your network.
- **Proxy on this PC** (the default): point it at `http://localhost:8137/`.
- **Proxy on another machine:** pass its address, `start.cmd -Public -TrustedProxy 10.0.0.2`, and
  point it at this PC's address shown in the server window. Separate several addresses with
  commas and no spaces. Trust only the proxy itself, not a whole network range: anything you trust
  can claim to be any visitor. A Cloudflare Tunnel whose `cloudflared` runs on another machine
  counts as such a proxy.
- If the site says "This server only answers its reverse proxy", the proxy connects from an address
  that isn't trusted. The server window names that address and the `-TrustedProxy` to restart with.
- With only a remote proxy trusted, opening `http://localhost:8137/` on this PC gets the same
  message; open the site through the proxy instead.
- The first run asks once for administrator permission to reserve the port. For a proxy on another
  machine, it also opens the firewall to that address only. If an older rule (from `-Lan`) lets in
  more, the server window says so and gives the command to narrow it.
- In `-Public` mode the server won't move to another port if 8137 is busy; it stops with an error
  instead. It also turns off QuickEdit in its window, because selecting text there would pause it.
- The proxy must add the `X-Forwarded-For` header. Caddy and Cloudflare Tunnel add it by default.
  For nginx, add `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. The per-visitor
  limits rely on this header.
- Set up HTTPS and HSTS on the proxy, since this server only speaks plain HTTP. Leave the proxy's
  response buffering on (the nginx default) so slow visitors tie up the proxy, not this server. If
  the proxy can rate-limit per IP (nginx `limit_req`, Caddy `rate_limit`), turn that on too.

Anyone who can open the site can download the stems, so only publish audio you're allowed to share.

### With Node.js and ffmpeg

You need [Node.js](https://nodejs.org) 18+ and [ffmpeg](https://ffmpeg.org) on your PATH. The
Node server (`serve.mjs`) is for local development only: it only listens on this computer and
serves the folder above the repo, so never put it behind a proxy.

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

To show real album covers, put your images in an `album_cover` folder next to this repo, named
after the album (for example `Random_Access_Memories.jpeg` or `Starboy.jpg`), and run
`npm run covers`. It makes small 256 px copies in `covers/`, which are deployed with the site. Like
the stems, the covers are copyrighted and stay out of git. Without them, the app uses its own
drawn art.

## Updating the site

The site is hosted on **Cloudflare Workers static assets**, the successor to Cloudflare Pages.
The Worker is named `dream-chamber-remixed` and serves the domain `dreamchamberremixed.xyz`.
Both are set in `wrangler.jsonc`. The stems are uploaded straight from your machine; they never
go through git. Unchanged files are skipped on each deploy, so updates that touch only the code
are quick. You need [Node.js](https://nodejs.org) 18+, plus [ffmpeg](https://ffmpeg.org) on your
PATH to build the Ogg stems (`npm run stems`) the first time or when the stems change.

```
# one time only
npm install
npm run stems -- --stems "D:\path\to\Stems"   # Ogg copies + stems.json
npx wrangler login           # or set CLOUDFLARE_API_TOKEN (template: Edit Cloudflare Workers)

# every release
git add -A && git commit -m "What changed"
git push
npm run deploy               # goes live on dreamchamberremixed.xyz
npm run deploy -- preview    # or: upload a preview version first; the live site is unchanged
```

`npx wrangler login` needs a browser on the same machine. Where that doesn't work (a remote
server, or a browser that fails Cloudflare's bot check), create an API token in the dashboard
(My Profile → API Tokens, template **Edit Cloudflare Workers**, limited to your account and the
`dreamchamberremixed.xyz` zone) and set it as the `CLOUDFLARE_API_TOKEN` environment variable.

To undo a bad release, roll back to the previous version in the Cloudflare dashboard
(Workers & Pages → dream-chamber-remixed → Deployments) or run `npx wrangler rollback`.

### Releasing a new version

1. Bump the version in `package.json` and `js/version.js`. The app shows the version in the
   top bar and the help screen.
2. Add a section to `CHANGELOG.md`.
3. Commit, then tag the release: `git tag v1.1.0 && git push --follow-tags`
4. Run `npm run deploy`.

## Audio engine to-do

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

## Project layout

| | |
|---|---|
| `index.html`, `style.css` | Layout and styling. Under 960px wide it stacks vertically for phones. |
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
| `tools/build-stems.mjs` | WAV → Ogg conversion and `stems.json` manifest |
| `tools/deploy.mjs` | Builds `dist/` and deploys it with Wrangler |
| `wrangler.jsonc` | Cloudflare config: Worker name, assets folder, custom domain |
| `serve.mjs` | Zero-dependency local dev server (Node) |
| `tools/serve-live.mjs` | Local dev server that streams the stems and covers from the live site |
| `tools/stage-lab.html` | Stage preview driven by a simulated song (no audio needed) |
| `start.cmd`, `tools/serve.ps1` | Windows local server: no installs, plays the WAVs straight from your folders |
| `tools/allow-lan.ps1` | One-time admin setup for `start.cmd -Lan` / `-Public` (port reservation + firewall rule) |
| `_headers` | Cache rules for the hosted site |

## License

The code is under the [MIT](LICENSE) license. The audio is not covered by it (see Credits).
