// @ts-check
/**
 * The Jam Rack: a 4-position board (vocals / drums / bass / lead) — the core
 * model of the app. Each position is sourced INDEPENDENTLY from any loaded
 * track's stem for that role, and all active positions play SIMULTANEOUSLY,
 * summed onto one jam bus (additive — never crossfaded).
 *
 * Grid lock: every position launches on transport.quantizeToNextBar() and is
 * re-created phase-accurately on each transport loop boundary (buffer sources
 * are one-use; recreating them on the shared clock prevents drift). Buffers
 * shorter than the transport loop repeat via source.loop and are started at
 * the correct phase offset, so a 4-bar stem stays locked inside a 16-bar grid.
 *
 * Swaps and clears settle on the next bar boundary with a ~6ms equal gain
 * micro-fade so re-entry never clicks.
 */

export const ROLES = /** @type {const} */ (['vocals', 'drums', 'bass', 'lead']);
/** @typedef {typeof ROLES[number]} Role */

const SWAP_FADE = 0.006; // seconds — micro-fade around bar-boundary swaps
const GAIN_TC = 0.014; // time constant for volume/mute/solo ramps

/**
 * @typedef {{
 *   role: Role,
 *   trackId: string | null,
 *   title: string,
 *   buffer: AudioBuffer | null,
 *   pending: { trackId: string | null, title: string, buffer: AudioBuffer | null } | null,
 *   source: AudioBufferSourceNode | null,
 *   srcGain: GainNode | null,
 *   gain: GainNode,
 *   eq: BiquadFilterNode | null,
 *   meter: AnalyserNode,
 *   volume: number,
 *   muted: boolean,
 *   soloed: boolean,
 *   adjusting: boolean,
 * }} Position
 */

export class JamRack {
  /**
   * @param {AudioContext} ctx
   * @param {import('./transport.js').Transport} transport
   * @param {AudioNode} output where the jam bus feeds (the FX input)
   */
  constructor(ctx, transport, output) {
    this.ctx = ctx;
    this.transport = transport;

    this.bus = ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(output);

    /** @type {Record<Role, Position>} */
    this.positions = /** @type {any} */ ({});
    for (const role of ROLES) {
      const gain = ctx.createGain();
      // Per-position EQ "glue": a gentle highpass on non-bass roles cuts the
      // low-mid mud that piles up when stems from different songs stack.
      /** @type {BiquadFilterNode | null} */
      let eq = null;
      if (role !== 'bass') {
        eq = ctx.createBiquadFilter();
        eq.type = 'highpass';
        eq.frequency.value = 120;
        eq.Q.value = 0.7;
        gain.connect(eq);
        eq.connect(this.bus);
      } else {
        gain.connect(this.bus);
      }
      // Level-meter tap (post-gain, so mute/solo/volume show in the meter).
      const meter = ctx.createAnalyser();
      meter.fftSize = 512;
      meter.smoothingTimeConstant = 0.4;
      gain.connect(meter);
      this.positions[role] = {
        role,
        trackId: null,
        title: '',
        buffer: null,
        pending: null,
        source: null,
        srcGain: null,
        gain,
        eq,
        meter,
        volume: 1,
        muted: false,
        soloed: false,
        adjusting: false,
      };
    }

    /** @type {((role: Role) => void) | null} UI hook: a position's assignment changed */
    this.onPositionChanged = null;

    this._unsubs = [
      // Loop boundary: recreate every source in lockstep (also fires at start).
      transport.on('loop', (/** @type {number} */ time) => this._restartAll(time)),
      transport.on('stop', () => this._stopAll()),
    ];
  }

  /** True if any position is soloed (affects everyone's effective gain). */
  get anySolo() {
    return ROLES.some((r) => this.positions[r].soloed);
  }

  /**
   * Put a stem buffer into a position. The other three positions keep playing
   * untouched. If the transport is running, the stem enters on the next bar
   * boundary; if not, it waits for transport start (the first loop event).
   * @param {Role} role
   * @param {{ trackId: string, title: string, buffer: AudioBuffer }} stem
   */
  assignPosition(role, stem) {
    const pos = this.positions[role];
    pos.trackId = stem.trackId;
    pos.title = stem.title;
    pos.buffer = stem.buffer;
    pos.pending = null;
    if (this.transport.isPlaying) {
      this._launch(pos, this.transport.quantizeToNextBar());
    }
    this.onPositionChanged?.(role);
  }

  /**
   * Queue a replacement buffer (e.g. re-conformed to a new grid) that takes
   * over at the NEXT LOOP boundary — never mid-loop, so no audible glitch.
   * @param {Role} role
   * @param {AudioBuffer} buffer
   */
  queueBufferSwap(role, buffer) {
    const pos = this.positions[role];
    if (!pos.trackId) return;
    pos.pending = { trackId: pos.trackId, title: pos.title, buffer };
    if (!this.transport.isPlaying) {
      pos.buffer = buffer;
      pos.pending = null;
    }
  }

  /** @param {Role} role */
  clearPosition(role) {
    const pos = this.positions[role];
    pos.trackId = null;
    pos.title = '';
    pos.buffer = null;
    pos.pending = null;
    this._stopSource(pos, this.transport.isPlaying ? this.transport.quantizeToNextBar() : undefined);
    this.onPositionChanged?.(role);
  }

