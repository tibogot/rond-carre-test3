import { pyRandom } from "./pyRandom.js";
import { loadImage, edgesHed, edgesDiblasi, applyFrame } from "./edges.js";
import { chainsAndAngles, chainsIntoGaps } from "./guides.js";
import {
  placeTilesAlongChains,
  placeTilesIntoGaps,
  cutTilesOutsideFrame,
  irregularShrink,
  repairTiles,
  reduceEdgeCount,
  dropSmallTiles,
} from "./tiles.js";
import { makeConvex } from "./convex.js";
import { colorsFromOriginal, modifyColors, COLOR_COLLECTIONS } from "./coloring.js";
import { rgbToImageData } from "./image.js";
import { exteriorXY } from "./geom.js";

export const DEFAULTS = {
  halfTile: 12,
  gauss: 3,
  edgeDetection: "HED",
  withFrame: true,
  randSize: 0.3,
  maxAngle: 40,
  gapChainSpacing: 0.5,
  makeConvex: true,
  colorSchema: "nilotic",
  width: 900,
  seed: 0,
};

export async function generateMosaic(sourceRgb, srcW, srcH, params = {}, onProgress) {
  const p = { ...DEFAULTS, ...params };
  const log = [];
  const say = async (msg, frac) => {
    log.push(msg);
    if (onProgress) await onProgress(msg, frac ?? 0);
    else await new Promise((r) => setTimeout(r, 0));
  };

  pyRandom.seed(p.seed);
  const t0 = performance.now();

  await say("Loading and resizing image…", 0.02);
  const { rgb, width: w, height: h } = loadImage(sourceRgb, srcW, srcH, p.width);
  const A0 = (2 * p.halfTile) ** 2;
  log.push(`Size of input image: ${h}px * ${w}px`);
  log.push(`Estimated number of tiles: ${Math.round((2 * w * h) / A0)}`);

  await say("Detecting edges…", 0.08);
  let imgEdges =
    p.edgeDetection === "DiBlasi"
      ? edgesDiblasi(rgb, w, h, p.gauss, 4)
      : edgesHed(rgb, w, h, p.gauss);
  if (p.withFrame) applyFrame(imgEdges, w, h);

  await say("Building guidelines and angles…", 0.18);
  const { chains, angles, distances, guidelines } = chainsAndAngles(
    imgEdges,
    w,
    h,
    p.halfTile
  );
  log.push(`Guideline chains: ${chains.length}`);

  await say("Placing tiles along guidelines…", 0.28);
  const polygonsChains = await placeTilesAlongChains(
    chains,
    angles,
    w,
    p.halfTile,
    p.randSize,
    p.maxAngle,
    A0,
    say
  );
  log.push(`Placed ${polygonsChains.length} tiles along guidelines`);

  await say("Finding gaps…", 0.55);
  const { chains2 } = chainsIntoGaps(polygonsChains, h, w, p.halfTile, p.gapChainSpacing);

  await say("Filling gaps…", 0.6);
  const gap = await placeTilesIntoGaps(polygonsChains, chains2, p.halfTile, A0, say);
  let polygonsAll = gap.polygons;
  log.push(`Added ${gap.added} tiles into gaps`);

  await say("Cutting tiles outside the frame…", 0.78);
  const cut = cutTilesOutsideFrame(polygonsAll, p.halfTile, h, w);
  polygonsAll = cut.polygons;
  log.push(`Up to ${cut.cut} tiles beyond image borders were cut`);

  await say("Making tiles convex…", 0.84);
  let polygonsConvex = polygonsAll;
  if (p.makeConvex) {
    const cv = makeConvex(polygonsAll, p.halfTile, A0);
    polygonsConvex = cv.polygons;
    if (cv.stillConcave.length) {
      log.push(`! ${cv.stillConcave.length} tiles are still concave`);
    }
    log.push(`${cv.converted} tiles converted to convex`);
  }

  await say("Post-processing tiles…", 0.9);
  let polygonsPost = irregularShrink(polygonsConvex, p.halfTile);
  polygonsPost = repairTiles(polygonsPost);
  polygonsPost = reduceEdgeCount(polygonsPost, p.halfTile);
  const dropped = dropSmallTiles(polygonsPost, A0);
  polygonsPost = dropped.polygons;
  log.push(`Dropped ${dropped.dropped} small tiles`);

  await say("Coloring tiles…", 0.95);
  const colors = colorsFromOriginal(polygonsPost, rgb, w, h, "average");
  const schema = COLOR_COLLECTIONS[p.colorSchema] || COLOR_COLLECTIONS.nilotic;
  const recolored = modifyColors(colors, "source", schema);

  const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
  log.push(`Total calculation time: ${elapsed}s`);
  log.push(`Final number of tiles: ${polygonsPost.length}`);
  await say(`Done — ${polygonsPost.length} tiles in ${elapsed}s`, 1);

  return {
    width: w,
    height: h,
    rgb,
    edges: imgEdges,
    distances,
    guidelines,
    polygons: polygonsPost,
    colors,
    recolored,
    log,
    elapsed,
    stages: {
      original: rgbToImageData(rgb, w, h),
      edges: rgbToImageData(null, w, h, invertForView(imgEdges)),
      distances: rgbToImageData(null, w, h, distances),
      guidelines: rgbToImageData(null, w, h, invertForView(guidelines)),
    },
  };
}

function invertForView(arr) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] ? 0 : 1;
  return out;
}

export function drawTiles(ctx, polygons, colors, h, w, background = 0.2) {
  ctx.save();
  ctx.fillStyle = `rgb(${background * 255}, ${background * 255}, ${background * 255})`;
  ctx.fillRect(0, 0, w, h);
  for (let j = 0; j < polygons.length; j++) {
    const { x, y } = exteriorXY(polygons[j]);
    if (x.length < 2) continue;
    ctx.beginPath();
    ctx.moveTo(x[0], y[0]);
    for (let i = 1; i < x.length; i++) ctx.lineTo(x[i], y[i]);
    ctx.closePath();
    if (colors) {
      const c = colors[j];
      ctx.fillStyle = `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`;
      ctx.fill();
    } else {
      ctx.fillStyle = "silver";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 0.3;
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

export function tilesToSvg(polygons, colors, h, w, background = 0.2) {
  const bg = Math.round(background * 255);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n`;
  svg += `<rect width="100%" height="100%" fill="rgb(${bg},${bg},${bg})"/>\n`;
  for (let j = 0; j < polygons.length; j++) {
    const { x, y } = exteriorXY(polygons[j]);
    const pts = x.map((xi, i) => `${xi.toFixed(1)},${y[i].toFixed(1)}`).join(" ");
    const c = colors[j];
    const fill = `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    svg += `<polygon points="${pts}" fill="${fill}"/>\n`;
  }
  svg += "</svg>";
  return svg;
}

export { COLOR_COLLECTIONS };
