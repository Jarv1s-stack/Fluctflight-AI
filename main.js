import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ------------------------------------------------------------------ *
 * FLUCTLIGHT — quantum light-cube field
 * Layers: lattice shell · memory filaments · core · sparks · rings · glitch
 * ------------------------------------------------------------------ */

const canvas = document.getElementById('stage');
const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
if (!gl) {
  document.getElementById('noWebgl').hidden = false;
  canvas.style.display = 'none';
  throw new Error('WebGL unavailable');
}

const REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const SMALL = Math.min(window.innerWidth, window.innerHeight) < 720;

const COUNTS = {
  shell: SMALL ? 7200 : 11000,
  filaments: SMALL ? 340 : 480,
  segments: SMALL ? 52 : 66,
  sparks: SMALL ? 950 : 1500,
};

/* ------------------------------ noise (CPU) ----------------------- */

function hash3(i, j, k) {
  let n = (i * 374761393 + j * 668265263 + k * 1274126177) | 0;
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}
const fade = (t) => t * t * (3 - 2 * t);

function noise3(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const lerp = (a, b, t) => a + (b - a) * t;
  const c000 = hash3(xi, yi, zi), c100 = hash3(xi + 1, yi, zi);
  const c010 = hash3(xi, yi + 1, zi), c110 = hash3(xi + 1, yi + 1, zi);
  const c001 = hash3(xi, yi, zi + 1), c101 = hash3(xi + 1, yi, zi + 1);
  const c011 = hash3(xi, yi + 1, zi + 1), c111 = hash3(xi + 1, yi + 1, zi + 1);
  const x00 = lerp(c000, c100, u), x10 = lerp(c010, c110, u);
  const x01 = lerp(c001, c101, u), x11 = lerp(c011, c111, u);
  return lerp(lerp(x00, x10, v), lerp(x01, x11, v), w) * 2 - 1;
}

function fbm(x, y, z) {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 3; o++) {
    sum += amp * noise3(x * f, y * f, z * f);
    amp *= 0.5; f *= 2.03;
  }
  return sum;
}

const _curl = new THREE.Vector3();
function curl(x, y, z, e = 0.14) {
  const pa = (a, b, c) => fbm(a, b, c);
  const pb = (a, b, c) => fbm(a + 31.4, b - 11.7, c + 7.3);
  const pc = (a, b, c) => fbm(a - 19.2, b + 43.1, c - 27.5);
  const dpc_dy = (pc(x, y + e, z) - pc(x, y - e, z)) / (2 * e);
  const dpb_dz = (pb(x, y, z + e) - pb(x, y, z - e)) / (2 * e);
  const dpa_dz = (pa(x, y, z + e) - pa(x, y, z - e)) / (2 * e);
  const dpc_dx = (pc(x + e, y, z) - pc(x - e, y, z)) / (2 * e);
  const dpb_dx = (pb(x + e, y, z) - pb(x - e, y, z)) / (2 * e);
  const dpa_dy = (pa(x, y + e, z) - pa(x, y - e, z)) / (2 * e);
  return _curl.set(dpc_dy - dpb_dz, dpa_dz - dpc_dx, dpb_dx - dpa_dy);
}

/* ------------------------------ GLSL chunks ----------------------- */

