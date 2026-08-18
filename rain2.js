import GUI from "lil-gui";

/* ==========================================================================
   Fogged window v2 — wipe the glass, watch it drip.

   Same skeleton as v1 (ping-pong clarity state, instanced stamping, drips
   that carve their own trails), with the physics of the water rewritten:

     * droplets are real lenses now — the image inside one is inverted and
       magnified, not just displaced sideways
     * dispersion at the droplet rim (chromatic aberration where the
       refraction angle is steepest, not smeared over the whole screen)
     * Fresnel rim reflection, and a caustic cast below each drop
     * running drops are teardrops, and they leave pinned satellite beads
       behind them so trails read as beaded rather than smooth
     * the squeegee edge frays into streaks along the wipe direction
     * the fog itself is no longer a flat constant

   Budget note: bgAt() used to sample BOTH photos on every tap for a
   crossfade that is idle ~99% of the time. Branching that away roughly
   halved the fragment cost, which is what pays for everything above.
   ========================================================================== */

const canvas = document.getElementById("rain-canvas");
const hintEl = document.getElementById("rain-hint");
const fallbackEl = document.getElementById("rain-fallback");

const PHOTOS = ["img8", "img1", "img3", "img5", "img12", "img15", "img18"];

const params = {
  // glass
  fogDensity: 0.19,
  fogBlur: 0.78,
  fogWarm: 0.05,
  fogVary: 0.55,
  beadSize: 0.14,
  beadDensity: 0.04,
  beadRefract: 0,
  // wipe
  brushSize: 70,
  brushSoft: 0.3,
  streak: 0.1,
  edgeWater: 0.0,
  refogDelay: 2.0,
  refogTime: 8.0,
  refogPatch: 0.3,
  // water
  dropSpawn: 0.35,
  ambient: 0.25,
  dropSize: 0.76,
  dropShine: 0.6,
  gravity: 0.59,
  wobble: 0.26,
  stickiness: 0.45,
  trailWidth: 0.75,
  trailClear: 0.69,
  residue: 0.5,
  tailTaper: 0.45,
  // optics
  lensZoom: 0.05,
  lensMix: 0.9,
  ca: 0.5,
  fresnel: 0.35,
  caustic: 0.5,
  // page
  autoplay: false,
  photo: PHOTOS[0],
};

const MAX_DROPS = 260;
const MAX_RESIDUE = 420;
const MAX_STAMPS = 1024;
const MAX_INSTANCES = MAX_DROPS + MAX_RESIDUE;
const SCALE_STEPS = [1, 0.85, 0.72, 0.6, 0.5];

const isTouch =
  window.matchMedia?.("(pointer: coarse)").matches || window.innerWidth < 768;
const DPR_CAP = isTouch ? 1.25 : 1.75;

/* Phones keep the lens (cheap, and it is the whole point) but drop the
   optics that cost extra texture fetches. */
if (isTouch) {
  params.ca = 0;
  params.caustic = 0;
  params.fresnel = 0.2;
}

/* ------------------------------------------------------------------ shaders */

