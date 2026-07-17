import Matter from "matter-js";
import GUI from "lil-gui";

const { Engine, World, Bodies, Body, Runner, Events, Query } = Matter;

const WALL_THICKNESS = 160;
// Equal visual mass: circle diameter must be √(4/π) × square side
// so a circle doesn't look smaller than a square of the same "size".
const OPTICAL_CIRCLE_SCALE = Math.sqrt(4 / Math.PI);

const DESKTOP = {
  shapeSize: 140,
  shapeCount: 70,
  circleSegments: 64,
  repelRadius: 400,
  repelStrength: 0.4,
  rainHeight: 600,
  spawnStagger: 4000,
};

const MOBILE = {
  shapeSize: 78,
  shapeCount: 42,
  circleSegments: 36,
  repelRadius: 240,
  repelStrength: 0.45,
  rainHeight: 420,
  spawnStagger: 3200,
};

const params = {
  shapeSize: DESKTOP.shapeSize,
  shapeCount: DESKTOP.shapeCount,
  circleRatio: 0.5,
  opticalCircleScale: OPTICAL_CIRCLE_SCALE,
  circleSegments: DESKTOP.circleSegments,
  color: "#ffd600",
  gravity: 1.15,
  restitution: 0.45,
  friction: 0.08,
  frictionAir: 0.014,
  density: 0.002,
  antiAlign: true,
  antiAlignTorque: 0.0035,
  repelRadius: DESKTOP.repelRadius,
  repelStrength: DESKTOP.repelStrength,
  showRepelAura: true,
  spawnStagger: DESKTOP.spawnStagger,
  rainHeight: DESKTOP.rainHeight,
  rainDrift: 0.12,
  clickSpawn: 3,
};

const canvas = document.getElementById("physics-canvas");
const hero = document.querySelector(".hero");
const ctx = canvas.getContext("2d");

let width = 0;
let height = 0;
let dpr = 1;
let isMobile = false;

const mouse = { x: -9999, y: -9999, active: false };
const shapes = [];

// Gesture arbitration: shape hit = play, empty / clear vertical flick = scroll
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
};

const engine = Engine.create({
  gravity: { x: 0, y: params.gravity },
});
const world = engine.world;

let floor = null;
let leftWall = null;
let rightWall = null;
let ceiling = null;
let spawnTimeouts = [];
let guiRef = null;

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
  params.repelRadius = preset.repelRadius;
  params.repelStrength = preset.repelStrength;
  params.rainHeight = preset.rainHeight;
  params.spawnStagger = preset.spawnStagger;
  params.showRepelAura = !isMobile;
  params.clickSpawn = isMobile ? 2 : 3;

  return true;
}

function clearSpawnTimeouts() {
  spawnTimeouts.forEach(clearTimeout);
  spawnTimeouts = [];
}

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, isMobile ? 1.75 : 2);
  width = hero.clientWidth || window.innerWidth;
  height = hero.clientHeight || window.innerHeight;
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

  floor = Bodies.rectangle(
    width / 2,
    height + WALL_THICKNESS / 2 - 2,
    width + WALL_THICKNESS * 2,
    WALL_THICKNESS,
    { isStatic: true, friction: 0.35, restitution: 0.25 }
  );
  leftWall = Bodies.rectangle(
    -WALL_THICKNESS / 2,
    height / 2,
    WALL_THICKNESS,
    height * 2,
    { isStatic: true }
  );
  rightWall = Bodies.rectangle(
    width + WALL_THICKNESS / 2,
    height / 2,
    WALL_THICKNESS,
    height * 2,
    { isStatic: true }
  );
  ceiling = Bodies.rectangle(
    width / 2,
    -WALL_THICKNESS / 2 - 2000,
    width + WALL_THICKNESS * 2,
    WALL_THICKNESS,
    { isStatic: true }
  );

  World.add(world, [floor, leftWall, rightWall, ceiling]);
}

function sizeForKind(kind) {
  return kind === "circle"
    ? params.shapeSize * params.opticalCircleScale
    : params.shapeSize;
}