const SNOISE = /* glsl */`
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
  vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))
        +i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z);
  vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y);
  vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

/* ------------------------------ core setup ------------------------ */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: !SMALL, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.setClearColor(0x04050b, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.1, 200);
camera.position.set(0, 0.32, 7.5);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.055;
controls.rotateSpeed = 0.55;
controls.zoomSpeed = 0.6;
controls.enablePan = false;
controls.minDistance = 2.6;
controls.maxDistance = 22;
controls.autoRotate = !REDUCED;
controls.autoRotateSpeed = 0.42;

const params = { chaos: 0.55, glow: 1.08, density: 0.85, pulse: 0.6, shell: true };

const U = {
  uTime: { value: 0 },
  uChaos: { value: params.chaos },
  uDensity: { value: params.density },
  uPulse: { value: params.pulse },
  uPR: { value: renderer.getPixelRatio() },
  // pixels-per-world-unit at unit depth — keeps point sizes physical
  uProj: { value: 1000 },
};

/* ------------------------------ voice bridge ----------------------- *
 * chat.js talks to the render loop only through window.Fluctlight —
 * it never touches Three.js objects directly. `energy` is a fast decaying
 * transient (one pulse per spoken word), `speaking`/`listening` are eased
 * 0..1 states blended into uPulse / uChaos / bloom every frame in animate().
 * ------------------------------------------------------------------- */
const voice = {
  energy: 0,
  speaking: 0, speakingTarget: 0,
  listening: 0, listeningTarget: 0,
  thinking: 0, thinkingTarget: 0,
  // brief warm flash layered on the core each time a word lands
  flash: 0,
};
window.Fluctlight = {
  pulse(amount = 0.5) {
    voice.energy = Math.min(1.6, voice.energy + amount);
    voice.flash = Math.min(1, voice.flash + amount * 0.9);
  },
  setSpeaking(on) { voice.speakingTarget = on ? 1 : 0; },
  setListening(on) { voice.listeningTarget = on ? 1 : 0; },
  // waiting on the AI reply — a slower, searching unease before it speaks
  setThinking(on) { voice.thinkingTarget = on ? 1 : 0; },
};

const group = new THREE.Group();
scene.add(group);

/* ------------------------------ background ------------------------ */

const bg = new THREE.Mesh(
  new THREE.SphereGeometry(60, 24, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, depthTest: false,
    uniforms: { uTop: { value: new THREE.Color(0x0a0b16) }, uBot: { value: new THREE.Color(0x03040a) } },
    vertexShader: `varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `
      uniform vec3 uTop; uniform vec3 uBot; varying vec3 vP;
      void main(){
        float t = clamp(vP.y*0.5+0.5, 0.0, 1.0);
        vec3 c = mix(uBot, uTop, pow(t, 1.3));
        c += vec3(0.012, 0.008, 0.026) * (1.0 - abs(vP.y));
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
);
bg.renderOrder = -1;
scene.add(bg);

/* ------------------------------ lattice shell --------------------- */

function buildShell() {
  const n = COUNTS.shell;
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const R = 1.72;
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const y = 1 - (i / (n - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const th = golden * i;
    const jitter = 1 + (Math.random() - 0.5) * 0.012;
    pos[i * 3] = Math.cos(th) * r * R * jitter;
    pos[i * 3 + 1] = y * R * jitter;
    pos[i * 3 + 2] = Math.sin(th) * r * R * jitter;
    seed[i] = Math.random();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U, uColor: { value: new THREE.Color(0x74d6e8) } },
    vertexShader: `
      attribute float aSeed;
      uniform float uTime, uProj, uChaos;
      varying float vA;
      void main(){
        vec3 p = position * (1.0 + 0.008*sin(uTime*0.7 + aSeed*24.0));
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        vec3 nrm = normalize(mat3(modelViewMatrix) * normalize(position));
        vec3 vd = normalize(-mv.xyz);
        float rim = pow(1.0 - abs(dot(nrm, vd)), 1.5);
        float tw = 0.35 + 0.65 * pow(abs(sin(uTime*1.1 + aSeed*47.0)), 2.0);
        vA = (0.165 + rim * 0.46) * (0.45 + tw*0.6) * (0.7 + uChaos*0.4);
        gl_PointSize = max(1.0, (0.0042 + rim*0.0055) * uProj / -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.06, d) * vA;
        gl_FragColor = vec4(uColor * (0.35 + vA*0.6), a);
      }`,
  });
  return new THREE.Points(geo, mat);
}
const shell = buildShell();
group.add(shell);

/* ------------------------------ memory filaments ------------------ */

const PALETTE = [
  new THREE.Color(0x3ef0d2), new THREE.Color(0x38b6ff),
  new THREE.Color(0x9df58e), new THREE.Color(0x6ff0ff),
  new THREE.Color(0x4fe3a8), new THREE.Color(0x2a86e0),
];

function buildFilaments() {
  const F = COUNTS.filaments, S = COUNTS.segments;
  const vCount = F * S * 2;
  const pos = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  const seed = new Float32Array(vCount);
  const id = new Float32Array(vCount);
  const fadeA = new Float32Array(vCount);

  const p = new THREE.Vector3();
  const prev = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const tangent = new THREE.Vector3();
  const c = new THREE.Color();
  let v = 0;

  for (let f = 0; f < F; f++) {
    const fid = f / F;
    const fseed = Math.random();
    const startR = 0.12 + Math.pow(Math.random(), 0.55) * 1.28;
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const sr = Math.sqrt(1 - u * u);
    p.set(sr * Math.cos(phi), u, sr * Math.sin(phi)).multiplyScalar(startR);
    const step = 0.010 + Math.random() * 0.016;
    const scale = 2.0 + Math.pow(Math.random(), 1.4) * 5.2;
    const bright = 0.45 + Math.pow(Math.random(), 1.8) * 1.5;

    const base = PALETTE[(Math.random() * PALETTE.length) | 0];
    const alt = PALETTE[(Math.random() * PALETTE.length) | 0];

    for (let s = 0; s < S; s++) {
      prev.copy(p);
      const cv = curl(p.x * scale + fseed * 40, p.y * scale, p.z * scale - fseed * 17);
      dir.copy(cv).normalize();
      // swirl bias — keeps filaments orbiting the core instead of escaping
      tangent.set(-p.z, p.x * 0.35, p.x).normalize();
      dir.addScaledVector(tangent, 0.22).normalize();
      // containment: pull back toward the shell interior
      const len = p.length();
      if (len > 1.28) dir.addScaledVector(p, -(len - 1.28) * 3.4).normalize();
      if (len < 0.12) dir.addScaledVector(p, 3.0).normalize();
      p.addScaledVector(dir, step);

      const t = s / (S - 1);
      const env = Math.sin(t * Math.PI) ** 0.5;
      c.copy(base).lerp(alt, t);
      const boost = bright * (0.75 + 0.5 * Math.random());

      for (let e = 0; e < 2; e++) {
        const src = e === 0 ? prev : p;
        pos[v * 3] = src.x; pos[v * 3 + 1] = src.y; pos[v * 3 + 2] = src.z;
        col[v * 3] = c.r * boost; col[v * 3 + 1] = c.g * boost; col[v * 3 + 2] = c.b * boost;
        seed[v] = fseed;
        id[v] = fid;
        fadeA[v] = env;
        v++;
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aId', new THREE.BufferAttribute(id, 1));
  geo.setAttribute('aFade', new THREE.BufferAttribute(fadeA, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U },
    vertexShader: SNOISE + `
      attribute vec3 aColor; attribute float aSeed; attribute float aId; attribute float aFade;
      uniform float uTime, uChaos, uDensity;
      varying vec3 vColor; varying float vA;
      void main(){
        vec3 p = position;
        float amp = 0.028 + uChaos * 0.13;
        float spd = 0.10 + uChaos * 0.42;
        vec3 q = p * 1.55 + vec3(aSeed*7.0) + vec3(0.0, uTime*spd*0.35, uTime*spd*0.2);
        vec3 disp = vec3(
          snoise(q),
          snoise(q + vec3(19.3, 7.1, -3.4)),
          snoise(q + vec3(-8.2, 31.7, 12.9))
        );
        p += disp * amp * (0.3 + aFade);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float live = smoothstep(uDensity + 0.04, uDensity - 0.04, aId);
        float flick = 0.42 + 0.58 * pow(abs(sin(uTime*(0.8 + uChaos*2.2) + aSeed*53.0)), 1.6);
        vA = aFade * flick * live * (0.13 + uChaos * 0.26);
        vColor = aColor * (0.6 + uChaos * 0.75);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vA;
      void main(){ gl_FragColor = vec4(vColor, vA); }`,
  });

  return new THREE.LineSegments(geo, mat);
}
const filaments = buildFilaments();
group.add(filaments);

/* ------------------------------ core ------------------------------ */

const coreGeo = new THREE.BufferGeometry();
coreGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, 0]), 3));
const CORE_COLOR_BASE = new THREE.Color(0xb9fff4);
const CORE_COLOR_SPEAK = new THREE.Color(0xfff0c2); // warm flash while speaking a word
const core = new THREE.Points(coreGeo, new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  uniforms: { ...U, uColor: { value: new THREE.Color(0xb9fff4) } },
  vertexShader: `
    uniform float uTime, uProj, uPulse, uChaos;
    varying float vI;
    void main(){
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      float beat = 0.72 + 0.28*sin(uTime*(1.0 + uPulse*3.2));
      float micro = 0.9 + 0.1*sin(uTime*11.0);
      vI = beat * micro * (0.42 + uChaos*0.5);
      gl_PointSize = (0.42 + 0.22*beat) * uProj / -mv.z;
      gl_Position = projectionMatrix * mv;
    }`,
  fragmentShader: `
    uniform vec3 uColor; varying float vI;
    void main(){
      float d = length(gl_PointCoord - 0.5) * 2.0;
      if (d > 1.0) discard;
      float halo = pow(1.0 - d, 3.2);
      float hot = pow(1.0 - d, 12.0);
      gl_FragColor = vec4(uColor * (halo*0.55 + hot*2.0) * vI, (halo*0.45 + hot) * vI);
    }`,
}));
group.add(core);

/* ------------------------------ sparks ---------------------------- */

function buildSparks() {
  const n = COUNTS.sparks;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  const size = new Float32Array(n);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const outside = Math.random() < 0.24;
    const r = outside ? 1.85 + Math.random() * 1.5 : 0.2 + Math.pow(Math.random(), 0.6) * 1.6;
    const u = Math.random() * 2 - 1;
    const phi = Math.random() * Math.PI * 2;
    const sr = Math.sqrt(1 - u * u);
    pos[i * 3] = sr * Math.cos(phi) * r;
    pos[i * 3 + 1] = u * r;
    pos[i * 3 + 2] = sr * Math.sin(phi) * r;

    const roll = Math.random();
    if (roll < 0.055) c.setHex(0xff3d4f);          // errant red quanta
    else if (roll < 0.12) c.setHex(0xa8ff86);      // green
    else if (roll < 0.22) c.setHex(0xffffff);      // white
    else c.setHex(0x5ff0e6);                        // cyan
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
    seed[i] = Math.random();
    size[i] = 0.9 + Math.random() * 2.2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));

  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U },
    vertexShader: SNOISE + `
      attribute vec3 aColor; attribute float aSeed; attribute float aSize;
      uniform float uTime, uProj, uChaos;
      varying vec3 vColor; varying float vA;
      void main(){
        vec3 p = position;
        vec3 q = p*0.9 + vec3(aSeed*30.0) + uTime*0.05;
        p += vec3(snoise(q), snoise(q+13.7), snoise(q-27.1)) * (0.05 + uChaos*0.14);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        float tw = pow(abs(sin(uTime*(1.4 + aSeed*3.0) + aSeed*61.0)), 3.0);
        vA = (0.07 + tw*0.75) * (0.5 + uChaos*0.5);
        vColor = aColor;
        gl_PointSize = max(1.0, aSize * 0.0030 * uProj / -mv.z * (0.6 + tw*0.7));
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      varying vec3 vColor; varying float vA;
      void main(){
        float d = length(gl_PointCoord - 0.5);
        if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.0, d);
        gl_FragColor = vec4(vColor * (0.6 + vA*0.8), a * vA);
      }`,
  });
  return new THREE.Points(geo, mat);
}
group.add(buildSparks());

/* ------------------------------ memory rings ---------------------- */

function buildRing(radius, tilt, yaw, thickness, hue) {
  const n = 420;
  const pos = new Float32Array(n * 3);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * Math.PI * 2;
    pos[i * 3] = Math.cos(t) * radius;
    pos[i * 3 + 1] = (Math.random() - 0.5) * thickness;
    pos[i * 3 + 2] = Math.sin(t) * radius;
    // arc-shaped brightness so the ring reads as a fragment, not a wireframe circle
    a[i] = Math.pow(Math.max(0, Math.sin(t * 0.5 + 0.4)), 2.2) * (0.55 + Math.random() * 0.45);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aArc', new THREE.BufferAttribute(a, 1));
  const line = new THREE.Line(geo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...U, uColor: { value: new THREE.Color(hue) }, uOff: { value: Math.random() * 10 } },
    vertexShader: `
      attribute float aArc; uniform float uTime, uChaos, uOff;
      varying float vA;
      void main(){
        vec3 p = position;
        p.y += sin(uTime*0.6 + p.x*3.0 + uOff) * 0.02 * (0.4 + uChaos);
        vA = aArc * (0.30 + 0.55*abs(sin(uTime*0.5 + uOff))) * (0.25 + uChaos*0.45);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: `uniform vec3 uColor; varying float vA;
      void main(){ gl_FragColor = vec4(uColor*0.9, vA); }`,
  }));
  line.rotation.set(tilt, yaw, 0);
  return line;
}
const rings = [
  buildRing(1.08, 1.15, 0.4, 0.05, 0x7ef7ff),
  buildRing(1.42, -0.55, 2.1, 0.03, 0x5ce0d2),
  buildRing(0.78, 2.4, -1.0, 0.06, 0xa8f0ff),
];
rings.forEach((r) => group.add(r));