const VERT_FULLSCREEN = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main(){
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

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

const VERT_STAMP = `#version 300 es
layout(location=0) in vec2 aQuad;
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

/* Drops now carry their centre through to the compositor so it can build a
   real lens. No blending: fragments outside the body are discarded and the
   last drop drawn wins, which is why residue is drawn before live drops. */
const VERT_DROP = `#version 300 es
layout(location=0) in vec2 aQuad;
layout(location=1) in vec4 aPosR;   // x, y (px), radius (px), vertical stretch
layout(location=2) in vec4 aVal;    // mass, taper amount, -, -
uniform vec2 uCanvas;
out vec2 vP;
out float vA;
out float vTaper;
flat out vec2 vCenter;
void main(){
  vP = aQuad;
  vA = aVal.x;
  // Only a moving drop draws out into a teardrop; a resting one stays round.
  vTaper = mix(1.0, aVal.y, clamp((aPosR.w - 1.0) / 1.2, 0.0, 1.0));
  vCenter = vec2(aPosR.x / uCanvas.x, 1.0 - aPosR.y / uCanvas.y);
  vec2 px = aPosR.xy + aQuad * aPosR.z * vec2(1.0, aPosR.w);
  gl_Position = vec4(px.x / uCanvas.x * 2.0 - 1.0, 1.0 - px.y / uCanvas.y * 2.0, 0.0, 1.0);
}`;

const FRAG_DROP = `#version 300 es
precision highp float;
in vec2 vP;
in float vA;
in float vTaper;
flat in vec2 vCenter;
out vec4 outColor;
void main(){
  // vP.y = -1 is the top of the quad, so the tail narrows upward.
  float t = mix(1.0, vTaper, smoothstep(0.30, -1.0, vP.y));
  vec2 q = vec2(vP.x / max(t, 0.08), vP.y);
  float d2 = dot(q, q);
  if (d2 >= 1.0) discard;
  float h = sqrt(max(1.0 - d2, 0.0)) * vA;
  if (h <= 0.002) discard;
  outColor = vec4(h, vCenter, 1.0);
}`;

const FRAG_COPY = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;
uniform sampler2D uSrc;
void main(){ outColor = texture(uSrc, vUv); }`;

const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uImgA, uImgB, uState, uDrops;
uniform vec4 uXfA, uXfB;
uniform float uFade, uTime, uIntro;
uniform vec2 uRes, uTexel;
uniform float uFogDensity, uFogBlur, uBeadScale, uBeadDensity, uBeadRefract;
uniform float uWarm, uEdgeWater, uDropShine, uFineBeads, uFogVary, uStreak;
uniform float uLensZoom, uLensMix, uCA, uFresnel, uCaustic;

vec2 imgUv(vec2 s, vec4 xf){ return (s - 0.5) * xf.xy + 0.5 + xf.zw; }

/* The crossfade is idle almost always — skip the second photo entirely.
   uFade is a uniform, so the branch is coherent across the whole draw. */
vec3 bgAt(vec2 s, float lod){
  vec3 a = textureLod(uImgA, imgUv(s, uXfA), lod).rgb;
  if (uFade <= 0.001) return a;
  return mix(a, textureLod(uImgB, imgUv(s, uXfB), lod).rgb, uFade);
}

float h21(vec2 p){
  p = fract(p * vec2(234.34, 435.345));
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
vec2 h22(vec2 p){ float n = h21(p); return vec2(n, h21(p + n + 17.1)); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1,0)), f.x),
             mix(h21(i + vec2(0,1)), h21(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p){
  return vnoise(p) * 0.6 + vnoise(p * 2.3 + 7.7) * 0.3 + vnoise(p * 5.1 + 3.1) * 0.1;
}

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
    float r = rBase + rVar * rnd.y * rnd.y;
    r *= 0.94 + 0.06 * sin(t * 0.22 + rnd.x * 6.283);
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

/* Condensation beads are lenses too, just small ones: invert and magnify a
   pinch of the scene rather than nudging it sideways. */
vec3 beadShade(vec4 O, vec2 suv, vec3 base, vec3 milk, float lod, float aspect,
               float zoom, float darkK, float glintK, float refr){
  if (O.x <= 0.0) return base;
  float mask = smoothstep(0.10, 0.55, O.x);
  vec2 flip = O.yz * zoom * refr * vec2(1.0 / aspect, 1.0);
  vec3 bc = bgAt(suv - flip, lod);
  bc = mix(bc, milk, 0.18) * darkK;
  bc *= 1.0 - smoothstep(0.26, 0.05, O.x) * 0.14;
  bc += pow(O.w, 4.0) * (0.22 + refr * glintK);
  return mix(base, bc, mask * 0.9);
}

void main(){
  vec2 suv = vUv;
  float aspect = uRes.x / uRes.y;
  vec2 guv = vec2(suv.x * aspect, suv.y);

  vec4 st = texture(uState, suv);
  float clarity = clamp(st.r, 0.0, 1.0);
  float wet = clamp(st.g, 0.0, 1.0);

  // Clarity gradient drives both the streaky wipe edge and the wet rim.
  float cl = texture(uState, suv - vec2(uTexel.x * 2.0, 0.0)).r;
  float cr = texture(uState, suv + vec2(uTexel.x * 2.0, 0.0)).r;
  float cd = texture(uState, suv - vec2(0.0, uTexel.y * 2.0)).r;
  float cu = texture(uState, suv + vec2(0.0, uTexel.y * 2.0)).r;
  vec2 gradC = vec2(cr - cl, cu - cd);
  float gradLen = length(gradC);
  vec2 en = gradLen > 1e-4 ? gradC / gradLen : vec2(0.0, 1.0);

  vec3 sharp = bgAt(suv, 0.0);

  // Frosted base: 4 taps now that each one costs half what it used to.
  float lod = 2.2 + uFogBlur * 3.6;
  float rad = 0.006 + uFogBlur * 0.02;
  vec3 frost = bgAt(suv, lod);
  frost += bgAt(suv + vec2( 0.92,  0.38) * rad, lod);
  frost += bgAt(suv + vec2(-0.62,  0.78) * rad, lod);
  frost += bgAt(suv + vec2(-0.30, -0.95) * rad, lod);
  frost *= 0.25;

  vec3 milk = mix(vec3(0.885, 0.905, 0.925), vec3(0.93, 0.905, 0.875),
                  clamp(uWarm, 0.0, 1.0) * 0.7)
            - clamp(-uWarm, 0.0, 1.0) * vec3(0.035, 0.02, -0.012);

  // Real condensation is never even: it drifts in patches and banks up in
  // the corners, where the pane runs coldest.
  float vary = mix(1.0, 0.55 + 0.9 * fbm(guv * 1.7 + uTime * 0.01), uFogVary);
  float corner = 1.0 + 0.30 * smoothstep(0.30, 0.0,
    min(min(suv.x, 1.0 - suv.x), min(suv.y, 1.0 - suv.y)));
  float density = uFogDensity * uIntro * (1.0 - wet * 0.45) * vary * corner;

  vec3 frostDesat = mix(frost, vec3(dot(frost, vec3(0.299, 0.587, 0.114))), 0.42);
  vec3 fogBase = mix(frostDesat, milk, clamp(density, 0.0, 1.0) * 0.88) + density * 0.05;

  vec3 fogged = fogBase;
  float cells = mix(110.0, 30.0, uBeadScale);
  float refr = uBeadRefract;
  if (uFineBeads > 0.5){
    vec4 O1 = beads(guv + 3.17, cells * 2.20, min(uBeadDensity * 1.5, 0.98), 0.12, 0.20, uTime * 0.9);
    fogged = beadShade(O1, suv, fogged, milk, 2.0, aspect, 0.010, 0.945, 0.7, refr);
  }
  vec4 O2 = beads(guv,        cells * 1.15, uBeadDensity,        0.13, 0.24, uTime);
  vec4 O3 = beads(guv + 9.71, cells * 0.52, uBeadDensity * 0.55, 0.15, 0.26, uTime * 0.7);
  fogged = beadShade(O2, suv, fogged, milk, 1.4, aspect, 0.018, 0.915, 0.9, refr);
  fogged = beadShade(O3, suv, fogged, milk, 0.8, aspect, 0.030, 0.885, 1.1, refr);

  // A squeegee never leaves a clean edge: it frays into fine streaks that
  // run along the direction of travel.
  float band = smoothstep(0.02, 0.45, clarity) * smoothstep(1.0, 0.55, clarity);
  vec2 tang = vec2(-en.y, en.x);
  float streak = (vnoise(vec2(dot(guv, tang) * 170.0, dot(guv, en) * 20.0)) - 0.5)
               * uStreak * band;
  float reveal = smoothstep(0.12, 0.62, clarity + streak);
  vec3 col = mix(fogged, sharp, reveal);

  if (uEdgeWater > 0.001){
    float edge = clamp(gradLen * 4.2, 0.0, 1.0) * (1.0 - reveal)
               * smoothstep(0.02, 0.2, clarity);
    col = mix(col, bgAt(suv + en * 0.012, 1.2) * 0.72, edge * uEdgeWater);
  }

  vec4 dt = texture(uDrops, suv);
  float hC = dt.r;
  float m = smoothstep(0.015, 0.055, hC);

  if (hC > 0.003){
    float hL = texture(uDrops, suv - vec2(uTexel.x, 0.0)).r;
    float hR = texture(uDrops, suv + vec2(uTexel.x, 0.0)).r;
    float hD = texture(uDrops, suv - vec2(0.0, uTexel.y)).r;
    float hU = texture(uDrops, suv + vec2(0.0, uTexel.y)).r;
    vec2 dn = vec2(hR - hL, hU - hD);
    float shine = uDropShine;

    // A droplet is a thick plano-convex lens, so it forms a REAL image: what
    // you see inside it is inverted and magnified, not shifted. Rebuild the
    // position on the sphere from the height, flip it through the centre,
    // and sample a small window of the scene from there.
    vec2 centre = dt.gb;
    vec2 toP = (suv - centre) * vec2(aspect, 1.0);
    float lp = length(toP);
    vec2 pn = (lp > 1e-5 ? toP / lp : vec2(0.0)) * sqrt(max(0.0, 1.0 - hC * hC));
    vec2 lensUv = centre - pn * uLensZoom * vec2(1.0 / aspect, 1.0);
    float lensMask = smoothstep(0.98, 0.55, length(pn)) * uLensMix;

    // The rim keeps the displacement model, which is where a steep surface
    // makes plain refraction read correctly.
    vec2 refrUv = suv + dn * (0.10 + shine * 0.25) + vec2(0.0, hC * 0.02);
    vec2 sampleUv = mix(refrUv, lensUv, lensMask);

    vec3 dropCol;
    if (uCA > 0.0001){
      // Dispersion is strongest where the surface is steepest: the rim.
      float caK = uCA * (1.0 - lensMask * 0.65) * 0.02;
      vec2 caDir = pn * vec2(1.0 / aspect, 1.0);
      dropCol = vec3(
        bgAt(sampleUv - caDir * caK, 0.0).r,
        bgAt(sampleUv, 0.0).g,
        bgAt(sampleUv + caDir * caK, 0.0).b
      );
    } else {
      dropCol = bgAt(sampleUv, 0.0);
    }

    dropCol = (dropCol - 0.5) * (1.0 + shine * 0.28) + 0.5;
    dropCol *= 0.96 - shine * 0.17;

    vec3 n3 = normalize(vec3(-dn * 4.0, 0.42));
    float g1 = pow(max(dot(n3, normalize(vec3( 0.30,  0.62, 0.55))), 0.0), 48.0);
    float g2 = pow(max(dot(n3, normalize(vec3(-0.45, -0.25, 0.75))), 0.0), 26.0);
    float crescent = smoothstep(0.30, 0.06, hC) * clamp(dn.y * 10.0, 0.0, 1.0);
    dropCol += (g1 * 1.5 + g2 * 0.35 + crescent * 0.55) * (0.25 + shine * 1.05);

    // Water reflects hard at grazing angles, which is what makes a rim read
    // as liquid rather than plastic. Schlick against a faked room.
    if (uFresnel > 0.001){
      float fres = pow(1.0 - clamp(n3.z, 0.0, 1.0), 4.0);
      vec3 env = mix(vec3(0.06, 0.07, 0.09), vec3(0.80, 0.84, 0.92),
                     smoothstep(-0.35, 0.90, -n3.y));
      dropCol = mix(dropCol, env, clamp(fres, 0.0, 1.0) * uFresnel);
    }

    float rimDark = smoothstep(0.015, 0.06, hC) * (1.0 - smoothstep(0.06, 0.22, hC));
    dropCol *= 1.0 - rimDark * (0.16 + shine * 0.10);

    col = mix(col, dropCol, m);
  }

  // Shadow and caustic land BELOW the drop, on pixels the drop itself does
  // not cover, so they are sampled outside the block above.
  float hNear = texture(uDrops, suv + vec2(0.0, uTexel.y * 2.2)).r;
  float hFar  = texture(uDrops, suv + vec2(0.0, uTexel.y * 4.5)).r;
  col *= 1.0 - smoothstep(0.05, 0.5, hFar) * (1.0 - m) * 0.12;
  if (uCaustic > 0.001){
    col += smoothstep(0.35, 0.85, hNear) * (1.0 - m)
         * uCaustic * vec3(1.0, 0.97, 0.92) * 0.16;
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
  throw new Error("[fog2] WebGL2 unavailable");
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
const progCopy = program(VERT_FULLSCREEN, FRAG_COPY);
const progComposite = program(VERT_FULLSCREEN, FRAG_COMPOSITE);

const triVao = gl.createVertexArray();
gl.bindVertexArray(triVao);
const triBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, triBuf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);
gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
gl.bindVertexArray(null);

const quadBuf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
gl.bufferData(
  gl.ARRAY_BUFFER,
  new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1]),
  gl.STATIC_DRAW
);

