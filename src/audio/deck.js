// @ts-check
/**
 * Deck: owns one AudioBuffer and manages playback.
 *
 * AudioBufferSourceNode is one-shot, so every play/seek/rate change creates a
 * fresh source node. Position is tracked manually:
 *   - `offset`     seconds into the buffer where playback last (re)started
 *   - `startedAt`  ctx.currentTime at that moment
 *   - position     = offset + (ctx.currentTime - startedAt) * rate   (mod duration when looping)
 * Rate changes checkpoint the offset first, otherwise the position drifts.
 */

const FADE = 0.008; // seconds — micro-fade on pause/stop to avoid clicks
const MUTE_TC = 0.012; // time constant for mute ramps

export class Deck {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} output crossfader gain for this deck
   * @param {'a' | 'b'} id
   */
  constructor(ctx, output, id) {
    this.ctx = ctx;
    this.id = id;

    /** Fade gain absorbs pause/stop micro-fades; mute gain holds the mute state. */
    this.fadeGain = ctx.createGain();
    this.muteGain = ctx.createGain();
    this.fadeGain.connect(this.muteGain);
    this.muteGain.connect(output);

    /** @type {AudioBuffer | null} */
    this.buffer = null;
    /** @type {{ id: string, title: string, artist?: string } | null} */
    this.track = null;
    /** @type {AudioBufferSourceNode | null} */
    this.source = null;

    this.playing = false;
    this.muted = false;
    this.loop = false;
    this.rate = 1;
    this.offset = 0;
    this.startedAt = 0;

    /** @type {(() => void) | null} fired when a non-looping track plays to the end */
    this.onEnded = null;
    /** @type {number} generation counter so stale onended callbacks are ignored */
    this._gen = 0;
  }

  get duration() {
    return this.buffer?.duration ?? 0;
  }

  /** Current playback position in seconds. */
  get position() {
    if (!this.buffer) return 0;
    let pos = this.offset;
    if (this.playing) pos += (this.ctx.currentTime - this.startedAt) * this.rate;
    if (this.loop && this.duration > 0) return ((pos % this.duration) + this.duration) % this.duration;
    return Math.min(Math.max(pos, 0), this.duration);
  }

  /**
   * Load a decoded buffer. Stops any current playback.
   * @param {AudioBuffer} buffer
   * @param {{ id: string, title: string, artist?: string }} track
   * @param {{ loop?: boolean, autoplay?: boolean }} [opts]
   */
  load(buffer, track, opts = {}) {
    this.stop();
    this.buffer = buffer;
    this.track = track;
    this.loop = opts.loop ?? false;
    this.offset = 0;
    if (opts.autoplay) this.play();
  }

  /** Remove the current track entirely. */
  eject() {
    this.stop();
    this.buffer = null;
    this.track = null;
    this.offset = 0;
  }

  play() {
    if (!this.buffer || this.playing) return;
    const ctx = this.ctx;
    const source = ctx.createBufferSource();
    source.buffer = this.buffer;
    source.loop = this.loop;
    source.playbackRate.value = this.rate;
    source.connect(this.fadeGain);

    const startOffset = this.loop && this.duration > 0 ? this.position : Math.min(this.offset, this.duration);
    this.offset = startOffset;
    this.startedAt = ctx.currentTime;

    // Ramp the fade gain up from silence so (re)starts never click.
    this.fadeGain.gain.cancelScheduledValues(ctx.currentTime);
    this.fadeGain.gain.setValueAtTime(0, ctx.currentTime);
    this.fadeGain.gain.linearRampToValueAtTime(1, ctx.currentTime + FADE);

    const gen = ++this._gen;
    source.onended = () => {
      if (gen !== this._gen || this.loop) return;
      // Natural end of a non-looping track.
      this.playing = false;
      this.source = null;
      this.offset = 0;
      this.onEnded?.();
    };

    source.start(ctx.currentTime, startOffset);
    this.source = source;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._checkpoint();
    this._stopSource();
    this.playing = false;
  }

  /** Stop and rewind to the start. */
  stop() {
    if (this.source) this._stopSource();
    this.playing = false;
    this.offset = 0;
  }

  /**
   * Jump to a position (seconds). Restarts the source if playing.
   * @param {number} seconds
   */
  seek(seconds) {
    if (!this.buffer) return;
    const target = Math.min(Math.max(seconds, 0), this.duration);
    if (this.playing) {
      this._stopSource();
      this.playing = false;
      this.offset = target;
      this.play();
    } else {
      this.offset = target;
    }
  }

  /** @param {number} fraction 0..1 */
  seekFraction(fraction) {
    this.seek(fraction * this.duration);
  }

  /**
   * Change playback rate. Checkpoints the position first so it doesn't drift.
   * @param {number} rate
   */
  setRate(rate) {
    if (rate === this.rate) return;
    if (this.playing && this.source) {
      this._checkpoint();
      this.startedAt = this.ctx.currentTime;
      this.source.playbackRate.setValueAtTime(rate, this.ctx.currentTime);
    }
    this.rate = rate;
  }

  /** @param {boolean} muted */
  setMuted(muted) {
    this.muted = muted;
    const t = this.ctx.currentTime;
    this.muteGain.gain.cancelScheduledValues(t);
    this.muteGain.gain.setTargetAtTime(muted ? 0 : 1, t, MUTE_TC);
  }

  /** Fold elapsed play time into `offset`. */
  _checkpoint() {
    this.offset = this.position;
    this.startedAt = this.ctx.currentTime;
  }

  /** Fade out and stop the current source without firing onEnded. */
  _stopSource() {
    const source = this.source;
    if (!source) return;
    this._gen++; // invalidate onended
    this.source = null;
    const t = this.ctx.currentTime;
    this.fadeGain.gain.cancelScheduledValues(t);
    this.fadeGain.gain.setValueAtTime(this.fadeGain.gain.value, t);
    this.fadeGain.gain.linearRampToValueAtTime(0, t + FADE);
    try {
      source.stop(t + FADE + 0.002);
    } catch {
      // already stopped — fine
    }
  }
}
