/** Image ops matching skimage / scipy used by yobeatz/mosaic. */

export function idx(row, col, w) {
  return row * w + col;
}

export function rgb2gray(rgb, n) {
  const gray = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const r = rgb[o] / 255;
    const g = rgb[o + 1] / 255;
    const b = rgb[o + 2] / 255;
    gray[i] = 0.2125 * r + 0.7154 * g + 0.0721 * b;
  }
  return gray;
}

export function gaussian1d(sigma, truncate) {
  const radius = Math.max(1, Math.floor(truncate * sigma + 0.5));
  const size = radius * 2 + 1;
  const kernel = new Float64Array(size);
  const s2 = 2 * sigma * sigma;
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-(i * i) / s2);
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  return { kernel, radius };
}

export function gaussian(src, w, h, sigma, truncate, channels = 1) {
  const { kernel, radius } = gaussian1d(sigma, truncate);
  const tmp = new Float64Array(src.length);
  const dst = new Float64Array(src.length);

  const blurPass = (inp, out, horiz) => {
    for (let c = 0; c < channels; c++) {
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          let acc = 0;
          for (let k = -radius; k <= radius; k++) {
            let rr = row;
            let cc = col;
            if (horiz) cc = Math.min(w - 1, Math.max(0, col + k));
            else rr = Math.min(h - 1, Math.max(0, row + k));
            const srcI = channels === 1 ? rr * w + cc : (rr * w + cc) * channels + c;
            acc += inp[srcI] * kernel[k + radius];
          }
          const dstI = channels === 1 ? row * w + col : (row * w + col) * channels + c;
          out[dstI] = acc;
        }
      }
    }
  };

  blurPass(src, tmp, true);
  blurPass(tmp, dst, false);
  return dst;
}

export function equalizeHist(gray, n, nbins = 256) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    if (gray[i] < min) min = gray[i];
    if (gray[i] > max) max = gray[i];
  }
  if (!(max > min)) return gray.slice();
  const hist = new Float64Array(nbins);
  const scale = (nbins - 1e-12) / (max - min);
  for (let i = 0; i < n; i++) {
    const b = Math.min(nbins - 1, Math.max(0, Math.floor((gray[i] - min) * scale)));
    hist[b]++;
  }
  const cdf = new Float64Array(nbins);
  cdf[0] = hist[0];
  for (let i = 1; i < nbins; i++) cdf[i] = cdf[i - 1] + hist[i];
  const cdfMax = cdf[nbins - 1] || 1;
  const binCenters = new Float64Array(nbins);
  for (let i = 0; i < nbins; i++) {
    binCenters[i] = min + ((i + 0.5) / nbins) * (max - min);
    cdf[i] /= cdfMax;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = interp(gray[i], binCenters, cdf);
  return out;
}

function interp(x, xp, fp) {
  if (x <= xp[0]) return fp[0];
  const last = xp.length - 1;
  if (x >= xp[last]) return fp[last];
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xp[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xp[lo]) / (xp[hi] - xp[lo] || 1);
  return fp[lo] + t * (fp[hi] - fp[lo]);
}

export function meanStd(arr, n) {
  let sum = 0;
  for (let i = 0; i < n; i++) sum += arr[i];
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) {
    const d = arr[i] - mean;
    varSum += d * d;
  }
  const variance = varSum / n;
  return { mean, variance, std: Math.sqrt(variance) };
}

export function laplace3(src, w, h) {
  const out = new Float64Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      out[i] = src[i - w] + src[i + w] + src[i - 1] + src[i + 1] - 4 * src[i];
    }
  }
  return out;
}

/** Felzenszwalb & Huttenlocher Euclidean distance transform. */
export function distanceTransformEdt(binary, w, h) {
  const n = w * h;
  const inf = 1e20;
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = binary[i] ? inf : 0;

  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const tmp = new Float64Array(n);

  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) d[c] = f[r * w + c];
    edt1d(d, w, v, z);
    for (let c = 0; c < w; c++) tmp[r * w + c] = d[c];
  }
  for (let c = 0; c < w; c++) {
    for (let r = 0; r < h; r++) d[r] = tmp[r * w + c];
    edt1d(d, h, v, z);
    for (let r = 0; r < h; r++) f[r * w + c] = Math.sqrt(d[r]);
  }
  return f;
}

function edt1d(f, n, v, z) {
  const inf = 1e20;
  let k = 0;
  v[0] = 0;
  z[0] = -inf;
  z[1] = inf;
  for (let q = 1; q < n; q++) {
    let s =
      (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = inf;
  }
  k = 0;
  const out = new Float64Array(n);
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const dx = q - v[k];
    out[q] = dx * dx + f[v[k]];
  }
  for (let q = 0; q < n; q++) f[q] = out[q];
}