const INSTANCE_FLOATS = 8;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;
const INSTANCE_CAP = Math.max(MAX_STAMPS, MAX_INSTANCES);

function makeInstancedVao() {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, INSTANCE_CAP * INSTANCE_BYTES, gl.DYNAMIC_DRAW);
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
const stampData = new Float32Array(INSTANCE_CAP * INSTANCE_FLOATS);
const dropData = new Float32Array(INSTANCE_CAP * INSTANCE_FLOATS);
let stampCount = 0;

function makeTarget(w, h) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, floatRenderable ? gl.RGBA16F : gl.RGBA8, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

/* ------------------------------------------------------------------ sizing */

let W = 0, H = 0, simW = 0, simH = 0, dpr = 1;
let scaleStep = isTouch ? 1 : 0;
let renderScale = SCALE_STEPS[scaleStep];

let state = [null, null];
let stateIdx = 0;
let dropTarget = null;

let gridW = 0, gridH = 0;
let gridTime = null, gridClarity = null, gridWet = null;
let now = 0;

function blit(target, srcTex, w, h) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.viewport(0, 0, w, h);
  gl.disable(gl.BLEND);
  gl.useProgram(progCopy);
  gl.bindVertexArray(triVao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, srcTex);
  gl.uniform1i(progCopy.u.uSrc, 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

/* Rebuild at the new size, carrying the simulation across so a resize or a
   quality step never resets the glass. */
function resize(force = false) {
  const nextDpr = Math.min(window.devicePixelRatio || 1, DPR_CAP) * renderScale;
  const w = Math.max(2, Math.round(canvas.clientWidth * nextDpr));
  const h = Math.max(2, Math.round(canvas.clientHeight * nextDpr));
  if (!force && w === W && h === H) return;

  const oldState = state[stateIdx];
  const oldTargets = [state[0], state[1], dropTarget];
  const oldGrid = gridClarity
    ? { w: gridW, h: gridH, clarity: gridClarity, wet: gridWet, time: gridTime }
    : null;

  dpr = nextDpr;
  W = w;
  H = h;
  canvas.width = W;
  canvas.height = H;
  simW = Math.max(2, Math.round(W * 0.5));
  simH = Math.max(2, Math.round(H * 0.5));

  state[0] = makeTarget(simW, simH);
  state[1] = makeTarget(simW, simH);
  dropTarget = makeTarget(simW, simH);
  for (const t of state) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }
  if (oldState) blit(state[stateIdx], oldState.tex, simW, simH);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);

  for (const t of oldTargets) {
    if (!t) continue;
    gl.deleteFramebuffer(t.fbo);
    gl.deleteTexture(t.tex);
  }

  const gw = Math.max(4, Math.round(simW / 4));
  const gh = Math.max(4, Math.round(simH / 4));
  const clarity = new Float32Array(gw * gh);
  const wet = new Float32Array(gw * gh);
  const time = new Float32Array(gw * gh);
  if (oldGrid) {
    for (let y = 0; y < gh; y++) {
      const sy = Math.min(oldGrid.h - 1, Math.floor((y * oldGrid.h) / gh));
      for (let x = 0; x < gw; x++) {
        const sx = Math.min(oldGrid.w - 1, Math.floor((x * oldGrid.w) / gw));
        const si = sy * oldGrid.w + sx;
        const di = y * gw + x;
        clarity[di] = oldGrid.clarity[si];
        wet[di] = oldGrid.wet[si];
        time[di] = oldGrid.time[si];
      }
    }
  }
  gridW = gw;
  gridH = gh;
  gridClarity = clarity;
  gridWet = wet;
  gridTime = time;
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
  img.onerror = () => console.warn("[fog2] failed to load " + name);
  img.src = "/" + name + ".jpeg";
});

