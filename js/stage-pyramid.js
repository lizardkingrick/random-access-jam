// The stage: a live concert seen from the crowd. A pyramid of LED panels with two figures in its
// cockpit, a lighting rig, haze, and an audience in silhouette, shot on a long lens.
//
// It is run like a lighting desk rather than a meter. Each stem layer owns part of the rig, so the
// show builds as layers are added:
//   Groove  the pyramid's LED programs and the crowd
//   Lead    the moving heads and lasers
//   Extra   the side towers, the air and the phone lights
// A cue changes every 8 bars (LED program, beams, camera) and everything moves in musical time.
// Most of the screen stays dark, one palette plays at a time, and the white hit is kept for the
// phrase changes. The groove's album picks the palette.

import {
  AdditiveBlending, BoxGeometry, BufferAttribute, BufferGeometry, CanvasTexture, CylinderGeometry, DataTexture,
  FloatType, FrontSide, HalfFloatType, InstancedBufferAttribute, InstancedMesh, LinearFilter, LinearMipmapLinearFilter,
  LinearSRGBColorSpace, Mesh, NoToneMapping, Object3D, OrthographicCamera, PerspectiveCamera, PlaneGeometry, Points,
  Quaternion, RedFormat, RGBAFormat, BackSide, Scene, ShaderMaterial, UnsignedByteType, Vector2, Vector3,
  WebGLRenderer, WebGLRenderTarget,
} from './vendor/three.min.js';

const TAU = Math.PI * 2;

// Pyramid size in metres: half the base width, height, and half the depth.
const W = 15.5, H = 17.5, D = 15.5;
const SLOPE = Math.hypot(H, D);
const EDGE = SLOPE / Math.hypot(SLOPE, W); // slanted-edge distance factor, in face space
const INRADIUS = (W * SLOPE) / (W + Math.hypot(W, SLOPE));
const COCKPIT = { halfW: 3.1, s0: 5.6, s1: 10 }; // the opening in the front face, in face space

// [a, b] per album: the main colour and the accent, linear RGB.
const PALETTES = {
  homework: [[1, 0.05, 0.02], [1, 0.42, 0.1]],
  discovery: [[0.1, 0.32, 1], [0.95, 0.12, 0.42]],
  haa: [[1, 0.015, 0.02], [1, 0.92, 0.86]],
  ram: [[1, 0.5, 0.09], [1, 0.84, 0.55]],
  weeknd: [[0.9, 0.012, 0.1], [0.42, 0.05, 1]],
  alive: [[1, 0.035, 0.02], [0.72, 0.82, 1]],
};
const paletteFor = (album) => PALETTES[Object.keys(PALETTES).find((k) => (album || '').includes(k))] || PALETTES.alive;

// One cue per 8 bars. `prog` is an LED program (see FACE_FRAG), `beam` an aim pattern.
const CUES = [
  { prog: 0, beam: 'fan', cam: 0, swap: false, laser: false },
  { prog: 2, beam: 'cross', cam: 1, swap: false, laser: false },
  { prog: 5, beam: 'still', cam: 4, swap: true, laser: true },
  { prog: 1, beam: 'sweep', cam: 3, swap: false, laser: false },
  { prog: 3, beam: 'fan', cam: 0, swap: true, laser: false },
  { prog: 4, beam: 'wave', cam: 2, swap: false, laser: true },
  { prog: 2, beam: 'cross', cam: 4, swap: true, laser: false },
];

// Long lenses from inside the crowd: [position, target, vertical fov]. Every shot keeps the whole
// pyramid in frame except the last, which is on the booth.
const CAMS = [
  [[0, 2.3, 44], [0, 10.4, 0], 32],
  [[-24, 3, 36], [1, 9.6, 2], 30],
  [[14, 2.6, 47], [0, 10, 0], 30],
  [[21, 2, 41], [-1, 9.4, 0], 35],
  [[-2, 3, 48], [0, 6.1, 7], 12],
];

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
// A head nod through one beat: down fast on the beat, back up slowly, and level before the next.
const nodShape = (p) => smooth(0, 0.14, p) * (1 - smooth(0.14, 0.86, p));
const approach = (v, to, dt, attack, release) => v + (to - v) * (1 - Math.exp(-dt * (to > v ? attack : release)));

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const NOISE = /* glsl */`
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3. - 2. * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p) { return .55 * noise(p) + .3 * noise(p * 2.1 + 3.7) + .15 * noise(p * 4.3 + 9.2); }
`;

// ---------- the pyramid's LED faces ----------
const FACE_VERT = /* glsl */`
  attribute vec3 aFace;
  varying vec3 vP;
  varying vec3 vW;
  void main() {
    vP = aFace;
    vec4 w = modelMatrix * vec4(position, 1.);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const FACE_FRAG = /* glsl */`
  uniform float uT, uKick, uLevel, uHit, uGate, uIdle, uGlow, uRes;
  uniform int uProg;
  uniform vec3 uA, uB;
  uniform sampler2D uSpec;
  varying vec3 vP;
  varying vec3 vW;
  ${NOISE}
  const float W = ${W.toFixed(2)}, S = ${SLOPE.toFixed(3)}, EDGE = ${EDGE.toFixed(4)}, INR = ${INRADIUS.toFixed(3)};
  const float PITCH = .22, LINES = 35.;

  void main() {
    vec2 p = vP.xy;
    float side = vP.z;
    if (side < .5 && abs(p.x) < ${COCKPIT.halfW.toFixed(2)} && p.y > ${COCKPIT.s0.toFixed(2)} && p.y < ${COCKPIT.s1.toFixed(2)}) discard;

    float v = p.y / S;
    float halfw = W * (1. - v);
    float nx = p.x / max(halfw, .001);
    float q = min(p.y, (halfw - abs(p.x)) * EDGE) / INR; // 0 at the edge, 1 at the centre

    // The face is dark steel carrying concentric runs of LED tube, grouped in seven tiers.
    float linePos = q * LINES;
    float id = floor(linePos), lf = fract(linePos);
    float tier = floor(id / 5.);
    float aw = fwidth(linePos);
    float thick = .24;
    float tube = 1. - smoothstep(thick - aw, thick + aw, abs(lf - .5));
    tube *= mod(id, 5.) < 4. ? 1. : 0.; // a gap between tiers

    // along each tube: the angle around the centre of the face, and the diodes
    float along = atan(p.y - INR, p.x) / 6.283185 + .5;
    float dw = fwidth(p.x + p.y) / PITCH;
    float diode = mix(.55 + .45 * smoothstep(.2, .05, abs(fract((p.x + p.y) / PITCH) - .5)), .72, clamp(dw, 0., 1.));
    float run = .8 + .34 * hash(vec2(id, side + 1.));           // no two runs quite match

    float t = uT + side * .5;
    float i = 0., m = 0.;
    float lineU = id / LINES;
    if (uProg == 0) {            // rings of light travelling inward, one tier a beat
      float f = fract(tier / 7. * 2. + lineU * .5 - t * .25);
      i = pow(1. - f, 9.) * 1.6 + .018;
      m = step(.86, fract(tier * .5 + .2));
    } else if (uProg == 1) {     // the groove fills the pyramid from the base
      float lvl = uLevel * .92 + .06;
      i = smoothstep(lvl, lvl - .34, v) * .75 + smoothstep(.03, .0, abs(v - lvl)) * 1.8;
      m = smoothstep(lvl - .12, lvl, v);
    } else if (uProg == 2) {     // the spectrum, mirrored, bass in the middle reaching the top
      float col = (floor(abs(p.x) / .5) + .5) * .5 / W;
      float a = texture2D(uSpec, vec2(col * col * .9 + .004, .5)).r;
      i = smoothstep(a * 1.04, a * .72, v) * (.2 + 1.1 * v / max(a, .06)) + smoothstep(.022, .0, abs(v - a)) * 1.8;
      m = smoothstep(.55, 1., v / max(a, .06));
    } else if (uProg == 3) {     // a soft bar crossing on every beat
      float dir = mod(floor(t), 2.) * 2. - 1.;
      float pos = dir * (fract(t) * 2.5 - 1.25);
      float d = (nx - pos) * dir;
      i = exp(-max(-d, 0.) * 3.2) * step(d, .02) * 1.4;
      m = smoothstep(-.1, .02, d);
    } else if (uProg == 4) {     // runs of tube firing at random, sixteenths
      float tick = floor(t * 4.);
      vec2 seg = vec2(floor(along * 40.), id);
      float r = hash(seg * .73 + tick * .37 + side);
      i = step(.8, r) * (1. - fract(t * 4.) * .75) * 1.5;
      m = step(.95, r);
    } else {                     // a comet running around the tiers
      float sgn = mod(tier, 2.) * 2. - 1.;
      float f = fract(along + tier * .13 * sgn - t * .25 * sgn);
      i = pow(f, 7.) * 2.2;
      m = step(.975, f);
    }

    float fade = .72 + .28 * sin(v * 3.1);
    vec3 c = mix(uA, uB, m) * i * (.42 + uKick * .85) * uGate * 3.3 * run * diode * fade * tube;
    c += vec3(1., .96, .9) * uHit * 2.4 * tube * diode;

    // the unlit steel catches a little of the room; a sliver of it keeps the shape readable
    c += (uA * .018 + .0035) * (.25 + uGlow) * (.5 + .5 * v);
    // standby: only the tiers breathing, faintly
    c += uA * uIdle * .05 * tube * step(mod(id, 10.), 3.) * (.55 + .45 * sin(uT * .9 - tier));
    gl_FragColor = vec4(c, 1.);
  }
