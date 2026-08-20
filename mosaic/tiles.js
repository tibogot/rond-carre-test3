import { pyRandom } from "./pyRandom.js";
import {
  lineString,
  multiPoint,
  polygon,
  geomType,
  areaOf,
  isValid,
  largestPolygon,
  stripHoles,
  differenceSafe,
  rotateDeg,
  scaleAboutCentroid,
  buffered,
  simplify,
  intersects,
  disjoint,
  parts,
  exteriorXY,
} from "./geom.js";
import { chainAsLine } from "./guides.js";

function fitInPolygon(p, nearbyPolygons) {
  for (const pThere of nearbyPolygons) p = differenceSafe(p, pThere);
  if (geomType(p) === "MultiPolygon") p = largestPolygon(p);
  const t = geomType(p);
  if (t !== "MultiLineString" && t !== "LineString" && t !== "GeometryCollection") {
    if (p && p.getNumInteriorRing && p.getNumInteriorRing() > 0) p = stripHoles(p);
  }
  return p;
}

export async function placeTilesAlongChains(
  chains,
  angles,
  w,
  halfTile,
  randSize,
  maxAngle,
  A0,
  onProgress
) {
  const randExtra = Math.round(halfTile * randSize);
  const polygons = [];
  const deltaI = halfTile * 2;

  for (let ik = 0; ik < chains.length; ik++) {
    const chain = chains[ik];
    if (chain.length < 2) continue;
    const searchArea = chainAsLine(chain, halfTile);
    const preselected = polygons.filter((poly) => intersects(poly, searchArea));

    let iStart = 0;
    let randI = pyRandom.randint(-randExtra, randExtra);
    let winkelStart = 0;
    let lineStart = null;

    for (let i = 0; i < chain.length; i++) {
      const [y, x] = chain[i];
      const winkel = angles[y * w + x];

      if (i === 0) {
        iStart = i;
        randI = pyRandom.randint(-randExtra, randExtra);
        winkelStart = winkel;
        lineStart = rotateDeg(
          lineString([
            [x, y - halfTile],
            [x, y + halfTile],
          ]),
          -winkelStart
        );
      }

      let drawPolygon = false;
      if (i === chain.length - 1) {
        drawPolygon = true;
      } else {
        const [yNext, xNext] = chain[i + 1];
        const winkelNext = angles[yNext * w + xNext];
        let winkeldelta = winkelNext - winkelStart;
        winkeldelta = Math.min(180 - Math.abs(winkeldelta), Math.abs(winkeldelta));
        if (winkeldelta > maxAngle) drawPolygon = true;
        if (i - iStart === deltaI + randI) drawPolygon = true;
      }

      if (drawPolygon) {
        const line = rotateDeg(
          lineString([
            [x, y - halfTile],
            [x, y + halfTile],
          ]),
          -winkel
        );

        const c0 = lineStart.getCoordinateN(0);
        const c1 = lineStart.getCoordinateN(1);
        const c2 = line.getCoordinateN(0);
        const c3 = line.getCoordinateN(1);
        let p = multiPoint([
          [c0.x, c0.y],
          [c1.x, c1.y],
          [c2.x, c2.y],
          [c3.x, c3.y],
        ]).convexHull();

        lineStart = line;
        winkelStart = winkel;

        if (i - iStart <= 2) {
          iStart = i;
          continue;
        }
        iStart = i;
        randI = pyRandom.randint(-randExtra, randExtra);

        const nearby = preselected.filter((poly) => !disjoint(p, poly));
        p = fitInPolygon(p, nearby);

        if (areaOf(p) >= 0.08 * A0 && geomType(p) === "Polygon" && isValid(p)) {
          polygons.push(p);
          preselected.push(p);
        }
      }
    }

    if (onProgress && ik % 4 === 0) {
      await onProgress(`Placing tiles along guidelines… ${polygons.length}`, ik / chains.length);
    }
  }
  return polygons;
}