const xfA = new Float32Array(4);
const xfB = new Float32Array(4);

function coverTransform(out, index, t) {
  const meta = imageMeta[index];
  if (!meta) {
    out[0] = 1; out[1] = 1; out[2] = 0; out[3] = 0;
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

/* ------------------------------------------------------------------- water */

const drops = [];
const residue = []; // pinned satellite beads left along a trail
let ambientAcc = 0;
let lastSpawnScan = 0;

function spawnDrop(x, y, opts) {
  if (drops.length >= MAX_DROPS) return;
  const size = 0.5 + 0.9 * params.dropSize;
  drops.push({
    x,
    y,
    r: (opts.rMin + opts.rVar * Math.random()) * size * dpr,
    vx: 0,
    vy: opts.vy || 0,
    stuck: opts.stuck || false,
    stickT: opts.stickT || 0,
    phase: Math.random() * 6.283,
    seed: Math.random(),
    trailAcc: 0,
    age: 0,
  });
}

/* The squeegee takes standing water and satellites with it. */
function sweepDrops(x0, y0, x1, y1, radius) {
  const ax = x1 - x0;
  const ay = y1 - y0;
  const len2 = ax * ax + ay * ay;
  const cull = (list) => {
    for (let i = list.length - 1; i >= 0; i--) {
      const d = list[i];
      let t = len2 > 0 ? ((d.x - x0) * ax + (d.y - y0) * ay) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const dx = x0 + ax * t - d.x;
      const dy = y0 + ay * t - d.y;
      const reach = radius + d.r;
      if (dx * dx + dy * dy < reach * reach) list.splice(i, 1);
    }
  };
  cull(drops);
  cull(residue);
}

function updateDrops(dt, time) {
  const accel = 240 + 900 * params.gravity;
  const shrink = 0.012 + 0.02 * (1 - params.dropSize);

  for (let i = drops.length - 1; i >= 0; i--) {
    const d = drops[i];
    d.age += dt;

    if (d.stuck) {
      d.r += (1.2 + 1.5 * params.ambient) * dt * dpr;
      d.stickT += dt;
      const release = (6 + (1 - params.gravity) * 7 + 10 * d.seed) * dpr;
      if (d.r > release) d.stuck = false;
      continue;
    }

    const vMax = (60 + 340 * params.gravity) * (d.r / (8 * dpr)) * dpr;
    d.vy = Math.min(d.vy + accel * dt * dpr, vMax);

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

    const travelled = Math.hypot(d.x - px, d.y - py);
    d.trailAcc += travelled;
    const trailR = d.r * (0.4 + 0.7 * params.trailWidth);
    const step = Math.max(trailR * 0.34, 1.2 * dpr);
    while (d.trailAcc > step) {
      d.trailAcc -= step;
      const back = travelled > 0 ? d.trailAcc / travelled : 0;
      const sx = d.x - (d.x - px) * back;
      const sy = d.y - (d.y - py) * back;
      stamp(sx, sy, trailR, 0.55, params.trailClear, 0.55);

      /* Surface tension cannot hold the whole tail together, so a running
         drop sheds pinned beads as it goes. This is why real trails look
         beaded instead of smoothly swept. */
      if (
        params.residue > 0 &&
        residue.length < MAX_RESIDUE &&
        Math.random() < params.residue * 0.3
      ) {
        residue.push({
          x: sx + (Math.random() - 0.5) * trailR * 1.3,
          y: sy + (Math.random() - 0.5) * trailR * 0.5,
          r: Math.max(1.1 * dpr, d.r * (0.16 + 0.2 * Math.random())),
          age: 0,
        });
      }
    }

    d.r -= shrink * travelled;
    if (d.r < 1.6 * dpr || d.y > H + 20 * dpr) drops.splice(i, 1);
  }

  // Satellites just sit there and slowly evaporate.
  for (let i = residue.length - 1; i >= 0; i--) {
    const b = residue[i];
    b.age += dt;
    b.r -= dt * 0.18 * dpr;
    if (b.r < 0.9 * dpr) residue.splice(i, 1);
  }

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

/* A clear cell with fog two rows below it is the bottom lip of a wipe —
   where water gathers and finally lets go. */
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
      if (gridClarity[below] - (now - gridTime[below]) * refog >= FOG_BELOW) continue;
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
  sweepDrops(
    lastPointer ? lastPointer.x : x,
    lastPointer ? lastPointer.y : y,
    x,
    y,
    r * 0.92
  );

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
window.addEventListener("pointerup", () => { lastPointer = null; });
window.addEventListener("pointercancel", () => { lastPointer = null; });

canvas.addEventListener("webglcontextlost", (e) => {
  e.preventDefault();
  console.warn("[fog2] WebGL context lost — reload to restore");
});

let resizeDue = 0;
window.addEventListener("resize", () => { resizeDue = performance.now() + 200; });
window.addEventListener("orientationchange", () => { resizeDue = performance.now() + 350; });

/* ------------------------------------------------------------------ render */

const startTime = performance.now();
let lastFrame = startTime;
let intro = 0;
let fpsFrames = 0;
let fpsElapsed = 0;
let fps = 60;
let lowFrames = 0;
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
  gl.uniform1f(progDecay.u.uDelayK, 0.9 * Math.min(params.refogDelay / 4, 1) + 0.05);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  if (stampCount > 0) {
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.MAX);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progStamp);
    gl.bindVertexArray(stampVao.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, stampVao.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, stampData, 0, stampCount * INSTANCE_FLOATS);
    gl.uniform2f(progStamp.u.uCanvas, W, H);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, stampCount);
    gl.blendEquation(gl.FUNC_ADD);
    gl.disable(gl.BLEND);
    stampCount = 0;
  }

  stateIdx = 1 - stateIdx;
}