function spawnShape(x, y, options = {}) {
  const { rain = false } = options;
  const kind = Math.random() < params.circleRatio ? "circle" : "square";
  const size = sizeForKind(kind);
  const bodyOptions = {
    restitution: params.restitution + (Math.random() - 0.5) * 0.08,
    friction: params.friction + Math.random() * 0.06,
    frictionAir: params.frictionAir,
    density: params.density,
  };

  const startY = rain
    ? -(size / 2 + 24 + Math.random() * params.rainHeight)
    : y;

  let body;
  if (kind === "circle") {
    body = Bodies.circle(
      x,
      startY,
      size / 2,
      bodyOptions,
      params.circleSegments
    );
  } else {
    body = Bodies.rectangle(x, startY, size, size, bodyOptions);
    Body.setAngle(body, Math.random() * Math.PI * 2);
  }

  const shape = { body, kind, size, hidden: false };

  if (rain) {
    Body.setStatic(body, true);
    Body.setPosition(body, {
      x,
      y: -(size / 2 + 24) - params.rainHeight - 200,
    });
    Body.setVelocity(body, { x: 0, y: 0 });
    Body.setAngularVelocity(body, 0);
    shape.hidden = true;

    const delay = Math.random() * params.spawnStagger;
    const id = setTimeout(() => {
      const dropX =
        size / 2 + 8 + Math.random() * Math.max(1, width - size - 16);
      const dropY = -(size / 2 + 24 + Math.random() * params.rainHeight);

      Body.setPosition(body, { x: dropX, y: dropY });
      Body.setVelocity(body, {
        x: (Math.random() - 0.5) * params.rainDrift,
        y: 0,
      });
      if (kind === "square") {
        Body.setAngle(body, Math.random() * Math.PI * 2);
        Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.03);
      } else {
        Body.setAngularVelocity(body, 0);
      }
      Body.setStatic(body, false);
      shape.hidden = false;
    }, delay);
    spawnTimeouts.push(id);
  } else {
    Body.setVelocity(body, {
      x: (Math.random() - 0.5) * params.rainDrift,
      y: 0,
    });
    if (kind === "square") {
      Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.03);
    }
  }

  World.add(world, body);
  shapes.push(shape);
}

function clearShapes() {
  clearSpawnTimeouts();
  shapes.splice(0).forEach(({ body }) => World.remove(world, body));
}

function seedShapes() {
  clearShapes();

  for (let i = 0; i < params.shapeCount; i++) {
    const margin = sizeForKind("circle");
    const x = margin + Math.random() * Math.max(1, width - margin * 2);
    spawnShape(x, 0, { rain: true });
  }
}

function applyLiveBodyParams() {
  for (const { body } of shapes) {
    body.restitution = params.restitution;
    body.friction = params.friction;
    body.frictionAir = params.frictionAir;
  }
}

function applyRepulsion() {
  if (!mouse.active) return;

  const r = params.repelRadius;
  const nearby = Query.region(world.bodies, {
    min: { x: mouse.x - r, y: mouse.y - r },
    max: { x: mouse.x + r, y: mouse.y + r },
  });

  for (const body of nearby) {
    if (body.isStatic) continue;

    const dx = body.position.x - mouse.x;
    const dy = body.position.y - mouse.y;
    const dist = Math.hypot(dx, dy) || 0.001;

    if (dist > r) continue;

    const falloff = 1 - dist / r;
    const force = falloff * falloff * params.repelStrength;
    const nx = dx / dist;
    const ny = dy / dist;

    Body.applyForce(body, body.position, {
      x: nx * force,
      y: ny * force,
    });
  }
}