/* ------------------------------ glitch bands ---------------------- */

const bands = [];
for (let i = 0; i < 5; i++) {
  const w = 0.5 + Math.random() * 1.5;
  const h = 0.08 + Math.random() * 0.3;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      uniforms: { uTime: U.uTime, uOn: { value: 0 }, uColor: { value: new THREE.Color(i === 3 ? 0xff5566 : 0x63e9ff) } },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
      fragmentShader: `
        uniform float uTime, uOn; uniform vec3 uColor; varying vec2 vUv;
        void main(){
          float rows = floor(vUv.y * 9.0);
          float on = step(0.45, fract(sin(rows*12.9898 + floor(uTime*9.0)) * 43758.5453));
          float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x);
          float a = on * edge * uOn * 0.5;
          gl_FragColor = vec4(uColor, a);
        }`,
    })
  );
  const r = 0.6 + Math.random() * 1.1;
  const u = Math.random() * 2 - 1;
  const phi = Math.random() * Math.PI * 2;
  const sr = Math.sqrt(1 - u * u);
  mesh.position.set(sr * Math.cos(phi) * r, u * r, sr * Math.sin(phi) * r);
  mesh.rotation.set(Math.random() * 0.6 - 0.3, Math.random() * Math.PI, Math.random() * 0.4 - 0.2);
  mesh.userData = { next: Math.random() * 4, on: 0 };
  bands.push(mesh);
  group.add(mesh);
}

