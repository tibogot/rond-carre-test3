import { distanceTransformEdt, skeletonize, label } from "./image.js";
import {
  lineString,
  buffered,
  exteriorXY,
} from "./geom.js";

function pixellinesToOrderedPoints(matrix, w, h, halfTile) {
  const skel = skeletonize(matrix, w, h);
  const { labels, count: chainCount } = label(skel, w, h);
  const chains = [];
  const neigh = [
    [1, 0],
    [-1, 0],
    [1, -1],
    [-1, 1],
    [0, -1],
    [0, 1],
    [-1, -1],
    [1, 1],
  ];

  // Python: range(1, chain_count) skips the last label — keep that.
  for (let iChain = 1; iChain < chainCount; iChain++) {
    const pixel = new Uint8Array(w * h);
    for (let i = 0; i < labels.length; i++) {
      if (labels[i] === iChain) pixel[i] = 1;
    }

    while (true) {
      let found = -1;
      for (let i = 0; i < pixel.length; i++) {
        if (pixel[i]) {
          found = i;
          break;
        }
      }
      if (found < 0) break;
      let x = Math.floor(found / w);
      let y = found % w;
      let done = false;
      const subchain = [];
      while (!done) {
        subchain.push([x, y]);
        pixel[x * w + y] = 0;
        done = true;
        for (const [dx, dy] of neigh) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < h && ny >= 0 && ny < w && pixel[nx * w + ny] > 0) {
            x = nx;
            y = ny;
            done = false;
            break;
          }
        }
      }
      if (subchain.length > Math.floor(halfTile / 2)) chains.push(subchain);
    }
  }
  return chains;
}

export function chainsAndAngles(imgEdges, w, h, halfTile) {
  const n = w * h;
  const notEdge = new Uint8Array(n);
  for (let i = 0; i < n; i++) notEdge[i] = imgEdges[i] === 0 ? 1 : 0;
  const distances = distanceTransformEdt(notEdge, w, h);

  const guidelines = new Uint8Array(n);
  const span = 2 * halfTile;
  for (let i = 0; i < n; i++) {
    if ((Math.trunc(distances[i]) + halfTile) % span === 0) guidelines[i] = 1;
  }

  const chains = pixellinesToOrderedPoints(guidelines, w, h, halfTile);

  const gradient = new Float64Array(n);
  const angles = new Float64Array(n);
  for (let x = 1; x < h - 1; x++) {
    for (let y = 1; y < w - 1; y++) {
      const i = x * w + y;
      const numerator = distances[i + 1] - distances[i - 1];
      const denominator = distances[(x + 1) * w + y] - distances[(x - 1) * w + y];
      gradient[i] = Math.atan2(numerator, denominator);
      angles[i] = (((gradient[i] * 180) / Math.PI + 180) % 180);
    }
  }

  return { chains, angles, distances, guidelines, gradient };
}

export function chainsIntoGaps(polygons, h, w, halfTile, chainSpacingParam) {
  const occupied = new Uint8Array(h * w);
  for (const p of polygons) {
    const { x, y } = exteriorXY(p);
    fillPolygon(occupied, y, x, h, w);
  }
  const notOcc = new Uint8Array(h * w);
  for (let i = 0; i < occupied.length; i++) notOcc[i] = occupied[i] === 0 ? 1 : 0;
  const distanceToTile = distanceTransformEdt(notOcc, w, h);

  let chainSpacing = Math.round(halfTile * chainSpacingParam);
  if (chainSpacing <= 1) chainSpacing = 2;

  const guidelines2 = new Uint8Array(h * w);
  for (let i = 0; i < distanceToTile.length; i++) {
    const d = Math.trunc(distanceToTile[i]);
    if (d === 1 || (d % chainSpacing === 0 && d > 0)) guidelines2[i] = 1;
  }

  const chains2 = pixellinesToOrderedPoints(guidelines2, w, h, halfTile);
  return { chains2, occupied, distanceToTile, guidelines2 };
}

/** skimage.draw.polygon(r, c) — r=row, c=col. */
function fillPolygon(img, rows, cols, h, w) {
  if (rows.length < 3) return;
  const minR = Math.max(0, Math.floor(Math.min(...rows)));
  const maxR = Math.min(h - 1, Math.ceil(Math.max(...rows)));
  const n = rows.length;
  for (let y = minR; y <= maxR; y++) {
    const xs = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = rows[i];
      const yj = rows[j];
      if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
        const x = cols[i] + ((y - yi) / (yj - yi || 1e-12)) * (cols[j] - cols[i]);
        xs.push(x);
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const x0 = Math.max(0, Math.ceil(xs[k]));
      const x1 = Math.min(w - 1, Math.floor(xs[k + 1]));
      for (let x = x0; x <= x1; x++) img[y * w + x] = 1;
    }
  }
}

export function chainAsLine(chain, halfTile) {
  const pts = chain.map(([row, col]) => [col, row]);
  return buffered(lineString(pts), 2.1 * halfTile);
}