function applyAntiAlign() {
  if (!params.antiAlign) return;

  for (const shape of shapes) {
    if (shape.kind !== "square") continue;

    const { body } = shape;
    const speed = Math.hypot(body.velocity.x, body.velocity.y);
    if (speed > 0.6 || Math.abs(body.angularVelocity) > 0.08) continue;

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

function drawMouseAura() {
  if (!mouse.active || !params.showRepelAura) return;

  const r = params.repelRadius;
  const gradient = ctx.createRadialGradient(
    mouse.x,
    mouse.y,
    0,
    mouse.x,
    mouse.y,
    r
  );
  gradient.addColorStop(0, "rgba(255, 214, 0, 0.12)");
  gradient.addColorStop(0.55, "rgba(255, 214, 0, 0.04)");
  gradient.addColorStop(1, "rgba(255, 214, 0, 0)");

  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.arc(mouse.x, mouse.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawShapes() {
  for (const shape of shapes) {
    if (shape.hidden) continue;

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
    if (!verts.length) continue;

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

function render() {
  ctx.clearRect(0, 0, width, height);
  drawMouseAura();
  drawShapes();
}

Events.on(engine, "beforeUpdate", () => {
  applyRepulsion();
  applyAntiAlign();
});

const runner = Runner.create();
Runner.run(runner, engine);

(function loop() {
  render();
  requestAnimationFrame(loop);
})();

function pointerPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  };
}

function findShapeAt(x, y, pad = HIT_PAD) {
  const hits = Query.region(world.bodies, {
    min: { x: x - pad, y: y - pad },
    max: { x: x + pad, y: y + pad },
  });
  return hits.find((body) => !body.isStatic) || null;
}

function activatePlay(e, pos) {
  mouse.x = pos.x;
  mouse.y = pos.y;
  mouse.active = true;

  const maxShapes = Math.max(params.shapeCount + 40, isMobile ? 90 : 160);
  if (shapes.length < maxShapes) {
    for (let i = 0; i < params.clickSpawn; i++) {
      spawnShape(
        pos.x + (Math.random() - 0.5) * params.shapeSize,
        -sizeForKind("circle") - Math.random() * 80,
        { rain: false }
      );
    }
  }

  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
}

function deactivatePlay() {
  mouse.active = false;
  mouse.x = -9999;
  mouse.y = -9999;
}

function resetGesture() {
  gesture.pointerId = null;
  gesture.mode = "idle";
  gesture.hitShape = false;
  deactivatePlay();
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
  deactivatePlay();
  releaseCapture(e);
}

function onPointerLeave() {
  resetGesture();
}

canvas.addEventListener(
  "pointerdown",
  (e) => {
    if (e.target.closest?.(".lil-gui")) return;

    const pos = pointerPos(e);
    const hit = findShapeAt(pos.x, pos.y);

    gesture.pointerId = e.pointerId;
    gesture.startX = e.clientX;
    gesture.startY = e.clientY;
    gesture.lastY = e.clientY;
    gesture.hitShape = Boolean(hit);

    // Desktop mouse: keep full play affordance on click
    if (e.pointerType === "mouse") {
      gesture.mode = "play";
      activatePlay(e, pos);
      e.preventDefault();
      return;
    }

    // Touch / pen: empty space → native scroll; shape → play (may yield to vertical flick)
    if (!hit) {
      gesture.mode = "scroll";
      return;
    }

    gesture.mode = "undecided";
    mouse.x = pos.x;
    mouse.y = pos.y;
    mouse.active = true;
    e.preventDefault();
  },
  { passive: false }
);

canvas.addEventListener(
  "pointermove",
  (e) => {
    if (gesture.pointerId !== null && e.pointerId !== gesture.pointerId) return;

    const pos = pointerPos(e);

    // Hover play on desktop without a press
    if (e.pointerType === "mouse" && gesture.mode === "idle") {
      mouse.x = pos.x;
      mouse.y = pos.y;
      mouse.active = true;
      return;
    }

    if (gesture.mode === "scroll") {
      // Continue manual scroll if we already owned the gesture (started on a shape)
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
        mouse.x = pos.x;
        mouse.y = pos.y;
        e.preventDefault();
        return;
      }

      // Clear vertical flick → scroll wins, even if started on a shape
      if (absY > absX * VERTICAL_RATIO) {
        switchToScroll(e);
        window.scrollBy(0, gesture.lastY - e.clientY);
        gesture.lastY = e.clientY;
        return;
      }

      // Otherwise lock into play
      gesture.mode = "play";
      activatePlay(e, pos);
      e.preventDefault();
      return;
    }

    if (gesture.mode === "play") {
      // Mid-play vertical override: mostly vertical travel hands control to scroll
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

      mouse.x = pos.x;
      mouse.y = pos.y;
      mouse.active = true;
      e.preventDefault();
      return;
    }
  },
  { passive: false }
);

canvas.addEventListener(
  "pointerup",
  (e) => {
    if (gesture.pointerId !== null && e.pointerId !== gesture.pointerId) return;

    // Confirmed tap on a shape (no scroll intent) → spawn
    if (
      gesture.mode === "undecided" &&
      gesture.hitShape &&
      e.pointerType !== "mouse"
    ) {
      const pos = pointerPos(e);
      activatePlay(e, pos);
      releaseCapture(e);
    }

    resetGesture();
  },
  { passive: true }
);

canvas.addEventListener("pointercancel", onPointerLeave);
canvas.addEventListener("pointerleave", (e) => {
  if (e.pointerType === "mouse" && gesture.mode === "idle") {
    deactivatePlay();
    return;
  }
  if (gesture.mode === "idle" || gesture.pointerId === e.pointerId) {
    onPointerLeave();
  }
});
window.addEventListener("blur", onPointerLeave);

let resizeTimer = null;
let lastLayoutWidth = 0;
let lastLayoutHeight = 0;

function onViewportChange() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const deviceChanged = applyDeviceDefaults();
    const nextW = hero.clientWidth || window.innerWidth;
    const nextH = hero.clientHeight || window.innerHeight;

    // Ignore mobile URL-bar / visualViewport jitter while scrolling
    const widthChanged = Math.abs(nextW - lastLayoutWidth) > 8;
    const heightChanged = Math.abs(nextH - lastLayoutHeight) > 48;
    if (!deviceChanged && !widthChanged && !heightChanged) return;

    resize();
    lastLayoutWidth = width;
    lastLayoutHeight = height;

    if (deviceChanged) {
      syncGuiControllers();
    }

    // Only remake the scene when layout meaningfully changes (rotate / breakpoint)
    if (deviceChanged || widthChanged) {
      seedShapes();
    }
  }, 150);
}

