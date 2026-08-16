import GUI from "lil-gui";

/* ==========================================================================
   Fogged window — wipe the glass, watch it drip.

   Pipeline (WebGL2, everything at half resolution except the final pass):

     state (ping-pong RGBA16F)   r = clarity (0 fogged .. 1 wiped)
                                 g = wetness (delays re-fogging)

     1. decay pass    clarity/wetness bleed back toward 0, modulated by fbm
                      so the glass re-fogs in blotches, not uniformly.
     2. stamp pass    instanced soft circles blended with MAX — the pointer
                      brush and every running drop's trail write here.
     3. drop pass     instanced hemispheres -> height map (MAX blend).
     4. composite     photo + frosted blur + condensation beads, revealed by
                      clarity, with the drop height map refracted on top.

   Drips are spawned by a coarse CPU mirror of the clarity grid: a cell that
   is clear with fog *directly below* it is the bottom lip of a wipe, which
   is exactly where real water collects and lets go.
   ========================================================================== */

const canvas = document.getElementById("rain-canvas");
const hintEl = document.getElementById("rain-hint");
const fallbackEl = document.getElementById("rain-fallback");

const PHOTOS = ["img8", "img1", "img3", "img5", "img12", "img15", "img18"];

const params = {
  fogDensity: 0.19,
  fogBlur: 0.78,
  fogWarm: 0.05,
  beadSize: 0.14,
  beadDensity: 1.0,
  beadRefract: 0.55,
  brushSize: 70,
  brushSoft: 0.3,
  edgeWater: 0.0,
  refogDelay: 2.0,
  refogTime: 8.0,
  refogPatch: 0.3,
  dropSpawn: 0.35,
  ambient: 0.25,
  dropSize: 0.76,
  dropShine: 0.6,
  gravity: 0.59,
  wobble: 0.26,
  stickiness: 0.45,
  trailWidth: 0.75,
  trailClear: 0.69,
  autoplay: false,
  photo: PHOTOS[0],
};

const MAX_DROPS = 260;
const MAX_STAMPS = 1024;
const SOFTWARE_GL = /swiftshader|swangle|software|llvmpipe/i;
const SCALE_STEPS = [1, 0.85, 0.72, 0.6, 0.5];

/* ------------------------------------------------------------------ shaders */

const VERT_FULLSCREEN = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

/* Clarity and wetness both decay back to zero. Clarity decays through an fbm
   mask so the fog creeps back in patches, and slower wherever the glass is
   still wet — a freshly wiped streak stays readable for a while. */
const FRAG_DECAY = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uPrev;
uniform float uDt, uTime, uRefogRate, uDryRate, uPatch, uDelayK;

float h21(vec2 p){
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x),
             mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  return vnoise(p) * 0.6 + vnoise(p * 2.3 + 7.7) * 0.3 + vnoise(p * 5.1 + 3.1) * 0.1;
}

