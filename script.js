import collection from "./collection.js";
import gsap from "gsap";
import CustomEase from "gsap/CustomEase";
import SplitText from "gsap/SplitText";
import * as THREE from "three";

document.addEventListener("DOMContentLoaded", () => {
  gsap.registerPlugin(SplitText, CustomEase);

  // Fast attack, long silky settle — used for the morph and the intro.
  CustomEase.create("silk", "M0,0 C0.7,0 0.16,1 1,1");

  const container = document.querySelector(".gallery-container");
  const titleContainer = document.querySelector(".title-container");

  const config = {
    imageCount: 25,
    cardWidth: 0.85,
    cardHeight: 1.15,
    sensitivity: 2.8,
    effectFalloff: 1.6,
    cardMoveAmount: 0.35,
    lerpFactor: 0.15,
    isMobile: window.innerWidth < 1000,

    // Morph feel
    morphDuration: 2.3,
    ripple: 0.45, // stagger of the morph traveling around the ring
    swirl: 0.05, // perimeter swirl during the morph (fraction of perimeter)
    lift: 0.55, // z lift toward the camera mid-morph
    tilt: 0.5, // y shimmer tilt mid-morph (radians)
    breathe: 0.07, // scale swell mid-morph
    driftSpeed: 0.006, // idle ring rotation (perimeter fraction per second)
    cornerSoftness: 10, // superellipse exponent: higher = sharper corners
  };

  let isCircularLayout = true;
  let isAnimating = true; // locked until the intro reveal finishes
  let currentTitle = null;

  // 0 = circle, 1 = square. The whole transition is driven by this
  // one value; card poses are computed from it every frame.
  const morphState = { progress: 0 };
  const revealState = { progress: 0 };
  let rippleOrigin = 0; // card index the morph ripples out from
  let morphDirection = 1; // sign of the swirl / shimmer
  let uDrift = 0; // idle rotation along the perimeter

  const BASE_CAMERA_Z = 8;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(
    50,
    window.innerWidth / window.innerHeight,
    0.1,
    100
  );
  camera.position.z = BASE_CAMERA_Z;

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000, 0);
  container.appendChild(renderer.domElement);

  const galleryGroup = new THREE.Group();
  scene.add(galleryGroup);

  const parallaxState = {
    targetX: 0,
    targetY: 0,
    targetZ: 0,
    currentX: 0,
    currentY: 0,
    currentZ: 0,
  };

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const cards = [];
  const transformState = [];

  const textureLoader = new THREE.TextureLoader();
  const maxAnisotropy = renderer.capabilities.getMaxAnisotropy();
  const sharedGeometry = new THREE.PlaneGeometry(
    config.cardWidth,
    config.cardHeight
  );

  // Visible bounds are computed from the camera's rest position so the
  // dolly "breath" during the morph reads as a zoom, not a layout change.
  function getVisibleBounds() {
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const height = 2 * Math.tan(vFov / 2) * BASE_CAMERA_Z;
    const width = height * camera.aspect;
    return { width, height };
  }

  function getRingRadius() {
    const { width, height } = getVisibleBounds();
    const cardPad = Math.max(config.cardWidth, config.cardHeight) * 0.35 + 0.15;
    return Math.min(width, height) / 2 - cardPad;
  }

  // ------------------------------------------------------------------
  // The rond–carré curve.
  //
  // One closed curve, parameterized by m in [0, 1]: a perfect circle at
  // m = 0 that continuously deforms into a superellipse — a square with
  // softly rounded corners (the brand, in one shape) — at m = 1.
  // Cards are placed on it by arc length, so spacing stays perfectly
  // even at every instant of the morph, and their rotation follows the
  // curve's tangent.
  // ------------------------------------------------------------------
  const SHAPE_SAMPLES = 256;
  const shapePts = new Float32Array((SHAPE_SAMPLES + 1) * 2);
  const shapeLens = new Float32Array(SHAPE_SAMPLES + 1);
  const shapeCache = { m: -1, w: -1, h: -1, total: 0 };

  function buildShape(m) {
    const { width, height } = getVisibleBounds();
    if (shapeCache.m === m && shapeCache.w === width && shapeCache.h === height)
      return;

    const rc = getRingRadius();
    const hw = width / 2 - config.cardWidth * 0.35;
    const hh = height / 2 - config.cardHeight * 0.35;
    const p = config.cornerSoftness;

    let prevX = 0;
    let prevY = 0;
    let total = 0;

    for (let k = 0; k <= SHAPE_SAMPLES; k++) {
      const a = (k / SHAPE_SAMPLES) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const rs = Math.pow(
        Math.pow(Math.abs(c) / hw, p) + Math.pow(Math.abs(s) / hh, p),
        -1 / p
      );
      const r = rc + (rs - rc) * m;
      const x = c * r;
      const y = s * r;

      shapePts[k * 2] = x;
      shapePts[k * 2 + 1] = y;
      if (k > 0) total += Math.hypot(x - prevX, y - prevY);
      shapeLens[k] = total;
      prevX = x;
      prevY = y;
    }

    shapeCache.m = m;
    shapeCache.w = width;
    shapeCache.h = height;
    shapeCache.total = total;
  }

  // u in [0, 1) is the fraction of perimeter traveled counterclockwise
  // from angle 0. Writes { x, y, rot } into out.
  function sampleShape(u, m, out) {
    buildShape(m);

    const target = u * shapeCache.total;
    let lo = 0;
    let hi = SHAPE_SAMPLES;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shapeLens[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    const k = Math.max(1, lo);
    const l0 = shapeLens[k - 1];
    const l1 = shapeLens[k];
    const t = l1 > l0 ? (target - l0) / (l1 - l0) : 0;
    const x0 = shapePts[(k - 1) * 2];
    const y0 = shapePts[(k - 1) * 2 + 1];
    const x1 = shapePts[k * 2];
    const y1 = shapePts[k * 2 + 1];

    out.x = x0 + (x1 - x0) * t;
    out.y = y0 + (y1 - y0) * t;
    out.rot = Math.atan2(y1 - y0, x1 - x0);
  }

  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  const smooth = (v) => v * v * (3 - 2 * v);
  const wrap01 = (v) => ((v % 1) + 1) % 1;

  // Normalized distance around the ring between two card indices (0..1).
  function ringDistance(i, j) {
    const n = config.imageCount;
    const raw = Math.abs(i - j);
    return Math.min(raw, n - raw) / (n / 2);
  }

  for (let i = 0; i < config.imageCount; i++) {
    const cardIndex = i % collection.length;
    const texture = textureLoader.load(collection[cardIndex].img);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = maxAnisotropy;

    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
    });

    const mesh = new THREE.Mesh(sharedGeometry, material);
    mesh.userData.index = i;
    mesh.userData.title = collection[cardIndex].title;

    galleryGroup.add(mesh);
    cards.push(mesh);

    const angle = (i / config.imageCount) * Math.PI * 2;
    transformState.push({
      normalX: Math.cos(angle),
      normalY: Math.sin(angle),
      currentFlip: 0,
      targetFlip: 0,
      currentX: 0,
      targetX: 0,
      currentY: 0,
      targetY: 0,
      currentScale: 1,
      targetScale: 1,
    });
  }

  function showTitle(text) {
    if (currentTitle) {
      currentTitle.remove();
      currentTitle = null;
    }

    const p = document.createElement("p");
    p.textContent = text;
    titleContainer.appendChild(p);
    currentTitle = p;

    const splitText = new SplitText(p, {
      type: "words",
      wordsClass: "word",
    });

    gsap.set(splitText.words, { y: "125%" });
    gsap.to(splitText.words, {
      y: "0%",
      duration: 0.75,
      delay: 0.7,
      stagger: 0.08,
      ease: "power4.out",
    });
  }

  function hideTitle() {
    if (!currentTitle) return;

    const words = currentTitle.querySelectorAll(".word");
    const titleEl = currentTitle;

    gsap.to(words, {
      y: "-125%",
      duration: 0.6,
      stagger: 0.06,
      ease: "power4.out",
      onComplete: () => {
        titleEl.remove();
        if (currentTitle === titleEl) currentTitle = null;
      },
    });
  }

  function resetHoverTargets() {
    transformState.forEach((state) => {
      state.targetFlip = 0;
      state.targetScale = 1;
      state.targetX = 0;
      state.targetY = 0;
    });
  }

  function toggleLayout(clickedIndex = null) {
    if (isAnimating) return;

    isAnimating = true;
    isCircularLayout = !isCircularLayout;
    morphDirection = isCircularLayout ? -1 : 1;
    if (clickedIndex !== null) rippleOrigin = clickedIndex;

    resetHoverTargets();
    Object.assign(parallaxState, {
      targetX: 0,
      targetY: 0,
      targetZ: 0,
    });

    gsap.to(galleryGroup.rotation, {
      x: 0,
      y: 0,
      z: 0,
      duration: 0.5,
      ease: "power2.out",
      onUpdate: () => {
        parallaxState.currentX = galleryGroup.rotation.x;
        parallaxState.currentY = galleryGroup.rotation.y;
        parallaxState.currentZ = galleryGroup.rotation.z;
      },
    });

    if (!isCircularLayout) {
      showTitle(cards[rippleOrigin].userData.title);
    } else {
      hideTitle();
    }

    // A slight camera breath: pull back as the shape re-forms, settle in.
    gsap.to(camera.position, {
      z: BASE_CAMERA_Z + 0.7,
      duration: config.morphDuration / 2,
      ease: "sine.inOut",
      yoyo: true,
      repeat: 1,
    });

    gsap.to(morphState, {
      progress: isCircularLayout ? 0 : 1,
      duration: config.morphDuration,
      ease: "silk",
      onComplete: () => {
        isAnimating = false;
      },
    });
  }

  function setPointerFromEvent(e) {
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  function onPointerMove(e) {
    if (isAnimating || config.isMobile) return;

    setPointerFromEvent(e);

    const percentX = pointer.x;
    const percentY = pointer.y;

    if (isCircularLayout) {
      parallaxState.targetY = percentX * 0.2;
      parallaxState.targetX = -percentY * 0.2;
      parallaxState.targetZ = (percentX + percentY) * 0.05;
    } else {
      parallaxState.targetY = percentX * 0.06;
      parallaxState.targetX = -percentY * 0.06;
      parallaxState.targetZ = 0;
    }

    if (!isCircularLayout) {
      resetHoverTargets();
      return;
    }

    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(cards);
    const hoverIndex = hits.length ? hits[0].object.userData.index : -1;

    cards.forEach((mesh, index) => {
      const state = transformState[index];
      const worldPos = new THREE.Vector3();
      mesh.getWorldPosition(worldPos);

      const projected = worldPos.clone().project(camera);
      const dx = pointer.x - projected.x;
      const dy = pointer.y - projected.y;
      const distance = Math.sqrt(dx * dx + dy * dy) * 8;

      if (distance < config.sensitivity || index === hoverIndex) {
        const flipFactor = Math.max(0, 1 - distance / config.effectFalloff);
        const moveAmount = config.cardMoveAmount * flipFactor;

        state.targetFlip = Math.PI * flipFactor;
        state.targetScale = 1 + 0.25 * flipFactor;
        state.targetX = moveAmount * state.normalX;
        state.targetY = moveAmount * state.normalY;
      } else {
        state.targetFlip = 0;
        state.targetScale = 1;
        state.targetX = 0;
        state.targetY = 0;
      }
    });
  }

  function onPointerLeave() {
    if (isAnimating) return;

    resetHoverTargets();
    parallaxState.targetX = 0;
    parallaxState.targetY = 0;
    parallaxState.targetZ = 0;
  }

  function onClick(e) {
    if (isAnimating) return;

    setPointerFromEvent(e);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(cards);

    if (hits.length) {
      toggleLayout(hits[0].object.userData.index);
    } else if (!isCircularLayout) {
      toggleLayout();
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape" && !isCircularLayout && !isAnimating) {
      toggleLayout();
    }
  }

  function onResize() {
    const width = window.innerWidth;
    const height = window.innerHeight;

    config.isMobile = width < 1000;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }

  window.addEventListener("resize", onResize);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("click", onClick);
  window.addEventListener("keydown", onKeyDown);

  // Intro: cards spiral out of the center one after another.
  gsap.to(revealState, {
    progress: 1,
    duration: 2.0,
    delay: 0.3,
    ease: "silk",
    onComplete: () => {
      isAnimating = false;
    },
  });

  const clock = new THREE.Clock();
  const poseOut = { x: 0, y: 0, rot: 0 };

  function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05);
    const total = config.imageCount;

    // The ring slowly rotates while idle in circle mode. A pure shift in
    // perimeter fraction, so even spacing is preserved and any moment is
    // a valid starting point for the morph.
    if (!isAnimating && isCircularLayout) uDrift += dt * config.driftSpeed;

    if (!isAnimating) {
      parallaxState.currentX +=
        (parallaxState.targetX - parallaxState.currentX) * config.lerpFactor;
      parallaxState.currentY +=
        (parallaxState.targetY - parallaxState.currentY) * config.lerpFactor;
      parallaxState.currentZ +=
        (parallaxState.targetZ - parallaxState.currentZ) * config.lerpFactor;

      galleryGroup.rotation.x = parallaxState.currentX;
      galleryGroup.rotation.y = parallaxState.currentY;
      galleryGroup.rotation.z = parallaxState.currentZ;
    }

    const P = morphState.progress;

    cards.forEach((mesh, i) => {
      const state = transformState[i];

      // The morph ripples around the ring from the clicked card: each
      // card gets its own local progress, offset by ring distance.
      const d = ringDistance(i, rippleOrigin);
      const local = smooth(clamp01(P * (1 + config.ripple) - d * config.ripple));
      const wave = Math.sin(Math.PI * local);

      // Intro reveal, staggered around the ring.
      const reveal = smooth(
        clamp01(revealState.progress * 1.7 - (i / total) * 0.7)
      );

      // Position on the morphing curve. The swirl shifts cards along the
      // perimeter mid-transition, so the ring "winds" as it squares off.
      const u = wrap01(
        i / total + uDrift + config.swirl * wave * morphDirection
      );
      sampleShape(u, local, poseOut);

      // Outward normal of the curve at this card (tangent rotated -90°),
      // used by the hover effect to push cards away from the shape.
      state.normalX = Math.sin(poseOut.rot);
      state.normalY = -Math.cos(poseOut.rot);

      state.currentFlip +=
        (state.targetFlip - state.currentFlip) * config.lerpFactor;
      state.currentScale +=
        (state.targetScale - state.currentScale) * config.lerpFactor;
      state.currentX += (state.targetX - state.currentX) * config.lerpFactor;
      state.currentY += (state.targetY - state.currentY) * config.lerpFactor;

      mesh.position.set(
        poseOut.x * reveal + state.currentX,
        poseOut.y * reveal + state.currentY,
        wave * config.lift
      );
      mesh.rotation.set(
        0,
        state.currentFlip + wave * config.tilt * morphDirection,
        poseOut.rot + (1 - reveal) * 0.9
      );
      mesh.scale.setScalar(
        Math.max(0.0001, reveal * (1 + wave * config.breathe) * state.currentScale)
      );
      mesh.material.opacity = reveal;
    });

    renderer.render(scene, camera);
  }

  animate();
});
