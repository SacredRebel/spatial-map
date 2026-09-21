// Footings: nothing stands on air.
//
//   A model is set down by one height — the ground at its origin plus altitudeM — and a hillside is
//   not flat. So wherever the ground falls away under a floor, the floor hangs in the air and the sky
//   shows through beneath it. A real building on a slope stands on foundation walls, and so does this
//   one: from every floor edge with nothing under it, a wall runs down to whatever is there.
//
//   Which edges get one is the whole difficulty, because a naive "every edge, down to the ground"
//   grows walls inside the house. Three cases decide it, by looking a hand's width either side of
//   the edge:
//     stacked    — a lower floor lies under this floor's own interior (a loft over the living room):
//                  no footing, or the loft would stand a wall in the middle of the room below
//     continuous — past the edge a floor carries on at the same level (a wing meeting the centre):
//                  no footing, or every seam in the plan would grow a wall
//     otherwise  — down to the highest thing under the edge: a lower floor (a riser) or the ground
//   Where the drop is more than a step, the footing is also something to walk into, so nobody walks
//   under the house. From above it is below your feet and stops nothing — the walker's own rule
//   (feet above a solid's top pass over it) does that for free.
//
//   This is honesty, not design. It shows what a placement implies: a house that needs four metres of
//   foundation wall to stand where it was put is saying it was put in the wrong place, or drawn for
//   flatter ground — and now anyone can see that, instead of a house floating in the air.

import * as THREE from 'three';
import type { Platform } from './build';
import { inRing, type Solid } from './collide';

export interface FootingOpts {
  /** the ground under a world point, in metres, or null where nothing is known */
  ground: (x: number, z: number) => number | null;
  /** the longest stretch between samples along an edge, so the foot follows the ground */
  step?: number;
}

export interface FootingReport {
  /** the tallest foundation wall drawn, in metres — what a placement costs */
  maxDrop: number;
  /** which floor needed it */
  worst: string | null;
  /** how many floor edges needed any footing at all */
  edges: number;
  /** total length of wall that needed to exist, in metres */
  lengthM: number;
  /** the tallest footing under each structure, by the structure's id — how badly each one is placed */
  byStructure: Record<string, number>;
}

export interface Footings extends FootingReport {
  mesh: THREE.Mesh | null;
  solids: Solid[];
}

const NUDGE = 0.3;     // how far in or out of an edge to look for what is there
const LEVEL = 0.05;    // two floors within this of each other are the same level
const STEP = 0.55;     // the walker's step: a drop taller than this is a wall, not a step
const SINK = 0.25;     // a footing goes this far into the ground, so its foot never shows a seam
const MIN = 0.05;      // a gap smaller than this needs nothing
const THICK_OUT = 0.15, THICK_IN = 0.05;   // the walkable wall straddles the edge, mostly outside

type Box = { x0: number; x1: number; z0: number; z1: number };
const boxOf = (ring: { x: number; z: number }[]): Box => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const q of ring) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.z < z0) z0 = q.z; if (q.z > z1) z1 = q.z; }
  return { x0, x1, z0, z1 };
};

/** what is at a point: the highest floor below `self`, and whether a floor at `self`'s level or above covers it */
function cover(platforms: Platform[], boxes: Box[], self: Platform, x: number, z: number) {
  let lower = -Infinity, level = false;
  for (let i = 0; i < platforms.length; i++) {
    const p = platforms[i], b = boxes[i];
    if (p === self || x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || !inRing(x, z, p.ring)) continue;
    if (p.top >= self.top - LEVEL) level = true;
    else if (p.top > lower) lower = p.top;
  }
  return { lower, level };
}

