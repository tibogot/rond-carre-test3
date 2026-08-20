import {
  rgb2gray,
  gaussian,
  equalizeHist,
  meanStd,
  laplace3,
  skeletonize,
  sobelMagnitude,
  resizeRgb,
} from "./image.js";

export function loadImage(rgb, width0, height0, width = 900) {
  let img = rgb;
  let w = width0;
  let h = height0;
  if (width != null && w !== width) {
    const factor = width / w;
    const nh = Math.max(1, Math.trunc(h * factor));
    img = resizeRgb(rgb, w, h, width, nh);
    w = width;
    h = nh;
  }
  return { rgb: img, width: w, height: h };
}

/** Di Blasi 2005 brightness-blob edges — exact port of edges_diblasi. */
export function edgesDiblasi(rgb, w, h, gauss = 5, details = 4) {
  const n = w * h;
  const imgGray = rgb2gray(rgb, n);
  const imgEq = equalizeHist(imgGray, n);
  const imgGauss = gaussian(imgEq, w, h, 16, gauss / 16, 1);
  const { mean, variance } = meanStd(imgGauss, n);
  const threshold = (variance / 4) * 2 * details;
  const imgSeg = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    imgSeg[i] = Math.abs(imgGauss[i] - mean) > threshold ? 0 : 1;
  }
  const imgEdge = laplace3(imgSeg, w, h);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) if (imgEdge[i] !== 0) out[i] = 1;
  return out;
}

/**
 * HED stand-in: same pre-blur / 0.5 threshold / skeletonize as edges_hed.
 * The Caffe HED net cannot run in the browser; multi-scale fused Sobel
 * is used as the probability map (object outlines, then skeleton).
 */
export function edgesHed(rgb, w, h, gauss = 3) {
  const n = w * h;
  let img = new Float64Array(n * 3);
  for (let i = 0; i < n * 3; i++) img[i] = rgb[i] / 255;
  if (gauss) img = gaussian(img, w, h, 16, gauss / 16, 3);

  let amax = 0;
  for (let i = 0; i < img.length; i++) if (img[i] > amax) amax = img[i];
  const scale = amax > 0 ? 255 / amax : 1;
  const u8 = new Uint8ClampedArray(n * 3);
  for (let i = 0; i < img.length; i++) u8[i] = img[i] * scale;

  const gray = rgb2gray(u8, n);
  const s1 = sobelMagnitude(gray, w, h);
  const g2 = gaussian(gray, w, h, 2, 4, 1);
  const s2 = sobelMagnitude(g2, w, h);
  const g4 = gaussian(gray, w, h, 4, 4, 1);
  const s4 = sobelMagnitude(g4, w, h);

  const fused = new Float64Array(n);
  let fmax = 0;
  for (let i = 0; i < n; i++) {
    fused[i] = 0.5 * s1[i] + 0.3 * s2[i] + 0.2 * s4[i];
    if (fused[i] > fmax) fmax = fused[i];
  }
  const hed = new Uint8Array(n);
  const cut = 0.5 * fmax;
  for (let i = 0; i < n; i++) if (fused[i] >= cut) hed[i] = 1;
  return skeletonize(hed, w, h);
}

export function applyFrame(edges, w, h) {
  for (let c = 0; c < w; c++) {
    edges[c] = 1;
    edges[(h - 1) * w + c] = 1;
  }
  for (let r = 0; r < h; r++) {
    edges[r * w] = 1;
    edges[r * w + (w - 1)] = 1;
  }
  return edges;
}