/* No blending here: the drop shader discards everything outside the body, so
   the last instance drawn wins. Residue goes first, live drops on top. */
function renderDropHeights() {
  gl.bindFramebuffer(gl.FRAMEBUFFER, dropTarget.fbo);
  gl.viewport(0, 0, simW, simH);
  gl.clearColor(0, 0, 0, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  if (!drops.length && !residue.length) return;

  let n = 0;
  for (const b of residue) {
    if (n >= INSTANCE_CAP) break;
    const o = n * INSTANCE_FLOATS;
    dropData[o] = b.x;
    dropData[o + 1] = b.y;
    dropData[o + 2] = b.r;
    dropData[o + 3] = 1;
    dropData[o + 4] = Math.min(b.r / (3 * dpr), 1) * Math.min(b.age / 0.35, 1);
    dropData[o + 5] = 1;
    n++;
  }
  for (const d of drops) {
    if (n >= INSTANCE_CAP) break;
    const o = n * INSTANCE_FLOATS;
    dropData[o] = d.x;
    dropData[o + 1] = d.y;
    dropData[o + 2] = d.r;
    dropData[o + 3] = 1 + Math.min(d.vy / (320 * dpr), 1.2);
    dropData[o + 4] = Math.min(d.r / (5 * dpr), 1) * Math.min(d.age / 0.28, 1);
    dropData[o + 5] = params.tailTaper;
    n++;
  }

  gl.disable(gl.BLEND);
  gl.useProgram(progDrop);
  gl.bindVertexArray(dropVao.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, dropVao.buf);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, dropData, 0, n * INSTANCE_FLOATS);
  gl.uniform2f(progDrop.u.uCanvas, W, H);
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, n);
}

