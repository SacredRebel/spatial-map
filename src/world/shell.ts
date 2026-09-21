// The shell: a roof that grows out of its own outline.
//
//   Gable, hip and vault are carpenter's roofs — they need a rectangle and a ridge, and an organic
//   plan has neither. So an organic plan gets a shell instead: a cushion of roof that rises from the
//   line of the walls to a crown over the plan's deepest point, whatever shape the walls make. A
//   leaf, a lobed flower, a nautilus: the roof follows, and droops a little past the walls into an
//   eave the way a mushroom cap or a thatched roundhouse does.
//
//   How: from the plan's deepest point (the pole — the point furthest from any wall) every point of
//   the outline is joined to it, and the roof is lofted along those spokes. Its height depends only
//   on how far along its spoke a point is, not on the spoke's length, so a long lobe and a short
//   one both rise to the same crown and the surface stays smooth between them. This needs the plan
//   to be star-shaped about the pole — which every form the organic generator makes is, by
//   construction; a freehand outline that is not gets a pole chosen to make it as nearly so as it can.
//
//   The same height function answers "how high is the roof here" for anything placed on it —
//   solar panels, ribs underneath — so nothing floats above it or sinks through.

import * as THREE from 'three';

export type XZ = { x: number; z: number };

export interface ShellOpts {
  /** height of the roof where it crosses the wall line, world metres */
  eaves: number;
  /** how far the crown rises above the eaves */
  rise: number;
  /** how far past the walls the roof reaches */
  overhang: number;
  /** thickness of the shell */
  thick?: number;
  /** the profile: 2 is a paraboloid, higher is flatter on top with a rounder shoulder */
  power?: number;
}

export interface Shell {
  geometry: THREE.BufferGeometry;
  /** the roof's top surface height over a plan point, or null outside it */
  heightAt: (x: number, z: number) => number | null;
  /** the plan point under the crown */
  pole: XZ;
  /** the outline at the walls, resampled, and the outer edge of the eave */
  wall: XZ[];
  outer: XZ[];
  /** plan area under the roof, m², and area of the roof surface itself */
  planArea: number;
  surfaceArea: number;
}

function inRing(x: number, z: number, ring: XZ[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function edgeDistance(x: number, z: number, ring: XZ[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(x - a.x - t * dx, z - a.z - t * dz));
  }
  return best;
}
export function ringArea(ring: XZ[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].z - ring[i].x * ring[j].z;
  return a / 2;
}

/** the point inside a ring furthest from its edges — found on a grid, then refined */
export function poleOf(ring: XZ[]): XZ {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of ring) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  let best = { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }, bd = -1;
  let cx = best.x, cz = best.z, hw = (x1 - x0) / 2, hd = (z1 - z0) / 2;
  for (let pass = 0; pass < 4; pass++) {
    const n = 16;
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) {
      const x = cx - hw + (2 * hw * i) / n, z = cz - hd + (2 * hd * j) / n;
      if (!inRing(x, z, ring)) continue;
      const d = edgeDistance(x, z, ring);
      if (d > bd) { bd = d; best = { x, z }; }
    }
    cx = best.x; cz = best.z; hw /= 4; hd /= 4;
  }
  return best;
}

