// Walls.
//
//   A building you can walk through is scenery; a building you have to walk around is architecture.
//   This is the difference, and it is deliberately not a physics engine: the buildings here are
//   vertical prisms over a footprint polygon, which is exactly what the atlas stores, so the cheap
//   correct test is "is the body inside this polygon, and is its head below the roof". If it is,
//   push it out to the nearest edge.
//
//   Reserved ground — a `site` with nothing built on it yet — is deliberately NOT solid. You are
//   meant to be able to stand in the footprint of a house that does not exist and look at the view
//   it would have.

import type { Structure } from './structures';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';

export interface Solid {
  id: string;
  /** world-space XZ footprint */
  ring: { x: number; z: number }[];
  /** ground level at the footprint, and the top of the building */
  base: number;
  top: number;
}

const FT = 0.3048;

/** turn the atlas's registry into the handful of prisms a walker can actually hit */
export function solidsFrom(list: Structure[], frame: Frame, field: HeightField, pid?: string): Solid[] {
  const out: Solid[] = [];
  for (const s of list) {
    if (pid && s.pid !== pid) continue;
    if (s.status === 'site') continue;                 // reserved ground is walkable
    if (!s.outline || s.outline.length < 3) continue;
    let base = Infinity;
    const ring = s.outline.map(([lng, lat]) => {
      const w = frame.toWorld(lng, lat);
      const h = field.atOr(lng, lat, 0);
      if (h < base) base = h;
      return { x: w.x, z: w.z };
    });
    if (!isFinite(base)) base = 0;
    out.push({ id: s.id, ring, base, top: base + (s.heightFt ?? 20) * FT });
  }
  return out;
}

/** is a point in plan inside a ring */
export function inRing(x: number, z: number, ring: { x: number; z: number }[]): boolean { return inside(x, z, ring); }

function inside(x: number, z: number, ring: { x: number; z: number }[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
  }
  return hit;
}

/** the closest point on the ring's boundary, and how far away it is */
function nearestEdge(x: number, z: number, ring: { x: number; z: number }[]) {
  let bx = x, bz = z, best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const px = a.x + t * dx, pz = a.z + t * dz;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) { best = d; bx = px; bz = pz; }
  }
  return { x: bx, z: bz, distance: best };
}

export interface Hit { id: string; pushed: number }

/**
 * Keep a body out of the solids.
 *
 *   Mutates `p` in place and returns what it hit, if anything. The body is a circle of `radius` in
 *   plan, so it is stopped a shoulder's width before the wall rather than with its nose in it; and
 *   a body whose feet are above the roof is over the building, not in it, so it passes.
 */
export function resolve(
  p: { x: number; y: number; z: number },
  radius: number,
  solids: Solid[]
): Hit | null {
  let hit: Hit | null = null;
  for (const s of solids) {
    if (p.y >= s.top - 0.05) continue;                    // standing on or above the roof
    const within = inside(p.x, p.z, s.ring);
    const near = nearestEdge(p.x, p.z, s.ring);
    if (!within && near.distance >= radius) continue;

    // push to the boundary, then a further `radius` along the outward direction
    let ox: number, oz: number;
    if (within) { ox = near.x - p.x; oz = near.z - p.z; }
    else { ox = p.x - near.x; oz = p.z - near.z; }
    const len = Math.hypot(ox, oz);
    if (len < 1e-6) { ox = 1; oz = 0; }
    else { ox /= len; oz /= len; }
    p.x = near.x + ox * radius;
    p.z = near.z + oz * radius;
    hit = { id: s.id, pushed: within ? near.distance + radius : radius - near.distance };
  }
  return hit;
}
