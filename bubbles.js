import Matter from "matter-js";
import * as THREE from "three";
import GUI from "lil-gui";

const { Engine, World, Bodies, Body, Runner, Events, Query } = Matter;

const WALL_THICKNESS = 180;
const OPTICAL_CIRCLE_SCALE = Math.sqrt(4 / Math.PI);
const CATEGORY_WALL = 0x0001;
const CATEGORY_SHAPE = 0x0002;
const CATEGORY_ESCAPED = 0x0004;

const DESKTOP = {
  shapeSize: 88,
  shapeCount: 12,
};

const MOBILE = {
  shapeSize: 88,
  shapeCount: 14,
};

const params = {
  shapeSize: DESKTOP.shapeSize,
  shapeCount: DESKTOP.shapeCount,
  circleRatio: 0.5,
  opticalCircleScale: OPTICAL_CIRCLE_SCALE,
  baseGravity: 0.85,
  tiltStrength: 1.8,
  tiltSmooth: 0.18,
  tiltSensitivity: 18,
  restitution: 0.55,
  friction: 0.05,
  frictionAir: 0.012,
  density: 0.002,
  swayForce: 0.00035,
  antiAlign: true,
  antiAlignTorque: 0.004,
  useMouseTilt: true,
  shakeThreshold: 6,
  shakeHitsNeeded: 1,
  shakeCooldown: 700,
  shakeSpawnCount: 4,
  maxShapes: 36,
  flickEscapeSpeed: 7,
  // Bubble look — tuned for white background visibility
  refraction: 0.14,
  aberration: 0.28,
  rimStrength: 0.55,
  tint: "#ffd600",
};

const canvas = document.getElementById("physics-canvas");
const logoImg = document.getElementById("logo-img");

let width = 0;
let height = 0;
let dpr = 1;
let isMobile = false;

const shapes = [];
const tilt = { x: 0, y: 1, targetX: 0, targetY: 1 };
let tiltEnabled = false;
let usingDeviceTilt = false;
let sensorMode = "none"; // orientation | motion | none
let lastSensorAt = 0;
const isIOS =
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const preferMotion = /Android/i.test(navigator.userAgent);
const calib = {
  ready: false,
  beta: 0,
  gamma: 0,
  ax: 0,
  ay: 0,
};

const shake = {
  lastX: 0,
  lastY: 0,
  lastZ: 0,
  lastGX: 0,
  lastGY: 0,
  lastGZ: 0,
  lastBeta: null,
  lastGamma: null,
  primed: false,
  hits: 0,
  windowStart: 0,
  lastSpawnAt: 0,
};

const drag = {
  active: false,
  shape: null,
  pointerId: null,
  offsetX: 0,
  offsetY: 0,
  samples: [],
};

// Bubbles rise: baseline gravity points up
const engine = Engine.create({
  gravity: { x: 0, y: -params.baseGravity, scale: 0.001 },
});
const world = engine.world;

let floor = null;
let leftWall = null;
let rightWall = null;
let ceiling = null;

/* ---------------------------------------------------------------- three.js */

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setClearColor(0xffffff, 1);

// Screen-space ortho camera: x right, y down (negated), 1 unit = 1 px
const camera = new THREE.OrthographicCamera(0, 1, 0, -1, 0.1, 3000);
camera.position.z = 600;

const bgScene = new THREE.Scene();
const bubbleScene = new THREE.Scene();

const bufferSize = new THREE.Vector2(1, 1);
const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
  depthBuffer: true,
});

// Uniform objects shared by every bubble material (updated once per frame)
const shared = {
  uTime: { value: 0 },
  uRes: { value: bufferSize },
  tBg: { value: renderTarget.texture },
  uRefraction: { value: params.refraction },
  uAberration: { value: params.aberration },
  uRim: { value: params.rimStrength },
  uTint: { value: new THREE.Color(params.tint) },
};

const bubbleVertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vPos;

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vPos = position;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const bubbleFragmentShader = /* glsl */ `
  precision highp float;
  uniform sampler2D tBg;
  uniform vec2 uRes;
  uniform float uRefraction;
  uniform float uAberration;
  uniform float uRim;
  uniform float uTime;
  uniform float uSeed;
  uniform vec3 uTint;
  varying vec3 vNormal;
  varying vec3 vPos;

  void main() {
    vec2 p = vPos.xy * 2.0;

    // Optics: spheres use real normals; squares keep a square outline but
    // a dome lens so they refract like a drink bubble, not a flat pane.
    #ifdef IS_SQUARE
      float len2 = dot(p, p);
      vec3 n = normalize(vec3(p * 1.05, sqrt(max(0.06, 1.0 - len2 * 0.55))));
      // Tight rim at the square edge — visible, not a wide muddy band
      float edge = pow(smoothstep(0.72, 1.0, max(abs(p.x), abs(p.y))), 1.35);
      float dome = clamp(len2 * 0.55, 0.0, 1.0);
    #else
      vec3 n = normalize(vNormal);
      float edge = pow(1.0 - abs(n.z), 1.45);
      float dome = edge;
    #endif

    // Liquid shimmer on the membrane
    float t = uTime * 1.45 + uSeed * 31.0;
    n.x += 0.18 * sin(t + vPos.y * 6.5 + vPos.z * 4.2);
    n.y += 0.18 * sin(t * 1.21 + vPos.x * 5.8 - vPos.z * 3.6 + 2.1);
    n = normalize(n);

    vec2 uv = gl_FragCoord.xy / uRes;
    float breathe = 1.0 + 0.2 * sin(uTime * 1.7 + uSeed * 21.0);
    // Stronger lens toward the rim so the bubble reads on flat white
    float lens = 0.45 + 0.85 * max(edge, dome);
    vec2 offset = -n.xy * uRefraction * lens * breathe;

    float ca = uAberration;
    float r = texture2D(tBg, clamp(uv + offset * (1.0 - ca), 0.0, 1.0)).r;
    float g = texture2D(tBg, clamp(uv + offset, 0.0, 1.0)).g;
    float b = texture2D(tBg, clamp(uv + offset * (1.0 + ca), 0.0, 1.0)).b;
    vec3 col = vec3(r, g, b);

    // Body: slight cool glass tint so the disc isn't pure white
    float body = 1.0 - edge;
    col = mix(col, col * vec3(0.93, 0.95, 0.98), body * 0.35);
    col += uTint * body * 0.035;

    // Visible soap-film rim on white (cool gray + brand gold)
    float fresnel = edge;
    col = mix(col, vec3(0.62, 0.66, 0.72), fresnel * uRim);
    col += uTint * fresnel * uRim * 0.28;

    // Iridescence helps the silhouette pop
    float iri = sin(edge * 16.0 - uTime * 1.3 + uSeed * 9.0) * 0.5 + 0.5;
    col += vec3(0.12, 0.32, 0.55) * iri * fresnel * 0.14;
    col += vec3(0.5, 0.2, 0.05) * (1.0 - iri) * fresnel * 0.1;

    // Specular sparkles (need a touch of shading so white isn't invisible)
    vec3 l1 = normalize(vec3(-0.4, 0.7, 0.55));
    vec3 l2 = normalize(vec3(0.55, -0.25, 0.7));
    float ndl = max(dot(n, l1), 0.0);
    float spec =
      pow(ndl, 80.0) * 0.9 +
      pow(max(dot(n, l2), 0.0), 40.0) * 0.3;
    // Soft shading bowl so highlights have contrast on white
    col *= 0.88 + 0.12 * ndl;
    col += vec3(spec);

    gl_FragColor = vec4(col, 1.0);
  }
`;

function makeBubbleMaterial(seed, kind) {
  return new THREE.ShaderMaterial({
    defines: kind === "square" ? { IS_SQUARE: "" } : {},
    uniforms: {
      uTime: shared.uTime,
      uRes: shared.uRes,
      tBg: shared.tBg,
      uRefraction: shared.uRefraction,
      uAberration: shared.uAberration,
      uRim: shared.uRim,
      uTint: shared.uTint,
      uSeed: { value: seed },
    },
    vertexShader: bubbleVertexShader,
    fragmentShader: bubbleFragmentShader,
  });
}

// Brand shapes: perfect sphere + perfect face-on square (2D axis, glass optics)
const sphereGeometry = new THREE.SphereGeometry(0.5, 96, 64);
const squareGeometry = new THREE.PlaneGeometry(1, 1);