/** a closed ring resampled to points about `step` apart */
export function resampleClosed(ring: XZ[], step: number, min = 24, max = 240): XZ[] {
  const pts = ring.slice();
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1e-6) pts.pop();
  const cum = [0];
  for (let i = 1; i <= pts.length; i++) { const a = pts[i - 1], b = pts[i % pts.length]; cum.push(cum[i - 1] + Math.hypot(b.x - a.x, b.z - a.z)); }
  const L = cum[cum.length - 1];
  const n = Math.max(min, Math.min(max, Math.round(L / step)));
  const out: XZ[] = [];
  let seg = 0;
  for (let k = 0; k < n; k++) {
    const s = (k / n) * L;
    while (seg < pts.length - 1 && cum[seg + 1] < s) seg++;
    const a = pts[seg], b = pts[(seg + 1) % pts.length], l = cum[seg + 1] - cum[seg] || 1;
    const t = (s - cum[seg]) / l;
    out.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

/**
 * The shell over a closed plan ring (world XZ, the wall centreline or its outer face).
 */
export function shell(ringIn: XZ[], o: ShellOpts): Shell {
  const thick = o.thick ?? 0.18;
  const P = o.power ?? 2.2;
  const wall = resampleClosed(ringIn, 0.5);
  const n = wall.length;
  const ccw = ringArea(wall) > 0;
  const pole = poleOf(wall);

  // the eave: each wall point pushed out along its own outward normal
  const outer: XZ[] = wall.map((p, i) => {
    const a = wall[(i - 1 + n) % n], b = wall[(i + 1) % n];
    let nx = b.z - a.z, nz = -(b.x - a.x);
    if (!ccw) { nx = -nx; nz = -nz; }
    // the normal as computed points to the right of travel; make sure it points away from the pole
    const l = Math.hypot(nx, nz) || 1;
    nx /= l; nz /= l;
    if ((p.x - pole.x) * nx + (p.z - pole.z) * nz < 0) { nx = -nx; nz = -nz; }
    return { x: p.x + nx * o.overhang, z: p.z + nz * o.overhang };
  });
  // how far along its spoke the wall is: the roof reaches the eaves height exactly there
  const sw = wall.map((p, i) => {
    const b = Math.hypot(outer[i].x - pole.x, outer[i].z - pole.z) || 1;
    return Math.min(1, Math.hypot(p.x - pole.x, p.z - pole.z) / b);
  });
  const droop = Math.max(0.12, o.overhang * 0.55);
  const H = (s: number, i: number) => {
    const rho = s / (sw[i] || 1);
    return Math.max(o.eaves - droop, o.eaves + o.rise * (1 - Math.pow(rho, P)));
  };

  // lofted along the spokes: K rings from the eave in to the crown, the crown itself last
  const K = 16;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const sOf = (k: number) => 1 - Math.pow(k / K, 0.9);   // a little denser near the edge, where the curve is
  for (let k = 0; k < K; k++) {
    const s = sOf(k);
    for (let i = 0; i < n; i++) {
      const x = pole.x + (outer[i].x - pole.x) * s, z = pole.z + (outer[i].z - pole.z) * s;
      pos.push(x, H(s, i), z); uv.push(x, z);
    }
  }
  const apex = pos.length / 3;
  pos.push(pole.x, o.eaves + o.rise, pole.z); uv.push(pole.x, pole.z);
  const top = pos.length / 3;
  const topIdx: number[] = [];
  for (let k = 0; k < K - 1; k++) for (let i = 0; i < n; i++) {
    const a = k * n + i, b = k * n + (i + 1) % n, c = (k + 1) * n + i, d = (k + 1) * n + (i + 1) % n;
    topIdx.push(a, c, b, b, c, d);
  }
  for (let i = 0; i < n; i++) topIdx.push((K - 1) * n + i, apex, (K - 1) * n + (i + 1) % n);
  // which way that winding faces depends on which way the ring runs; make the top face the sky
  let ny = 0;
  for (let t = 0; t < topIdx.length; t += 3) {
    const a = topIdx[t] * 3, b = topIdx[t + 1] * 3, c = topIdx[t + 2] * 3;
    const ux = pos[b] - pos[a], uz = pos[b + 2] - pos[a + 2], vx = pos[c] - pos[a], vz = pos[c + 2] - pos[a + 2];
    ny += uz * vx - ux * vz;
  }
  if (ny < 0) for (let t = 0; t < topIdx.length; t += 3) { const s1 = topIdx[t + 1]; topIdx[t + 1] = topIdx[t + 2]; topIdx[t + 2] = s1; }
  idx.push(...topIdx);
  const topTris = topIdx.length;

  // the underside, the same surface a shell's thickness lower, facing down
  for (let v = 0; v < top; v++) { pos.push(pos[v * 3], pos[v * 3 + 1] - thick, pos[v * 3 + 2]); uv.push(uv[v * 2], uv[v * 2 + 1]); }
  for (let t = 0; t < topIdx.length; t += 3) idx.push(topIdx[t] + top, topIdx[t + 2] + top, topIdx[t + 1] + top);
  // the rim: the eave's edge, closing top to bottom, facing out
  for (let i = 0; i < n; i++) {
    const a = i, b = (i + 1) % n, c = i + top, d = (i + 1) % n + top;
    const mx = (outer[i].x + outer[(i + 1) % n].x) / 2 - pole.x, mz = (outer[i].z + outer[(i + 1) % n].z) / 2 - pole.z;
    // the face normal of (a, b, c): (b - a) × (c - a); c is straight below a
    const ex = pos[b * 3] - pos[a * 3], ez = pos[b * 3 + 2] - pos[a * 3 + 2];
    const outward = (ez * -thick * 0) + (-ez * mx + ex * mz) * -1;   // sign of the horizontal part of (b-a)×(down)
    if (outward > 0) idx.push(a, b, c, b, d, c); else idx.push(a, c, b, b, c, d);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(idx);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  // the height at any plan point: which spoke it is on, and how far along
  const ang = outer.map(p => Math.atan2(p.z - pole.z, p.x - pole.x));
  const heightAt = (x: number, z: number): number | null => {
    const dx = x - pole.x, dz = z - pole.z;
    const r = Math.hypot(dx, dz);
    if (r < 1e-6) return o.eaves + o.rise;
    const a = Math.atan2(dz, dx);
    // the two spokes either side, by angle
    let bi = 0, bd = Infinity;
    for (let i = 0; i < n; i++) { let d = Math.abs(a - ang[i]); if (d > Math.PI) d = 2 * Math.PI - d; if (d < bd) { bd = d; bi = i; } }
    const R = Math.hypot(outer[bi].x - pole.x, outer[bi].z - pole.z);
    const s = r / (R || 1);
    if (s > 1.0001) return null;
    return H(s, bi);
  };

  // areas: plan under the eave, and the surface (for materials)
  let surf = 0;
  for (let t = 0; t < topTris; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    surf += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
  }
  return { geometry, heightAt, pole, wall, outer, planArea: Math.abs(ringArea(outer)), surfaceArea: surf };
}

/** where the sun-facing part of a shell can carry panels: plan points and their surface normals */
export function solarSpots(sh: Shell, o: { ratio: number; facingDeg?: number; pw?: number; pl?: number }): { x: number; y: number; z: number; n: THREE.Vector3 }[] {
  const pw = o.pw ?? 1.05, pl = o.pl ?? 1.75;
  const facing = ((o.facingDeg ?? 180) * Math.PI) / 180;
  const fx = Math.sin(facing), fz = -Math.cos(facing);     // a compass bearing as a world direction (z is south)
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of sh.wall) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const cand: { x: number; y: number; z: number; n: THREE.Vector3; score: number }[] = [];
  const e = 0.25;
  for (let x = x0 + pw / 2; x < x1; x += pw + 0.08) for (let z = z0 + pl / 2; z < z1; z += pl + 0.1) {
    // the whole panel must sit inside the wall line, a little in from the eave
    const corners = [[-pw / 2, -pl / 2], [pw / 2, -pl / 2], [pw / 2, pl / 2], [-pw / 2, pl / 2]];
    if (!corners.every(([a, b]) => inRing(x + a, z + b, sh.wall) && edgeDistance(x + a, z + b, sh.wall) > 0.35)) continue;
    const h = sh.heightAt(x, z), hx = sh.heightAt(x + e, z), hz = sh.heightAt(x, z + e);
    if (h == null || hx == null || hz == null) continue;
    const n = new THREE.Vector3(-(hx - h) / e, 1, -(hz - h) / e).normalize();
    const tilt = Math.acos(n.y);
    if (tilt > (42 * Math.PI) / 180) continue;
    const horiz = Math.hypot(n.x, n.z);
    const toward = horiz < 0.05 ? 0.6 : (n.x * fx + n.z * fz) / horiz;
    if (toward < 0.1 && tilt > (6 * Math.PI) / 180) continue;
    cand.push({ x, y: h, z, n, score: toward * Math.sin(Math.max(tilt, 0.1)) + 0.2 });
  }
  cand.sort((a, b) => b.score - a.score);
  const keep = Math.round(Math.max(0, Math.min(1, o.ratio)) * cand.length);
  return cand.slice(0, keep).map(({ x, y, z, n }) => ({ x, y, z, n }));
}