export async function placeTilesIntoGaps(polygons, fillerChains, halfTile, A0, onProgress) {
  let counter = 0;
  for (let ic = 0; ic < fillerChains.length; ic++) {
    const chain = fillerChains[ic];
    if (!chain.length) continue;
    const chainAsSearch = chainAsLine(chain, halfTile);
    const preselected = polygons.filter((poly) => intersects(poly, chainAsSearch));

    const indexList = [];
    for (let i = 0; i < chain.length; i += halfTile * 2) indexList.push(i);
    const lastI = chain.length - 1;
    const minDelta = 3;
    if (indexList[indexList.length - 1] !== lastI && lastI - indexList[indexList.length - 1] >= minDelta) {
      indexList.push(lastI);
    }

    for (const i of indexList) {
      const [y, x] = chain[i];
      let p = polygon([
        [x - halfTile, y + halfTile],
        [x + halfTile, y + halfTile],
        [x + halfTile, y - halfTile],
        [x - halfTile, y - halfTile],
      ]);
      const pBuff = buffered(p, 0.1);
      const nearby = preselected.filter((poly) => intersects(pBuff, poly));
      for (const pVorhanden of nearby) {
        p = differenceSafe(p, pVorhanden);
      }
      if (geomType(p) === "MultiPolygon") p = largestPolygon(p);
      if (areaOf(p) >= 0.05 * A0 && geomType(p) === "Polygon") {
        polygons.push(p);
        preselected.push(p);
        counter++;
      }
    }
    if (onProgress && ic % 8 === 0) {
      await onProgress(`Filling gaps… +${counter}`, ic / fillerChains.length);
    }
  }
  return { polygons, added: counter };
}

export function cutTilesOutsideFrame(polygons, halfTile, imgH, imgW) {
  const A0 = (2 * halfTile) ** 2;
  const w = imgH;
  const h = imgW;
  const outer = polygon(
    [
      [-3 * halfTile, -3 * halfTile],
      [h + 3 * halfTile, -3 * halfTile],
      [h + 3 * halfTile, w + 3 * halfTile],
      [-3 * halfTile, w + 3 * halfTile],
    ],
    [
      [
        [1, 1],
        [h - 1, 1],
        [h - 1, w - 1],
        [1, w - 1],
      ],
    ]
  );

  const polygonsCut = [];
  let counter = 0;
  for (let p of polygons) {
    const pt = p.getInteriorPoint().getCoordinate();
    const y = pt.x;
    const x = pt.y;
    if (y < 4 * halfTile || y > h - 4 * halfTile || x < 4 * halfTile || x > w - 4 * halfTile) {
      p = differenceSafe(p, outer);
      counter++;
    }
    if (areaOf(p) >= 0.05 * A0 && geomType(p) === "Polygon") polygonsCut.push(p);
  }
  return { polygons: polygonsCut, cut: counter };
}

export function irregularShrink(polygons, halfTile) {
  const out = [];
  for (const p of polygons) {
    let q = scaleAboutCentroid(
      p,
      pyRandom.uniform(0.85, 1),
      pyRandom.uniform(0.85, 1)
    );
    q = buffered(q, -0.03 * halfTile);
    out.push(q);
  }
  return out;
}

export function repairTiles(polygons) {
  const polygonsNew = [];
  for (const p of polygons) {
    if (geomType(p) === "MultiPolygon") {
      for (const pp of parts(p)) polygonsNew.push(pp);
    } else {
      polygonsNew.push(p);
    }
  }
  const polygonsNew2 = [];
  for (const p of polygonsNew) {
    if (
      p &&
      p.getExteriorRing &&
      geomType(p.getExteriorRing()) === "LinearRing"
    ) {
      polygonsNew2.push(p);
    }
  }
  return polygonsNew2;
}

export function reduceEdgeCount(polygons, halfTile, tol = 20) {
  return polygons.map((p) => simplify(p, halfTile / tol));
}

export function dropSmallTiles(polygons, A0, threshold = 0.03) {
  const out = [];
  let counter = 0;
  for (const p of polygons) {
    if (areaOf(p) > threshold * A0) out.push(p);
    else counter++;
  }
  return { polygons: out, dropped: counter };
}

export { exteriorXY };
