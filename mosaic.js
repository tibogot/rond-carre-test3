import GUI from "lil-gui";
import {
  generateMosaic,
  drawTiles,
  tilesToSvg,
  COLOR_COLLECTIONS,
  DEFAULTS,
} from "./mosaic/pipeline.js";
import { modifyColors } from "./mosaic/coloring.js";

const canvas = document.getElementById("mosaic-canvas");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("mosaic-status");
const fileInput = document.getElementById("mosaic-file");

const state = {
  ...DEFAULTS,
  view: "final_recolored",
  running: false,
  result: null,
  source: null,
};

function setStatus(msg) {
  statusEl.textContent = msg;
}

function fitCanvas(w, h) {
  canvas.width = w;
  canvas.height = h;
}

function paint() {
  const result = state.result;
  if (!result) return;
  const { width: w, height: h } = result;
  fitCanvas(w, h);

  if (state.view === "original" && result.stages.original) {
    ctx.putImageData(result.stages.original, 0, 0);
    return;
  }
  if (state.view === "edges" && result.stages.edges) {
    ctx.putImageData(result.stages.edges, 0, 0);
    return;
  }
  if (state.view === "distances" && result.stages.distances) {
    ctx.putImageData(result.stages.distances, 0, 0);
    return;
  }
  if (state.view === "guidelines" && result.stages.guidelines) {
    ctx.putImageData(result.stages.guidelines, 0, 0);
    return;
  }
  if (state.view === "tiles") {
    drawTiles(ctx, result.polygons, null, h, w, 0.2);
    return;
  }
  if (state.view === "final") {
    drawTiles(ctx, result.polygons, result.colors, h, w, 0.2);
    return;
  }
  drawTiles(ctx, result.polygons, result.recolored, h, w, 0.2);
}

function recolorCurrent() {
  if (!state.result) return;
  const schema = COLOR_COLLECTIONS[state.colorSchema];
  state.result.recolored = modifyColors(state.result.colors, "source", schema);
  if (state.view === "final_recolored") paint();
}

async function loadImageFile(fileOrUrl) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  const url = fileOrUrl instanceof Blob ? URL.createObjectURL(fileOrUrl) : fileOrUrl;
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error("Could not load image"));
    img.src = url;
  });
  if (fileOrUrl instanceof Blob) URL.revokeObjectURL(url);

  const off = document.createElement("canvas");
  off.width = img.naturalWidth;
  off.height = img.naturalHeight;
  const c = off.getContext("2d");
  c.drawImage(img, 0, 0);
  const data = c.getImageData(0, 0, off.width, off.height);
  const rgb = new Uint8ClampedArray(off.width * off.height * 3);
  for (let i = 0, j = 0; i < data.data.length; i += 4, j += 3) {
    rgb[j] = data.data[i];
    rgb[j + 1] = data.data[i + 1];
    rgb[j + 2] = data.data[i + 2];
  }
  state.source = { rgb, width: off.width, height: off.height, name: img.src };
  fitCanvas(off.width, off.height);
  ctx.putImageData(data, 0, 0);
  setStatus(`Loaded ${off.width}×${off.height} — generate mosaic`);
}

async function run() {
  if (state.running) return;
  if (!state.source) {
    await loadImageFile("/mosaic/coffee.png");
  }
  state.running = true;
  setStatus("Working…");
  try {
    const result = await generateMosaic(
      state.source.rgb,
      state.source.width,
      state.source.height,
      {
        halfTile: state.halfTile,
        gauss: state.gauss,
        edgeDetection: state.edgeDetection,
        withFrame: state.withFrame,
        randSize: state.randSize,
        maxAngle: state.maxAngle,
        gapChainSpacing: state.gapChainSpacing,
        makeConvex: state.makeConvex,
        colorSchema: state.colorSchema,
        width: state.width,
        seed: state.seed,
      },
      async (msg) => {
        setStatus(msg);
        await new Promise((r) => setTimeout(r, 0));
      }
    );
    state.result = result;
    paint();
    setStatus(result.log[result.log.length - 1]);
    console.log(result.log.join("\n"));
  } catch (err) {
    console.error(err);
    setStatus(err.message || String(err));
  } finally {
    state.running = false;
  }
}

function downloadPng() {
  if (!state.result) return;
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = "mosaic.png";
  a.click();
}

function downloadSvg() {
  if (!state.result) return;
  const colors =
    state.view === "final" ? state.result.colors : state.result.recolored;
  const svg = tilesToSvg(
    state.result.polygons,
    colors || state.result.recolored,
    state.result.height,
    state.result.width
  );
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mosaic.svg";
  a.click();
}

const gui = new GUI({ title: "Mosaic" });
gui.add(state, "width", 320, 1200, 10).name("image width");
gui.add(state, "halfTile", 4, 30, 1).name("half tile");
gui.add(state, "gauss", 0, 8, 1).name("gauss");
gui.add(state, "edgeDetection", { "HED (approx)": "HED", DiBlasi: "DiBlasi" }).name("edges");
gui.add(state, "withFrame").name("frame");
gui.add(state, "randSize", 0, 0.8, 0.05).name("rand size");
gui.add(state, "maxAngle", 30, 75, 1).name("max angle");
gui.add(state, "gapChainSpacing", 0.4, 1, 0.05).name("gap spacing");
gui.add(state, "makeConvex").name("make convex");
gui.add(state, "seed", 0, 9999, 1).name("seed");
gui
  .add(state, "colorSchema", Object.keys(COLOR_COLLECTIONS))
  .name("palette")
  .onChange(recolorCurrent);
gui
  .add(state, "view", [
    "original",
    "edges",
    "distances",
    "guidelines",
    "tiles",
    "final",
    "final_recolored",
  ])
  .name("view")
  .onChange(paint);

const actions = {
  generate: () => run(),
  upload: () => fileInput.click(),
  coffee: () => loadImageFile("/mosaic/coffee.png"),
  png: downloadPng,
  svg: downloadSvg,
};
gui.add(actions, "generate").name("Generate");
gui.add(actions, "upload").name("Upload image");
gui.add(actions, "coffee").name("Coffee test image");
gui.add(actions, "png").name("Download PNG");
gui.add(actions, "svg").name("Download SVG");

fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0];
  if (file) await loadImageFile(file);
});

loadImageFile("/mosaic/coffee.png").catch((err) => setStatus(err.message));
