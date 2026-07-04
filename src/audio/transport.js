// @ts-check
/**
 * Master transport clock: owns tempo, the bar grid, and a look-ahead scheduler
 * (Chris Wilson "two clocks" pattern). A coarse setTimeout pump wakes every
 * ~25ms and schedules every beat boundary that falls inside a 100ms window on
 * the AudioContext clock — so JS timer jitter never touches audible timing.
 * Everything downstream (metronome now, jam-rack loop launches later) books
 * audio events against the precise beat times this class emits.
 *
 * All times passed to callbacks are AudioContext times (seconds).
 */

export const BPM_MIN = 90;
export const BPM_MAX = 157;

const LOOKAHEAD_MS = 25; // pump interval (coarse JS clock)
const SCHEDULE_AHEAD = 0.1; // seconds of audio-clock lookahead (precise clock)

/**
 * @typedef {'beat' | 'bar' | 'loop' | 'gridChanged' | 'start' | 'stop'} TransportEvent
 */

export class Transport {
  /**
   * @param {AudioContext} ctx
   * @param {{ bpm?: number, beatsPerBar?: number, bars?: number }} [opts]
   */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.beatsPerBar = opts.beatsPerBar ?? 4;
    this.bars = opts.bars ?? 16; // loop length in bars
    this._bpm = clampBpm(opts.bpm ?? 120);

    this.isPlaying = false;
    this._timer = 0;
    /** Audio time at which `_anchorBeat` falls (grid anchor). */
    this._anchorTime = 0;
    /** Absolute (float) beat index at the anchor; re-anchoring on setBpm keeps position. */
    this._anchorBeat = 0;
    /** Next absolute beat index the pump will schedule. */
    this._nextBeat = 0;

    /** @type {Map<TransportEvent, Set<Function>>} */
    this._listeners = new Map();
  }

  get bpm() {
    return this._bpm;
  }

  get secondsPerBeat() {
    return 60 / this._bpm;
  }

  get barLengthSeconds() {
    return this.beatsPerBar * this.secondsPerBeat;
  }

  get loopLengthSeconds() {
    return this.bars * this.barLengthSeconds;
  }

  /** Absolute beat position (float) at an audio time. */
  beatAt(time = this.ctx.currentTime) {
    return this._anchorBeat + (time - this._anchorTime) / this.secondsPerBeat;
  }

  /** Audio time of an absolute beat index. */
  timeOfBeat(beat) {
    return this._anchorTime + (beat - this._anchorBeat) * this.secondsPerBeat;
  }

  /** Bar index within the loop (0..bars-1) at an audio time. */
  barIndexAt(time = this.ctx.currentTime) {
    const bar = Math.floor(this.beatAt(time) / this.beatsPerBar);
    return ((bar % this.bars) + this.bars) % this.bars;
  }

  /**
   * Subscribe. Returns an unsubscribe function.
   * beat → (barIndex, beatIndex, time); bar → (barIndex, time); loop → (time);
   * gridChanged → (bpm); start/stop → ().
   * @param {TransportEvent} event
   * @param {Function} cb
   */
  on(event, cb) {
    let set = this._listeners.get(event);
    if (!set) this._listeners.set(event, (set = new Set()));
    set.add(cb);
    return () => set.delete(cb);
  }

  /** @param {TransportEvent} event @param {...*} args */
  _emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of set) cb(...args);
  }

  start() {
    if (this.isPlaying) return;
    this.isPlaying = true;
    // Anchor beat 0 slightly ahead so the first downbeat is schedulable.
    this._anchorTime = this.ctx.currentTime + 0.06;
    this._anchorBeat = 0;
    this._nextBeat = 0;
    this._emit('start');
    this._pump();
  }

  stop() {
    if (!this.isPlaying) return;
    this.isPlaying = false;
    clearTimeout(this._timer);
    this._timer = 0;
    this._emit('stop');
  }

  /**
   * Audio time of the next bar boundary — the quantized launch point for
   * loops. Guaranteed to be far enough ahead to schedule against (≥10ms out).
   */
  quantizeToNextBar() {
    if (!this.isPlaying) {
      // Not running: the caller's launch effectively defines the grid start.
      return this.ctx.currentTime + 0.06;
    }
    const now = this.ctx.currentTime;
    const beatNow = this.beatAt(now + 0.01); // small guard so "exactly on the line" rolls over
    const nextBarBeat = Math.ceil(beatNow / this.beatsPerBar) * this.beatsPerBar;
    return this.timeOfBeat(nextBarBeat);
  }

  /**
   * Change tempo. Re-anchors the grid at the current musical position so no
   * beat is skipped or doubled, then notifies listeners to re-conform.
   * @param {number} bpm
   */
  setBpm(bpm) {
    const next = clampBpm(bpm);
    if (next === this._bpm) return;
    if (this.isPlaying) {
      const now = this.ctx.currentTime;
      this._anchorBeat = this.beatAt(now);
      this._anchorTime = now;
    }
    this._bpm = next;
    this._emit('gridChanged', next);
  }

  /** Look-ahead pump: schedule every beat inside the audio-clock window. */
  _pump() {
    if (!this.isPlaying) return;
    const horizon = this.ctx.currentTime + SCHEDULE_AHEAD;
    while (this.timeOfBeat(this._nextBeat) < horizon) {
      const beat = this._nextBeat++;
      const time = this.timeOfBeat(beat);
      const absBar = Math.floor(beat / this.beatsPerBar);
      const barIndex = ((absBar % this.bars) + this.bars) % this.bars;
      const beatIndex = ((beat % this.beatsPerBar) + this.beatsPerBar) % this.beatsPerBar;
      this._emit('beat', barIndex, beatIndex, time);
      if (beatIndex === 0) {
        this._emit('bar', barIndex, time);
        if (barIndex === 0) this._emit('loop', time);
      }
    }
    this._timer = window.setTimeout(() => this._pump(), LOOKAHEAD_MS);
  }
}

/** @param {number} bpm */
function clampBpm(bpm) {
  return Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(bpm)));
}

/**
 * TEMPORARY (Phase 1 proof): a metronome that blips on every scheduled beat,
 * accented on each bar's downbeat, extra-bright on the loop downbeat.
 * Will be removed once the jam rack replaces it as the audible grid proof.
 *
 * @param {AudioContext} ctx
 * @param {Transport} transport
 * @param {AudioNode} output
 */
export function createMetronome(ctx, transport, output) {
  let enabled = false;
  /** @type {(() => void) | null} */
  let unsubscribe = null;

  /** @param {number} barIndex @param {number} beatIndex @param {number} time */
  function blip(barIndex, beatIndex, time) {
    const accent = beatIndex === 0;
    const loopStart = accent && barIndex === 0;
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = loopStart ? 1760 : accent ? 1320 : 880;
    const g = ctx.createGain();
    const peak = accent ? 0.22 : 0.12;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, time + 0.06);
    osc.connect(g).connect(output);
    osc.start(time);
    osc.stop(time + 0.08);
  }

  return {
    get enabled() {
      return enabled;
    },
    /** @param {boolean} next */
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      if (enabled) {
        unsubscribe = transport.on('beat', blip);
        if (!transport.isPlaying) transport.start();
      } else {
        unsubscribe?.();
        unsubscribe = null;
      }
    },
    toggle() {
      this.setEnabled(!enabled);
      return enabled;
    },
  };
}