/* ------------------------------ postprocessing -------------------- */

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));

const bloom = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  params.glow, 0.42, 0.42
);
composer.addPass(bloom);

const gradePass = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberr: { value: 0.0022 },
    uGrain: { value: 0.018 },
  },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uTime, uAberr, uGrain;
    varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5;
      float d = dot(c, c);
      float a = uAberr * (0.35 + d * 3.2);
      vec3 col;
      col.r = texture2D(tDiffuse, vUv + c*a).r;
      col.g = texture2D(tDiffuse, vUv).g;
      col.b = texture2D(tDiffuse, vUv - c*a).b;
      col *= smoothstep(1.15, 0.22, length(c) * 1.24);
      float g = fract(sin(dot(vUv * (1.0 + fract(uTime)*0.7), vec2(12.9898, 78.233))) * 43758.5453);
      col += (g - 0.5) * uGrain * (0.4 + d);
      gl_FragColor = vec4(col, 1.0);
    }`,
});
composer.addPass(gradePass);
composer.addPass(new OutputPass());

/* ------------------------------ UI -------------------------------- */

const $ = (id) => document.getElementById(id);
const fmt = (v) => Number(v).toFixed(2);

function bindSlider(id, outId, key, after) {
  const el = $(id), out = $(outId);
  const apply = () => {
    const v = parseFloat(el.value);
    params[key] = v;
    out.textContent = fmt(v);
    if (after) after(v);
  };
  el.addEventListener('input', apply);
  apply();
  return el;
}

const sChaos = bindSlider('chaos', 'outChaos', 'chaos', (v) => { U.uChaos.value = v; });
const sGlow = bindSlider('glow', 'outGlow', 'glow', (v) => { bloom.strength = v; });
const sDens = bindSlider('dens', 'outDens', 'density', (v) => { U.uDensity.value = v; });
const sPulse = bindSlider('pulse', 'outPulse', 'pulse', (v) => { U.uPulse.value = v; });

$('spin').addEventListener('change', (e) => { controls.autoRotate = e.target.checked; });
$('shell').addEventListener('change', (e) => { shell.visible = e.target.checked; });

const panelToggle = $('panelToggle'), panelBody = $('panelBody');
panelToggle.addEventListener('click', () => {
  const open = panelToggle.getAttribute('aria-expanded') === 'true';
  panelToggle.setAttribute('aria-expanded', String(!open));
  panelBody.hidden = open;
});

const PRESETS = {
  calm: { chaos: 0.18, glow: 0.8, density: 0.5, pulse: 0.22 },
  think: { chaos: 0.55, glow: 1.15, density: 0.60, pulse: 0.6 },
  overload: { chaos: 0.70, glow: 2.0, density: 1.0, pulse: 1.0 },
};
const sliders = { chaos: sChaos, glow: sGlow, density: sDens, pulse: sPulse };
const outs = { chaos: $('outChaos'), glow: $('outGlow'), density: $('outDens'), pulse: $('outPulse') };
let tween = null;

document.querySelectorAll('.presets button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.presets button').forEach((b) => b.removeAttribute('data-active'));
    btn.setAttribute('data-active', '');
    const target = PRESETS[btn.dataset.preset];
    const from = { chaos: params.chaos, glow: params.glow, density: params.density, pulse: params.pulse };
    tween = { from, target, t: 0 };
  });
});
document.querySelector('.presets button[data-preset="think"]').setAttribute('data-active', '');

canvas.addEventListener('dblclick', () => {
  controls.reset();
  camera.position.set(0, fitDistance * 0.042, fitDistance);
});

const rdLinks = $('rdLinks'), rdFlux = $('rdFlux');

/* ------------------------------ loop ------------------------------ */

const clock = new THREE.Clock();
let readoutTimer = 0;

let fitDistance = 7.5;
function computeFit() {
  const R = 3; // radius that must stay inside the frame
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  return R / Math.tan(Math.min(vFov, hFov) / 2);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  const prevFit = fitDistance;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  fitDistance = computeFit();
  // preserve the user's zoom ratio while keeping the cluster framed
  const ratio = camera.position.distanceTo(controls.target) / prevFit;
  const dir = camera.position.clone().sub(controls.target).normalize();
  camera.position.copy(controls.target).addScaledVector(dir, fitDistance * ratio);
  controls.minDistance = fitDistance * 0.34;
  controls.maxDistance = fitDistance * 2.8;

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  composer.setSize(w, h);
  bloom.setSize(w, h);
  U.uPR.value = renderer.getPixelRatio();
  U.uProj.value = (h * renderer.getPixelRatio()) / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
}
window.addEventListener('resize', onResize);

function animate() {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  U.uTime.value = t;
  gradePass.uniforms.uTime.value = t;

  if (tween) {
    tween.t = Math.min(1, tween.t + dt * 1.5);
    const e = 1 - Math.pow(1 - tween.t, 3);
    for (const k of Object.keys(tween.target)) {
      const v = tween.from[k] + (tween.target[k] - tween.from[k]) * e;
      params[k] = v;
      sliders[k].value = v;
      outs[k].textContent = fmt(v);
    }
    U.uChaos.value = params.chaos;
    U.uDensity.value = params.density;
    U.uPulse.value = params.pulse;
    bloom.strength = params.glow;
    if (tween.t >= 1) tween = null;
  }

  // ease the voice states and decay the per-word transients first, so
  // everything below (rotation speed, bands, wobble, color) can react to
  // the same-frame values instead of lagging one frame behind
  voice.speaking += (voice.speakingTarget - voice.speaking) * Math.min(1, dt * 4);
  voice.listening += (voice.listeningTarget - voice.listening) * Math.min(1, dt * 4);
  voice.thinking += (voice.thinkingTarget - voice.thinking) * Math.min(1, dt * 3);
  voice.energy *= Math.pow(0.015, dt);
  voice.flash *= Math.pow(0.006, dt);

  group.rotation.y += dt * 0.05 * (0.3 + params.chaos) * (1 + voice.speaking * 0.5);
  // speaking adds a faster head-nod-like wobble; thinking a slow, searching drift
  const wobbleAmp = 0.06 * (1 + voice.speaking * 0.7) + voice.thinking * 0.03;
  const wobbleFreq = 0.13 + voice.speaking * 0.35 + voice.thinking * 0.05;
  group.rotation.x = Math.sin(t * wobbleFreq) * wobbleAmp;
  filaments.rotation.y -= dt * 0.035 * (0.4 + params.chaos);
  // rings spin up while the reply is spoken, giving the orb a distinct
  // "voice" gait instead of just brightness changes
  const ringBoost = 1 + voice.speaking * 1.6 + voice.thinking * 0.4;
  rings[0].rotation.z += dt * 0.09 * ringBoost;
  rings[1].rotation.x -= dt * 0.06 * ringBoost;
  rings[2].rotation.y += dt * 0.12 * ringBoost;

  // glitch bands blink at random intervals, more often under load and
  // markedly more often while actually speaking a reply
  for (const b of bands) {
    b.userData.next -= dt * (0.4 + params.chaos * 2.4 + voice.speaking * 1.8 + voice.thinking * 0.7);
    if (b.userData.next <= 0) {
      b.userData.on = 1;
      b.userData.next = 1.2 + Math.random() * 5;
      b.rotation.y += Math.random() * 1.2;
    }
    b.userData.on *= Math.pow(0.02, dt * 4);
    b.material.uniforms.uOn.value = b.userData.on;
  }

  U.uPulse.value = Math.min(1.5, params.pulse + voice.energy * 0.65 + voice.speaking * 0.14 + voice.thinking * 0.08);
  U.uChaos.value = Math.min(1.2, params.chaos + voice.speaking * 0.10 + voice.listening * 0.06 + voice.thinking * 0.08);
  bloom.strength = params.glow + voice.energy * 0.32 + voice.speaking * 0.1 + voice.thinking * 0.05;

  gradePass.uniforms.uAberr.value = 0.0016 + params.chaos * 0.0042 + voice.energy * 0.0018;

  // core briefly warms from cyan toward gold on each spoken word, then
  // eases back — a visible "voice" tell distinct from the ambient pulse
  core.material.uniforms.uColor.value.copy(CORE_COLOR_BASE).lerp(CORE_COLOR_SPEAK, Math.min(1, voice.flash));

  readoutTimer -= dt;
  if (readoutTimer <= 0) {
    readoutTimer = 0.22;
    const links = Math.round(COUNTS.filaments * params.density * 1000 + Math.random() * 900);
    rdLinks.textContent = links.toLocaleString('ru-RU');
    rdFlux.textContent = (params.chaos * 100 + Math.random() * 6 - 3).toFixed(1) + '%';
  }

  controls.update();
  composer.render();
  requestAnimationFrame(animate);
}

// start collapsed on small screens so the cluster owns the frame
if (SMALL) {
  panelToggle.setAttribute('aria-expanded', 'false');
  panelBody.hidden = true;
}

onResize();
camera.position.set(0, fitDistance * 0.042, fitDistance);
animate();
