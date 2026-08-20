import {
  geomType,
  areaOf,
  isValid,
  polygon,
  lineString,
  point,
  buffered,
  differenceSafe,
  rotateDeg,
  convexHull,
  contains,
  exteriorCoords,
} from "./geom.js";

function mySimplify(p, acceptedLoss = 0.05) {
  while (true) {
    const ecken = exteriorCoords(p).slice(0, -1);
    const A0 = areaOf(polygon(ecken));
    let erfolg = false;
    for (let i = 0; i < ecken.length; i++) {
      const eckenNeu = ecken.slice(0, i).concat(ecken.slice(i + 1));
      if (ecken.length <= 3) break;
      const pNeu = polygon(eckenNeu);
      if (
        areaOf(pNeu) <= A0 &&
        A0 - areaOf(pNeu) < acceptedLoss * A0 &&
        areaOf(pNeu) > 0.05 * A0 &&
        isValid(pNeu)
      ) {
        p = pNeu;
        erfolg = true;
        break;
      }
    }
    if (ecken.length < 3) erfolg = false;
    if (geomType(p) !== "Polygon") erfolg = false;
    if (!erfolg) break;
  }
  return p;
}

function isConvex(p) {
  return areaOf(convexHull(p)) <= 1.01 * areaOf(p);
}

function simpleConcaveToConvex(p, halfTile, A0, richtung = -1) {
  const concaveList = [p];
  const convexList = [];
  let success = true;
  let counter = 0;

  while (concaveList.length > 0) {
    counter++;
    p = concaveList.pop();
    const coords = exteriorCoords(p);
    const hull = convexHull(p);
    const concavePoints = [];
    for (let i = 0; i < coords.length; i++) {
      const [xa, ya] = coords[i];
      if (contains(hull, point(xa, ya))) concavePoints.push(i);
    }
    if (concavePoints.length === 0) return { success: false, convexList: [] };

    const iKrit = concavePoints[0];
    let iOther = iKrit + richtung;
    if (iOther < 0) iOther = coords.length + iOther;
    if (iOther >= coords.length) iOther = iOther % coords.length;
    const [xa, ya] = coords[iKrit];
    const [xb, yb] = coords[iOther];
    const angleOfCutLine = (Math.atan2(xa - xb, ya - yb) * 180) / Math.PI;
    let cutLine = lineString([
      [xa, ya - halfTile * 4],
      [xa, yb + halfTile * 4],
    ]);
    cutLine = rotateDeg(cutLine, -angleOfCutLine, [xa, ya]);

    let pp;
    try {
      pp = differenceSafe(p, buffered(cutLine, 0.2));
    } catch {
      success = false;
      break;
    }
    if (geomType(pp) !== "MultiPolygon") {
      success = false;
      break;
    }
    if (counter > 5) {
      success = false;
      break;
    }
    for (let i = 0; i < pp.getNumGeometries(); i++) {
      const ppi = pp.getGeometryN(i);
      if (!isValid(ppi) || areaOf(ppi) < 0.05 * A0) continue;
      convexList.push(ppi);
    }
  }
  return { success, convexList };
}

export function makeConvex(polygons, halfTile, A0) {
  const stillConcave = [];
  const polygonsConvex = [];
  let already = 0;

  for (let p of polygons) {
    if (isConvex(p)) {
      polygonsConvex.push(p);
      already++;
      continue;
    }
    p = mySimplify(p);
    if (isConvex(p)) {
      polygonsConvex.push(p);
      continue;
    }
    let { success, convexList } = simpleConcaveToConvex(p, halfTile, A0, -1);
    if (!success) {
      ({ success, convexList } = simpleConcaveToConvex(
        buffered(p, 0.1),
        halfTile,
        A0,
        1
      ));
    }
    if (!success) {
      ({ success, convexList } = simpleConcaveToConvex(
        buffered(p, 0.5),
        halfTile,
        A0,
        1
      ));
    }
    if (!success) {
      ({ success, convexList } = simpleConcaveToConvex(
        buffered(p, 0.5),
        halfTile,
        A0,
        -1
      ));
    }
    if (success) {
      for (const kp of convexList) polygonsConvex.push(kp);
    } else {
      let acceptedLoss = 0.05;
      while (!isConvex(p) && acceptedLoss < 0.8) {
        acceptedLoss += 0.05;
        p = mySimplify(p, acceptedLoss);
      }
      if (isConvex(p)) polygonsConvex.push(p);
      else stillConcave.push(p);
    }
  }

  return { polygons: polygonsConvex, stillConcave, converted: polygons.length - already };
}
