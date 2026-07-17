import Matter from "matter-js";
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
  circleSegments: 48,
};

const MOBILE = {
  shapeSize: 88,
  shapeCount: 14,
  circleSegments: 36,
};

const params = {
  shapeSize: DESKTOP.shapeSize,
  shapeCount: DESKTOP.shapeCount,
  circleRatio: 0.5,
  opticalCircleScale: OPTICAL_CIRCLE_SCALE,
  circleSegments: DESKTOP.circleSegments,
  color: "#ffd600",
  baseGravity: 0.85,
  tiltStrength: 1.8,
  tiltSmooth: 0.18,
  tiltSensitivity: 18,
  restitution: 0.55,
  friction: 0.05,
  frictionAir: 0.008,
  density: 0.002,
  antiAlign: true,
  antiAlignTorque: 0.004,
  useMouseTilt: true,
  shakeThreshold: 6,
  shakeHitsNeeded: 1,
  shakeCooldown: 700,
  shakeSpawnCount: 4,
  maxShapes: 36,
  flickEscapeSpeed: 7,
};

const canvas = document.getElementById("physics-canvas");
const stage = document.querySelector(".tilt-stage");
const scrollCue = document.querySelector(".tilt-scroll-cue");
const ctx = canvas.getContext("2d");
const enableBtn = document.getElementById("tilt-enable");
const hintEl = document.getElementById("tilt-hint");
const statusEl = document.getElementById("tilt-status");

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

// Gesture arbitration: shape hit = drag, empty / clear vertical flick = scroll
const HIT_PAD = 14;
const SCROLL_LOCK_PX = 10;
const VERTICAL_RATIO = 1.25;

const gesture = {
  pointerId: null,
  mode: "idle", // idle | undecided | play | scroll
  startX: 0,
  startY: 0,
  lastY: 0,
  hitShape: false,
  shape: null,
};

const engine = Engine.create({
  gravity: { x: 0, y: params.baseGravity, scale: 0.001 },
});
const world = engine.world;

let floor = null;
let leftWall = null;
let rightWall = null;
let ceiling = null;

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
  params.circleSegments = preset.circleSegments;
  return true;
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.75 : 2);
  width = stage.clientWidth || window.innerWidth;
  height = stage.clientHeight || window.innerHeight;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rebuildBounds();
}

function rebuildBounds() {
  const walls = [floor, leftWall, rightWall, ceiling].filter(Boolean);
  if (walls.length) World.remove(world, walls);

  // Closed box so shapes can roll around the full screen
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

function sizeForKind(kind) {
  return kind === "circle"
    ? params.shapeSize * params.opticalCircleScale
    : params.shapeSize;
}

function spawnShape(x, y, options = {}) {
  const { fromTop = false } = options;
  const kind = Math.random() < params.circleRatio ? "circle" : "square";
  const size = sizeForKind(kind);
  const bodyOptions = {
    restitution: params.restitution,
    friction: params.friction,
    frictionAir: params.frictionAir,
    density: params.density,
    collisionFilter: {
      category: CATEGORY_SHAPE,
      mask: CATEGORY_WALL | CATEGORY_SHAPE | CATEGORY_ESCAPED,
    },
  };

  let body;
  if (kind === "circle") {
    body = Bodies.circle(x, y, size / 2, bodyOptions, params.circleSegments);
  } else {
    body = Bodies.rectangle(x, y, size, size, bodyOptions);
    Body.setAngle(body, Math.random() * Math.PI * 2);
  }

  if (fromTop) {
    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * 2,
      y: 1 + Math.random() * 2,
    });
  } else {
    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * 1.5,
      y: (Math.random() - 0.5) * 1.5,
    });
  }

  World.add(world, body);
  shapes.push({ body, kind, size, escaped: false });
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

function findShapeAt(x, y, pad = HIT_PAD) {
  // Prefer exact hit, then a small pad for fat fingers
  for (let i = shapes.length - 1; i >= 0; i--) {
    const shape = shapes[i];
    if (Query.point([shape.body], { x, y }).length) return shape;
  }
  if (pad <= 0) return null;
  const hits = Query.region(
    shapes.map((s) => s.body),
    {
      min: { x: x - pad, y: y - pad },
      max: { x: x + pad, y: y + pad },
    }
  );
  if (!hits.length) return null;
  return shapes.find((s) => s.body === hits[hits.length - 1]) || null;
}

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
  const outside =
    x < 0 || x > width || y < 0 || y > height;

  // Only finger drag/flick can leave — tilt alone still hits walls
  if (outside || speed >= params.flickEscapeSpeed) {
    markEscaped(shape);
  }

  drag.active = false;
  drag.shape = null;
  drag.pointerId = null;
  drag.samples = [];
}

