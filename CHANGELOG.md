# Changelog

## Unreleased

- Faster start, sound unchanged: the song list no longer waits for the local server's file
  listing (a 404 on the hosted site, one round trip before any stem could start), a shared mix's
  stems start downloading before the stage is set up, and the stage's show (three.js and the
  figures, ~650 KB) waits until the mix is in (8 s at most), so on a phone they don't split the line
- Phones held upright: each layer row has a mute button again, and mute and remove answer taps
  (the row's own tap target used to sit on top of them). Tempo, key and the Audio FX row are
  slimmer, so the wheel gets more of the height
- Phones on their side: tempo, key and the effects are slimmer and the volume knob smaller, so the
  knob no longer pokes out of the bottom of its layer card. On desktop and tablets the knob has
  room under it too
- The selected layer's button in the middle of the wheel is about twice the size of the other
  two, which sit small and dim beside it. On small wheels the hub shows just "Playing" (the "pick
  again to remove" hint was cut off), and the space bar key is wide like a space bar
- The site moved to dreamchamberremixed.xyz (Worker `dream-chamber-remixed`); hiddenalchemist.com
  is no longer used. `npm run deploy -- --config <file>` deploys with another wrangler config
- A song name too long for its layer card scrolls left, Spotify style, round
  to its first word again, pauses and repeats (with motion reduced it stays put and is cut off)
- Game controller support is gone for now (stick, buttons, controller glyphs on the keycaps and
  the controller column in the help): the app is played with keyboard, mouse and touch
- Installable: Add to Home Screen (or Install app in Chrome) puts a Dream Chamber icon on the
  phone and opens it full screen, without the browser's bars. The layout keeps clear of the status
  bar drawn over it. `python tools/build-icons.py` redraws the icons
- Phones on their side get a new layout: no top row, the transport heads the left panel and the
  wheel takes the full height with the albums in a rail beside it. Buttons are bigger for thumbs,
  the layout stays clear of the notch, and drags on the wheel steer in any direction (a vertical
  drag used to be taken as a scroll and dropped the pick). The left panel never scrolls or shows a
  scrollbar: it fits the height, down to a phone with the browser's bars showing. Small phones
  turned sideways (667x375, 568x320) used to get the portrait layout squeezed sideways and now get
  this one. The stage centres the pyramid on the whole screen when there's no gap between the panels
- Phones held upright fit the whole jam on one screen, with the browser's bars showing or opened
  from the home screen: the layers are three tiles side by side under the albums, tempo, key and
  the Audio FX button share a row with the effects underneath, and the wheel takes whatever height
  is left. On shorter phones the title folds into the logo and the album covers shrink first.
  Messages show over the title instead of the transport buttons
- Phones held upright: the top row is the logo, a clear gap and the buttons. The layers are three
  slim full-width rows, each with its own volume and remove (M still mutes), and the wheel takes all
  the spare height, with the album bar right on top of the layers
- Phones on their side: the wheel and album rail sit against the right edge again with the stage
  in the gap, and each layer's volume runs under the song only, clear of its mute and remove buttons
- Phones on their side keep their buttons big enough to tap (about 33-44px, were 20-27px with the
  browser's bars showing): the FX button joins the row of effects, which show icons only
- The small layer buttons inside the hub have a bigger touch area than their icons
- New stage: a neon pyramid with its top cut off and the duo in the gap, bopping their heads on the
  beat. Each layer drives part of the light show, cues change every 8 bars and the groove's album
  picks the palette. Devices without a real GPU fall back to a starry night sky. The old stage (dome,
  light strands, floating objects) and the helmet holograms are gone (the helmet models were game
  assets)
- Background is a plain starry night sky for now, while a new music visualizer is designed. The old
  stage (dome, light strands, floating objects) and the helmet holograms are gone (the helmet models
  were game assets). The visualizer hook is documented at the top of js/stage.js
- Audio fixes:
  - Swaps finish on the bar line: the new stem fades in during the 10 ms before it, so its downbeat
    lands at full level and the old stem's downbeat no longer leaks through. The same goes for Play,
    Clear and tempo changes.
  - Random, and a new song on the key-setting layer, swap every affected layer on the same bar once
    all of them are ready, instead of one by one in clashing keys.
  - No thump when letting go of Tape stop. Stutter and Tape stop also act on a swap waiting for its
    bar line, and end when Stop is pressed.
  - Stems slowed down a lot no longer play bar 1's downbeat twice at the loop restart.
  - Picking a song right after a tempo change no longer drops that layer out, and clearing the last
    layer stops the sound at once.
  - The layer card goes straight to "Syncing" when the stem was already downloaded.
  - Error messages say what went wrong (missing file, can't decode, connection, memory), and a
    dropped connection is retried.
  - Safari recordings are saved as .m4a instead of a mislabelled .webm.
- Sound quality:
  - Drum hits stay on the beat when a stem is slowed down or sped up a lot: hits are found and
    pinned to their stretched time, so they no longer double, drop out or flam against other
    layers (on a click track every hit now lands within 0.2 ms at 0.45x to 2.27x, where up to
    54 ms off before). Leads and textures only pin hard, isolated hits, so held notes stay smooth.
  - Less warble on chords and pads (a wider splice search between hits), no level flutter on
    cymbals and noise at the splices, and more top end on stems shifted down in key.
  - Every stem is measured once and trimmed to a common loudness for its layer, so swapping one
    lead for another no longer jumps or drops by up to 5 dB.
  - The bus compressor is replaced by a look-ahead true-peak limiter (-1 dBTP): three-layer mixes
    no longer pump 3-5 dB on every beat, at about the same overall level. Browsers without
    AudioWorklet, or a plain-HTTP network address, keep the old compressor.
  - Wah sweeps in time with the beat and evenly in pitch, and no longer drops the mix by 5-10 dB.
    Phaser is a real phaser now, synced to two bars. Tape stop lasts two beats at any tempo.
  - Effects no longer jump on a second press or on release, and Play after Stop during Stutter is
    no longer silent.
- Loading and timing:
  - Unwanted downloads (songs you hovered or picked over) are cancelled instead of holding up the
    one you chose, and stretch jobs nobody needs any more are dropped, newest pick first.
  - Memory use is capped by size and by device, so long jams don't crash phones.
  - A tempo change during a Random mix waits for the whole mix, so the layers still drop in together.
  - A layer that fails to re-sync retries once, and the playback position stays on whole samples
    after tempo changes (no dulled top end).
  - iPhones play with the silent switch on, and the sound comes back after a call or app switch.
  - Exports and recordings are named after the mix (songs, BPM, key), exports are dithered, and
    both come out at the same level.
- Empty slots on the wheel no longer show a faint outline inside their edge
- Song titles on the wheel always fit inside their segment ("Around The World" ran into the rim on
  Homework, and two longer titles touched the centre circle)
- Layout rebuilt to fit any screen: every size scales from one unit, so 4K and ultrawide monitors get a
  sharp full-size layout and small laptops shrink proportionally. New layouts for portrait tablets and
  tall monitors (big wheel, controls beside the layer cards) and for phones on their side (the wheel
  fills the height, albums run down its side). Small text never drops below 10.5px. Checked at 28
  screen sizes from 320x568 to 3840x2160
- Keyboard controls now match The Daft Punk Experience on PC: `Space` next layer, hold `F` for
  Audio FX, `Z` / `C` tempo, `A` / `D` albums, `Tab` exits Jam mode
- The wheel follows the direction of the mouse instead of exact hovering, keeps the last song
  highlighted, and shows a white selector arc pointing at it
- Hold the mouse button, drag through the songs and let go to pick (a plain click still works);
  letting go inside the hub cancels
- Songs without a stem for the current layer show as empty slots with no name, like in Fortnite
- Real album covers on the album tiles and layer badges (`npm run covers` makes small copies from
  your own full-size images in `../album_cover`; the drawn art is used where there's no cover)
- Songs that aren't playing in the current layer are a darker blue (names still shown, still pickable);
  the playing one is bright blue, and the hub shows Fortnite's spacebar icon for switching layers
- Audio FX: choose one of six effects in the FX strip (or `Q` / `E`), then hold `F` to play it:
  Stutter (beat repeat of the last eighth note, gated), Low-pass and High-pass sweeps that deepen the
  longer you hold, Phaser, a tempo-synced Wah, and Tape stop. Replaces the drag-around filter/echo pad
- The middle of the wheel shows each layer icon once, with the selected one enlarged, and the
  outer ring around the wheel is gone
- Jam mode: Enter Jam (or click empty space) captures the mouse so small flicks steer the wheel and
  letting go of the button picks; hidden where the browser doesn't allow mouse capture
- The layer buttons, icon, title and key badge in the middle of the wheel no longer overlap
- The top bar no longer squeezes the version badge under the bar counter on 1280px-wide screens
- Run it locally on Windows with nothing to install: `start.cmd` starts a small PowerShell
  server that plays the WAV stems straight from your folders (no ffmpeg or Node step)
- `start.cmd -Lan` serves the app to other devices on your local network (one-time admin
  prompt; the firewall rule only admits the local subnet)
- `start.cmd -Public` runs the server behind a reverse proxy for internet use. It only answers the
  proxy (`-TrustedProxy`, this PC by default) and tells visitors apart by `X-Forwarded-For`
- The local server is hardened in every mode. It serves only the app and the media it lists (never
  the rest of the repo), sends security headers including a Content-Security-Policy, and streams
  files in parallel. It also drops stalled clients, limits each visitor's requests and downloads,
  supports ETag revalidation and never shows error details to the browser. Locally and with
  `-Lan` it only answers addresses that name this PC, so other websites can't reach it through
  DNS rebinding. The app waits and retries when the server says it is busy. The Node dev server
  (`serve.mjs`) now only listens on this computer, refuses other host names and never serves
  dot files
- Instrument Guns page on the wheel when the instrument-gun loops are next to the stems:
  backing track, melody gun and rhythm gun as Groove, Lead and Extra. The engine now handles
  loops of any whole number of bars (the Da Funk melody gun is 16 bars)
- Key lock treats a major key as its relative minor, so A major and F♯m mix untouched
- Replacing the auto-key song now re-keys the other layers; a random mix keys every layer
  against the final picks and prefers a different song per layer
- Tempo changes render all layers in parallel (worker pool) and keep your place in the loop
- Bounded caches for decoded and rendered stems (memory no longer grows with every hover)
- Gentle bus compression and a peak limiter so stacked stems don't clip; WAV export renders
  through the same chain and loops without a level bump
- Pressing Stop while a stem is loading no longer restarts playback when it arrives; pressing
  Play while a shared mix is loading starts it once everything is ready
- New time-stretch worker: the loop wrap is crossfaded instead of a hard cut and a click, onsets
  after silence land on the beat (were 11-17 ms late), the near-unity path no longer stutters,
  and pitching up is band-limited instead of aliasing
- Audio runs at 44.1 kHz (the stems' rate) so 48 kHz devices don't tick at the loop point; WAV
  loops are used whole; layers of different loop lengths stay sample-locked
- Fixes from a code review: layers cleared or re-picked during a tempo change, re-keying when
  the key anchor changes, a removed-but-scheduled stem clicking, recordings following the
  volume slider, exported loops starting late (compressor look-ahead), controller users stuck
  without sound or behind the help dialog, Enter after arrow keys picking the wrong thing,
  tempo buttons running away after a right-click, clipped album tiles on phones
- Stage draws about 40% cheaper (cached backdrop, batched paths, frame pacing, no backdrop
  blurs) and follows the audible beat on Bluetooth/HDMI output; reduced motion is respected

## 1.0.0-beta (2026-10-29)

This release replaces the earlier Vite-based Random Access Jam with a rebuild modelled on
The Daft Punk Experience remix station.

- A radial song wheel with one page per album and a hub that switches between the Groove,
  Lead and Extra layers
- Layer cards with mute, volume and remove buttons, plus loading progress
- Tempo and key-lock controls. Hold Audio FX for a filter sweep and echo
- A reactive canvas stage, with an object for each active layer
- Controls for keyboard, mouse, touch and game controllers, and a layout for phones
- Audio engine from MuscularCrab's Dream Chamber Studios Remixed: WSOLA time-stretch and key
  shift, bar-quantized swaps, share links, recording and WAV loop export. Share links from
  that site still work.
- Deployed to Cloudflare (Workers static assets) at hiddenalchemist.com