window.addEventListener("resize", onViewportChange);
// Do not listen to visualViewport — it fires on scroll chrome show/hide

function syncGuiControllers() {
  if (!guiRef) return;
  guiRef.controllersRecursive().forEach((c) => c.updateDisplay());
}

function setupGUI() {
  const showDev =
    new URLSearchParams(window.location.search).has("dev") || !isMobile;

  if (!showDev) return;

  const gui = new GUI({ title: "Dev Controls" });
  guiRef = gui;

  if (isMobile) {
    gui.close();
  }

  const shapesFolder = gui.addFolder("Shapes");
  shapesFolder
    .add(params, "shapeSize", 40, 280, 1)
    .name("Size")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "shapeCount", 10, 200, 1)
    .name("Count")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "circleRatio", 0, 1, 0.05)
    .name("Circle ratio")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "opticalCircleScale", 1, 1.3, 0.001)
    .name("Circle optical scale")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "circleSegments", 12, 128, 1)
    .name("Circle segments")
    .onFinishChange(seedShapes);
  shapesFolder.addColor(params, "color").name("Color");
  shapesFolder
    .add(params, "spawnStagger", 500, 8000, 50)
    .name("Rain duration ms")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "rainHeight", 100, 1200, 10)
    .name("Rain height")
    .onFinishChange(seedShapes);
  shapesFolder
    .add(params, "rainDrift", 0, 1, 0.01)
    .name("Rain drift")
    .onFinishChange(seedShapes);
  shapesFolder.add(params, "clickSpawn", 0, 10, 1).name("Click spawn");

  const physicsFolder = gui.addFolder("Physics");
  physicsFolder
    .add(params, "gravity", 0, 3, 0.05)
    .name("Gravity")
    .onChange((v) => {
      engine.gravity.y = v;
    });
  physicsFolder
    .add(params, "restitution", 0, 1, 0.01)
    .name("Bounce")
    .onChange(applyLiveBodyParams);
  physicsFolder
    .add(params, "friction", 0, 1, 0.01)
    .name("Friction")
    .onChange(applyLiveBodyParams);
  physicsFolder
    .add(params, "frictionAir", 0, 0.1, 0.001)
    .name("Air friction")
    .onChange(applyLiveBodyParams);
  physicsFolder
    .add(params, "density", 0.0005, 0.01, 0.0001)
    .name("Density")
    .onFinishChange(seedShapes);
  physicsFolder.add(params, "antiAlign").name("Anti-align");
  physicsFolder
    .add(params, "antiAlignTorque", 0, 0.02, 0.0005)
    .name("Anti-align torque");

  const mouseFolder = gui.addFolder("Mouse");
  mouseFolder.add(params, "repelRadius", 40, 600, 1).name("Repel radius");
  mouseFolder
    .add(params, "repelStrength", 0, 1, 0.005)
    .name("Repel strength");
  mouseFolder.add(params, "showRepelAura").name("Show aura");

  const actions = {
    respawn: () => seedShapes(),
    clear: () => clearShapes(),
  };
  gui.add(actions, "respawn").name("Respawn");
  gui.add(actions, "clear").name("Clear all");

  shapesFolder.open();
  physicsFolder.open();
  mouseFolder.open();
}

applyDeviceDefaults(true);
resize();
lastLayoutWidth = width;
lastLayoutHeight = height;
seedShapes();
setupGUI();