/** Zhang-Suen thinning (skimage.morphology.skeletonize method='zhang'). */
export function skeletonize(binary, w, h) {
  const img = new Uint8Array(w * h);
  for (let i = 0; i < img.length; i++) img[i] = binary[i] ? 1 : 0;
  const neighbors = (r, c) => {
    const p2 = img[(r - 1) * w + c];
    const p3 = img[(r - 1) * w + (c + 1)];
    const p4 = img[r * w + (c + 1)];
    const p5 = img[(r + 1) * w + (c + 1)];
    const p6 = img[(r + 1) * w + c];
    const p7 = img[(r + 1) * w + (c - 1)];
    const p8 = img[r * w + (c - 1)];
    const p9 = img[(r - 1) * w + (c - 1)];
    return [p2, p3, p4, p5, p6, p7, p8, p9];
  };
  const transitions = (p) => {
    let n = 0;
    for (let i = 0; i < 8; i++) if (p[i] === 0 && p[(i + 1) % 8] === 1) n++;
    return n;
  };

  let changed = true;
  while (changed) {
    changed = false;
    for (const step of [0, 1]) {
      const toRemove = [];
      for (let r = 1; r < h - 1; r++) {
        for (let c = 1; c < w - 1; c++) {
          if (!img[r * w + c]) continue;
          const p = neighbors(r, c);
          const bp = p.reduce((a, b) => a + b, 0);
          if (bp < 2 || bp > 6) continue;
          if (transitions(p) !== 1) continue;
          if (step === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue;
            if (p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue;
            if (p[0] * p[4] * p[6] !== 0) continue;
          }
          toRemove.push(r * w + c);
        }
      }
      if (toRemove.length) {
        changed = true;
        for (const i of toRemove) img[i] = 0;
      }
    }
  }
  return img;
}

/** scipy.ndimage.label with 8-connectivity. Returns labels 1..count. */
export function label(binary, w, h) {
  const n = w * h;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[b] = a;
  };

  const neigh = [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, -1],
  ];
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      if (!binary[i]) continue;
      for (const [dr, dc] of neigh) {
        const rr = r + dr;
        const cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= h || cc >= w) continue;
        const j = rr * w + cc;
        if (binary[j]) union(i, j);
      }
    }
  }

  const labels = new Int32Array(n);
  const map = new Map();
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!binary[i]) continue;
    const root = find(i);
    let id = map.get(root);
    if (!id) {
      count++;
      id = count;
      map.set(root, id);
    }
    labels[i] = id;
  }
  return { labels, count };
}

export function sobelMagnitude(gray, w, h) {
  const mag = new Float64Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      const gx =
        -gray[i - w - 1] +
        gray[i - w + 1] -
        2 * gray[i - 1] +
        2 * gray[i + 1] -
        gray[i + w - 1] +
        gray[i + w + 1];
      const gy =
        -gray[i - w - 1] -
        2 * gray[i - w] -
        gray[i - w + 1] +
        gray[i + w - 1] +
        2 * gray[i + w] +
        gray[i + w + 1];
      mag[i] = Math.hypot(gx, gy);
    }
  }
  return mag;
}

export function resizeRgb(src, sw, sh, dw, dh) {
  const dst = new Float64Array(dw * dh * 3);
  const xRatio = sw / dw;
  const yRatio = sh / dh;
  for (let r = 0; r < dh; r++) {
    const sy = (r + 0.5) * yRatio - 0.5;
    const y0 = Math.min(sh - 1, Math.max(0, Math.floor(sy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const fy = sy - y0;
    for (let c = 0; c < dw; c++) {
      const sx = (c + 0.5) * xRatio - 0.5;
      const x0 = Math.min(sw - 1, Math.max(0, Math.floor(sx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const fx = sx - x0;
      const o = (r * dw + c) * 3;
      for (let k = 0; k < 3; k++) {
        const v00 = src[(y0 * sw + x0) * 3 + k];
        const v10 = src[(y0 * sw + x1) * 3 + k];
        const v01 = src[(y1 * sw + x0) * 3 + k];
        const v11 = src[(y1 * sw + x1) * 3 + k];
        dst[o + k] =
          v00 * (1 - fx) * (1 - fy) +
          v10 * fx * (1 - fy) +
          v01 * (1 - fx) * fy +
          v11 * fx * fy;
      }
    }
  }
  const out = new Uint8ClampedArray(dw * dh * 3);
  for (let i = 0; i < dst.length; i++) out[i] = Math.round(dst[i]);
  return out;
}

export function imageDataToRgb(imageData) {
  const { width, height, data } = imageData;
  const rgb = new Uint8ClampedArray(width * height * 3);
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i];
    rgb[j + 1] = data[i + 1];
    rgb[j + 2] = data[i + 2];
  }
  return { rgb, width, height };
}

export function rgbToImageData(rgb, w, h, gray = null) {
  if (typeof ImageData === "undefined") return null;
  const data = new Uint8ClampedArray(w * h * 4);
  if (gray) {
    let max = 0;
    for (let i = 0; i < gray.length; i++) if (gray[i] > max) max = gray[i];
    const s = max > 0 ? 255 / max : 1;
    for (let i = 0; i < w * h; i++) {
      const v = Math.max(0, Math.min(255, gray[i] * s));
      const o = i * 4;
      data[o] = data[o + 1] = data[o + 2] = v;
      data[o + 3] = 255;
    }
  } else {
    for (let i = 0, j = 0; i < w * h; i++, j += 3) {
      const o = i * 4;
      data[o] = rgb[j];
      data[o + 1] = rgb[j + 1];
      data[o + 2] = rgb[j + 2];
      data[o + 3] = 255;
    }
  }
  return new ImageData(data, w, h);
}

export function invert01(arr) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] ? 0 : 1;
  return out;
}