  /** @param {Role} role @param {number} v 0..1.4 */
  setVolume(role, v) {
    this.positions[role].volume = Math.min(Math.max(v, 0), 1.4);
    this._applyGains();
  }

  /** @param {Role} role @param {boolean} muted */
  mute(role, muted) {
    this.positions[role].muted = muted;
    this._applyGains();
  }

  /**
   * Solo semantics: while any solo is active, every non-soloed position is
   * silent; clearing all solos restores mutes/volumes.
   * @param {Role} role @param {boolean} soloed
   */
  solo(role, soloed) {
    this.positions[role].soloed = soloed;
    this._applyGains();
  }

  /** @param {Role} role @param {boolean} adjusting */
  setAdjusting(role, adjusting) {
    this.positions[role].adjusting = adjusting;
    this.onPositionChanged?.(role);
  }

  /**
   * Instantaneous peak level 0..1 for a position (for UI meters; call from
   * the shared visual ticker only).
   * @param {Role} role
   */
  getLevel(role) {
    const pos = this.positions[role];
    if (!pos.source) return 0;
    if (!this._meterData) this._meterData = new Uint8Array(pos.meter.fftSize);
    pos.meter.getByteTimeDomainData(this._meterData);
    let peak = 0;
    for (let i = 0; i < this._meterData.length; i++) {
      const v = Math.abs(this._meterData[i] - 128);
      if (v > peak) peak = v;
    }
    return Math.min(peak / 110, 1);
  }

  /** Snapshot for UI rendering. @param {Role} role */
  getPosition(role) {
    const p = this.positions[role];
    return {
      role,
      trackId: p.trackId,
      title: p.title,
      hasBuffer: Boolean(p.buffer),
      volume: p.volume,
      muted: p.muted,
      soloed: p.soloed,
      adjusting: p.adjusting,
      audible: Boolean(p.buffer) && !p.muted && (!this.anySolo || p.soloed),
    };
  }

  dispose() {
    for (const unsub of this._unsubs) unsub();
    this._stopAll();
    for (const role of ROLES) {
      this.positions[role].gain.disconnect();
      this.positions[role].eq?.disconnect();
    }
    this.bus.disconnect();
  }

  // ---------- internals ----------

  /** Effective gain for a position under mute/solo rules. @param {Position} pos */
  _effectiveGain(pos) {
    if (pos.muted) return 0;
    if (this.anySolo && !pos.soloed) return 0;
    return pos.volume;
  }

  _applyGains() {
    const t = this.ctx.currentTime;
    for (const role of ROLES) {
      const pos = this.positions[role];
      pos.gain.gain.cancelScheduledValues(t);
      pos.gain.gain.setTargetAtTime(this._effectiveGain(pos), t, GAIN_TC);
    }
  }

  /**
   * Start (or re-enter) a position's source at an exact grid time, at the
   * correct phase offset within the transport loop.
   * @param {Position} pos @param {number} when audio time (a bar boundary)
   */
  _launch(pos, when) {
    if (!pos.buffer) return;
    this._stopSource(pos, when);

    const source = this.ctx.createBufferSource();
    source.buffer = pos.buffer;
    source.loop = true;

    const srcGain = this.ctx.createGain();
    // Micro-fade in so re-entry at the boundary never clicks.
    srcGain.gain.setValueAtTime(0, when);
    srcGain.gain.linearRampToValueAtTime(1, when + SWAP_FADE);
    source.connect(srcGain);
    srcGain.connect(pos.gain);

    // Phase offset: where inside the transport loop does `when` fall?
    const barIndex = this.transport.barIndexAt(when + 0.001);
    const secondsIntoLoop = barIndex * this.transport.barLengthSeconds;
    const offset = pos.buffer.duration > 0 ? secondsIntoLoop % pos.buffer.duration : 0;

    source.start(when, offset);
    pos.source = source;
    pos.srcGain = srcGain;
  }

  /**
   * Fade out and stop a position's current source at `when` (defaults to now).
   * @param {Position} pos @param {number} [when]
   */
  _stopSource(pos, when) {
    const { source, srcGain } = pos;
    if (!source || !srcGain) return;
    pos.source = null;
    pos.srcGain = null;
    const t = when ?? this.ctx.currentTime;
    srcGain.gain.cancelScheduledValues(t - SWAP_FADE);
    srcGain.gain.setValueAtTime(1, Math.max(t - SWAP_FADE, this.ctx.currentTime));
    srcGain.gain.linearRampToValueAtTime(0, t + SWAP_FADE / 2);
    try {
      source.stop(t + SWAP_FADE);
    } catch {
      // already stopped
    }
  }

  /** Loop boundary: apply pending swaps and re-create all sources in lockstep. */
  _restartAll(time) {
    for (const role of ROLES) {
      const pos = this.positions[role];
      if (pos.pending) {
        pos.buffer = pos.pending.buffer;
        pos.pending = null;
        this.onPositionChanged?.(role);
      }
      if (pos.buffer) this._launch(pos, time);
    }
  }

  _stopAll() {
    for (const role of ROLES) this._stopSource(this.positions[role]);
  }
}
