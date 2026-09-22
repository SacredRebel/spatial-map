// Shaping the ground.
//
//   A pad flattened for a house, a bank raised, a hollow cut: each is one edit feature — a
//   Polygon with an `op` — and the height field applies them after the tiles. Everything that
//   asks the field for the ground (the terrain mesh, every tree, every building, the walker, the
//   grid) follows without knowing, which is the whole point of the ground being a function.
//
//   Inside the polygon the ground is the target height, or the old ground plus a delta; across an
//   edge band outside it the change fades to nothing, so a pad has a bank and not a cliff. The
//   record's tiles are never rewritten.

import type { Feature } from './pack';
import { metresPerDegree } from './geo';

export interface Shaping {
  id: string;
  op: 'flatten' | 'raise' | 'lower';
  /** the ring, lng/lat */
  ring: [number, number][];
  /** flatten: metres above sea level to make the ground; raise/lower: metres to move it */
  height: number;
  /** the width of the bank outside the ring, metres */
  edge: number;
  /** lng/lat bounding box, padded by the edge, for the quick reject */
  bbox: [number, number, number, number];
  /** metres per degree at the polygon, so distances are metres */
  mx: number; my: number;
}


/** an edit feature into a shaping, or null when it is not one */
export function shapingFrom(f: Feature, groundAt: (lng: number, lat: number) => number | null): Shaping | null {
  if (f.properties.op !== 'add' || f.properties.layer !== 'terrain' || f.geometry.type !== 'Polygon') return null;
  const ring = (f.geometry.coordinates[0] || []).slice() as [number, number][];
  if (ring.length < 3) return null;
  if (ring.length > 3 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
  const op = f.properties.terrain_op === 'raise' || f.properties.terrain_op === 'lower' ? f.properties.terrain_op : 'flatten';
  const edge = Math.min(40, Math.max(0, Number(f.properties.edge_m ?? 3)));
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const { mx, my } = metresPerDegree(lat0);
  let height: number;
  if (op === 'flatten') {
    if (isFinite(Number(f.properties.to_m))) height = Number(f.properties.to_m);
    else {
      // the pad's level, when none was given: the mean of the ground around its ring
      let sum = 0, n = 0;
      for (const [lng, lat] of ring) { const h = groundAt(lng, lat); if (h != null && isFinite(h)) { sum += h; n++; } }
      if (!n) return null;
      height = sum / n;
    }
  } else {
    const d = Math.abs(Number(f.properties.height_m));
    if (!isFinite(d)) return null;
    height = op === 'raise' ? d : -d;
  }
  const lngs = ring.map(p => p[0]), lats = ring.map(p => p[1]);
  const pe = edge / mx, pn = edge / my;
  return {
    id: String(f.properties.id), op, ring, height, edge, mx, my,
    bbox: [Math.min(...lngs) - pe, Math.min(...lats) - pn, Math.max(...lngs) + pe, Math.max(...lats) + pn]
  };
}

function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[i], [bx, by] = ring[j];
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) hit = !hit;
  }
  return hit;
}

/** metres from a point to the nearest edge of the ring */
function ringDistance(x: number, y: number, s: Shaping): number {
  let best = Infinity;
  for (let i = 0, j = s.ring.length - 1; i < s.ring.length; j = i++) {
    const ax = (s.ring[i][0] - x) * s.mx, ay = (s.ring[i][1] - y) * s.my;
    const bx = (s.ring[j][0] - x) * s.mx, by = (s.ring[j][1] - y) * s.my;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const px = ax + t * dx, py = ay + t * dy;
    best = Math.min(best, Math.hypot(px, py));
  }
  return best;
}

/** the ground at a point once the shapings have had their say */
export function shaped(h: number, lng: number, lat: number, list: Shaping[]): number {
  let out = h;
  for (const s of list) {
    if (lng < s.bbox[0] || lng > s.bbox[2] || lat < s.bbox[1] || lat > s.bbox[3]) continue;
    const inside = inRing(lng, lat, s.ring);
    let w = 1;
    if (!inside) {
      if (s.edge <= 0) continue;
      const d = ringDistance(lng, lat, s);
      if (d >= s.edge) continue;
      const t = 1 - d / s.edge;
      w = t * t * (3 - 2 * t);                        // smoothstep: the bank eases into the hill
    }
    const target = s.op === 'flatten' ? s.height : out + s.height;
    out = out + (target - out) * w;
  }
  return out;
}