`;

function pyramidGeometry() {
  const faces = [
    [[-W, 0, D], [W, 0, D], [0, H, 0]],   // front
    [[-W, 0, -D], [-W, 0, D], [0, H, 0]], // left
    [[W, 0, D], [W, 0, -D], [0, H, 0]],   // right
  ];
  const pos = [], face = [];
  faces.forEach((f, id) => {
    f.forEach((v, k) => {
      pos.push(...v);
      face.push(k === 0 ? -W : k === 1 ? W : 0, k === 2 ? SLOPE : 0, id);
    });
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('aFace', new BufferAttribute(new Float32Array(face), 3));
  return g;
}

// The cockpit: a booth let into the front face, lit from behind.
function paintCanvas(w, h, paint) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  paint(c.getContext('2d'));
  const t = new CanvasTexture(c);
  t.colorSpace = LinearSRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  return t;
}

const cockpitTexture = () => paintCanvas(1024, 512, (g) => {
  g.fillStyle = '#000';
  g.fillRect(0, 0, 1024, 512);
  g.globalCompositeOperation = 'lighter';
  for (const x of [286, 738]) {
    const pool = g.createRadialGradient(x, 190, 10, x, 210, 250);
    pool.addColorStop(0, '#fff');
    pool.addColorStop(0.5, '#555');
    pool.addColorStop(1, '#000');
    g.fillStyle = pool;
    g.fillRect(0, 0, 1024, 512);
  }
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(0,0,0,.5)';
  for (let x = 0; x < 1024; x += 30) g.fillRect(x, 0, 2, 512);
  for (let y = 0; y < 512; y += 30) g.fillRect(0, y, 1024, 2);
});

// The two of them: dark figures against the back wall, with a thin strip of light for a visor.
// The head is drawn on a 512x640 canvas with the neck running off the bottom.
const NECK = '#030304';

const figureHead = () => paintCanvas(512, 640, (g) => {
  g.fillStyle = NECK;
  g.fillRect(221, 460, 70, 180);
  g.beginPath();
  g.ellipse(256, 340, 115, 145, 0, 0, TAU);
  g.fill();
  g.fillStyle = '#ffdb99';
  g.fillRect(166, 318, 180, 22);
});

const figureBody = () => paintCanvas(768, 384, (g) => {
  g.translate(384, 32);
  g.scale(2.45, 2.45);
  g.fillStyle = NECK;
  g.beginPath();
  g.moveTo(-66, 170);
  g.bezierCurveTo(-72, 60, -52, 26, -22, 18);
  g.lineTo(22, 18);
  g.bezierCurveTo(52, 26, 72, 60, 66, 170);
  g.fill();
});

const deskTexture = () => paintCanvas(1024, 96, (g) => {
  g.fillStyle = '#040405';
  g.fillRect(0, 0, 1024, 96);
  g.fillStyle = '#fff';
  const r = rng(5);
  for (let x = 60; x < 964; x += 9) { g.globalAlpha = r() * r() * 0.6; g.fillRect(x, 14 + Math.floor(r() * 4) * 8, 3, 2); }
});

// ---------- the audience ----------
const CROWD_POSES = 8;
function crowdTexture() {
  const cellW = 256, cellH = 512;
  const c = document.createElement('canvas');
  c.width = cellW * CROWD_POSES; c.height = cellH;
  const g = c.getContext('2d');
  g.fillStyle = g.strokeStyle = '#fff';
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const limb = (pts, width) => {
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke();
  };
  const hand = (x, y, a) => {
    g.save();
    g.translate(x, y);
    g.rotate(a);
    g.beginPath();
    g.ellipse(0, 0, 11, 14, 0, 0, TAU);
    g.fill();
    for (let f = -2; f <= 2; f++) limb([f * 5, -8, f * 8, -28 + Math.abs(f) * 4], 5);
    g.restore();
  };
  const body = (hair) => {
    g.beginPath();
    g.ellipse(128, 262, 34, 41, 0, 0, TAU);
    g.fill();
    g.fillRect(114, 290, 28, 34);
    g.beginPath();
    g.moveTo(34, 512);
    g.bezierCurveTo(32, 372, 60, 330, 112, 314);
    g.lineTo(144, 314);
    g.bezierCurveTo(196, 330, 224, 372, 222, 512);
    g.fill();
    if (hair === 'long') { g.beginPath(); g.ellipse(128, 288, 41, 72, 0, 0, TAU); g.fill(); }
    if (hair === 'cap') { g.beginPath(); g.ellipse(146, 238, 50, 9, 0.08, 0, TAU); g.fill(); }
  };
  const poses = [
    () => body(),
    () => body('long'),
    () => { body(); limb([202, 352, 214, 240, 196, 138], 27); hand(194, 122, -0.15); },
    () => { body('cap'); limb([54, 352, 40, 244, 66, 136], 27); g.beginPath(); g.ellipse(68, 118, 19, 21, 0, 0, TAU); g.fill(); },
    () => { body('long'); limb([54, 352, 34, 240, 84, 150], 26); limb([202, 352, 222, 240, 172, 150], 26); hand(92, 132, 0.3); hand(164, 132, -0.3); },
    () => { body('long'); limb([202, 352, 218, 250, 188, 164], 27); hand(186, 148, -0.1); },
    () => body('cap'),
    () => { body(); limb([202, 352, 232, 254, 226, 150], 26); limb([54, 352, 26, 254, 32, 150], 26); hand(226, 132, 0.08); hand(32, 132, -0.08); },
  ];
  poses.forEach((draw, i) => {
    g.save();
    g.translate(i * cellW, 0);
    g.beginPath();
    g.rect(0, 0, cellW, cellH);
    g.clip();
    draw();
    g.restore();
  });
  const t = new CanvasTexture(c);
  t.colorSpace = LinearSRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = LinearMipmapLinearFilter;
  return t;
}

const CROWD_VERT = /* glsl */`
  attribute vec3 aInst; // pose, phase, depth shade
  uniform float uKick, uLevel, uT;
  varying vec2 vUv;
  varying float vShade;
  void main() {
    vUv = (uv + vec2(aInst.x, 0.)) * vec2(1. / ${CROWD_POSES.toFixed(1)}, 1.);
    vShade = aInst.z;
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.);
    w.y += max(0., sin(uT * 3.14159 + aInst.y)) * uLevel * .13 * (.4 + uKick);
    w.x += sin(uT * .785 + aInst.y * 3.) * .06;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const CROWD_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform vec3 uRim;
  varying vec2 vUv;
  varying float vShade;
  void main() {
    // the lens is focused on the stage, so the closest rows melt into soft shapes
    float a = texture2D(uMap, vUv, mix(4.2, 1.2, vShade)).a;
    a = smoothstep(.22, mix(.62, .56, vShade), a);
    // and the haze lifts the far rows off the near ones
    gl_FragColor = vec4(vec3(.0012) + uRim * vShade * vShade * .014, a);
  }
