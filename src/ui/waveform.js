// @ts-check
/**
 * Canvas waveform: renders min/max peak bars for a decoded AudioBuffer,
 * an animated playhead, and click/drag-to-seek.
 */

const PEAK_COLUMNS = 400; // peaks are computed once at this resolution and scaled on draw

/**
 * Compute min/max peaks from an AudioBuffer (all channels merged).
 * @param {AudioBuffer} buffer
 * @returns {Float32Array} interleaved [min0, max0, min1, max1, ...]
 */
export function computePeaks(buffer) {
  const peaks = new Float32Array(PEAK_COLUMNS * 2);
  const length = buffer.length;
  const step = length / PEAK_COLUMNS;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));

  for (let i = 0; i < PEAK_COLUMNS; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(Math.floor((i + 1) * step), length);
    let min = 0;
    let max = 0;
    // Sample sparsely inside the window; exact peaks aren't worth the scan cost.
    const stride = Math.max(1, Math.floor((end - start) / 64));
    for (const data of channels) {
      for (let j = start; j < end; j += stride) {
        const v = data[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    peaks[i * 2] = min;
    peaks[i * 2 + 1] = max;
  }
  return peaks;
}

/**
 * @param {HTMLElement} container element the canvas mounts into (position: relative)
 * @param {{ color?: string, onSeek?: (fraction: number) => void }} [opts]
 */
export function createWaveform(container, opts = {}) {
  const canvas = document.createElement('canvas');
  container.append(canvas);
  const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

  /** @type {Float32Array | null} */
  let peaks = null;
  let progress = 0;
  let color = opts.color ?? '#35c9ff';
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let needsRedraw = true;

  const resize = () => {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    cssW = rect.width;
    cssH = rect.height;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    needsRedraw = true;
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  function draw() {
    if (!needsRedraw || cssW === 0) return;
    needsRedraw = false;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!peaks) return;

    const mid = cssH / 2;
    const columns = peaks.length / 2;
    const colW = cssW / columns;
    const playX = progress * cssW;

    for (let pass = 0; pass < 2; pass++) {
      // pass 0: played (bright), pass 1: remaining (dim)
      ctx.fillStyle = color;
      ctx.globalAlpha = pass === 0 ? 0.95 : 0.32;
      for (let i = 0; i < columns; i++) {
        const x = i * colW;
        const played = x + colW / 2 <= playX;
        if ((pass === 0) !== played) continue;
        const min = peaks[i * 2];
        const max = peaks[i * 2 + 1];
        const y = mid - max * mid;
        const h = Math.max(1, (max - min) * mid);
        ctx.fillRect(x, y, Math.max(colW - 0.5, 0.5), h);
      }
    }
    ctx.globalAlpha = 1;

    // playhead
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(playX - 0.75, 0, 1.5, cssH);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.fillRect(playX - 3, 0, 6, cssH);
    ctx.globalAlpha = 1;
  }

  /** @param {PointerEvent} e */
  const seekFromEvent = (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - rect.left, 0), rect.width);
    opts.onSeek?.(rect.width ? x / rect.width : 0);
  };

  let dragging = false;
  canvas.addEventListener('pointerdown', (e) => {
    if (!peaks || !opts.onSeek) return;
    dragging = true;
    canvas.setPointerCapture(e.pointerId);
    seekFromEvent(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (dragging) seekFromEvent(e);
  });
  canvas.addEventListener('pointerup', () => (dragging = false));
  canvas.addEventListener('pointercancel', () => (dragging = false));

  return {
    canvas,
    /** @param {AudioBuffer | null} buffer */
    setBuffer(buffer) {
      peaks = buffer ? computePeaks(buffer) : null;
      needsRedraw = true;
      draw();
    },
    /** @param {Float32Array | null} p precomputed peaks */
    setPeaks(p) {
      peaks = p;
      needsRedraw = true;
      draw();
    },
    /** @param {number} fraction 0..1 */
    setProgress(fraction) {
      const next = Math.min(Math.max(fraction, 0), 1);
      if (Math.abs(next - progress) < 0.0005) return;
      progress = next;
      needsRedraw = true;
    },
    /** Called from the shared ticker. */
    render() {
      draw();
    },
    destroy() {
      ro.disconnect();
      canvas.remove();
    },
  };
}

/**
 * Generate gentle placeholder peaks for empty/demo states.
 * @returns {Float32Array}
 */
export function placeholderPeaks() {
  const peaks = new Float32Array(PEAK_COLUMNS * 2);
  for (let i = 0; i < PEAK_COLUMNS; i++) {
    const t = i / PEAK_COLUMNS;
    const env = 0.25 + 0.5 * Math.abs(Math.sin(t * Math.PI * 6)) * (0.6 + 0.4 * Math.sin(t * Math.PI));
    const jitter = 0.15 * Math.sin(i * 12.9898) * Math.sin(i * 0.5);
    const v = Math.max(0.04, env + jitter);
    peaks[i * 2] = -v;
    peaks[i * 2 + 1] = v;
  }
  return peaks;
}
