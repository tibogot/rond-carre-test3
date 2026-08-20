import { exteriorXY, interiorPointXY } from "./geom.js";
import { COLOR_COLLECTIONS } from "./palettes.js";

export function colorsFromOriginal(polygons, rgb, w, h, method = "average") {
  const colors = [];
  for (const p of polygons) {
    let color;
    if (method === "point") {
      const [x, y] = interiorPointXY(p);
      color = sample(rgb, w, h, Math.trunc(x), Math.trunc(y));
    } else {
      const { x: xx, y: yy } = exteriorXY(p);
      const minX = Math.max(0, Math.floor(Math.min(...xx)));
      const maxX = Math.min(w - 1, Math.ceil(Math.max(...xx)));
      const minY = Math.max(0, Math.floor(Math.min(...yy)));
      const maxY = Math.min(h - 1, Math.ceil(Math.max(...yy)));
      if (maxX > minX && maxY > minY) {
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let row = minY; row <= maxY; row++) {
          for (let col = minX; col <= maxX; col++) {
            const o = (row * w + col) * 3;
            r += rgb[o];
            g += rgb[o + 1];
            b += rgb[o + 2];
            n++;
          }
        }
        color = n ? [r / n / 255, g / n / 255, b / n / 255] : [0, 0, 0];
      } else {
        color = sample(rgb, w, h, Math.trunc(xx[0]), Math.trunc(yy[0]));
      }
    }
    colors.push(color);
  }
  return colors;
}

function sample(rgb, w, h, x, y) {
  const row = Math.min(h - 1, Math.max(0, y));
  const col = Math.min(w - 1, Math.max(0, x));
  const o = (row * w + col) * 3;
  return [rgb[o] / 255, rgb[o + 1] / 255, rgb[o + 2] / 255];
}

function nearestColor(subjects, query) {
  let best = subjects[0];
  let bestD = Infinity;
  for (const subject of subjects) {
    let d = 0;
    for (let i = 0; i < 3; i++) {
      const t = subject[i] - query[i];
      d += t * t;
    }
    if (d < bestD) {
      bestD = d;
      best = subject;
    }
  }
  return best;
}

export function modifyColors(colors, variant, collection = []) {
  const newColors = [];
  const source =
    collection && collection.length
      ? collection.map((c) => [c[0] / 255, c[1] / 255, c[2] / 255])
      : [];
  for (const c of colors) {
    let cNew;
    if (variant === "monochrome") {
      cNew = nearestColor(
        [
          [1, 1, 1],
          [0, 0, 0],
        ],
        c
      );
    } else if (variant === "grayscale") {
      const g = 0.2989 * c[0] + 0.587 * c[1] + 0.114 * c[2];
      cNew = [g, g, g];
    } else if (variant === "polychrome") {
      const n = 9;
      const someGray = [];
      for (let g = 0; g <= n; g++) someGray.push([g / n, g / n, g / n]);
      cNew = nearestColor(someGray, c);
    } else if (variant === "source") {
      cNew = nearestColor(source, c);
    } else {
      cNew = c;
    }
    newColors.push(cNew);
  }
  return newColors;
}

export { COLOR_COLLECTIONS };