function spawnShapesFromTop(count) {
  const n = Math.min(count, Math.max(0, params.maxShapes - shapes.length));
  for (let i = 0; i < n; i++) {
    const size = sizeForKind(Math.random() < params.circleRatio ? "circle" : "square");
    const x = size / 2 + 8 + Math.random() * Math.max(1, width - size - 16);
    // Inside the box, near the top edge (ceiling blocks anything above y≈0)
    const y = size / 2 + 12 + Math.random() * 36;
    spawnShape(x, y, { fromTop: true });
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
    spawnShapesFromTop(params.shakeSpawnCount);
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

    const jerk = Math.hypot(x - shake.lastGX, y - shake.lastGY, z - shake.lastGZ);
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

  const jump = Math.abs(beta - shake.lastBeta) + Math.abs(gamma - shake.lastGamma);
  shake.lastBeta = beta;
  shake.lastGamma = gamma;

  // Sudden orientation jumps while shaking the phone
  if (jump > 18) registerShakeHit();
}

function clearShapes() {
  shapes.splice(0).forEach(({ body }) => World.remove(world, body));
}

function seedShapes() {
  clearShapes();

  // Spread in the open center so there's room to move
  for (let i = 0; i < params.shapeCount; i++) {
    const margin = sizeForKind("circle") + 24;
    const x = margin + Math.random() * Math.max(1, width - margin * 2);
    const y =
      height * 0.28 + Math.random() * Math.max(1, height * 0.35 - margin);
    spawnShape(x, y);
  }
}

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

  if (usingDeviceTilt) {
    engine.gravity.x = tilt.x * params.tiltStrength;
    engine.gravity.y = tilt.y * params.tiltStrength;
    if (Math.hypot(engine.gravity.x, engine.gravity.y) < 0.2) {
      engine.gravity.y = params.baseGravity;
    }
  } else if (params.useMouseTilt) {
    engine.gravity.x = tilt.x * params.tiltStrength;
    engine.gravity.y =
      tilt.y * params.tiltStrength + params.baseGravity * 0.15;
  } else {
    engine.gravity.x = 0;
    engine.gravity.y = params.baseGravity;
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

function drawShapes() {
  for (const shape of shapes) {
    const { body, kind, size } = shape;
    ctx.fillStyle = params.color;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.08)";
    ctx.lineWidth = 1.5;

    if (kind === "circle") {
      ctx.beginPath();
      ctx.arc(body.position.x, body.position.y, size / 2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      continue;
    }

    const verts = body.vertices;
    ctx.beginPath();
    ctx.moveTo(verts[0].x, verts[0].y);
    for (let i = 1; i < verts.length; i++) {
      ctx.lineTo(verts[i].x, verts[i].y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
}

function drawTiltIndicator() {
  if (!tiltEnabled && !usingDeviceTilt) return;

  const cx = width / 2;
  const cy = height / 2;
  const len = 36;
  const gx = engine.gravity.x;
  const gy = engine.gravity.y;
  const mag = Math.hypot(gx, gy) || 1;
  const nx = (gx / mag) * len;
  const ny = (gy / mag) * len;

  ctx.beginPath();
  ctx.strokeStyle = "rgba(17, 17, 17, 0.18)";
  ctx.lineWidth = 2;
  ctx.moveTo(cx, cy);
  ctx.lineTo(cx + nx, cy + ny);
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = "rgba(17, 17, 17, 0.22)";
  ctx.arc(cx + nx, cy + ny, 4, 0, Math.PI * 2);
  ctx.fill();
}

function render() {
  ctx.clearRect(0, 0, width, height);
  // drawTiltIndicator(); // orientation debug
  drawShapes();
}

Events.on(engine, "beforeUpdate", () => {
  updateGravity();
  applyAntiAlign();
  removeOffscreenEscaped();
});

const runner = Runner.create();
Runner.run(runner, engine);

(function loop() {
  render();
  requestAnimationFrame(loop);
})();

function setStatus(text, active = false) {
  if (!statusEl) return;
  statusEl.hidden = !text;
  statusEl.textContent = text;
  statusEl.dataset.active = active ? "true" : "false";
}

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
      if (permission !== "granted") {
        setStatus("Permission refusée — réessaie");
        return;
      }
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

    // Start with a calm downward gravity until first sensor sample
    tilt.targetX = 0;
    tilt.targetY = 1;
    tilt.x = 0;
    tilt.y = 1;

    // enableBtn.hidden = true;
    // hintEl.hidden = true;
    // setStatus("Tilt actif — penche le téléphone", true);

    // If nothing arrives, tell the user (common when sensors are blocked)
    // setTimeout(() => {
    //   if (usingDeviceTilt && performance.now() - lastSensorAt > 1500) {
    //     setStatus(
    //       "Pas de capteur — autorise le mouvement dans Chrome (icône cadenas)",
    //       false
    //     );
    //   }
    // }, 1600);
  } catch (err) {
    // setStatus("Tilt indisponible sur cet appareil");
    console.warn(err);
  }
}

function canvasPointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function releaseCapture(e) {
  if (canvas.hasPointerCapture?.(e.pointerId)) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  }
}

function switchToScroll(e) {
  gesture.mode = "scroll";
  if (drag.active) endDrag();
  releaseCapture(e);
}

function resetGesture() {
  if (drag.active) endDrag();
  gesture.pointerId = null;
  gesture.mode = "idle";
  gesture.hitShape = false;
  gesture.shape = null;
}

// enableBtn?.addEventListener("click", enableTilt);

canvas.addEventListener(
  "pointerdown",
  (e) => {
    // iOS needs a user gesture for sensor permission
    if (!usingDeviceTilt) enableTilt();

    const pos = canvasPointerPos(e);
    const hit = findShapeAt(pos.x, pos.y);

    gesture.pointerId = e.pointerId;
    gesture.startX = e.clientX;
    gesture.startY = e.clientY;
    gesture.lastY = e.clientY;
    gesture.hitShape = Boolean(hit);
    gesture.shape = hit;

    // Desktop mouse: keep full drag / tilt affordance
    if (e.pointerType === "mouse") {
      gesture.mode = "play";
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (hit) {
        startDrag(hit, pos.x, pos.y, e.pointerId);
      } else {
        setTiltTargetsFromPointer(e.clientX, e.clientY);
      }
      e.preventDefault();
      return;
    }

    // Touch: empty space → native scroll; shape → drag (may yield to vertical flick)
    if (!hit) {
      gesture.mode = "scroll";
      return;
    }

    gesture.mode = "undecided";
    e.preventDefault();
  },
  { passive: false }
);

canvas.addEventListener(
  "pointermove",
  (e) => {
    if (gesture.pointerId !== null && e.pointerId !== gesture.pointerId) {
      // Desktop hover tilt while idle
      if (e.pointerType === "mouse" && gesture.mode === "idle" && !drag.active) {
        setTiltTargetsFromPointer(e.clientX, e.clientY);
      }
      return;
    }

    const pos = canvasPointerPos(e);

    if (e.pointerType === "mouse" && gesture.mode === "idle" && !drag.active) {
      setTiltTargetsFromPointer(e.clientX, e.clientY);
      return;
    }

    if (gesture.mode === "scroll") {
      if (gesture.hitShape && e.pointerType !== "mouse") {
        window.scrollBy(0, gesture.lastY - e.clientY);
        gesture.lastY = e.clientY;
        e.preventDefault();
      }
      return;
    }

    if (gesture.mode === "undecided") {
      const dx = e.clientX - gesture.startX;
      const dy = e.clientY - gesture.startY;
      const absX = Math.abs(dx);
      const absY = Math.abs(dy);
      const dist = Math.hypot(dx, dy);

      if (dist < SCROLL_LOCK_PX) {
        e.preventDefault();
        return;
      }

      if (absY > absX * VERTICAL_RATIO) {
        switchToScroll(e);
        window.scrollBy(0, gesture.lastY - e.clientY);
        gesture.lastY = e.clientY;
        return;
      }

      // Lock into drag play
      gesture.mode = "play";
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      if (gesture.shape) {
        startDrag(gesture.shape, pos.x, pos.y, e.pointerId);
      }
      e.preventDefault();
      return;
    }

    if (gesture.mode === "play") {
      if (e.pointerType !== "mouse") {
        const dx = e.clientX - gesture.startX;
        const dy = e.clientY - gesture.startY;
        if (
          Math.abs(dy) > SCROLL_LOCK_PX * 2 &&
          Math.abs(dy) > Math.abs(dx) * VERTICAL_RATIO
        ) {
          switchToScroll(e);
          window.scrollBy(0, gesture.lastY - e.clientY);
          gesture.lastY = e.clientY;
          return;
        }
      }

      if (drag.active && e.pointerId === drag.pointerId) {
        moveDrag(pos.x, pos.y);
      } else if (!drag.active) {
        setTiltTargetsFromPointer(e.clientX, e.clientY);
      }
      e.preventDefault();
    }
  },
  { passive: false }
);

canvas.addEventListener("pointerup", (e) => {
  if (gesture.pointerId !== null && e.pointerId !== gesture.pointerId) return;

  // Tap on a shape with no scroll intent → start+end drag (release in place)
  if (
    gesture.mode === "undecided" &&
    gesture.hitShape &&
    e.pointerType !== "mouse"
  ) {
    const pos = canvasPointerPos(e);
    if (gesture.shape) {
      startDrag(gesture.shape, pos.x, pos.y, e.pointerId);
      endDrag();
    }
  } else if (drag.active && e.pointerId === drag.pointerId) {
    endDrag();
  }

  gesture.pointerId = null;
  gesture.mode = "idle";
  gesture.hitShape = false;
  gesture.shape = null;
});

canvas.addEventListener("pointercancel", (e) => {
  if (gesture.pointerId !== null && e.pointerId !== gesture.pointerId) return;
  resetGesture();
});

function updateScrollCue() {
  if (!scrollCue) return;
  const hide = window.scrollY > Math.min(48, height * 0.08);
  scrollCue.classList.toggle("is-hidden", hide);
}

window.addEventListener("scroll", updateScrollCue, { passive: true });
updateScrollCue();

// If orientation exists and no iOS prompt needed, auto-hint
function initTiltUi() {
  /*
  const needsPermission =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  const hasOrientation = "DeviceOrientationEvent" in window;

  if (!hasOrientation) {
    enableBtn.hidden = true;
    hintEl.textContent =
      "Ouvre cette page sur mobile, ou déplace le curseur pour simuler le tilt";
    setStatus("Mode curseur (desktop)");
    tiltEnabled = true;
    return;
  }

  if (!needsPermission && isMobile) {
    hintEl.textContent = "Appuie pour activer le tilt, puis incline le téléphone";
  } else if (!isMobile) {
    hintEl.textContent =
      "Sur mobile: active le tilt. Sur desktop: déplace le curseur pour simuler.";
  }
  */

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
let lastLayoutWidth = 0;
let lastLayoutHeight = 0;

function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const deviceChanged = applyDeviceDefaults();
    const nextW = stage.clientWidth || window.innerWidth;
    const nextH = stage.clientHeight || window.innerHeight;

    // Ignore mobile URL-bar / visualViewport jitter while scrolling
    const widthChanged = Math.abs(nextW - lastLayoutWidth) > 8;
    const heightChanged = Math.abs(nextH - lastLayoutHeight) > 48;
    if (!deviceChanged && !widthChanged && !heightChanged) return;

    resize();
    lastLayoutWidth = width;
    lastLayoutHeight = height;

    // Only remake the scene when layout meaningfully changes (rotate / breakpoint)
    if (deviceChanged || widthChanged) {
      seedShapes();
    }
  }, 150);
}