export function footingsFor(platforms: Platform[], o: FootingOpts, material?: THREE.Material): Footings {
  const step = o.step ?? 1.5;
  const pos: number[] = [];
  const index: number[] = [];
  const solids: Solid[] = [];
  const report: FootingReport = { maxDrop: 0, worst: null, edges: 0, lengthM: 0, byStructure: {} };
  const boxes = platforms.map(p => boxOf(p.ring));

  for (const P of platforms) {
    const r = P.ring, n = r.length;
    if (n < 3 || !isFinite(P.top)) continue;
    let area = 0;
    for (let i = 0; i < n; i++) { const a = r[i], b = r[(i + 1) % n]; area += a.x * b.z - b.x * a.z; }
    const sgn = area >= 0 ? 1 : -1;

    for (let i = 0; i < n; i++) {
      const a = r[i], b = r[(i + 1) % n];
      const dx = b.x - a.x, dz = b.z - a.z;
      const len = Math.hypot(dx, dz);
      if (len < 1e-3) continue;
      const nx = (sgn * dz) / len, nz = (sgn * -dx) / len;   // outward
      const k = Math.max(1, Math.ceil(len / step));

      // at each sample along the edge: the gap under it (what a person would see) and where the wall's foot goes
      const gap: number[] = [], foot: number[] = [];
      for (let j = 0; j <= k; j++) {
        const t = j / k, x = a.x + dx * t, z = a.z + dz * t;
        gap.push(0); foot.push(P.top);
        if (cover(platforms, boxes, P, x - nx * NUDGE, z - nz * NUDGE).lower > -Infinity) continue;   // stacked
        const outer = cover(platforms, boxes, P, x + nx * NUDGE, z + nz * NUDGE);
        if (outer.level) continue;                                                            // continuous
        const g = o.ground(x, z);
        const ground = g == null || !isFinite(g) ? -Infinity : g;
        const support = Math.max(outer.lower, ground);
        if (!isFinite(support) || P.top - support < MIN) continue;
        gap[j] = P.top - support;
        // onto a lower floor the riser meets it exactly; into the ground it goes a little further
        foot[j] = outer.lower >= ground ? outer.lower : ground - SINK;
      }
      if (gap.every(v => v === 0)) continue;
      report.edges++;

      // the wall: one strip of quads under the edge, pinched to nothing where no footing is wanted
      let run = -1, runLo = Infinity;
      for (let j = 0; j <= k; j++) {
        const t = j / k, x = a.x + dx * t, z = a.z + dz * t;
        const v = pos.length / 3;
        pos.push(x, P.top, z, x, foot[j], z);
        if (j > 0) {
          index.push(v - 2, v - 1, v, v - 1, v + 1, v);
          if (gap[j - 1] > 0 || gap[j] > 0) report.lengthM += len / k;
        }
        if (gap[j] > report.maxDrop) { report.maxDrop = gap[j]; report.worst = P.id; }
        const sid = P.id.split(':')[0];
        if (gap[j] > (report.byStructure[sid] ?? 0)) report.byStructure[sid] = Math.round(gap[j] * 100) / 100;

        // something to walk into wherever the drop is more than a step
        const wall = gap[j] > STEP;
        if (wall) { if (run < 0) run = j; runLo = Math.min(runLo, foot[j]); }
        if (run >= 0 && (!wall || j === k)) {
          const to = wall ? j : j - 1;
          if (to > run) {
            const t0 = run / k, t1 = to / k;
            const x0 = a.x + dx * t0, z0 = a.z + dz * t0, x1 = a.x + dx * t1, z1 = a.z + dz * t1;
            solids.push({
              id: `${P.id}:footing:${i}:${run}`,
              ring: [
                { x: x0 + nx * THICK_OUT, z: z0 + nz * THICK_OUT }, { x: x1 + nx * THICK_OUT, z: z1 + nz * THICK_OUT },
                { x: x1 - nx * THICK_IN, z: z1 - nz * THICK_IN }, { x: x0 - nx * THICK_IN, z: z0 - nz * THICK_IN }
              ],
              base: runLo,
              top: P.top - 0.05
            });
          }
          run = -1; runLo = Infinity;
        }
      }
    }
  }

  let mesh: THREE.Mesh | null = null;
  if (index.length) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(index);
    geo.computeVertexNormals();
    mesh = new THREE.Mesh(geo, material ?? footingMaterial());
    mesh.name = 'footings';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
  }
  report.maxDrop = Math.round(report.maxDrop * 100) / 100;
  report.lengthM = Math.round(report.lengthM * 10) / 10;
  return { mesh, solids, ...report };
}

/** board-formed concrete: plain, a little warm, obviously structure rather than design */
export function footingMaterial(): THREE.Material {
  return new THREE.MeshStandardMaterial({ color: 0x9a958c, roughness: 0.93, metalness: 0, side: THREE.DoubleSide });
}