function composite(time) {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, W, H);
  gl.useProgram(progComposite);
  gl.bindVertexArray(triVao);

  const a = images[currentPhoto] ? currentPhoto : 0;
  const b = images[nextPhoto] ? nextPhoto : a;
  const u = progComposite.u;

  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, images[a]);
  gl.uniform1i(u.uImgA, 0);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, images[b]);
  gl.uniform1i(u.uImgB, 1);
  gl.activeTexture(gl.TEXTURE2);
  gl.bindTexture(gl.TEXTURE_2D, state[stateIdx].tex);
  gl.uniform1i(u.uState, 2);
  gl.activeTexture(gl.TEXTURE3);
  gl.bindTexture(gl.TEXTURE_2D, dropTarget.tex);
  gl.uniform1i(u.uDrops, 3);

  gl.uniform4fv(u.uXfA, coverTransform(xfA, a, time));
  gl.uniform4fv(u.uXfB, coverTransform(xfB, b, time));
  gl.uniform1f(u.uFade, fade < 1 ? fade * fade * (3 - 2 * fade) : 0);
  gl.uniform1f(u.uTime, time);
  gl.uniform1f(u.uIntro, intro * intro * (3 - 2 * intro));
  gl.uniform2f(u.uRes, W, H);
  gl.uniform2f(u.uTexel, 1 / simW, 1 / simH);
  gl.uniform1f(u.uFogDensity, params.fogDensity);
  gl.uniform1f(u.uFogBlur, params.fogBlur);
  gl.uniform1f(u.uBeadScale, params.beadSize);
  gl.uniform1f(u.uBeadDensity, params.beadDensity);
  gl.uniform1f(u.uBeadRefract, params.beadRefract);
  gl.uniform1f(u.uWarm, params.fogWarm);
  gl.uniform1f(u.uEdgeWater, params.edgeWater);
  gl.uniform1f(u.uDropShine, params.dropShine);
  gl.uniform1f(u.uFineBeads, isTouch ? 0 : 1);
  gl.uniform1f(u.uFogVary, params.fogVary);
  gl.uniform1f(u.uStreak, params.streak);
  gl.uniform1f(u.uLensZoom, params.lensZoom);
  gl.uniform1f(u.uLensMix, params.lensMix);
  gl.uniform1f(u.uCA, params.ca);
  gl.uniform1f(u.uFresnel, params.fresnel);
  gl.uniform1f(u.uCaustic, params.caustic);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function adaptQuality(t) {
  if (probeStart === 0) probeStart = t;
  if (scaleStep >= SCALE_STEPS.length - 1) return;
  if (t - probeStart < 2000) return;
  if (fps >= 45) { lowFrames = 0; return; }
  if (fps < 20) lowFrames = 4;
  if (++lowFrames < 4) return;
  lowFrames = 0;
  renderScale = SCALE_STEPS[++scaleStep];
  resize(true);
  console.info("[fog2] fps " + fps + " -> renderScale " + renderScale);
}