window.addEventListener("resize", onViewportChange);
// Do not listen to visualViewport — it fires on scroll chrome show/hide

function setupGUI() {
  const showDev =
    new URLSearchParams(window.location.search).has("dev") || !isMobile;
  if (!showDev) return;

  const gui = new GUI({ title: "Tilt Controls" });
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
    .name("Circle ratio")
    .onFinishChange(seedShapes);
  shapesFolder.addColor(params, "color").name("Color");

  const tiltFolder = gui.addFolder("Tilt");
  tiltFolder.add(params, "tiltStrength", 0.2, 4, 0.05).name("Tilt strength");
  tiltFolder.add(params, "tiltSensitivity", 8, 40, 1).name("Sensitivity");
  tiltFolder.add(params, "tiltSmooth", 0.02, 0.4, 0.01).name("Smoothing");
  tiltFolder.add(params, "baseGravity", 0, 2, 0.05).name("Base gravity");
  tiltFolder.add(params, "useMouseTilt").name("Mouse tilt (desktop)");
  tiltFolder
    .add(
      {
        recalibrate: () => {
          calib.ready = false;
          setStatus("Recalibré — penche depuis cette position", true);
        },
      },
      "recalibrate"
    )
    .name("Recalibrate");

  const physicsFolder = gui.addFolder("Physics");
  physicsFolder.add(params, "restitution", 0, 1, 0.01).name("Bounce");
  physicsFolder.add(params, "friction", 0, 1, 0.01).name("Friction");
  physicsFolder.add(params, "frictionAir", 0, 0.05, 0.001).name("Air");
  physicsFolder.add(params, "antiAlign").name("Anti-align");

  gui.add({ respawn: seedShapes }, "respawn").name("Respawn");

  shapesFolder.open();
  tiltFolder.open();
}

applyDeviceDefaults(true);
resize();
lastLayoutWidth = width;
lastLayoutHeight = height;
seedShapes();
initTiltUi();
// setupGUI(); // orientation / physics debug panel