// Background: white + faint yellow glow at top (what the bubbles refract)
const bgMaterial = new THREE.ShaderMaterial({
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vec2 p = (vUv - vec2(0.5, 1.0)) / vec2(0.8, 0.5);
      float a = 0.12 * (1.0 - smoothstep(0.0, 0.65, length(p)));
      vec3 col = mix(vec3(1.0), vec3(1.0, 0.84, 0.0), a);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
  depthWrite: false,
});
const bgPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), bgMaterial);
bgScene.add(bgPlane);

// The logo lives in the GL background scene so bubbles can distort it.
// All materials pass sRGB texels through untouched (NoColorSpace) so the
// direct view and the refracted view match exactly.
const logoMaterial = new THREE.ShaderMaterial({
  uniforms: { map: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D map;
    varying vec2 vUv;
    void main() {
      vec4 texel = texture2D(map, vUv);
      if (texel.a < 0.01) discard;
      gl_FragColor = texel;
    }
  `,
  transparent: true,
});
const logoMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), logoMaterial);
logoMesh.visible = false;
bgScene.add(logoMesh);

new THREE.TextureLoader().load(logoImg.getAttribute("src"), (texture) => {
  texture.colorSpace = THREE.NoColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  logoMaterial.uniforms.map.value = texture;
  logoMesh.visible = true;
  layoutLogo();
});

function layoutLogo() {
  const rect = logoImg.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  logoMesh.position.set(
    rect.left + rect.width / 2,
    -(rect.top + rect.height / 2),
    -400
  );
  logoMesh.scale.set(rect.width, rect.height, 1);
}

if (logoImg.complete) layoutLogo();
logoImg.addEventListener("load", layoutLogo);

/* ------------------------------------------------------------------ layout */

function detectMobile() {
  return (
    window.matchMedia("(max-width: 768px)").matches ||
    (window.matchMedia("(pointer: coarse)").matches && window.innerWidth < 1000)
  );
}

function applyDeviceDefaults(force = false) {
  const nextMobile = detectMobile();
  if (!force && nextMobile === isMobile) return false;
  isMobile = nextMobile;

  const preset = isMobile ? MOBILE : DESKTOP;
  params.shapeSize = preset.shapeSize;
  params.shapeCount = preset.shapeCount;
  return true;
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.75 : 2);
  width = window.innerWidth;
  height = window.innerHeight;

  renderer.setPixelRatio(dpr);
  renderer.setSize(width, height, true);

  camera.left = 0;
  camera.right = width;
  camera.top = 0;
  camera.bottom = -height;
  camera.updateProjectionMatrix();

  renderer.getDrawingBufferSize(bufferSize);
  renderTarget.setSize(bufferSize.x, bufferSize.y);

  bgPlane.position.set(width / 2, -height / 2, -500);
  bgPlane.scale.set(width, height, 1);
  layoutLogo();

  rebuildBounds();
}

function rebuildBounds() {
  const walls = [floor, leftWall, rightWall, ceiling].filter(Boolean);
  if (walls.length) World.remove(world, walls);

  // Closed box so bubbles gather under the ceiling instead of escaping
  const wallOptions = {
    isStatic: true,
    friction: 0.2,
    restitution: 0.35,
    collisionFilter: {
      category: CATEGORY_WALL,
      mask: CATEGORY_SHAPE,
    },
  };

  floor = Bodies.rectangle(
    width / 2,
    height + WALL_THICKNESS / 2 - 2,
    width + WALL_THICKNESS * 2,
    WALL_THICKNESS,
    wallOptions
  );
  ceiling = Bodies.rectangle(
    width / 2,
    -WALL_THICKNESS / 2 + 2,
    width + WALL_THICKNESS * 2,
    WALL_THICKNESS,
    wallOptions
  );
  leftWall = Bodies.rectangle(
    -WALL_THICKNESS / 2 + 2,
    height / 2,
    WALL_THICKNESS,
    height * 2,
    wallOptions
  );
  rightWall = Bodies.rectangle(
    width + WALL_THICKNESS / 2 - 2,
    height / 2,
    WALL_THICKNESS,
    height * 2,
    wallOptions
  );

  World.add(world, [floor, ceiling, leftWall, rightWall]);
}

/* ------------------------------------------------------------------ shapes */

function sizeForKind(kind) {
  return kind === "circle"
    ? params.shapeSize * params.opticalCircleScale
    : params.shapeSize;
}

function spawnShape(x, y, options = {}) {
  const { fromBottom = false } = options;
  const kind = Math.random() < params.circleRatio ? "circle" : "square";
  const size = sizeForKind(kind);
  const bodyOptions = {
    restitution: params.restitution,
    friction: params.friction,
    // Varied drag = varied rise speed, like real champagne bubbles
    frictionAir: params.frictionAir * (0.7 + Math.random() * 0.6),
    density: params.density,
    collisionFilter: {
      category: CATEGORY_SHAPE,
      mask: CATEGORY_WALL | CATEGORY_SHAPE | CATEGORY_ESCAPED,
    },
  };

  let body;
  if (kind === "circle") {
    body = Bodies.circle(x, y, size / 2, bodyOptions);
  } else {
    body = Bodies.rectangle(x, y, size, size, bodyOptions);
    Body.setAngle(body, Math.random() * Math.PI * 2);
  }

  if (fromBottom) {
    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * 2,
      y: -(1 + Math.random() * 2),
    });
  } else {
    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * 1.5,
      y: (Math.random() - 0.5) * 1.5,
    });
  }

  const seed = Math.random();
  const mesh = new THREE.Mesh(
    kind === "circle" ? sphereGeometry : squareGeometry,
    makeBubbleMaterial(seed, kind)
  );
  mesh.scale.setScalar(size);
  bubbleScene.add(mesh);

  World.add(world, body);
  shapes.push({
    body,
    kind,
    size,
    mesh,
    seed,
    swayFreq: 0.5 + Math.random() * 0.9,
    swayPhase: Math.random() * Math.PI * 2,
    escaped: false,
  });
}

function disposeShapeVisual(shape) {
  bubbleScene.remove(shape.mesh);
  shape.mesh.material.dispose();
}

function markEscaped(shape) {
  if (!shape || shape.escaped) return;
  shape.escaped = true;
  shape.body.collisionFilter.category = CATEGORY_ESCAPED;
  // Pass through walls; still bump other shapes a bit
  shape.body.collisionFilter.mask = CATEGORY_SHAPE | CATEGORY_ESCAPED;
}

function removeShape(shape) {
  const idx = shapes.indexOf(shape);
  if (idx === -1) return;
  World.remove(world, shape.body);
  disposeShapeVisual(shape);
  shapes.splice(idx, 1);
}

function removeOffscreenEscaped() {
  const margin = params.shapeSize * 1.5;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (!shape.escaped) continue;
    const { x, y } = shape.body.position;
    if (
      x < -margin ||
      x > width + margin ||
      y < -margin ||
      y > height + margin
    ) {
      removeShape(shape);
    }
  }
}

function findShapeAt(x, y) {
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (Query.point([shape.body], { x, y }).length) return shape;
  }
  return null;
}

/* -------------------------------------------------------------------- drag */

function recordDragSample(x, y) {
  const now = performance.now();
  drag.samples.push({ x, y, t: now });
  while (drag.samples.length > 6) drag.samples.shift();
  while (drag.samples.length && now - drag.samples[0].t > 100) {
    drag.samples.shift();
  }
}

function dragVelocity() {
  if (drag.samples.length < 2) return { x: 0, y: 0 };
  const a = drag.samples[0];
  const b = drag.samples[drag.samples.length - 1];
  const dt = Math.max(16, b.t - a.t);
  return {
    x: ((b.x - a.x) / dt) * 16.67,
    y: ((b.y - a.y) / dt) * 16.67,
  };
}

function startDrag(shape, x, y, pointerId) {
  drag.active = true;
  drag.shape = shape;
  drag.pointerId = pointerId;
  drag.offsetX = shape.body.position.x - x;
  drag.offsetY = shape.body.position.y - y;
  drag.samples = [];
  recordDragSample(x, y);
  Body.setStatic(shape.body, true);
  Body.setVelocity(shape.body, { x: 0, y: 0 });
  Body.setAngularVelocity(shape.body, 0);
}

function moveDrag(x, y) {
  if (!drag.active || !drag.shape) return;
  const nx = x + drag.offsetX;
  const ny = y + drag.offsetY;
  Body.setPosition(drag.shape.body, { x: nx, y: ny });
  recordDragSample(x, y);
}

function endDrag() {
  if (!drag.active || !drag.shape) {
    drag.active = false;
    drag.shape = null;
    drag.pointerId = null;
    return;
  }

  const shape = drag.shape;
  const vel = dragVelocity();
  const throwVx = vel.x * 0.55;
  const throwVy = vel.y * 0.55;
  const speed = Math.hypot(throwVx, throwVy);

  Body.setStatic(shape.body, false);
  Body.setVelocity(shape.body, { x: throwVx, y: throwVy });
  Body.setAngularVelocity(shape.body, (Math.random() - 0.5) * 0.2);

  const { x, y } = shape.body.position;
  const outside = x < 0 || x > width || y < 0 || y > height;

  // Only finger drag/flick can leave — tilt alone still hits walls
  if (outside || speed >= params.flickEscapeSpeed) {
    markEscaped(shape);
  }

  drag.active = false;
  drag.shape = null;
  drag.pointerId = null;
  drag.samples = [];
}

/* ------------------------------------------------------------ spawn / seed */

function spawnShapesFromBottom(count) {
  const n = Math.min(count, Math.max(0, params.maxShapes - shapes.length));
  for (let i = 0; i < n; i++) {
    const size = sizeForKind(
      Math.random() < params.circleRatio ? "circle" : "square"
    );
    const x = size / 2 + 8 + Math.random() * Math.max(1, width - size - 16);
    // Inside the box, near the bottom edge (floor blocks anything below)
    const y = height - size / 2 - 12 - Math.random() * 36;
    spawnShape(x, y, { fromBottom: true });
  }
}

function registerShakeHit() {
  const now = performance.now();

  if (now - shake.windowStart > 600) {
    shake.windowStart = now;
    shake.hits = 0;
  }

  shake.hits += 1;

  if (
    shake.hits >= params.shakeHitsNeeded &&
    now - shake.lastSpawnAt > params.shakeCooldown
  ) {
    shake.lastSpawnAt = now;
    shake.hits = 0;
    spawnShapesFromBottom(params.shakeSpawnCount);
  }
}

function detectShake(e) {
  if (!usingDeviceTilt) return;

  const acc = e.acceleration;
  const ag = e.accelerationIncludingGravity;
  let intensity = 0;

  // Linear acceleration (no gravity) — best shake signal when available
  if (acc && (acc.x != null || acc.y != null || acc.z != null)) {
    const x = acc.x || 0;
    const y = acc.y || 0;
    const z = acc.z || 0;
    intensity = Math.hypot(x, y, z);
    shake.lastX = x;
    shake.lastY = y;
    shake.lastZ = z;
  } else if (ag && (ag.x != null || ag.y != null || ag.z != null)) {
    // Fallback: sudden change in gravity vector (works on iOS Safari)
    const x = ag.x || 0;
    const y = ag.y || 0;
    const z = ag.z || 0;

    if (!shake.primed) {
      shake.lastGX = x;
      shake.lastGY = y;
      shake.lastGZ = z;
      shake.primed = true;
      return;
    }

    const jerk = Math.hypot(
      x - shake.lastGX,
      y - shake.lastGY,
      z - shake.lastGZ
    );
    const gravityDev = Math.abs(Math.hypot(x, y, z) - 9.81);
    intensity = Math.max(jerk, gravityDev);
    shake.lastGX = x;
    shake.lastGY = y;
    shake.lastGZ = z;
  } else {
    return;
  }

  if (intensity >= params.shakeThreshold) {
    registerShakeHit();
  }
}

function detectOrientationShake(beta, gamma) {
  if (!usingDeviceTilt || beta == null || gamma == null) return;

  if (shake.lastBeta == null || shake.lastGamma == null) {
    shake.lastBeta = beta;
    shake.lastGamma = gamma;
    return;
  }

  const jump =
    Math.abs(beta - shake.lastBeta) + Math.abs(gamma - shake.lastGamma);
  shake.lastBeta = beta;
  shake.lastGamma = gamma;

  // Sudden orientation jumps while shaking the phone
  if (jump > 18) registerShakeHit();
}

function clearShapes() {
  shapes.splice(0).forEach((shape) => {
    World.remove(world, shape.body);
    disposeShapeVisual(shape);
  });
}

function seedShapes() {
  clearShapes();

  // Spread in the lower middle — they rise and settle under the ceiling
  for (let i = 0; i < params.shapeCount; i++) {
    const margin = sizeForKind("circle") + 24;
    const x = margin + Math.random() * Math.max(1, width - margin * 2);
    const y =
      height * 0.35 + Math.random() * Math.max(1, height * 0.4 - margin);
    spawnShape(x, y);
  }
}

/* -------------------------------------------------------------- tilt input */

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function setTiltTargetsFromOrientation(beta, gamma) {
  // Relative to pose at activation — small leans from how you hold the phone
  const b = beta ?? 0;
  const g = gamma ?? 0;

  if (!calib.ready) {
    calib.beta = b;
    calib.gamma = g;
    calib.ready = true;
  }

  const db = b - calib.beta;
  const dg = g - calib.gamma;
  const sens = params.tiltSensitivity;

  // gamma sign differs on iOS vs Android for the same physical lean
  tilt.targetX = clamp((isIOS ? dg : -dg) / sens, -1.6, 1.6);
  // Keep screen-"down" as baseline, then add forward/back lean
  tilt.targetY = clamp(1 + db / sens, -1.6, 1.6);
  lastSensorAt = performance.now();
  detectOrientationShake(b, g);
}

function setTiltTargetsFromMotion(ax, ay) {
  // accelerationIncludingGravity — axis signs differ on iOS vs Android
  if (!calib.ready) {
    calib.ax = ax;
    calib.ay = ay;
    calib.ready = true;
  }

  const g = 9.81;
  // Android: +Y ≈ upright, X flipped to match lean direction
  // iOS:    Y is inverted vs Android for the same physical tilt
  let x = -(ax / g);
  let y = isIOS ? -(ay / g) : ay / g;

  if (Math.hypot(ax / g, ay / g) < 0.15) {
    const dx = (ax - calib.ax) / g;
    const dy = (ay - calib.ay) / g;
    x = -dx;
    y = isIOS ? 1 - dy : 1 + dy;
  }

  tilt.targetX = clamp(x * 1.15, -1.6, 1.6);
  tilt.targetY = clamp(y * 1.15, -1.6, 1.6);
  lastSensorAt = performance.now();
}

function setTiltTargetsFromPointer(clientX, clientY) {
  if (!params.useMouseTilt || usingDeviceTilt) return;
  const nx = (clientX / width) * 2 - 1;
  const ny = (clientY / height) * 2 - 1;
  tilt.targetX = clamp(nx * 1.2, -1.5, 1.5);
  tilt.targetY = clamp(ny * 1.2, -1.5, 1.5);
}

function updateGravity() {
  const s = params.tiltSmooth;
  tilt.x += (tilt.targetX - tilt.x) * s;
  tilt.y += (tilt.targetY - tilt.y) * s;

  // Champagne: gravity is the OPPOSITE of the tilt — bubbles rise
  // against the lean instead of rolling with it
  if (usingDeviceTilt) {
    engine.gravity.x = -tilt.x * params.tiltStrength;
    engine.gravity.y = -tilt.y * params.tiltStrength;
    if (Math.hypot(engine.gravity.x, engine.gravity.y) < 0.2) {
      engine.gravity.y = -params.baseGravity;
    }
  } else if (params.useMouseTilt) {
    engine.gravity.x = -tilt.x * params.tiltStrength;
    engine.gravity.y =
      -tilt.y * params.tiltStrength - params.baseGravity * 0.15;
  } else {
    engine.gravity.x = 0;
    engine.gravity.y = -params.baseGravity;
  }
}

/* ----------------------------------------------------------------- physics */

function applyChampagneSway() {
  // Gentle side-to-side drift while rising, like bubbles in a glass
  const t = engine.timing.timestamp * 0.001;
  for (const shape of shapes) {
    const { body } = shape;
    if (body.isStatic) continue;
    Body.applyForce(body, body.position, {
      x:
        Math.sin(t * shape.swayFreq * Math.PI * 2 + shape.swayPhase) *
        params.swayForce *
        body.mass,
      y: 0,
    });
  }
}

function applyAntiAlign() {
  if (!params.antiAlign) return;

  for (const shape of shapes) {
    if (shape.kind !== "square") continue;
    const { body } = shape;
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > 0.8 || Math.abs(body.angularVelocity) > 0.1) continue;

    const quarter = Math.PI / 2;
    let a = body.angle % quarter;
    if (a < 0) a += quarter;
    const toFlat = Math.min(a, quarter - a);
    if (toFlat > 0.22) continue;

    const dir = a < Math.PI / 4 ? 1 : -1;
    Body.setAngularVelocity(
      body,
      body.angularVelocity + dir * params.antiAlignTorque
    );
  }
}

/* ------------------------------------------------------------------ render */

function syncMeshes() {
  for (const shape of shapes) {
    const { body, mesh } = shape;
    mesh.position.set(body.position.x, -body.position.y, 0);
    // Face the camera like 2D: only spin in-plane (Matter angle)
    mesh.rotation.set(0, 0, -body.angle);
  }
}

function syncSharedUniforms() {
  shared.uTime.value = performance.now() * 0.001;
  shared.uRefraction.value = params.refraction;
  shared.uAberration.value = params.aberration;
  shared.uRim.value = params.rimStrength;
  shared.uTint.value.set(params.tint);
}

function render() {
  syncSharedUniforms();
  syncMeshes();

  // 1. Background (gradient + logo) into the refraction texture
  renderer.setRenderTarget(renderTarget);
  renderer.render(bgScene, camera);

  // 2. Same background straight to screen, bubbles on top
  renderer.setRenderTarget(null);
  renderer.render(bgScene, camera);
  renderer.autoClear = false;
  renderer.clearDepth();
  renderer.render(bubbleScene, camera);
  renderer.autoClear = true;
}

Events.on(engine, "beforeUpdate", () => {
  updateGravity();
  applyChampagneSway();
  applyAntiAlign();
  removeOffscreenEscaped();
});

const runner = Runner.create();
Runner.run(runner, engine);

(function loop() {
  render();
  requestAnimationFrame(loop);
})();

/* ----------------------------------------------------------------- sensors */

function onDeviceOrientation(e) {
  if (!usingDeviceTilt || preferMotion) return;
  if (e.beta == null && e.gamma == null) return;
  sensorMode = "orientation";
  setTiltTargetsFromOrientation(e.beta, e.gamma);
}

function onDeviceOrientationAbsolute(e) {
  if (!usingDeviceTilt || preferMotion) return;
  if (e.beta == null && e.gamma == null) return;
  sensorMode = "orientation";
  setTiltTargetsFromOrientation(e.beta, e.gamma);
}

function onDeviceMotion(e) {
  if (!usingDeviceTilt) return;

  // Always watch for shakes (even when iOS tilt uses orientation)
  detectShake(e);

  const acc = e.accelerationIncludingGravity;
  if (!acc || (acc.x == null && acc.y == null)) return;

  // Android: accelerometer is the reliable source for tilt
  if (preferMotion) {
    sensorMode = "motion";
    setTiltTargetsFromMotion(acc.x || 0, acc.y || 0);
    return;
  }

  // iOS: orientation wins for tilt; motion is only a gravity fallback
  if (sensorMode === "orientation") return;

  sensorMode = "motion";
  setTiltTargetsFromMotion(acc.x || 0, acc.y || 0);
}

function attachSensors() {
  window.addEventListener("deviceorientation", onDeviceOrientation);
  window.addEventListener(
    "deviceorientationabsolute",
    onDeviceOrientationAbsolute
  );
  window.addEventListener("devicemotion", onDeviceMotion);
}

async function enableTilt() {
  try {
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") return;
    }

    if (
      typeof DeviceMotionEvent !== "undefined" &&
      typeof DeviceMotionEvent.requestPermission === "function"
    ) {
      try {
        await DeviceMotionEvent.requestPermission();
      } catch (_) {
        // iOS only; ignore on Android
      }
    }

    calib.ready = false;
    sensorMode = "none";
    lastSensorAt = 0;
    shake.primed = false;
    shake.hits = 0;
    shake.lastBeta = null;
    shake.lastGamma = null;
    usingDeviceTilt = true;
    tiltEnabled = true;
    attachSensors();

    // Start with calm upward drift until first sensor sample
    tilt.targetX = 0;
    tilt.targetY = 1;
    tilt.x = 0;
    tilt.y = 1;
  } catch (err) {
    console.warn(err);
  }
}

/* ---------------------------------------------------------------- pointers */

function canvasPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

canvas.addEventListener(
  "pointermove",
  (e) => {
    const pos = canvasPointerPos(e);
    if (drag.active && e.pointerId === drag.pointerId) {
      moveDrag(pos.x, pos.y);
    } else if (!drag.active) {
      setTiltTargetsFromPointer(e.clientX, e.clientY);
    }
    e.preventDefault();
  },
  { passive: false }
);

canvas.addEventListener(
  "pointerdown",
  (e) => {
    // iOS needs a user gesture for sensor permission
    if (!usingDeviceTilt) enableTilt();

    const pos = canvasPointerPos(e);
    const hit = findShapeAt(pos.x, pos.y);

    canvas.setPointerCapture(e.pointerId);

    if (hit) {
      startDrag(hit, pos.x, pos.y, e.pointerId);
    } else {
      setTiltTargetsFromPointer(e.clientX, e.clientY);
    }
    e.preventDefault();
  },
  { passive: false }
);

canvas.addEventListener("pointerup", (e) => {
  if (drag.active && e.pointerId === drag.pointerId) endDrag();
});

canvas.addEventListener("pointercancel", (e) => {
  if (drag.active && e.pointerId === drag.pointerId) endDrag();
});

function initTiltUi() {
  // Auto-enable when no iOS permission prompt is required (e.g. Android)
  const needsPermission =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  if (!needsPermission) {
    enableTilt();
  } else {
    tiltEnabled = true; // desktop cursor / wait for first tap on iOS
  }
}

let resizeTimer = null;
function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    applyDeviceDefaults();
    resize();
    seedShapes();
  }, 150);
}

window.addEventListener("resize", onViewportChange);
window.visualViewport?.addEventListener("resize", onViewportChange);

function setupGUI() {
  const showDev =
    new URLSearchParams(window.location.search).has("dev") || !isMobile;
  if (!showDev) return;

  const gui = new GUI({ title: "Bubble Controls" });
  if (isMobile) gui.close();

  const shapesFolder = gui.addFolder("Shapes");
  shapesFolder
    .add(params, "shapeSize", 30, 160, 1)
    .name("Size")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "shapeCount", 3, 24, 1)
    .name("Count")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "circleRatio", 0, 1, 0.05)
    .name("Sphere ratio")
    .onFinishChange(seedShapes);

  const bubbleFolder = gui.addFolder("Bubble look");
  bubbleFolder.add(params, "refraction", 0, 0.25, 0.005).name("Refraction");
  bubbleFolder.add(params, "aberration", 0, 0.6, 0.01).name("Chromatic ab.");
  bubbleFolder.add(params, "rimStrength", 0, 1, 0.01).name("Rim");
  bubbleFolder.addColor(params, "tint").name("Tint");

  const tiltFolder = gui.addFolder("Tilt");
  tiltFolder.add(params, "tiltStrength", 0.2, 4, 0.05).name("Tilt strength");
  tiltFolder.add(params, "tiltSensitivity", 8, 40, 1).name("Sensitivity");
  tiltFolder.add(params, "tiltSmooth", 0.02, 0.4, 0.01).name("Smoothing");
  tiltFolder.add(params, "baseGravity", 0, 2, 0.05).name("Buoyancy");
  tiltFolder.add(params, "useMouseTilt").name("Mouse tilt (desktop)");
  tiltFolder
    .add(
      {
        recalibrate: () => {
          calib.ready = false;
        },
      },
      "recalibrate"
    )
    .name("Recalibrate");

  const physicsFolder = gui.addFolder("Physics");
  physicsFolder.add(params, "restitution", 0, 1, 0.01).name("Bounce");
  physicsFolder.add(params, "friction", 0, 1, 0.01).name("Friction");
  physicsFolder.add(params, "frictionAir", 0, 0.05, 0.001).name("Air");
  physicsFolder.add(params, "swayForce", 0, 0.001, 0.00005).name("Sway");
  physicsFolder.add(params, "antiAlign").name("Anti-align");

  gui.add({ respawn: seedShapes }, "respawn").name("Respawn");

  shapesFolder.open();
  bubbleFolder.open();
}

applyDeviceDefaults(true);
resize();
seedShapes();
initTiltUi();
// setupGUI(); // bubble look / physics debug panel