`;

const FIGURE_FRAG = /* glsl */`
  uniform sampler2D uMap;
  uniform float uLight;
  varying vec2 vUv;
  void main() {
    vec4 t = texture2D(uMap, vUv);
    if (t.a < .03) discard;
    gl_FragColor = vec4(t.rgb * (.22 + uLight * 1.5), t.a);
  }
`;

// ---------- light ----------
const BEAM_VERT = /* glsl */`
  attribute vec3 aColor;
  attribute float aPower;
  varying vec3 vN, vV, vW, vColor;
  varying float vL, vPower;
  uniform float uLength;
  void main() {
    mat4 m = modelMatrix * instanceMatrix;
    vec4 w = m * vec4(position, 1.);
    vN = mat3(m) * normal;
    vV = cameraPosition - w.xyz;
    vW = w.xyz;
    vL = -position.y / uLength;
    vColor = aColor;
    vPower = aPower;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const BEAM_FRAG = /* glsl */`
  uniform float uTime, uSoft, uFall;
  varying vec3 vN, vV, vW, vColor;
  varying float vL, vPower;
  ${NOISE}
  void main() {
    float f = abs(dot(normalize(vN), normalize(vV)));
    float core = pow(f, uSoft);
    float fall = exp(-vL * uFall) * (1. - smoothstep(.75, 1., vL));
    // the haze the beam is cutting through
    float h = fbm(vec2(vW.x * .09 + vW.z * .05, vW.y * .13) + vec2(uTime * .05, -uTime * .08));
    float haze = .32 + 1.25 * h * h;
    gl_FragColor = vec4(vColor * vPower * core * fall * haze, 1.);
  }
`;

const AIR_VERT = /* glsl */`
  attribute vec2 aSeed;
  uniform float uTime, uScale, uDrift;
  varying float vTw;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * .13 + aSeed.x * 40.) * uDrift;
    p.y += sin(uTime * .09 + aSeed.y * 40.) * uDrift;
    vec4 mv = viewMatrix * modelMatrix * vec4(p, 1.);
    vTw = .5 + .5 * sin(uTime * (1. + aSeed.x * 3.) + aSeed.y * 50.);
    gl_PointSize = clamp(uScale * (.5 + aSeed.y) / -mv.z, 1., 16.);
    gl_Position = projectionMatrix * mv;
  }
`;
const AIR_FRAG = /* glsl */`
  uniform vec3 uColor;
  varying float vTw;
  void main() {
    float d = length(gl_PointCoord - .5);
    gl_FragColor = vec4(uColor * vTw * smoothstep(.5, .05, d), 1.);
  }
`;

// Haze behind the rig, lit by the wall.
const BACK_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }
`;
const BACK_FRAG = /* glsl */`
  uniform vec3 uA;
  uniform float uGlow, uTime;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    vec2 p = (vUv - vec2(.5, .34)) * vec2(2.3, 1.4);
    float g = exp(-dot(p, p) * 3.2);
    float s = fbm(vUv * vec2(5., 3.) + vec2(uTime * .012, -uTime * .02));
    vec3 c = uA * uGlow * g * (.012 + .1 * s * s) + vec3(.0016, .0018, .0032) * (.5 + s);
    gl_FragColor = vec4(c, 1.);
  }
`;
const FLOOR_FRAG = /* glsl */`
  uniform vec3 uA;
  uniform float uGlow, uTime;
  varying vec2 vUv;
  ${NOISE}
  void main() {
    // a dull polished stage: the wall smeared down it toward the viewer
    vec2 p = (vUv - .5) * 2.;
    float streak = exp(-p.x * p.x * 20.) * exp(-abs(p.y + .25) * 3.);
    float r = .6 + .6 * noise(vUv * vec2(90., 26.));
    gl_FragColor = vec4(uA * uGlow * streak * r * .07 + vec3(.0012), 1.);
  }
`;

const STRIP_VERT = /* glsl */`
  attribute float aTower;
  uniform float uBoxes;
  varying vec3 vL;
  varying float vTower;
  void main() {
    vL = position;
    vTower = aTower;
    vec4 w = modelMatrix * instanceMatrix * vec4(position, 1.);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const STRIP_FRAG = /* glsl */`
  uniform float uT, uTexture, uHigh;
  uniform vec3 uA, uB;
  varying vec3 vL;
  varying float vTower;
  void main() {
    float y = (vL.y + .5) * 16.;
    float cell = floor(y), f = fract(y);
    float lit = fract(cell / 16. * 3. - uT * .5 + vTower * .25);
    float i = pow(1. - lit, 5.) * smoothstep(.0, .1, f) * smoothstep(1., .9, f);
    float top = step(cell / 16., uHigh);
    vec3 c = mix(uA, uB, step(.7, 1. - lit)) * (i * 4. + top * .9) * uTexture;
    gl_FragColor = vec4(c + vec3(.002), 1.);
  }
`;

// ---------- post ----------
const FS_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }
`;
const DOWN_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform vec2 uPx;
  uniform float uKnee;
  varying vec2 vUv;
  void main() {
    vec2 d = uPx;
    vec3 c = texture2D(uTex, vUv).rgb * 4.;
    c += texture2D(uTex, vUv + d).rgb + texture2D(uTex, vUv - d).rgb;
    c += texture2D(uTex, vUv + vec2(d.x, -d.y)).rgb + texture2D(uTex, vUv + vec2(-d.x, d.y)).rgb;
    c /= 8.;
    if (uKnee > 0.) { float b = max(c.r, max(c.g, c.b)); c *= smoothstep(uKnee * .5, uKnee * 1.6, b); c = min(c, vec3(16.)); }
    gl_FragColor = vec4(c, 1.);
  }
`;
const UP_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform vec2 uPx;
  varying vec2 vUv;
  void main() {
    vec2 d = uPx;
    vec3 c = texture2D(uTex, vUv + vec2(-d.x * 2., 0.)).rgb + texture2D(uTex, vUv + vec2(d.x * 2., 0.)).rgb
      + texture2D(uTex, vUv + vec2(0., -d.y * 2.)).rgb + texture2D(uTex, vUv + vec2(0., d.y * 2.)).rgb;
    c += (texture2D(uTex, vUv + vec2(-d.x, d.y)).rgb + texture2D(uTex, vUv + d).rgb
      + texture2D(uTex, vUv + vec2(d.x, -d.y)).rgb + texture2D(uTex, vUv - d).rgb) * 2.;
    gl_FragColor = vec4(c / 12., 1.);
  }
