// Ground truth about where things are.
//
//   A world you walk through wants metres, not degrees and not Mercator. So every community gets an
//   origin — a longitude and latitude somewhere on its own land — and everything inside the world is
//   expressed as metres east, metres north and metres up from that origin. Over a few hundred metres
//   the error from treating the Earth as flat there is millimetres, and in exchange the physics, the
//   camera and the models all speak the same unit as the tape measure.
//
//   three.js is Y-up and looks down -Z, so: x = east, y = up, z = -north.
//
//   The metres are TRUE metres. Until v0.16 a degree of latitude was taken as the equator's radius
//   times π/180 (111,319 m), the sphere's answer; on the WGS84 ellipsoid at Sulphur Mountain it is
//   110,930 m. That stretched everything 0.35% north–south, 1.3 ft on a 378 ft survey line. Now the
//   two radii of the ellipsoid at the origin are used, and the surveyor's eleven boundary calls
//   come back within 0.07 ft (see tests/measure.test.mjs, which checks them all).

export const EARTH_R = 6378137;
/** WGS84: semi-major axis, flattening, first eccentricity squared */
export const WGS84 = { a: 6378137, f: 1 / 298.257223563, e2: (1 / 298.257223563) * (2 - 1 / 298.257223563) };
const D2R = Math.PI / 180;

export interface LngLat { lng: number; lat: number }

/**
 * metres per degree of longitude and of latitude at a given latitude, on the WGS84 ellipsoid:
 * the prime-vertical radius N for longitude (times cos φ) and the meridional radius M for latitude
 */
export function metresPerDegree(lat: number): { mx: number; my: number } {
  const s = Math.sin(lat * D2R);
  const w = 1 - WGS84.e2 * s * s;
  const N = WGS84.a / Math.sqrt(w);
  const M = WGS84.a * (1 - WGS84.e2) / (w * Math.sqrt(w));
  return { mx: N * Math.cos(lat * D2R) * D2R, my: M * D2R };
}

/** the ground distance between two points in metres, flat at their mid-latitude (exact to a millimetre over a few km) */
export function metresBetween(a: [number, number], b: [number, number]): number {
  const { mx, my } = metresPerDegree((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * mx, (b[1] - a[1]) * my);
}

/** the area of a ring of lng/lat points in square metres, flat at its mean latitude */
export function ringAreaM2(ring: [number, number][]): number {
  if (ring.length < 3) return 0;
  const lat0 = ring.reduce((s, p) => s + p[1], 0) / ring.length, lng0 = ring[0][0];
  const { mx, my } = metresPerDegree(lat0);
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i], q = ring[(i + 1) % ring.length];
    a += (p[0] - lng0) * mx * (q[1] - lat0) * my - (q[0] - lng0) * mx * (p[1] - lat0) * my;
  }
  return Math.abs(a) / 2;
}

/** the local east-north-up frame of one community */
export class Frame {
  readonly mx: number;
  readonly my: number;
  constructor(readonly origin: LngLat) {
    const m = metresPerDegree(origin.lat);
    this.mx = m.mx; this.my = m.my;
  }
  /** lng/lat -> world metres (x east, z south-negative-north) */
  toWorld(lng: number, lat: number): { x: number; z: number } {
    return { x: (lng - this.origin.lng) * this.mx, z: -(lat - this.origin.lat) * this.my };
  }
  /** world metres -> lng/lat */
  toLngLat(x: number, z: number): LngLat {
    return { lng: this.origin.lng + x / this.mx, lat: this.origin.lat - z / this.my };
  }
}

// ---- web mercator tiles ------------------------------------------------------------------------

export interface TileId { z: number; x: number; y: number }

export function tileOf(lng: number, lat: number, z: number): TileId {
  const n = Math.pow(2, z);
  const x = Math.floor(((lng + 180) / 360) * n);
  const latR = lat * D2R;
  const y = Math.floor(((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n);
  return { z, x, y };
}

/** the lng/lat box a tile covers: [west, south, east, north] */
export function tileBounds(t: TileId): [number, number, number, number] {
  const n = Math.pow(2, t.z);
  const lngAt = (x: number) => (x / n) * 360 - 180;
  const latAt = (y: number) => {
    const s = Math.PI * (1 - (2 * y) / n);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(s) - Math.exp(-s)));
  };
  return [lngAt(t.x), latAt(t.y + 1), lngAt(t.x + 1), latAt(t.y)];
}

/** every tile at zoom z that touches a lng/lat box */
export function tilesCovering(bbox: [number, number, number, number], z: number): TileId[] {
  const a = tileOf(bbox[0], bbox[3], z);      // north-west
  const b = tileOf(bbox[2], bbox[1], z);      // south-east
  const out: TileId[] = [];
  for (let x = a.x; x <= b.x; x++) for (let y = a.y; y <= b.y; y++) out.push({ z, x, y });
  return out;
}
