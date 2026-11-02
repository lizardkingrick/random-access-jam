// Background stage. js/stage-pyramid.js is the show; this file picks it when the device can run
// it, and otherwise (or if it fails to start) falls back to a black night sky with twinkling stars.
//
// The contract for a stage (main.js calls it once):
//   createStage(canvas, getFrame)
//   - canvas: the full-screen <canvas id="stage"> behind the interface.
//   - getFrame(): call it on EVERY animation frame, even ones you skip drawing; it also advances
//     the bar clock. It returns:
//       meters:   { groove, lead, texture: 0..1 levels of each layer's output,
//                   bass, mid, high: 0..1 band energies, spectrum: Uint8Array(256) analyser bins,
//                   beat: 0..1 phase within the beat, bar: 0..32 position in the loop,
//                   beatIndex: beat number in the loop, or -1 when stopped }
//       active:   { groove, lead, texture } true while that layer is audibly playing
//       playing, bpm
//       fx, fxX:  Audio FX held (0 or 1) and which kind (fxX < 0: low-pass or tape stop)
//       zone:     left edge of the song wheel, as a fraction of the screen width
//       open:     [from, to] the open area between the side panels, as fractions of the width
//                 ([0, 1] when the panels are stacked: phones, portrait)
//       paused:   true while the help dialog covers the screen
//       album:    album id of the first filled layer, or null
//   - Respect prefers-reduced-motion, and keep frames cheap: the interface sits on top.

const TAU = Math.PI * 2;

// Small seeded random, so the stars are in the same places on every load.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function createStarfield(canvas, getFrame) {
  const g = canvas.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let w = 0, h = 0, dpr = 1, t = 0, last = performance.now();
  let sky = null;
  const twinkle = (() => { const r = rng(11); return Array.from({ length: 70 }, () => ({ x: r(), y: r(), ph: r() * TAU, s: 0.5 + r() })); })();

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 1.5);
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw === w && ch === h) return;
    canvas.width = w = cw;
    canvas.height = h = ch;
    if (!w || !h) return;
    // black sky with a static star field, painted once per size
    sky = document.createElement('canvas');
    sky.width = w;
    sky.height = h;
    const s = sky.getContext('2d');
    s.fillStyle = '#000';
    s.fillRect(0, 0, w, h);
    const r = rng(3);
    s.fillStyle = '#fff';
    const n = Math.round((w * h) / (2800 * dpr * dpr));
    for (let k = 0; k < n; k++) {
      s.globalAlpha = 0.25 + r() * 0.75;
      const sz = (r() < 0.06 ? 2 : 1) * dpr;
      s.fillRect(r() * w, r() * h, sz, sz);
    }
    s.globalAlpha = 1;
  }

  let lastDraw = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const f = getFrame(); // every frame: it also advances the clock
    if (now - lastDraw < (f.paused ? 100 : 1000 / 30)) return; // stars don't need more than 30 fps
    lastDraw = now;
    resize();
    if (!w || !h) return; // not laid out yet
    t += reduce.matches ? 0 : Math.min(0.1, (now - last) / 1000);
    last = now;
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.drawImage(sky, 0, 0);
    g.fillStyle = '#fff';
    for (const s of twinkle) {
      g.globalAlpha = 0.15 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.8 * s.s + s.ph));
      const sz = 1.8 * dpr;
      g.fillRect(s.x * w, s.y * h, sz, sz);
    }
    g.globalAlpha = 1;
  }

  requestAnimationFrame(frame);
  return {};
}

// WebGL2 on a real GPU. Software renderers would drag the whole page down, so they get the stars.
function canRunShow() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const name = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return !/swiftshader|llvmpipe|software|basic render/i.test(name);
  } catch (_) { return false; }
}

export function createStage(canvas, getFrame) {
  if (!canRunShow()) return createStarfield(canvas, getFrame);
  // The show is downloaded after the app starts; keep the clock running meanwhile.
  let loading = true;
  const idle = () => { if (loading) { getFrame(); requestAnimationFrame(idle); } };
  requestAnimationFrame(idle);
  import('./stage-pyramid.js')
    .then((m) => { m.createPyramid(canvas, getFrame); loading = false; })
    .catch((err) => {
      console.error('stage failed to start', err);
      loading = false;
      const fresh = canvas.cloneNode(); // a canvas that tried WebGL can't give a 2D context
      canvas.replaceWith(fresh);
      createStarfield(fresh, getFrame);
    });
  return {};
}
