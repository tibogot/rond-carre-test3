import "jsts/org/locationtech/jts/monkey.js";
import GeometryFactory from "jsts/org/locationtech/jts/geom/GeometryFactory.js";
import Coordinate from "jsts/org/locationtech/jts/geom/Coordinate.js";
import AffineTransformation from "jsts/org/locationtech/jts/geom/util/AffineTransformation.js";
import DouglasPeuckerSimplifier from "jsts/org/locationtech/jts/simplify/DouglasPeuckerSimplifier.js";

export const gf = new GeometryFactory();

export function coord(x, y) {
  return new Coordinate(x, y);
}

export function lineString(points) {
  return gf.createLineString(points.map(([x, y]) => new Coordinate(x, y)));
}

export function polygon(shell, holes = []) {
  const ring = linearRing(shell);
  const holeRings = holes.length ? holes.map(linearRing) : null;
  try {
    return gf.createPolygon(ring, holeRings);
  } catch {
    return gf.createPolygon(ring);
  }
}

export function linearRing(points) {
  const pts = points.map(([x, y]) => new Coordinate(x, y));
  if (
    pts.length === 0 ||
    pts[0].x !== pts[pts.length - 1].x ||
    pts[0].y !== pts[pts.length - 1].y
  ) {
    pts.push(new Coordinate(pts[0].x, pts[0].y));
  }
  return gf.createLinearRing(pts);
}

export function multiPoint(points) {
  const pts = points.map(([x, y]) => gf.createPoint(new Coordinate(x, y)));
  return gf.createMultiPoint(pts);
}

export function geomType(g) {
  return g ? g.getGeometryType() : "Empty";
}

export function isEmpty(g) {
  return !g || g.isEmpty();
}

export function areaOf(g) {
  return isEmpty(g) ? 0 : g.getArea();
}

export function isValid(g) {
  try {
    return !isEmpty(g) && g.isValid();
  } catch {
    return false;
  }
}

export function parts(g) {
  if (isEmpty(g)) return [];
  const t = geomType(g);
  if (t === "MultiPolygon" || t === "GeometryCollection") {
    const out = [];
    for (let i = 0; i < g.getNumGeometries(); i++) out.push(g.getGeometryN(i));
    return out;
  }
  return [g];
}

export function largestPolygon(g) {
  if (isEmpty(g)) return g;
  if (geomType(g) === "Polygon") return g;
  let best = null;
  let bestA = -1;
  for (const p of parts(g)) {
    if (geomType(p) === "Polygon") {
      const a = p.getArea();
      if (a > bestA) {
        best = p;
        bestA = a;
      }
    }
  }
  return best;
}

export function stripHoles(p) {
  if (isEmpty(p) || geomType(p) !== "Polygon") return p;
  if (p.getNumInteriorRing() > 0) return gf.createPolygon(p.getExteriorRing());
  return p;
}

export function exteriorXY(p) {
  if (isEmpty(p) || !p.getExteriorRing) return { x: [], y: [] };
  const cs = p.getExteriorRing().getCoordinates();
  const x = [];
  const y = [];
  for (const c of cs) {
    x.push(c.x);
    y.push(c.y);
  }
  return { x, y };
}

export function exteriorCoords(p) {
  if (isEmpty(p) || !p.getExteriorRing) return [];
  return p.getExteriorRing().getCoordinates().map((c) => [c.x, c.y]);
}

export function centroidXY(g) {
  const c = g.getCentroid().getCoordinate();
  return [c.x, c.y];
}

export function interiorPointXY(g) {
  const c = g.getInteriorPoint().getCoordinate();
  return [c.x, c.y];
}

export function rotateDeg(g, angleDeg, origin) {
  let ox;
  let oy;
  if (!origin || origin === "centroid") {
    [ox, oy] = centroidXY(g);
  } else {
    ox = origin[0];
    oy = origin[1];
  }
  const theta = (angleDeg * Math.PI) / 180;
  return AffineTransformation.rotationInstance(theta, ox, oy).transform(g);
}

export function scaleAboutCentroid(g, xfact, yfact) {
  const [ox, oy] = centroidXY(g);
  return AffineTransformation.scaleInstance(xfact, yfact, ox, oy).transform(g);
}

export function buffered(g, dist) {
  try {
    return g.buffer(dist);
  } catch {
    return g;
  }
}

export function differenceSafe(a, b) {
  try {
    return a.difference(b);
  } catch {
    try {
      return a.difference(b.buffer(0.1));
    } catch {
      try {
        return a.buffer(0).difference(b.buffer(0));
      } catch {
        return a;
      }
    }
  }
}

export function convexHull(g) {
  return g.convexHull();
}

export function simplify(g, tolerance) {
  return DouglasPeuckerSimplifier.simplify(g, tolerance);
}

export function intersects(a, b) {
  try {
    return a.intersects(b);
  } catch {
    return false;
  }
}

export function disjoint(a, b) {
  try {
    return a.disjoint(b);
  } catch {
    return true;
  }
}

export function contains(a, b) {
  try {
    return a.contains(b);
  } catch {
    return false;
  }
}

export function point(x, y) {
  return gf.createPoint(new Coordinate(x, y));
}