`;
const STREAK_FRAG = /* glsl */`
  uniform sampler2D uTex;
  uniform vec2 uPx;
  varying vec2 vUv;
  void main() {
    vec3 c = vec3(0.);
    float total = 0.;
    for (float i = -7.; i <= 7.; i += 1.) {
      float w = exp(-i * i / 22.);
      c += texture2D(uTex, vUv + vec2(i * uPx.x * 3.2, 0.)).rgb * w;
      total += w;
    }
    gl_FragColor = vec4(c / total, 1.);
  }
`;
const FINAL_FRAG = /* glsl */`
  uniform sampler2D uTex, uBloom, uStreak;
  uniform float uTime, uExposure, uBlack;
  uniform vec3 uTint;
  varying vec2 vUv;
  float rand(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 filmic(vec3 x) { return (x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14); }
  void main() {
    vec2 c = vUv - .5;
    float r2 = dot(c, c);
    // a real lens: the colours part slightly toward the corners
    vec2 ca = c * r2 * .0085;
    vec3 col = vec3(texture2D(uTex, vUv + ca).r, texture2D(uTex, vUv).g, texture2D(uTex, vUv - ca).b);
    vec3 bloom = texture2D(uBloom, vUv).rgb;
    vec3 streak = texture2D(uStreak, vUv).rgb;
    col += bloom * .2 + streak * vec3(.05, .06, .1);
    col *= uTint * uExposure;
    col *= 1. - smoothstep(.1, .62, r2) * .62;
    col = filmic(col);
    col = pow(clamp(col, 0., 1.), vec3(1. / 2.2));
    // sensor noise sits in the shadows and the lifted black of a hazy room
    float g = rand(vUv * 913.7 + fract(uTime) * 17.3) - .5;
    float lum = dot(col, vec3(.3, .6, .1));
    col += g * mix(.032, .012, smoothstep(0., .6, lum));
    col = uBlack + col * (1. - uBlack);
    gl_FragColor = vec4(col, 1.);
  }
`;

function detectLowEnd() {
  const coarse = matchMedia('(pointer: coarse)').matches;
  return coarse || (navigator.hardwareConcurrency || 8) <= 4;
}

export function createPyramid(canvas, getFrame) {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  const low = detectLowEnd();
  const renderer = new WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: false });
  renderer.outputColorSpace = LinearSRGBColorSpace;
  renderer.toneMapping = NoToneMapping;
  renderer.autoClear = true;
  renderer.setClearColor(0x000000, 1);
  renderer.info.autoReset = true;

  const scene = new Scene();
  const camera = new PerspectiveCamera(32, 1, 1, 260);

  const spectrumData = new Uint8Array(64);
  const specTex = new DataTexture(spectrumData, 64, 1, RedFormat, UnsignedByteType);
  specTex.magFilter = specTex.minFilter = LinearFilter;
  specTex.needsUpdate = true;

  const palA = new Vector3(...PALETTES.alive[0]), palB = new Vector3(...PALETTES.alive[1]);
  const shared = { uA: { value: palA }, uB: { value: palB }, uT: { value: 0 }, uTime: { value: 0 }, uGlow: { value: 0 }, uKick: { value: 0 } };

  // backdrop and floor
  const back = new Mesh(new PlaneGeometry(240, 110), new ShaderMaterial({
    vertexShader: BACK_VERT, fragmentShader: BACK_FRAG, depthWrite: false,
    uniforms: { uA: shared.uA, uGlow: shared.uGlow, uTime: shared.uTime },
  }));
  back.position.set(0, 44, -46);
  scene.add(back);
  const floor = new Mesh(new PlaneGeometry(170, 110), new ShaderMaterial({
    vertexShader: BACK_VERT, fragmentShader: FLOOR_FRAG,
    uniforms: { uA: shared.uA, uGlow: shared.uGlow, uTime: shared.uTime },
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, 12);
  scene.add(floor);

  // the pyramid
  const faceU = {
    uA: shared.uA, uB: shared.uB, uT: shared.uT, uKick: shared.uKick, uGlow: shared.uGlow, uSpec: { value: specTex },
    uLevel: { value: 0 }, uHit: { value: 0 }, uGate: { value: 0 }, uIdle: { value: 1 }, uProg: { value: 0 }, uRes: { value: 1 },
  };
  const pyramid = new Mesh(pyramidGeometry(), new ShaderMaterial({ vertexShader: FACE_VERT, fragmentShader: FACE_FRAG, uniforms: faceU, side: FrontSide }));
  scene.add(pyramid);
  scene.add(new Mesh(pyramid.geometry, new ShaderMaterial({ vertexShader: BACK_VERT, fragmentShader: 'void main() { gl_FragColor = vec4(0., 0., 0., 1.); }', side: BackSide })));

  // edges of the pyramid: steel with a run of LEDs
  const edgeMat = new ShaderMaterial({
    vertexShader: STRIP_VERT.replace('modelMatrix * instanceMatrix', 'modelMatrix'), fragmentShader: /* glsl */`
      uniform vec3 uA; uniform float uEdge; void main() { gl_FragColor = vec4(uA * uEdge * 2.4 + vec3(.0025), 1.); }`,
    uniforms: { uA: shared.uA, uEdge: { value: 0 }, uBoxes: { value: 0 } },
  });
  const edgeGeo = new BoxGeometry(0.09, 1, 0.09);
  edgeGeo.setAttribute('aTower', new BufferAttribute(new Float32Array(edgeGeo.attributes.position.count), 1));
  const up = new Vector3(0, 1, 0);
  const placeEdge = (a, b) => {
    const m = new Mesh(edgeGeo, edgeMat);
    const A = new Vector3(...a), B = new Vector3(...b);
    m.position.copy(A).add(B).multiplyScalar(0.5);
    m.scale.y = A.distanceTo(B);
    m.quaternion.setFromUnitVectors(up, B.clone().sub(A).normalize());
    scene.add(m);
  };
  placeEdge([-W, 0, D], [0, H, 0]);
  placeEdge([W, 0, D], [0, H, 0]);
  placeEdge([-W, 0, -D], [0, H, 0]);
  placeEdge([W, 0, -D], [0, H, 0]);
  placeEdge([-W, 0.08, D], [W, 0.08, D]);

  // the cockpit
  const cockY = (COCKPIT.s0 + COCKPIT.s1) * 0.5 * (H / SLOPE);
  const cockH = (COCKPIT.s1 - COCKPIT.s0) * (H / SLOPE);
  const cockZ = D * (1 - cockY / H);
  const cockU = { uMap: { value: cockpitTexture() }, uA: shared.uA, uB: shared.uB, uLight: { value: 0.1 } };
  // nodFrom: where in the beat this one's head goes down. They're never quite together.
  const performers = [
    { x: -1.5, lean: 0.03, nodFrom: 0 },
    { x: 1.5, lean: -0.025, nodFrom: 0.035 },
  ];
  const cockpit = new Mesh(new PlaneGeometry(COCKPIT.halfW * 2 + 0.6, cockH + 1.3), new ShaderMaterial({
    vertexShader: BACK_VERT,
    fragmentShader: /* glsl */`
      uniform sampler2D uMap; uniform vec3 uA, uB; uniform float uLight; varying vec2 vUv;
      void main() {
        vec3 warm = mix(uA, vec3(1.), .4);
        gl_FragColor = vec4(warm * texture2D(uMap, vUv).r * (.04 + uLight * .42), 1.);
      }`,
    uniforms: cockU,
  }));
  cockpit.position.set(0, cockY, cockZ - 4.6);
  scene.add(cockpit);
  // the booth's walls, black: they stop the faces being seen through the opening
  const boothBox = new Mesh(new BoxGeometry(COCKPIT.halfW * 2 + 1.2, cockH + 0.6, 4.4), new ShaderMaterial({
    vertexShader: BACK_VERT, side: BackSide,
    fragmentShader: /* glsl */`uniform vec3 uA; uniform float uLight; void main() { gl_FragColor = vec4(uA * uLight * .03, 1.); }`,
    uniforms: cockU,
  }));
  boothBox.position.set(0, cockY, cockZ - 3.98);
  scene.add(boothBox);

  // the two of them, behind the desk: the heads pivot at the neck so they can nod
  const figureZ = cockZ - 3;
  const figureMat = (map) => new ShaderMaterial({
    vertexShader: BACK_VERT, fragmentShader: FIGURE_FRAG, transparent: true, depthWrite: false,
    uniforms: { uMap: { value: map }, uLight: cockU.uLight },
  });
  const headMap = figureHead(), bodyMap = figureBody();
  performers.forEach((p) => {
    p.body = new Mesh(new PlaneGeometry(2.6, 1.3), figureMat(bodyMap));
    p.body.position.set(p.x, cockY - 0.62, figureZ);
    p.body.renderOrder = 1;
    p.bodyY = p.body.position.y;
    scene.add(p.body);
    const face = new Mesh(new PlaneGeometry(1.36, 1.7), figureMat(headMap));
    face.position.y = 0.85;
    face.renderOrder = 2;
    p.head = new Object3D();
    p.head.position.set(p.x, cockY - 0.42, figureZ + 0.05);
    p.neckY = p.head.position.y;
    p.head.add(face);
    scene.add(p.head);
  });
  const desk = new Mesh(new PlaneGeometry(COCKPIT.halfW * 2 + 1, 1.3), new ShaderMaterial({
    vertexShader: BACK_VERT, fragmentShader: FIGURE_FRAG,
    uniforms: { uMap: { value: deskTexture() }, uLight: cockU.uLight },
  }));
  desk.position.set(0, cockY - 1.5, figureZ + 0.9);
  scene.add(desk);

  // side towers
  const towers = [[-23, 13], [23, 13], [-29.5, 16.5], [29.5, 16.5], [-36, 11], [36, 11]];
  const towerGeo = new BoxGeometry(1, 1, 1);
  towerGeo.setAttribute('aTower', new BufferAttribute(new Float32Array(towerGeo.attributes.position.count), 1));
  const towerU = { uA: shared.uA, uB: shared.uB, uT: shared.uT, uTexture: { value: 0 }, uHigh: { value: 0 }, uBoxes: { value: 0 } };
  const towerMesh = new InstancedMesh(towerGeo, new ShaderMaterial({ vertexShader: STRIP_VERT, fragmentShader: STRIP_FRAG, uniforms: towerU }), towers.length);
  const towerIndex = new Float32Array(towers.length);
  const dummy = new Object3D();
  towers.forEach(([x, h], i) => {
    dummy.position.set(x, h / 2, 4);
    dummy.scale.set(1.5, h, 0.5);
    dummy.quaternion.identity();
    dummy.updateMatrix();
    towerMesh.setMatrixAt(i, dummy.matrix);
    towerIndex[i] = i;
  });
  towerMesh.geometry.setAttribute('aTower', new InstancedBufferAttribute(towerIndex, 1));
  towerMesh.frustumCulled = false;
  scene.add(towerMesh);

  // truss: dark steel seen only against the haze
  const truss = new Mesh(new BoxGeometry(84, 0.9, 0.9), new ShaderMaterial({
    vertexShader: BACK_VERT, fragmentShader: `void main() { gl_FragColor = vec4(.003, .003, .004, 1.); }`,
  }));
  truss.position.set(0, 24.2, 6);
  scene.add(truss);

  // moving heads: eight on the truss, six on the floor
  const heads = [];
  for (let i = 0; i < 8; i++) heads.push({ pos: new Vector3(-31.5 + i * 9, 23.6, 6), top: true, side: i < 4 ? -1 : 1, i, yaw: 0, pitch: 0.6, power: 0 });
  for (let i = 0; i < 6; i++) heads.push({ pos: new Vector3(-24 + i * 9.6, 0.5, D + 1.5), top: false, side: i < 3 ? -1 : 1, i, yaw: 0, pitch: 0.6, power: 0 });
  const BEAM_LEN = 74;
  const beamGeo = new CylinderGeometry(0.14, 2.3, BEAM_LEN, 28, 1, true);
  beamGeo.translate(0, -BEAM_LEN / 2, 0);
  const beamU = { uTime: shared.uTime, uLength: { value: BEAM_LEN }, uSoft: { value: 6 }, uFall: { value: 3.3 } };
  const beamColor = new InstancedBufferAttribute(new Float32Array(heads.length * 3), 3);
  const beamPower = new InstancedBufferAttribute(new Float32Array(heads.length), 1);
  beamGeo.setAttribute('aColor', beamColor);
  beamGeo.setAttribute('aPower', beamPower);
  const light = { blending: AdditiveBlending, transparent: true, depthWrite: false };
  const beams = new InstancedMesh(beamGeo, new ShaderMaterial({ vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, uniforms: beamU, ...light }), heads.length);
  beams.frustumCulled = false;
  scene.add(beams);

  // the lens of each head, seen as a hot point
  const lensGeo = new BufferGeometry();
  lensGeo.setAttribute('position', new BufferAttribute(new Float32Array(heads.length * 3), 3));
  lensGeo.setAttribute('aSeed', new BufferAttribute(new Float32Array(heads.length * 2).fill(0.8), 2));
  heads.forEach((h, i) => lensGeo.attributes.position.setXYZ(i, h.pos.x, h.pos.y - 0.5, h.pos.z));
  const lensColor = new Vector3();
  const lens = new Points(lensGeo, new ShaderMaterial({
    vertexShader: AIR_VERT, fragmentShader: AIR_FRAG, ...light,
    uniforms: { uTime: { value: 0 }, uScale: { value: 620 }, uDrift: { value: 0 }, uColor: { value: lensColor } },
  }));
  lens.frustumCulled = false;
  scene.add(lens);

  // lasers from the apex, over the heads of the crowd
  const LASERS = 10, LASER_LEN = 90;
  const laserGeo = new CylinderGeometry(0.018, 0.14, LASER_LEN, 6, 1, true);
  laserGeo.translate(0, -LASER_LEN / 2, 0);
  const laserColor = new InstancedBufferAttribute(new Float32Array(LASERS * 3), 3);
  const laserPower = new InstancedBufferAttribute(new Float32Array(LASERS), 1);
  laserGeo.setAttribute('aColor', laserColor);
  laserGeo.setAttribute('aPower', laserPower);
  const lasers = new InstancedMesh(laserGeo, new ShaderMaterial({
    vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG, ...light,
    uniforms: { uTime: shared.uTime, uLength: { value: LASER_LEN }, uSoft: { value: 0.6 }, uFall: { value: 1.2 } },
  }), LASERS);
  lasers.frustumCulled = false;
  scene.add(lasers);

  // dust in the air
  const rand = rng(21);
  const dustCount = low ? 350 : 800;
  const dustPos = new Float32Array(dustCount * 3), dustSeed = new Float32Array(dustCount * 2);
  for (let i = 0; i < dustCount; i++) {
    dustPos.set([(rand() - 0.5) * 80, rand() * 26, -6 + rand() * 44], i * 3);
    dustSeed.set([rand(), rand()], i * 2);
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute('position', new BufferAttribute(dustPos, 3));
  dustGeo.setAttribute('aSeed', new BufferAttribute(dustSeed, 2));
  const dustColor = new Vector3();
  const dust = new Points(dustGeo, new ShaderMaterial({
    vertexShader: AIR_VERT, fragmentShader: AIR_FRAG, ...light,
    uniforms: { uTime: shared.uTime, uScale: { value: 150 }, uDrift: { value: 2.2 }, uColor: { value: dustColor } },
  }));
  dust.frustumCulled = false;
  scene.add(dust);

  // the audience: rows of cut-outs, thickening toward the camera
  const crowdPlaces = [];
  const crowdRand = rng(7);
  for (let z = 24; z < 39; z += 0.85) {
    const near = (z - 24) / 15;
    const n = Math.round(mix(30, 13, near)) * (low ? 0.7 : 1);
    for (let i = 0; i < n; i++) {
      crowdPlaces.push([(i + crowdRand() * 0.8 - n / 2) * mix(2.7, 1.5, near) * (1 + 0.1 * crowdRand()), z + crowdRand() * 0.5, 0.86 + crowdRand() * 0.2]);
    }
  }
  const crowdGeo = new PlaneGeometry(1, 2);
  crowdGeo.translate(0, 1, 0);
  const crowdInst = new InstancedBufferAttribute(new Float32Array(crowdPlaces.length * 3), 3);
  crowdGeo.setAttribute('aInst', crowdInst);
  const crowdU = { uMap: { value: crowdTexture() }, uRim: { value: new Vector3() }, uKick: shared.uKick, uT: shared.uT, uLevel: { value: 0 } };
  const crowd = new InstancedMesh(crowdGeo, new ShaderMaterial({ vertexShader: CROWD_VERT, fragmentShader: CROWD_FRAG, uniforms: crowdU, transparent: true, depthWrite: false }), crowdPlaces.length);
  crowdPlaces.forEach(([x, z, s], i) => {
    dummy.position.set(x, 0, z);
    dummy.scale.set(s * 1.75, s * 1.72, 1);
    dummy.quaternion.identity();
    dummy.updateMatrix();
    crowd.setMatrixAt(i, dummy.matrix);
    const pose = Math.floor(crowdRand() * CROWD_POSES);
    crowdInst.setXYZ(i, pose, crowdRand() * TAU, 1 - (z - 24) / 15);
  });
  crowd.frustumCulled = false;
  crowd.renderOrder = 5;
  scene.add(crowd);

  // phone lights held up
  const phoneCount = low ? 40 : 90;
  const phonePos = new Float32Array(phoneCount * 3), phoneSeed = new Float32Array(phoneCount * 2);
  for (let i = 0; i < phoneCount; i++) {
    phonePos.set([(rand() - 0.5) * 72, 2.6 + rand() * 0.7, 24 + rand() * 16], i * 3);
    phoneSeed.set([rand(), rand()], i * 2);
  }
  const phoneGeo = new BufferGeometry();
  phoneGeo.setAttribute('position', new BufferAttribute(phonePos, 3));
  phoneGeo.setAttribute('aSeed', new BufferAttribute(phoneSeed, 2));
  const phoneColor = new Vector3();
  const phones = new Points(phoneGeo, new ShaderMaterial({
    vertexShader: AIR_VERT, fragmentShader: AIR_FRAG, ...light,
    uniforms: { uTime: shared.uTime, uScale: { value: 150 }, uDrift: { value: 0.1 }, uColor: { value: phoneColor } },
  }));
  phones.frustumCulled = false;
  scene.add(phones);

  // ---------- post chain ----------
  const fsCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const fsGeo = new BufferGeometry();
  fsGeo.setAttribute('position', new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const fsMesh = new Mesh(fsGeo);
  fsMesh.frustumCulled = false;
  const fsScene = new Scene();
  fsScene.add(fsMesh);
  const fsMat = (fragmentShader, uniforms) => new ShaderMaterial({ vertexShader: FS_VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  const downMat = fsMat(DOWN_FRAG, { uTex: { value: null }, uPx: { value: new Vector2() }, uKnee: { value: 0 } });
  const upMat = fsMat(UP_FRAG, { uTex: { value: null }, uPx: { value: new Vector2() } });
  upMat.blending = AdditiveBlending;
  upMat.transparent = true;
  const streakMat = fsMat(STREAK_FRAG, { uTex: { value: null }, uPx: { value: new Vector2() } });
  const finalMat = fsMat(FINAL_FRAG, {
    uTex: { value: null }, uBloom: { value: null }, uStreak: { value: null }, uTime: shared.uTime,
    uExposure: { value: 1 }, uBlack: { value: 0.006 }, uTint: { value: new Vector3(1, 1, 1) },
  });
  const pass = (mat, target) => {
    fsMesh.material = mat;
    renderer.setRenderTarget(target);
    renderer.render(fsScene, fsCam);
  };

  const hdrOptions = { type: HalfFloatType, format: RGBAFormat, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false };
  let hdr = null, mips = [], streakA = null, streakB = null;
  let w = 0, h = 0, scale = low ? 0.62 : 0.86, cap = low ? 1 : 1.5;
  function disposeTargets() {
    [hdr, streakA, streakB, ...mips].forEach((t) => t && t.dispose());
    mips = [];
  }
  function buildTargets() {
    disposeTargets();
    const rw = Math.max(2, Math.round(w * scale)), rh = Math.max(2, Math.round(h * scale));
    hdr = new WebGLRenderTarget(rw, rh, { ...hdrOptions, depthBuffer: true, samples: low ? 0 : 4 });
    let mw = rw, mh = rh;
    for (let i = 0; i < 6; i++) {
      mw = Math.max(2, mw >> 1); mh = Math.max(2, mh >> 1);
      mips.push(new WebGLRenderTarget(mw, mh, hdrOptions));
    }
    const s = mips[2];
    streakA = new WebGLRenderTarget(s.width, s.height, hdrOptions);
    streakB = new WebGLRenderTarget(s.width, s.height, hdrOptions);
  }
  function resize() {
    const dpr = Math.min(devicePixelRatio || 1, cap);
    const cw = Math.round(canvas.clientWidth * dpr), ch = Math.round(canvas.clientHeight * dpr);
    if (cw === w && ch === h) return;
    w = cw; h = ch;
    if (!w || !h) return;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    buildTargets();
  }

  function renderFrame(f) {
    renderer.setRenderTarget(hdr);
    renderer.render(scene, camera);
    downMat.uniforms.uTex.value = hdr.texture;
    downMat.uniforms.uKnee.value = 1.1;
    downMat.uniforms.uPx.value.set(0.5 / hdr.width, 0.5 / hdr.height);
    pass(downMat, mips[0]);
    downMat.uniforms.uKnee.value = 0;
    for (let i = 1; i < mips.length; i++) {
      downMat.uniforms.uTex.value = mips[i - 1].texture;
      downMat.uniforms.uPx.value.set(0.5 / mips[i - 1].width, 0.5 / mips[i - 1].height);
      pass(downMat, mips[i]);
    }
    // the anamorphic flare: only the hottest light, smeared sideways
    streakMat.uniforms.uTex.value = mips[2].texture;
    streakMat.uniforms.uPx.value.set(1 / mips[2].width, 0);
    pass(streakMat, streakA);
    streakMat.uniforms.uTex.value = streakA.texture;
    streakMat.uniforms.uPx.value.set(3 / mips[2].width, 0);
    pass(streakMat, streakB);
    for (let i = mips.length - 1; i > 0; i--) {
      upMat.uniforms.uTex.value = mips[i].texture;
      upMat.uniforms.uPx.value.set(0.5 / mips[i].width, 0.5 / mips[i].height);
      renderer.autoClear = false;
      pass(upMat, mips[i - 1]);
      renderer.autoClear = true;
    }
    finalMat.uniforms.uTex.value = hdr.texture;
    finalMat.uniforms.uBloom.value = mips[0].texture;
    finalMat.uniforms.uStreak.value = streakB.texture;
    pass(finalMat, null);
  }

  // ---------- the show ----------
  const pres = { groove: 0, lead: 0, texture: 0 };
  const peak = { groove: 0.25, lead: 0.25, texture: 0.25, bass: 0.3 };
  const level = { groove: 0, lead: 0, texture: 0 };
  let nodDepth = 0;
  let kick = 0, bassSlow = 0, hit = 0, glow = 0, fxAmt = 0, tIdle = 0, time = 0;
  let T = 0, lastBar = -1, lastPhrase = -1, loops = 0, cue = CUES[0], camIndex = 0, album = null;
  const camPos = new Vector3(), camAim = new Vector3();
  const A = new Vector3(...PALETTES.alive[0]), B = new Vector3(...PALETTES.alive[1]);
  const tintFx = new Vector3(), q = new Quaternion(), dir = new Vector3(), down = new Vector3(0, -1, 0);
  const specSmooth = new Float32Array(64);

  function normalise(key, value, dt) {
    peak[key] = Math.max(value, peak[key] * Math.exp(-dt * 0.12), 0.12);
    return clamp01(value / peak[key]);
  }

  function aimHeads(dt, t, power, reduced) {
    const pattern = cue.beam;
    heads.forEach((h, n) => {
      let yaw, pitch;
      const s = h.side, i = h.i;
      const phase = t * Math.PI * 0.25;
      if (pattern === 'fan') { yaw = (i - (h.top ? 3.5 : 2.5)) * 0.13; pitch = h.top ? 0.36 + 0.09 * Math.sin(phase) : 0.2; }
      else if (pattern === 'cross') { yaw = -s * (0.34 + 0.13 * Math.sin(phase + i)); pitch = h.top ? 0.42 : 0.14; }
      else if (pattern === 'sweep') { yaw = Math.sin(phase * 0.5) * 0.52; pitch = h.top ? 0.4 : 0.22; }
      else if (pattern === 'wave') { yaw = Math.sin(phase * 2 + i * 0.7) * 0.28; pitch = (h.top ? 0.38 : 0.2) + Math.cos(phase * 2 + i * 0.7) * 0.12; }
      else { yaw = (i - (h.top ? 3.5 : 2.5)) * 0.03; pitch = h.top ? 0.1 : 0; }
      if (reduced) { yaw *= 0.5; pitch *= 0.8; }
      // a head has mass: it swings to its new position instead of snapping
      h.yaw = approach(h.yaw, yaw, dt, 3.2, 3.2);
      h.pitch = approach(h.pitch, pitch, dt, 3.2, 3.2);
      if (h.top) dir.set(Math.sin(h.yaw), -Math.cos(h.pitch + 0.42), Math.sin(h.pitch + 0.42)).normalize();
      else dir.set(Math.sin(h.yaw), Math.cos(h.pitch * 2.1 + 0.34), -0.22 + h.pitch * 0.7).normalize();
      q.setFromUnitVectors(down, dir);
      dummy.position.copy(h.pos);
      dummy.quaternion.copy(q);
      dummy.scale.set(1, 1, 1);
      dummy.updateMatrix();
      beams.setMatrixAt(n, dummy.matrix);
      const alt = (i % 2 === 0) === cue.swap;
      const col = alt ? palB : palA;
      const chase = pattern === 'still' ? 1 : 0.62 + 0.38 * Math.max(0, Math.cos((t * 0.5 + i * 0.125) * TAU));
      const pw = power * chase;
      beamColor.setXYZ(n, col.x * pw, col.y * pw, col.z * pw);
      beamPower.setX(n, h.top ? 1 : 0.7);
    });
    beams.instanceMatrix.needsUpdate = true;
    beamColor.needsUpdate = beamPower.needsUpdate = true;
  }

  function aimLasers(t, power) {
    for (let i = 0; i < LASERS; i++) {
      const u = (i + 0.5) / LASERS - 0.5;
      const sweep = Math.sin(t * Math.PI * 0.25) * 0.3;
      dir.set(Math.sin(u * 2.1 + sweep), 0.015 + 0.07 * Math.sin(t * 1.57 + i), Math.cos(u * 2.1 + sweep)).normalize();
      q.setFromUnitVectors(down, dir);
      dummy.position.set(0, H + 0.15, 0.05);
      dummy.quaternion.copy(q);
      dummy.updateMatrix();
      lasers.setMatrixAt(i, dummy.matrix);
      const p = power * (0.6 + 0.4 * Math.sin(t * Math.PI + i * 1.3));
      laserColor.setXYZ(i, palB.x * p, palB.y * p, palB.z * p);
      laserPower.setX(i, 1);
    }
    lasers.instanceMatrix.needsUpdate = true;
    laserColor.needsUpdate = laserPower.needsUpdate = true;
    lasers.visible = power > 0.01;
  }

  function placeCamera(f, dt, reduced) {
    const [pos, aim, fov] = CAMS[camIndex];
    const a = Math.min(4, w / Math.max(1, h));
    const [o0, o1] = f.open || [0, 1];
    const openW = Math.max(0.2, o1 - o0);
    const wide = fov > 20;
    // someone is holding this camera
    const sway = reduced ? 0 : 1;
    camPos.set(pos[0] + Math.sin(time * 0.31) * 0.2 * sway, pos[1] + Math.sin(time * 0.47 + 1) * 0.08 * sway, pos[2]);
    const jitter = wide ? 0.09 : 0.03;
    camAim.set(
      aim[0] + (Math.sin(time * 0.71) + Math.sin(time * 1.3 + 2) * 0.5) * jitter * sway,
      aim[1] + (Math.sin(time * 0.57 + 4) + Math.sin(time * 1.1) * 0.5) * jitter * sway,
      aim[2],
    );
    camera.position.copy(camPos);
    camera.fov = fov;
    camera.aspect = a;
    camera.near = 1;
    camera.far = 260;
    camera.zoom = wide ? clamp01(mix(0.62, 1.15, clamp01((openW * a - 0.5) / 1.1))) : 1;
    camera.setViewOffset(w, h, (0.5 - (o0 + o1) / 2) * w, 0, w, h);
    camera.lookAt(camAim);
    camera.updateProjectionMatrix();
  }

  function update(f, dt) {
    const reduced = reduce.matches;
    const m = f.meters;
    const playing = f.playing && m.beatIndex >= 0;
    time += dt;
    tIdle = playing ? 0 : tIdle + dt;

    for (const k of ['groove', 'lead', 'texture']) {
      pres[k] = approach(pres[k], f.active[k] ? 1 : 0, dt, 7, 3);
      level[k] = approach(level[k], normalise(k, m[k], dt), dt, 34, 8);
    }
    const bassN = normalise('bass', m.bass, dt);
    const onset = Math.max(0, bassN - bassSlow);
    bassSlow = approach(bassSlow, bassN, dt, 7, 5);
    const beatPulse = playing ? Math.pow(1 - m.beat, 5) * 0.34 : 0;
    kick = reduced ? 0.35 : Math.max(kick * Math.exp(-dt * 8.5), clamp01(onset * 3.2), beatPulse * pres.groove);

    // spectrum, log-spaced so the bass isn't one bar wide
    if (m.spectrum) {
      for (let i = 0; i < 64; i++) {
        const u = i / 63;
        const bin = Math.min(m.spectrum.length - 1, Math.floor(1 + Math.pow(u, 2.1) * 210));
        const tilt = 0.85 + u * 0.55;
        const v = (m.spectrum[bin] / 255) * tilt;
        specSmooth[i] = approach(specSmooth[i], v, dt, 40, 9);
        spectrumData[i] = Math.round(clamp01(specSmooth[i] * specSmooth[i] * 1.2) * 255);
      }
      specTex.needsUpdate = true;
    }

    // the clock: musical while playing, slow when not
    if (playing) T = m.beatIndex + m.beat;
    else T += dt * 0.35;
    const bar = Math.floor(T / 4);
    if (playing && bar !== lastBar) {
      if (lastBar > bar) loops++;
      lastBar = bar;
      const phrase = Math.floor(bar / 8);
      const layers = (f.active.groove ? 1 : 0) + (f.active.lead ? 1 : 0) + (f.active.texture ? 1 : 0);
      if (phrase !== lastPhrase) {
        lastPhrase = phrase;
        cue = CUES[(loops * 4 + phrase) % CUES.length];
        if (layers >= 2 && !reduced) hit = 1;
        if (!reduced) camIndex = cue.cam;
      } else if (bar % 4 === 0 && !reduced) {
        camIndex = cue.cam === 0 ? 1 : 0; // answer the close shot with a wide one, halfway through
      }
    }
    if (!playing) { lastBar = -1; lastPhrase = -1; loops = 0; cue = CUES[0]; if (tIdle > 0.2) camIndex = 0; }
    hit *= Math.exp(-dt * 5);

    if (f.album !== album) {
      album = f.album;
      const [a, b] = paletteFor(album);
      A.set(...a); B.set(...b);
    }
    palA.lerp(cue.swap ? B : A, 1 - Math.exp(-dt * 14));
    palB.lerp(cue.swap ? A : B, 1 - Math.exp(-dt * 14));
    fxAmt = approach(fxAmt, f.fx ? 1 : 0, dt, 18, 8);
    if (fxAmt > 0.001) {
      if (f.fxX < 0) tintFx.set(0.34, 0.06, 1); else tintFx.set(0.04, 0.72, 1);
      palA.lerp(tintFx, fxAmt * 0.85);
      palB.lerp(tintFx, fxAmt * 0.6);
    }

    // The breath before the phrase: half a beat of dark, then the hit lands.
    const inPhrase = (T % 32) / 32;
    const gate = playing && !reduced && inPhrase > 0.984 && pres.groove > 0.5 ? 0.04 : 1;
    const g = pres.groove;
    faceU.uGate.value = g * gate;
    faceU.uLevel.value = level.groove * 0.55 + bassN * 0.45;
    faceU.uHit.value = hit * g;
    faceU.uProg.value = cue.prog;
    faceU.uIdle.value = 1 - clamp01(g + pres.lead + pres.texture);
    shared.uT.value = reduced ? time * 0.25 : T;
    shared.uTime.value = time;
    shared.uKick.value = kick;
    edgeMat.uniforms.uEdge.value = g * gate * (0.08 + kick * 0.5) + hit * g * 0.6 + faceU.uIdle.value * 0.012;

    const room = (0.25 + kick * 0.75) * g + pres.lead * level.lead * 0.5 + pres.texture * 0.1;
    glow = approach(glow, room * gate, dt, 30, 6);
    shared.uGlow.value = glow + hit * g * 0.8;
    cockU.uLight.value = 0.16 + clamp01(g + pres.lead + pres.texture) * (0.3 + kick * 0.4) + hit * 0.4;

    // They nod with the beat for as long as anything is playing, harder as the groove pushes.
    const nodTo = playing && !reduced ? clamp01(g + pres.lead + pres.texture) * (0.62 + level.groove * 0.38) : 0;
    nodDepth = approach(nodDepth, nodTo, dt, 7, 3);
    performers.forEach((p, i) => {
      const n = nodShape((m.beat - p.nodFrom + 1) % 1) * nodDepth;
      p.head.rotation.x = n * 0.5;
      p.head.position.y = p.neckY - n * 0.3;
      p.head.rotation.z = p.lean + Math.sin(T * Math.PI * 0.5 + i * 2) * 0.045 * nodDepth;
      p.body.position.y = p.bodyY - n * 0.07;
    });

    const beamPw = pres.lead * (0.2 + level.lead * 0.9) * gate * (1 - fxAmt * 0.3) * 0.62;
    aimHeads(dt, shared.uT.value, beamPw, reduced);
    aimLasers(shared.uT.value, cue.laser && !reduced ? beamPw * 1.6 : 0);
    lensColor.copy(palA).multiplyScalar(beamPw * 2.4);
    lens.visible = beamPw > 0.01;

    const tx = pres.texture * (0.4 + level.texture * 0.6);
    towerU.uTexture.value = tx * gate;
    towerU.uHigh.value = clamp01(level.texture * 0.9) * pres.texture;
    dustColor.copy(palA).multiplyScalar(0.005 + glow * 0.02 + tx * 0.08).addScalar(0.002 + tx * 0.05);
    phoneColor.set(0.8, 0.86, 1).multiplyScalar(pres.texture * 0.8);
    phones.visible = pres.texture > 0.01;
    crowdU.uLevel.value = g;
    crowdU.uRim.value.copy(palA).multiplyScalar(0.14 + glow * 1.3 + hit * 1.8 + beamPw * 0.9);

    finalMat.uniforms.uExposure.value = 1.02 - fxAmt * 0.22 + hit * g * 0.15;
    placeCamera(f, dt, reduced);
    faceU.uRes.value = h;
  }

  // Keep the page responsive: if frames run long, render fewer pixels.
  let msAvg = 16, sinceResize = 0;
  function adapt(ms) {
    msAvg = msAvg * 0.95 + ms * 0.05;
    if (++sinceResize < 90) return;
    if (msAvg > 26 && scale > 0.5) {
      scale = Math.max(0.5, scale - 0.13);
      sinceResize = 0;
      if (w && h) buildTargets();
    }
  }

  let last = performance.now(), lastDraw = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    const f = getFrame(); // every frame: it also advances the clock and polls the controller
    const budget = f.paused ? 100 : msAvg > 40 ? 30 : 0;
    if (now - lastDraw < budget) return;
    lastDraw = now;
    resize();
    if (!w || !h) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    adapt(now - last);
    last = now;
    update(f, dt);
    renderFrame(f);
  }
  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());

  requestAnimationFrame(frame);
  return { renderer };
}