function frame(t) {
  requestAnimationFrame(frame);
  if (!loadedCount) return;

  if (resizeDue && t >= resizeDue) {
    resizeDue = 0;
    resize();
  }

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

function buildGui() {
  const gui = new GUI({ title: "Window v2" });
  gui.domElement.style.right = "12px";
  gui.domElement.style.top = "72px";

  const fOptics = gui.addFolder("Optics");
  fOptics.add(params, "lensZoom", 0.005, 0.2, 0.001).name("Lens zoom");
  fOptics.add(params, "lensMix", 0, 1, 0.01).name("Lens strength");
  fOptics.add(params, "ca", 0, 2, 0.01).name("Chromatic aberration");
  fOptics.add(params, "fresnel", 0, 1, 0.01).name("Fresnel rim");
  fOptics.add(params, "caustic", 0, 2, 0.01).name("Caustic");
  fOptics.add(params, "dropShine", 0, 1.5, 0.01).name("Shine");

  const fFog = gui.addFolder("Fog");
  fFog.add(params, "fogDensity", 0, 1, 0.01).name("Density");
  fFog.add(params, "fogBlur", 0, 1, 0.01).name("Blur");
  fFog.add(params, "fogWarm", -1, 1, 0.01).name("Warmth");
  fFog.add(params, "fogVary", 0, 1, 0.01).name("Patchiness");
  fFog.add(params, "beadSize", 0, 1, 0.01).name("Bead size");
  fFog.add(params, "beadDensity", 0, 1, 0.01).name("Bead density");
  fFog.add(params, "beadRefract", 0, 1.5, 0.01).name("Bead lens");
  fFog.close();

  const fWipe = gui.addFolder("Wipe");
  fWipe.add(params, "brushSize", 20, 160, 1).name("Brush size");
  fWipe.add(params, "brushSoft", 0.02, 1, 0.01).name("Brush softness");
  fWipe.add(params, "streak", 0, 0.5, 0.005).name("Squeegee streaks");
  fWipe.add(params, "edgeWater", 0, 1, 0.01).name("Edge water");
  fWipe.add(params, "refogTime", 2, 40, 0.5).name("Re-fog time");
  fWipe.add(params, "refogDelay", 0.2, 8, 0.1).name("Dry delay");
  fWipe.add(params, "refogPatch", 0, 1, 0.01).name("Re-fog patchiness");
  fWipe.close();

  const fDrops = gui.addFolder("Drops");
  fDrops.add(params, "dropSpawn", 0, 1.5, 0.01).name("Spawn from wipes");
  fDrops.add(params, "ambient", 0, 1.5, 0.01).name("Ambient drops");
  fDrops.add(params, "dropSize", 0, 1.5, 0.01).name("Size");
  fDrops.add(params, "residue", 0, 1.5, 0.01).name("Satellite beads");
  fDrops.add(params, "tailTaper", 0.1, 1, 0.01).name("Teardrop taper");
  fDrops.add(params, "gravity", 0, 1, 0.01).name("Gravity");
  fDrops.add(params, "wobble", 0, 1, 0.01).name("Wobble");
  fDrops.add(params, "stickiness", 0, 1, 0.01).name("Stickiness");
  fDrops.add(params, "trailWidth", 0, 1.5, 0.01).name("Trail width");
  fDrops.add(params, "trailClear", 0, 1, 0.01).name("Trail clearing");
  fDrops
    .add({ clear: () => { drops.length = 0; residue.length = 0; } }, "clear")
    .name("Clear water");
  fDrops.close();

  gui
    .add(params, "photo", PHOTOS)
    .name("Photo")
    .onChange((v) => showPhoto(PHOTOS.indexOf(v)));
  gui.add(params, "autoplay").name("Auto-cycle");
}

if (!isTouch) buildGui();

window.__fog2 = {
  params,
  drops: () => drops.length,
  residue: () => residue.length,
  fps: () => fps,
  wipeLine(x0, y0, x1, y1, steps) {
    const n = steps || 28;
    lastPointer = null;
    for (let i = 0; i <= n; i++) {
      wipeTo((x0 + (x1 - x0) * (i / n)) * dpr, (y0 + (y1 - y0) * (i / n)) * dpr);
    }
    lastPointer = null;
  },
};
