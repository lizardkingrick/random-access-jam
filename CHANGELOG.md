# Changelog

## Unreleased

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
- Phones held upright fit the whole jam on one screen: the layers are three tiles side by side
  under the albums, tempo, key and the Audio FX button share a row with the effects underneath,
  and the wheel shrinks a little on shorter phones instead of pushing the controls off screen.
  Messages show over the title instead of the transport buttons
- New stage: a neon pyramid with its top cut off and the duo in the gap, bopping their heads on the
  beat. Each layer drives part of the light show, cues change every 8 bars and the groove's album
  picks the palette. Devices without a real GPU fall back to a starry night sky. The old stage (dome,
  light strands, floating objects) and the helmet holograms are gone (the helmet models were game
  assets)
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
