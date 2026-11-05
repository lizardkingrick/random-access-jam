# Running and hosting Dream Chamber Remixed

[← Back to the README](../README.md)

The repository has the code only. The stems and album covers are copyrighted and are never
committed, so you need your own copies to hear anything.

## Windows, nothing to install

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

## Publish it through a reverse proxy

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

## With Node.js and ffmpeg

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