void main(){
  vec4 s = texture(uPrev, vUv);
  float blotch = mix(1.0, 0.25 + 1.5 * fbm(vUv * 4.0 + uTime * 0.015), uPatch);
  float wetGate = 1.0 - uDelayK * smoothstep(0.05, 0.6, s.g);
  float clarity = s.r - uRefogRate * blotch * wetGate * uDt;
  float wet = s.g - uDryRate * uDt;
  outColor = vec4(max(clarity, 0.0), max(wet, 0.0), 0.0, 1.0);
}`;

/* Instanced soft disc. One instance per brush dab / trail dab. */
const VERT_STAMP = `#version 300 es
layout(location=0) in vec2 aQuad;   // -1..1
layout(location=1) in vec4 aPosR;   // x, y (px), radius (px), softness
layout(location=2) in vec4 aVal;    // clarity, wet, -, -
uniform vec2 uCanvas;
out vec2 vP;
out float vSoft;
out vec2 vVal;
void main(){
  vP = aQuad;
  vSoft = aPosR.w;
  vVal = aVal.xy;
  vec2 px = aPosR.xy + aQuad * aPosR.z;
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const FRAG_STAMP = `#version 300 es
precision highp float;
in vec2 vP;
in float vSoft;
in vec2 vVal;
out vec4 outColor;
void main(){
  float d = length(vP);
  float t = 1.0 - smoothstep(1.0 - max(vSoft, 0.03), 1.0, d);
  outColor = vec4(vVal.x * t, vVal.y * t, 0.0, 1.0);
}`;

/* Instanced hemisphere, stretched vertically with speed -> drop height map. */
const VERT_DROP = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec4 aPosR;   // x, y (px), radius (px), vertical stretch
layout(location=2) in vec4 aVal;    // mass/alpha, -, -, -
uniform vec2 uCanvas;
out vec2 vP;
out float vA;
void main(){
  vP = aQuad;
  vA = aVal.x;
  vec2 px = aPosR.xy + aQuad * aPosR.z * vec2(1.0, aPosR.w);
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const FRAG_DROP = `#version 300 es
precision highp float;
in vec2 vP;
in float vA;
out vec4 outColor;
void main(){
  float h = sqrt(max(1.0 - dot(vP, vP), 0.0)) * vA;
  outColor = vec4(h, 0.0, 0.0, 1.0);
}`;

const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uImgA, uImgB, uState, uDrops;
uniform vec4 uXfA, uXfB;            // (scaleX, scaleY, offsetX, offsetY)
uniform float uFade, uTime, uIntro;
uniform vec2 uRes, uTexel;
uniform float uFogDensity, uFogBlur, uBeadScale, uBeadDensity, uBeadRefract;
uniform float uWarm, uEdgeWater, uDropShine;

vec2 imgUv(vec2 s, vec4 xf){ return (s - 0.5) * xf.xy + 0.5 + xf.zw; }

vec3 bgAt(vec2 s, float lod){
  vec3 a = textureLod(uImgA, imgUv(s, uXfA), lod).rgb;
  vec3 b = textureLod(uImgB, imgUv(s, uXfB), lod).rgb;
  return mix(a, b, uFade);
}

float h21(vec2 p){
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
vec2 h22(vec2 p){ float n = h21(p); return vec2(n, h21(p + n + 17.1)); }

/* Condensation layer: a cellular field where each cell may hold one bead.
   Returns x = spherical height, yz = surface normal, w = lens glint. */
vec4 beads(vec2 guv, float scale, float density, float rBase, float rVar, float t){
  vec2 g = guv * scale;
  vec2 id = floor(g), f = fract(g);
  vec4 best = vec4(0.0);
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++){
    vec2 off = vec2(float(x), float(y));
    vec2 cid = id + off;
    if (h21(cid + 3.7) > density) continue;
    vec2 rnd = h22(cid);
    float r = rBase + rVar * rnd.y * rnd.y;          // biased toward small beads
    r *= 0.94 + 0.06 * sin(t * 0.22 + rnd.x * 6.283); // faint breathing
    vec2 c = off + 0.5 + (rnd - 0.5) * 0.72;
    vec2 d = f - c;
    float dist = length(d);
    if (dist >= r) continue;
    float h = sqrt(max(1.0 - (dist * dist) / (r * r), 0.0));
    if (h <= best.x) continue;
    vec2 n = (dist > 1e-4 ? d / dist : vec2(0.0)) * (1.0 - h);
    float spec = pow(max(1.0 - length(d / r - vec2(-0.30, 0.38)), 0.0), 3.5);
    best = vec4(h, n, spec);
  }
  return best;
}

vec3 beadShade(vec4 O, vec2 suv, vec3 base, vec3 milk, float lod,
               float refK, float darkK, float glintK, float refr){
  if (O.x <= 0.0) return base;
  float mask = smoothstep(0.10, 0.55, O.x);
  vec3 bc = bgAt(suv - O.yz * refr * refK, lod);      // tiny lens, sharper than the fog
  bc = mix(bc, milk, 0.18) * darkK;                   // beads read slightly darker than milk
  bc *= 1.0 - smoothstep(0.26, 0.05, O.x) * 0.14;     // thin rim
  bc += pow(O.w, 4.0) * (0.22 + refr * glintK);
  return mix(base, bc, mask * 0.9);
}

void main(){
  vec2 suv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 guv = vec2(suv.x * aspect, suv.y);   // square-ish space so beads stay round

  vec4 st = texture(uState, suv);
  float clarity = clamp(st.r, 0.0, 1.0);
  float wet = clamp(st.g, 0.0, 1.0);

  vec3 sharp = bgAt(suv, 0.0);

  /* Frosted base: a cheap 6-tap blur at a high mip level, desaturated and
     pulled toward a milk colour. */
  float lod = 2.0 + uFogBlur * 3.5;
  float rad = 0.006 + uFogBlur * 0.02;
  vec3 frost = bgAt(suv, lod);
  frost += bgAt(suv + vec2( 0.840,  0.320) * rad, lod);
  frost += bgAt(suv + vec2(-0.700,  0.590) * rad, lod);
  frost += bgAt(suv + vec2( 0.230, -0.880) * rad, lod);
  frost += bgAt(suv + vec2(-0.520, -0.560) * rad, lod);
  frost += bgAt(suv + vec2( 0.410,  0.830) * rad, lod);
  frost /= 6.0;

  vec3 milk = mix(vec3(0.885, 0.905, 0.925), vec3(0.93, 0.905, 0.875),
                  clamp(uWarm, 0.0, 1.0) * 0.7)
            - clamp(-uWarm, 0.0, 1.0) * vec3(0.035, 0.02, -0.012);

  float density = uFogDensity * uIntro * (1.0 - wet * 0.45);
  vec3 frostDesat = mix(frost, vec3(dot(frost, vec3(0.299, 0.587, 0.114))), 0.42);
  vec3 fogBase = mix(frostDesat, milk, density * 0.88) + density * 0.05;

  /* Three octaves of beads, from dust-fine to just-visible. */
  float cells = mix(110.0, 30.0, uBeadScale);
  float refr = uBeadRefract;
  vec4 O1 = beads(guv + 3.17, cells * 2.20, min(uBeadDensity * 1.5, 0.98), 0.12, 0.20, uTime * 0.9);
  vec4 O2 = beads(guv,        cells * 1.15, uBeadDensity,                  0.13, 0.24, uTime);
  vec4 O3 = beads(guv + 9.71, cells * 0.52, uBeadDensity * 0.55,           0.15, 0.26, uTime * 0.7);
  vec3 fogged = fogBase;
  fogged = beadShade(O1, suv, fogged, milk, 2.0, 0.006, 0.945, 0.7, refr);
  fogged = beadShade(O2, suv, fogged, milk, 1.4, 0.010, 0.915, 0.9, refr);
  fogged = beadShade(O3, suv, fogged, milk, 0.8, 0.016, 0.885, 1.1, refr);

  float reveal = smoothstep(0.12, 0.62, clarity);
  vec3 col = mix(fogged, sharp, reveal);

  /* Wet rim along the edge of a wipe, read from the clarity gradient. */
  if (uEdgeWater > 0.001){
    float cl = texture(uState, suv - vec2(uTexel.x * 2.0, 0.0)).r;
    float cr = texture(uState, suv + vec2(uTexel.x * 2.0, 0.0)).r;
    float cd = texture(uState, suv - vec2(0.0, uTexel.y * 2.0)).r;
    float cu = texture(uState, suv + vec2(0.0, uTexel.y * 2.0)).r;
    vec2 gradC = vec2(cr - cl, cu - cd);
    float edge = clamp(length(gradC) * 4.2, 0.0, 1.0)
               * (1.0 - reveal) * smoothstep(0.02, 0.2, clarity);
    vec2 en = length(gradC) > 1e-4 ? normalize(gradC) : vec2(0.0);
    col = mix(col, bgAt(suv + en * 0.012, 1.2) * 0.72, edge * uEdgeWater);
  }

  /* Running drops: height map -> normal -> refraction, glints, drop shadow. */
  float hC = texture(uDrops, suv).r;
  if (hC > 0.003){
    float hL = texture(uDrops, suv - vec2(uTexel.x, 0.0)).r;
    float hR = texture(uDrops, suv + vec2(uTexel.x, 0.0)).r;
    float hD = texture(uDrops, suv - vec2(0.0, uTexel.y)).r;
    float hU = texture(uDrops, suv + vec2(0.0, uTexel.y)).r;
    vec2 dn = vec2(hR - hL, hU - hD);
    float shine = uDropShine;

    vec3 dropCol = bgAt(suv + dn * (0.10 + shine * 0.25) + vec2(0.0, hC * 0.02), 0.0);
    dropCol = (dropCol - 0.5) * (1.0 + shine * 0.28) + 0.5;
    dropCol *= 0.96 - shine * 0.17;

    vec3 n3 = normalize(vec3(-dn * 4.0, 0.42));
    float g1 = pow(max(dot(n3, normalize(vec3( 0.30,  0.62, 0.55))), 0.0), 48.0);
    float g2 = pow(max(dot(n3, normalize(vec3(-0.45, -0.25, 0.75))), 0.0), 26.0);
    float crescent = smoothstep(0.30, 0.06, hC) * clamp(dn.y * 10.0, 0.0, 1.0);
    dropCol += (g1 * 1.5 + g2 * 0.35 + crescent * 0.55) * (0.25 + shine * 1.05);

    float rim = smoothstep(0.015, 0.06, hC) * (1.0 - smoothstep(0.06, 0.22, hC));
    dropCol *= 1.0 - rim * (0.16 + shine * 0.10);

    float m = smoothstep(0.015, 0.055, hC);
    col = mix(col, dropCol, m);

    float hBelow = texture(uDrops, suv - vec2(0.0, uTexel.y * 2.5)).r;
    col *= 1.0 - smoothstep(0.05, 0.5, hBelow) * (1.0 - m) * 0.10;
  }

  vec2 vc = suv - 0.5;
  col *= 1.0 - dot(vc, vc) * 0.22;
  outColor = vec4(col, 1.0);
}`;

/* ---------------------------------------------------------------- gl setup */

const gl = canvas.getContext("webgl2", {
  antialias: false,
  alpha: false,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
});

if (!gl) {
  fallbackEl?.classList.add("is-visible");
  throw new Error("[fog] WebGL2 unavailable");
}

{
  const ext = gl.getExtension("WEBGL_debug_renderer_info");
  const name = ext
    ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  if (typeof name === "string" && SOFTWARE_GL.test(name)) {
    console.info(`[fog] software renderer (${name}) — too slow for this scene`);
  }
}

const floatRenderable = !!(
  gl.getExtension("EXT_color_buffer_float") ||
  gl.getExtension("EXT_color_buffer_half_float")
);

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error(gl.getShaderInfoLog(sh), src);
    throw new Error("shader compile failed");
  }
  return sh;
}

function program(vsSrc, fsSrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error(gl.getProgramInfoLog(p));
    throw new Error("program link failed");
  }
  // Cache uniform locations by name so the render loop stays allocation-free.
  const uniforms = {};
  const count = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, "");
    uniforms[name] = gl.getUniformLocation(p, name);
  }
  p.u = uniforms;
  return p;
}

const progDecay = program(VERT_FULLSCREEN, FRAG_DECAY);
const progStamp = program(VERT_STAMP, FRAG_STAMP);
const progDrop = program(VERT_DROP, FRAG_DROP);
const progComposite = program(VERT_FULLSCREEN, FRAG_COMPOSITE);

// Fullscreen triangle.
const triVao = gl.createVertexArray();
gl.bindVertexArray(triVao);
const triBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 3, -1, -1, 3]),
  gl.STATIC_DRAW
);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

// Unit quad reused by both instanced passes.
const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
  gl.STATIC_DRAW
);

const INSTANCE_FLOATS = 8; // x, y, r, soft/stretch, val0, val1, -, -
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

function makeInstancedVao() {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, MAX_STAMPS * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 4, gl.FLOAT, false, INSTANCE_BYTES, 0);
  gl.vertexAttribDivisor(1, 1);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 4, gl.FLOAT, false, INSTANCE_BYTES, 16);
  gl.vertexAttribDivisor(2, 1);
  gl.bindVertexArray(null);
  return { vao, buf };
}

const stampVao = makeInstancedVao();
const dropVao = makeInstancedVao();

const stampData = new Float32Array(MAX_STAMPS * INSTANCE_FLOATS);
const dropData = new Float32Array(MAX_STAMPS * INSTANCE_FLOATS);
let stampCount = 0;

function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(
    gl.TEXTURE_2D,
    1,
    floatRenderable ? gl.RGBA16F : gl.RGBA8,
    w,
    h
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    tex,
    0
  );
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

/* ------------------------------------------------------------------ sizing */

let W = 0;
let H = 0;
let simW = 0;
let simH = 0;
let dpr = 1;
let renderScale = SCALE_STEPS[0];
let scaleStep = 0;

let state = [null, null];
let stateIdx = 0;
let dropTarget = null;

// Coarse CPU mirror of the clarity field, used to find drip origins.
let gridW = 0;
let gridH = 0;
let gridTime = null; // last write time per cell (seconds)
let gridClarity = null;
let gridWet = null;
let now = 0;

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 1.75) * renderScale;
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  if (w === W && h === H) return;

  W = w;
  H = h;
  canvas.width = W;
  canvas.height = H;
  simW = Math.max(2, Math.round(W * 0.5));
  simH = Math.max(2, Math.round(H * 0.5));

  for (const t of [state[0], state[1], dropTarget]) {
    if (!t) continue;
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
  }
  state[0] = makeTarget(simW, simH);
  state[1] = makeTarget(simW, simH);
  dropTarget = makeTarget(simW, simH);

  gridW = Math.max(4, Math.round(simW / 4));
  gridH = Math.max(4, Math.round(simH / 4));
  gridTime = new Float32Array(gridW * gridH);
  gridClarity = new Float32Array(gridW * gridH);
  gridWet = new Float32Array(gridW * gridH);

  for (const t of state) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

/* -------------------------------------------------------------- photo load */

const images = [];
const imageMeta = [];
let loadedCount = 0;
let currentPhoto = 0;
let nextPhoto = 0;
let fade = 1;
let lastSlide = performance.now();

function uploadPhoto(index, img) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  images[index] = tex;
  imageMeta[index] = { w: img.naturalWidth, h: img.naturalHeight };
  loadedCount++;
}

PHOTOS.forEach((name, i) => {
  const img = new Image();
  img.decoding = "async";
  img.onload = () => uploadPhoto(i, img);
  img.onerror = () => console.warn(`[fog] failed to load ${name}`);
  img.src = `/${name}.jpeg`;
});

/* Cover-fit plus a very slow Ken Burns drift, packed into one vec4. */
const xfA = new Float32Array(4);
const xfB = new Float32Array(4);

function coverTransform(out, index, t) {
  const meta = imageMeta[index];
  if (!meta) {
    out[0] = 1;
    out[1] = 1;
    out[2] = 0;
    out[3] = 0;
    return out;
  }
  const cover = Math.max(W / meta.w, H / meta.h);
  const zoom = 1 + 0.045 * (0.5 + 0.5 * Math.sin(t * 0.05 + index * 2.1));
  out[0] = W / (meta.w * cover) / zoom;
  out[1] = H / (meta.h * cover) / zoom;
  out[2] = 0.01 * Math.sin(t * 0.031 + index * 1.7);
  out[3] = 0.008 * Math.cos(t * 0.026 + index * 2.9);
  return out;
}

function showPhoto(index) {
  if (index === nextPhoto) return;
  nextPhoto = (index + PHOTOS.length) % PHOTOS.length;
  fade = 0;
  lastSlide = performance.now();
}

/* --------------------------------------------------- stamps + clarity grid */

/* Keep the coarse grid in sync with what we just wrote to the GPU. Cells are
   decayed lazily: each one remembers when it was last touched. */
function touchGrid(x, y, r, clarity, wet) {
  if (!W || !H || !gridClarity) return;
  const gx = (x / W) * gridW;
  const gy = (1 - y / H) * gridH;
  const gr = (r / W) * gridW;
  const x0 = Math.max(0, Math.floor(gx - gr));
  const x1 = Math.min(gridW - 1, Math.ceil(gx + gr));
  const y0 = Math.max(0, Math.floor(gy - gr));
  const y1 = Math.min(gridH - 1, Math.ceil(gy + gr));
  const r2 = gr * gr;
  const refog = 1 / Math.max(params.refogTime, 1);
  const dry = 1 / Math.max(params.refogDelay, 0.15);

  for (let row = y0; row <= y1; row++) {
    const base = row * gridW;
    const dy = row + 0.5 - gy;
    for (let col = x0; col <= x1; col++) {
      const dx = col + 0.5 - gx;
      if (dx * dx + dy * dy > r2) continue;
      const i = base + col;
      const elapsed = now - gridTime[i];
      gridClarity[i] = Math.max(gridClarity[i] - elapsed * refog, 0, clarity);
      gridWet[i] = Math.max(gridWet[i] - elapsed * dry, 0, wet);
      gridTime[i] = now;
    }
  }
}

function stamp(x, y, r, soft, clarity, wet) {
  if (stampCount >= MAX_STAMPS) return;
  touchGrid(x, y, r, clarity, wet);
  const o = stampCount * INSTANCE_FLOATS;
  stampData[o] = x;
  stampData[o + 1] = y;
  stampData[o + 2] = r;
  stampData[o + 3] = soft;
  stampData[o + 4] = clarity;
  stampData[o + 5] = wet;
  stampCount++;
}

/* ------------------------------------------------------------------- drops */

const drops = [];
let ambientAcc = 0;
let lastSpawnScan = 0;

function spawnDrop(x, y, opts = {}) {
  if (drops.length >= MAX_DROPS) return;
  const size = 0.5 + 0.9 * params.dropSize;
  const r = (opts.rMin + opts.rVar * Math.random()) * size * dpr;
  drops.push({
    x,
    y,
    r,
    vx: 0,
    vy: opts.vy ?? 0,
    stuck: opts.stuck ?? false,
    stickT: opts.stickT ?? 0,
    phase: Math.random() * 6.283,
    seed: Math.random(),
    trailAcc: 0,
    age: 0,
  });
}

/* The squeegee pushes standing water out of its way. */
function sweepDrops(x0, y0, x1, y1, radius) {
  const ax = x1 - x0;
  const ay = y1 - y0;
  const len2 = ax * ax + ay * ay;
  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    let t = len2 > 0 ? ((d.x - x0) * ax + (d.y - y0) * ay) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = x0 + ax * t - d.x;
    const dy = y0 + ay * t - d.y;
    const reach = radius + d.r;
    if (dx * dx + dy * dy < reach * reach) drops.splice(i, 1);
  }
}

function updateDrops(dt, time) {
  const accel = 240 + 900 * params.gravity;
  const shrink = 0.012 + 0.02 * (1 - params.dropSize);

  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.age += dt;

    // A bead that is still clinging just grows until it is heavy enough.
    if (d.stuck) {
      d.r += (1.2 + 1.5 * params.ambient) * dt * dpr;
      d.stickT += dt;
      const release = (6 + (1 - params.gravity) * 7 + 10 * d.seed) * dpr;
      if (d.r > release) d.stuck = false;
      continue;
    }

    const vMax = (60 + 340 * params.gravity) * (d.r / (8 * dpr)) * dpr;
    d.vy = Math.min(d.vy + accel * dt * dpr, vMax);

    // Random micro-snags: water on glass runs in stutters, not smoothly.
    if (d.stickT <= 0 && Math.random() < params.stickiness * dt * 2.7) {
      d.stickT = 0.08 + 0.4 * Math.random() * params.stickiness;
    }
    if (d.stickT > 0) {
      d.stickT -= dt;
      d.vy *= 0.2;
    }

    d.phase += dt * (3 + 6 * params.wobble);
    d.vx =
      Math.sin(d.phase) * params.wobble * 26 * dpr +
      Math.sin(d.seed * 40 + time) * params.wobble * 8 * dpr;

    const px = d.x;
    const py = d.y;
    d.x += d.vx * dt;
    d.y += d.vy * dt;

    // Lay down the trail: this is what carves a clear streak into the fog.
    const travelled = Math.hypot(d.x - px, d.y - py);
    d.trailAcc += travelled;
    const trailR = d.r * (0.4 + 0.7 * params.trailWidth);
    const step = Math.max(trailR * 0.34, 1.2 * dpr);
    while (d.trailAcc > step) {
      d.trailAcc -= step;
      const back = travelled > 0 ? d.trailAcc / travelled : 0;
      stamp(
        d.x - (d.x - px) * back,
        d.y - (d.y - py) * back,
        trailR,
        0.55,
        params.trailClear,
        0.55
      );
    }

    d.r -= shrink * travelled;
    if (d.r < 1.6 * dpr || d.y > H + 20 * dpr) drops.splice(i, 1);
  }

  // Merge on contact — a big drop swallowing a small one speeds up.
  for (let i = 0; i < drops.length; i++) {
    const a = drops[i];
    for (let j = i + 1; j < drops.length; j++) {
      const b = drops[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const lim = (a.r + b.r) * 0.5;
      if (dx * dx + dy * dy >= lim * lim) continue;
      const big = a.r >= b.r ? a : b;
      const small = a.r >= b.r ? b : a;
      big.r = Math.min(Math.hypot(big.r, small.r), 16 * dpr);
      big.vy = Math.max(big.vy, small.vy);
      big.stuck = big.stuck && small.stuck;
      drops.splice(drops.indexOf(small), 1);
      if (small === a) i--;
      break;
    }
  }
}

/* Look for the bottom lip of a cleared area: a clear cell with fog two rows
   below it. That boundary is where water pools and finally runs. */
function scanForDrips(t) {
  if (t - lastSpawnScan < 130 || !gridClarity) return;
  lastSpawnScan = t;

  const CLEAR_ABOVE = 140 / 255;
  const FOG_BELOW = 82 / 255;
  const MIN_WET = 60 / 255;
  const refog = 1 / Math.max(params.refogTime, 1);
  const dry = 1 / Math.max(params.refogDelay, 0.15);
  const candidates = [];

  for (let col = 0; col < gridW; col++) {
    for (let row = gridH - 1; row >= 2; row--) {
      const i = row * gridW + col;
      if (gridClarity[i] - (now - gridTime[i]) * refog <= CLEAR_ABOVE) continue;
      const wet = gridWet[i] - (now - gridTime[i]) * dry;
      if (wet <= MIN_WET) continue;
      const below = (row - 2) * gridW + col;
      if (gridClarity[below] - (now - gridTime[below]) * refog >= FOG_BELOW) {
        continue;
      }
      candidates.push(col, row, wet);
    }
  }
  if (!candidates.length) return;

  const rate = params.dropSpawn * Math.min(candidates.length / 3, 80) * 0.085;
  let count = Math.min(Math.floor(rate) + (Math.random() < rate % 1 ? 1 : 0), 6);
  const cellW = W / gridW;
  const cellH = H / gridH;

  while (count-- > 0) {
    const k = ((Math.random() * candidates.length) / 3) | 0;
    const o = k * 3;
    if (Math.random() > candidates[o + 2] * 1.25) continue;

    const x = (candidates[o] + 0.5) * cellW + (Math.random() - 0.5) * cellW;
    const y =
      (1 - (candidates[o + 1] + 0.5) / gridH) * H +
      (0.2 + 0.8 * Math.random()) * cellH;

    const clearance = (16 + 22 * Math.random()) * dpr;
    let crowded = false;
    for (const d of drops) {
      const dx = d.x - x;
      const dy = d.y - y;
      if (dx * dx + dy * dy < clearance * clearance) {
        crowded = true;
        break;
      }
    }
    if (crowded) continue;

    spawnDrop(x, y, {
      rMin: 3.5,
      rVar: 5,
      vy: (25 + 55 * Math.random()) * dpr,
      stickT: Math.random() < 0.3 ? 0.15 + 0.45 * Math.random() : 0,
    });
  }
}

/* ----------------------------------------------------------------- pointer */

let lastPointer = null;
let hintHidden = false;

function hideHint() {
  if (hintHidden) return;
  hintHidden = true;
  hintEl?.classList.add("is-hidden");
}

function wipeTo(x, y) {
  const r = params.brushSize * dpr;
  const soft = params.brushSoft;
  sweepDrops(lastPointer ? lastPointer.x : x, lastPointer ? lastPointer.y : y, x, y, r * 0.92);

  if (lastPointer) {
    const dist = Math.hypot(x - lastPointer.x, y - lastPointer.y);
    const steps = Math.max(1, Math.ceil(dist / Math.max(r * 0.3, 4)));
    for (let i = 1; i <= steps; i++) {
      stamp(
        lastPointer.x + (x - lastPointer.x) * (i / steps),
        lastPointer.y + (y - lastPointer.y) * (i / steps),
        r,
        soft,
        1,
        0.95
      );
    }
  } else {
    stamp(x, y, r, soft, 1, 0.95);
  }
  lastPointer = { x, y };
}

canvas.addEventListener("pointerdown", (e) => {
  hideHint();
  lastPointer = null;
  wipeTo(e.clientX * dpr, e.clientY * dpr);
});
window.addEventListener("pointermove", (e) => {
  hideHint();
  wipeTo(e.clientX * dpr, e.clientY * dpr);
});
window.addEventListener("pointerup", () => {
  lastPointer = null;
});
window.addEventListener("pointercancel", () => {
  lastPointer = null;
});
window.addEventListener("resize", resize);

/* ------------------------------------------------------------------ render */

const startTime = performance.now();
let lastFrame = startTime;
let intro = 0;
let fpsFrames = 0;
let fpsElapsed = 0;
let fps = 60;
let lowFrames = 0;
let highFrames = 0;
let probeStart = 0;

function runSim(dt, time) {
  const src = state[stateIdx];
  const dst = state[1 - stateIdx];

  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
  gl.viewport(0, 0, simW, simH);
  gl.disable(gl.BLEND);
  gl.useProgram(progDecay);
  gl.bindVertexArray(triVao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src.tex);
  gl.uniform1i(progDecay.u.uPrev, 0);
  gl.uniform1f(progDecay.u.uDt, dt);
  gl.uniform1f(progDecay.u.uTime, time);
  gl.uniform1f(progDecay.u.uRefogRate, 1 / Math.max(params.refogTime, 1));
  gl.uniform1f(progDecay.u.uDryRate, 1 / Math.max(params.refogDelay, 0.15));
  gl.uniform1f(progDecay.u.uPatch, params.refogPatch);
  gl.uniform1f(
    progDecay.u.uDelayK,
    0.9 * Math.min(params.refogDelay / 4, 1) + 0.05
  );
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (stampCount > 0) {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progStamp);
    gl.bindVertexArray(stampVao.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, stampVao.buf);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      stampData,
      0,
      stampCount * INSTANCE_FLOATS
    );
    gl.uniform2f(progStamp.u.uCanvas, W, H);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, stampCount);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    stampCount = 0;
  }

  stateIdx = 1 - stateIdx;
}

function renderDropHeights() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dropTarget.fbo);
  gl.viewport(0, 0, simW, simH);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!drops.length) return;

  let n = 0;
  for (const d of drops) {
    if (n >= MAX_STAMPS) break;
    const o = n * INSTANCE_FLOATS;
    dropData[o] = d.x;
    dropData[o + 1] = d.y;
    dropData[o + 2] = d.r;
    dropData[o + 3] = 1 + Math.min(d.vy / (320 * dpr), 1.2); // stretch with speed
    dropData[o + 4] =
      Math.min(d.r / (5 * dpr), 1) * Math.min(d.age / 0.28, 1);
    n++;
  }

  gl.enable(gl.BLEND);
  gl.blendEquation(gl.MAX);
  gl.blendFunc(gl.ONE, gl.ONE);
  gl.useProgram(progDrop);
  gl.bindVertexArray(dropVao.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, dropVao.buf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, dropData, 0, n * INSTANCE_FLOATS);
  gl.uniform2f(progDrop.u.uCanvas, W, H);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
  gl.blendEquation(gl.FUNC_ADD);
  gl.disable(gl.BLEND);
}

function composite(time) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(progComposite);
  gl.bindVertexArray(triVao);

  const a = images[currentPhoto] ? currentPhoto : 0;
  const b = images[nextPhoto] ? nextPhoto : a;

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, images[a]);
  gl.uniform1i(progComposite.u.uImgA, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, images[b]);
  gl.uniform1i(progComposite.u.uImgB, 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, state[stateIdx].tex);
  gl.uniform1i(progComposite.u.uState, 2);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, dropTarget.tex);
  gl.uniform1i(progComposite.u.uDrops, 3);

  gl.uniform4fv(progComposite.u.uXfA, coverTransform(xfA, a, time));
  gl.uniform4fv(progComposite.u.uXfB, coverTransform(xfB, b, time));
  gl.uniform1f(progComposite.u.uFade, fade < 1 ? fade * fade * (3 - 2 * fade) : 0);
  gl.uniform1f(progComposite.u.uTime, time);
  gl.uniform1f(progComposite.u.uIntro, intro * intro * (3 - 2 * intro));
  gl.uniform2f(progComposite.u.uRes, W, H);
  gl.uniform2f(progComposite.u.uTexel, 1 / simW, 1 / simH);
  gl.uniform1f(progComposite.u.uFogDensity, params.fogDensity);
  gl.uniform1f(progComposite.u.uFogBlur, params.fogBlur);
  gl.uniform1f(progComposite.u.uBeadScale, params.beadSize);
  gl.uniform1f(progComposite.u.uBeadDensity, params.beadDensity);
  gl.uniform1f(progComposite.u.uBeadRefract, params.beadRefract);
  gl.uniform1f(progComposite.u.uWarm, params.fogWarm);
  gl.uniform1f(progComposite.u.uEdgeWater, params.edgeWater);
  gl.uniform1f(progComposite.u.uDropShine, params.dropShine);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* Back off the render scale if the GPU can't keep up. */
function adaptQuality(t) {
  if (probeStart === 0) probeStart = t;
  if (scaleStep >= SCALE_STEPS.length - 1) return;
  if (t - probeStart < 3000) {
    if (fps < 20 && fps > 0) {
      scaleStep = SCALE_STEPS.length - 1;
      renderScale = SCALE_STEPS[scaleStep];
      W = H = 0;
      resize();
      console.info(`[fog] fps ${fps} — renderScale -> ${renderScale}`);
    }
    return;
  }
  if (fps >= 50) {
    lowFrames = 0;
    return;
  }
  if (++lowFrames >= 3) {
    lowFrames = 0;
    renderScale = SCALE_STEPS[++scaleStep];
    W = H = 0;
    resize();
    console.info(`[fog] fps ${fps} — renderScale -> ${renderScale}`);
  }
}

function frame(t) {
  requestAnimationFrame(frame);
  if (!loadedCount) return;

  resize();

  const dt = Math.min((t - lastFrame) / 1000, 0.033);
  lastFrame = t;
  const time = (t - startTime) / 1000;
  now = time;
  intro = Math.min(1, intro + dt / 2.2);

  if (params.autoplay && t - lastSlide > 7000) {
    showPhoto((currentPhoto + 1) % PHOTOS.length);
  }
  if (fade < 1) {
    fade = Math.min(1, fade + (dt * 1000) / 1600);
    if (fade === 1) currentPhoto = nextPhoto;
  }

  // Occasional drop that just appears out of the condensation.
  ambientAcc += dt * params.ambient * 0.55;
  while (ambientAcc > 1) {
    ambientAcc -= 1;
    spawnDrop(Math.random() * W, Math.random() * H * 0.45, {
      rMin: 5.5,
      rVar: 5.5,
      vy: (18 + 30 * Math.random()) * dpr,
    });
  }

  updateDrops(dt, time);
  runSim(dt, time);
  scanForDrips(t);
  renderDropHeights();
  composite(time);

  fpsFrames++;
  fpsElapsed += dt;
  if (fpsElapsed >= 0.5) {
    fps = Math.round(fpsFrames / fpsElapsed);
    fpsFrames = 0;
    fpsElapsed = 0;
    adaptQuality(t);
  }
}

resize();
requestAnimationFrame(frame);

/* --------------------------------------------------------------------- gui */

const gui = new GUI({ title: "Window" });
gui.domElement.style.right = "12px";
gui.domElement.style.top = "72px";

const fFog = gui.addFolder("Fog");
fFog.add(params, "fogDensity", 0, 1, 0.01).name("Density");
fFog.add(params, "fogBlur", 0, 1, 0.01).name("Blur");
fFog.add(params, "fogWarm", -1, 1, 0.01).name("Warmth");
fFog.add(params, "beadSize", 0, 1, 0.01).name("Bead size");
fFog.add(params, "beadDensity", 0, 1, 0.01).name("Bead density");
fFog.add(params, "beadRefract", 0, 1.5, 0.01).name("Bead lens");

const fWipe = gui.addFolder("Wipe");
fWipe.add(params, "brushSize", 20, 160, 1).name("Brush size");
fWipe.add(params, "brushSoft", 0.02, 1, 0.01).name("Brush softness");
fWipe.add(params, "edgeWater", 0, 1, 0.01).name("Edge water");
fWipe.add(params, "refogTime", 2, 40, 0.5).name("Re-fog time");
fWipe.add(params, "refogDelay", 0.2, 8, 0.1).name("Dry delay");
fWipe.add(params, "refogPatch", 0, 1, 0.01).name("Re-fog patchiness");

const fDrops = gui.addFolder("Drops");
fDrops.add(params, "dropSpawn", 0, 1.5, 0.01).name("Spawn from wipes");
fDrops.add(params, "ambient", 0, 1.5, 0.01).name("Ambient drops");
fDrops.add(params, "dropSize", 0, 1.5, 0.01).name("Size");
fDrops.add(params, "dropShine", 0, 1.5, 0.01).name("Shine");
fDrops.add(params, "gravity", 0, 1, 0.01).name("Gravity");
fDrops.add(params, "wobble", 0, 1, 0.01).name("Wobble");
fDrops.add(params, "stickiness", 0, 1, 0.01).name("Stickiness");
fDrops.add(params, "trailWidth", 0, 1.5, 0.01).name("Trail width");
fDrops.add(params, "trailClear", 0, 1, 0.01).name("Trail clearing");
fDrops.add({ clear: () => (drops.length = 0) }, "clear").name("Clear drops");
fDrops.close();

gui
  .add(params, "photo", PHOTOS)
  .name("Photo")
  .onChange((v) => showPhoto(PHOTOS.indexOf(v)));
gui.add(params, "autoplay").name("Auto-cycle");

window.__fog = {
  params,
  drops: () => drops.length,
  fps: () => fps,
  wipeLine(x0, y0, x1, y1, steps = 28) {
    lastPointer = null;
    for (let i = 0; i <= steps; i++) {
      wipeTo(
        (x0 + (x1 - x0) * (i / steps)) * dpr,
        (y0 + (y1 - y0) * (i / steps)) * dpr
      );
    }
    lastPointer = null;
  },
};
