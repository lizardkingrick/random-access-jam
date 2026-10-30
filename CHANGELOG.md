# Changelog

## Unreleased

- Run it locally on Windows with nothing to install: `start.cmd` starts a small PowerShell
  server that plays the WAV stems straight from your folders (no ffmpeg or Node step)
- `start.cmd -Lan` serves the app to other devices on your local network (one-time admin
  prompt; the firewall rule only admits the local subnet)
- Instrument Guns page on the wheel when the instrument-gun loops are next to the stems:
  backing track, melody gun and rhythm gun as Groove, Lead and Extra. The engine now handles
  loops of any whole number of bars (the Da Funk melody gun is 16 bars)
- Helmet holograms on the stage when the helmet models are available locally
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
