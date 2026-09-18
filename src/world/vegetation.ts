// What grows here.
//
//   A hillside with no plants on it is not a hillside, it is a contour map you can stand on. But a
//   thousand hand-placed trees is a thousand things to be wrong, and nobody is going to survey the
//   chaparral. So the vegetation is a *rule* rather than a list: the same slope and aspect that
//   shade the terrain also decide what grows on it, and the scatter is seeded by position, so the
//   oak you walked past is in the same place when you come back, and in the same place for the next
//   person, without a single coordinate being stored anywhere.
//
//   The rule is the real Ojai rule. Coast live oak takes the gentler, cooler, north-facing ground
//   where the water sits; chamise and ceanothus take the steep dry south faces where it does not.
//   Walk from one to the other and the ground under you has changed, which is the point: this is
//   how you read a property with your feet.
//
//   Everything is instanced. Two draw calls carry several thousand plants, so the cost of a wooded
//   hillside is roughly the cost of an empty one.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';

export interface KeepOut {
  /** world-space XZ polygon to leave clear — a building footprint, a yard */
  ring: { x: number; z: number }[];
  /** extra clearance outside the ring, in metres */
  pad: number;
}

export interface VegetationOpts {
  /** half-width of the planted square, in metres */
  radius: number;
  /** anything inside these stays bare */
  keepOut?: KeepOut[];
  /** multiply every density by this — 0 plants nothing */
  density?: number;
  /** a world-space XZ ring the rule stays out of — where a pack has the real trees on record */
  exclude?: { x: number; z: number }[];
}

/** one tree as a record says it is: where, how tall, how wide, in world metres */
export interface TreeRecord { x: number; z: number; height: number; crown: number }

/**
 * A position-seeded random in [0,1).
 *
 *   Keyed on the grid cell rather than on a running counter, so a plant's existence and shape do
 *   not depend on the order things were generated or on where the patch was centred. Rebuild the
 *   ring from a different standing position and the same cell yields the same plant.
 */
function rand(gx: number, gz: number, salt: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (gx & 0xffff), 16777619);
  h = Math.imul(h ^ (gz & 0xffff), 16777619);
  h = Math.imul(h ^ (salt & 0xffff), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** true when the point is inside the ring (ray casting, XZ plane) */
export function inRing(x: number, z: number, ring: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

/** distance from a point to the ring's nearest edge, in the XZ plane */
export function ringDistance(x: number, z: number, ring: { x: number; z: number }[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const dx = b.x - a.x, dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / len2));
    const d = Math.hypot(x - (a.x + t * dx), z - (a.z + t * dz));
    if (d < best) best = d;
  }
  return best;
}

// ---- the plants themselves ---------------------------------------------------------------------
// Built once, merged into a single vertex-coloured geometry each, then instanced. Deliberately
// low-poly: at a thousand of them the silhouette is what reads, never the polygon count.

const BARK = new THREE.Color('#5e4b39');
const LEAF = new THREE.Color('#4e6b3f');
const SAGE = new THREE.Color('#7d8b5c');

/**
 * Give a part its colour, and make it mergeable.
 *
 *   Cylinders come out of three indexed and icosahedra do not, and mergeGeometries refuses a mix.
 *   Flattening to non-indexed here means every part of every plant is built the same way, whatever
 *   primitive it started as.
 */
function paint(geo0: THREE.BufferGeometry, c: THREE.Color): THREE.BufferGeometry {
  const geo = geo0.index ? geo0.toNonIndexed() : geo0;
  if (geo !== geo0) geo0.dispose();
  const n = geo.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** a coast live oak: a short leaning trunk under a broad low crown, about 6 m to the top */
function oakGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.17, 0.3, 2.3, 6, 1);
  trunk.translate(0, 1.15, 0);
  parts.push(paint(trunk, BARK));
  const blobs: [number, number, number, number][] = [
    [0, 3.5, 0, 1.75], [-1.15, 3.05, 0.35, 1.2], [1.0, 3.15, -0.5, 1.3], [0.2, 4.15, 0.6, 1.05]
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.scale(1, 0.72, 1);
    b.translate(x, y, z);
    parts.push(paint(b, LEAF));
  }
  return mergeGeometries(parts, false)!;
}

/** chamise / ceanothus: a low dense cushion, knee to chest high */
function shrubGeometry(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const blobs: [number, number, number, number][] = [
    [0, 0.5, 0, 0.62], [0.42, 0.36, 0.22, 0.42], [-0.34, 0.33, -0.28, 0.38]
  ];
  for (const [x, y, z, r] of blobs) {
    const b = new THREE.IcosahedronGeometry(r, 0);
    b.scale(1, 0.85, 1);
    b.translate(x, y, z);
    parts.push(paint(b, SAGE));
  }
  return mergeGeometries(parts, false)!;
}

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface Species {
  name: 'oak' | 'shrub';
  geometry: THREE.BufferGeometry;
  /** metres between candidate positions — the grid this species is scattered on */
  cell: number;
  /** how likely a candidate survives, given the ground under it */
  chance: (slope: number, northness: number) => number;
  scale: [number, number];
}

const SPECIES: Species[] = [
  {
    name: 'oak',
    geometry: oakGeometry(),
    cell: 13,
    // oaks want the gentler, cooler ground: they thin out fast on a steep face and prefer north
    chance: (slope, northness) =>
      clamp(0.95 - 1.75 * slope, 0, 1) * (0.32 + 0.68 * clamp((northness + 1) / 2, 0, 1)),
    scale: [0.72, 1.35]
  },
  {
    name: 'shrub',
    geometry: shrubGeometry(),
    cell: 5,
    // chaparral takes what is left: the steep, the dry, the south-facing
    chance: (slope, northness) =>
      clamp(0.16 + 1.15 * slope, 0, 0.92) * (0.35 + 0.65 * clamp((1 - northness) / 2, 0, 1)),
    scale: [0.65, 1.5]
  }
];

export class Vegetation {
  group = new THREE.Group();
  /** how many of each species the last build placed — the tests read this */
  counts: Record<string, number> = {};
  private centre = new THREE.Vector2(NaN, NaN);
  private meshes: THREE.InstancedMesh[] = [];
  private records: THREE.InstancedMesh[] = [];
  /** for each record mesh, the index into the list it was built from, per instance — the editor picks by this */
  recordIndex = new Map<THREE.InstancedMesh, number[]>();

  constructor(private frame: Frame, private field: HeightField) {
    this.group.name = 'vegetation';
  }

  /**
   * What the rule says about a piece of ground: the chance each species has of taking it.
   *
   *   Exposed because this is the part with an opinion. The scatter is arithmetic; this is the
   *   claim about Ojai — oak on the gentle cool ground, chaparral on the steep dry ground — and a
   *   claim should be checkable without looking at a screenshot.
   */
  mix(slope: number, northness: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const sp of SPECIES) out[sp.name] = sp.chance(slope, northness);
    return out;
  }

  /** the slope and the direction it faces, read from the same height function everything else uses */
  private ground(x: number, z: number): { h: number; slope: number; northness: number } {
    const d = 4;
    const at = (px: number, pz: number) => {
      const ll = this.frame.toLngLat(px, pz);
      return this.field.atOr(ll.lng, ll.lat, NaN);
    };
    const h = at(x, z);
    const hx = at(x + d, z) - at(x - d, z);
    const hz = at(x, z + d) - at(x, z - d);
    if (!isFinite(h) || !isFinite(hx) || !isFinite(hz)) return { h: NaN, slope: 0, northness: 0 };
    const slope = Math.hypot(hx, hz) / (2 * d);
    // the surface falls towards (-hx, -hz); in this frame -z is north, so northness is +1 when the
    // slope faces north and -1 when it faces south
    const len = Math.hypot(hx, hz);
    const northness = len < 1e-6 ? 0 : hz / len;
    return { h, slope, northness };
  }

  /** plant (or replant) the patch around a point */
  build(cx: number, cz: number, o: VegetationOpts) {
    this.dispose();
    const density = o.density ?? 1;
    const keep = { record_oak: this.counts.record_oak ?? 0, record_shrub: this.counts.record_shrub ?? 0 };
    this.counts = { ...keep };
    if (density <= 0) { this.centre.set(cx, cz); return; }

    for (let si = 0; si < SPECIES.length; si++) {
      const sp = SPECIES[si];
      const step = sp.cell;
      const n = Math.ceil((o.radius * 2) / step);
      const g0x = Math.floor((cx - o.radius) / step);
      const g0z = Math.floor((cz - o.radius) / step);
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      const v = new THREE.Vector3();
      const s = new THREE.Vector3();
      const rows: { m: THREE.Matrix4; c: THREE.Color }[] = [];

      for (let gz = g0z; gz <= g0z + n; gz++) {
        for (let gx = g0x; gx <= g0x + n; gx++) {
          // jitter inside the cell so the grid never shows through
          const x = (gx + 0.15 + 0.7 * rand(gx, gz, si * 7 + 1)) * step;
          const z = (gz + 0.15 + 0.7 * rand(gx, gz, si * 7 + 2)) * step;
          const dist = Math.hypot(x - cx, z - cz);
          if (dist > o.radius) continue;

          const { h, slope, northness } = this.ground(x, z);
          if (!isFinite(h)) continue;

          // thin towards the edge of the patch, so the seam where it ends is never a hard line
          const falloff = dist < o.radius * 0.55 ? 1 : 1 - 0.65 * ((dist - o.radius * 0.55) / (o.radius * 0.45));
          const p = sp.chance(slope, northness) * density * falloff;
          if (rand(gx, gz, si * 7 + 3) > p) continue;

          if (o.keepOut && o.keepOut.some(k => inRing(x, z, k.ring) || ringDistance(x, z, k.ring) < k.pad)) continue;
          if (o.exclude && o.exclude.length >= 3 && inRing(x, z, o.exclude)) continue;

          const scale = sp.scale[0] + (sp.scale[1] - sp.scale[0]) * rand(gx, gz, si * 7 + 4);
          e.set(
            (rand(gx, gz, si * 7 + 5) - 0.5) * 0.12,
            rand(gx, gz, si * 7 + 6) * Math.PI * 2,
            (rand(gx, gz, si * 7 + 7) - 0.5) * 0.12
          );
          q.setFromEuler(e);
          v.set(x, h, z);
          s.setScalar(scale);
          const mm = new THREE.Matrix4().compose(v, q, s);
          const tint = 0.82 + 0.36 * rand(gx, gz, si * 7 + 8);
          rows.push({ m: mm, c: new THREE.Color(tint, tint * (0.94 + 0.12 * rand(gx, gz, si * 7 + 9)), tint * 0.9) });
        }
      }

      this.counts[sp.name] = rows.length;
      if (!rows.length) continue;

      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const mesh = new THREE.InstancedMesh(sp.geometry, mat, rows.length);
      mesh.name = `veg-${sp.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      for (let i = 0; i < rows.length; i++) {
        mesh.setMatrixAt(i, rows[i].m);
        mesh.setColorAt(i, rows[i].c);
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      this.meshes.push(mesh);
      this.group.add(mesh);
    }
    this.centre.set(cx, cz);
  }

  /**
   * Plant what a record says is there.
   *
   *   The rule guesses; a record knows. Where a pack has the lidar's trees, each one is placed at
   *   its own position with its own height and crown, and the rule is told to stay out of that
   *   ground (`exclude`). These are built once and never move: they are the record, not a guess.
   *   The oak's crown as modelled reads narrower than a closed canopy really is, so a tall tree
   *   with a thin watershed basin is given at least a fifth of its height as crown radius.
   */
  buildRecords(list: TreeRecord[]) {
    for (const m of this.records) { this.group.remove(m); (m.material as THREE.Material).dispose(); m.dispose(); }
    this.records = [];
    this.recordIndex.clear();
    this.counts.record_oak = 0; this.counts.record_shrub = 0;
    const OAK_H = 4.9, OAK_R = 2.35, SHRUB_H = 1.03, SHRUB_R = 0.8;
    const groups: Record<'oak' | 'shrub', TreeRecord[]> = { oak: [], shrub: [] };
    const indices: Record<'oak' | 'shrub', number[]> = { oak: [], shrub: [] };
    list.forEach((t, i) => { const k = t.height >= 4.5 ? 'oak' : 'shrub'; groups[k].push(t); indices[k].push(i); });
    const q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
    for (const name of ['oak', 'shrub'] as const) {
      const rows = groups[name];
      this.counts[`record_${name}`] = rows.length;
      if (!rows.length) continue;
      const sp = SPECIES.find(x => x.name === name)!;
      const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
      const mesh = new THREE.InstancedMesh(sp.geometry, mat, rows.length);
      mesh.name = `veg-record-${name}`;
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      const H = name === 'oak' ? OAK_H : SHRUB_H, R = name === 'oak' ? OAK_R : SHRUB_R;
      for (let i = 0; i < rows.length; i++) {
        const t = rows[i];
        const gx = Math.round(t.x * 10), gz = Math.round(t.z * 10);
        const ll = this.frame.toLngLat(t.x, t.z);
        const h = this.field.atOr(ll.lng, ll.lat, NaN);
        const crown = Math.min(0.6 * t.height, Math.max(t.crown, 0.22 * t.height, 0.6));
        e.set((rand(gx, gz, 21) - 0.5) * 0.08, rand(gx, gz, 22) * Math.PI * 2, (rand(gx, gz, 23) - 0.5) * 0.08);
        q.setFromEuler(e);
        v.set(t.x, isFinite(h) ? h : 0, t.z);
        s.set(crown / R, t.height / H, crown / R);
        mesh.setMatrixAt(i, new THREE.Matrix4().compose(v, q, s));
        const tint = 0.8 + 0.4 * rand(gx, gz, 24);
        mesh.setColorAt(i, new THREE.Color(tint, tint * (0.94 + 0.12 * rand(gx, gz, 25)), tint * 0.9));
      }
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      this.records.push(mesh);
      this.recordIndex.set(mesh, indices[name]);
      this.group.add(mesh);
    }
  }

  /** the record meshes, for picking */
  get recordMeshes(): THREE.InstancedMesh[] { return this.records; }

  /** replant once the player has walked well into the outer part of the patch */
  update(x: number, z: number, o: VegetationOpts) {
    if (!this.meshes.length && !Object.keys(this.counts).length) { this.build(x, z, o); return; }
    if (Math.hypot(x - this.centre.x, z - this.centre.y) > o.radius * 0.4) this.build(x, z, o);
  }

  /** clear the rule's plants; the records stay, they are not a guess to be redone */
  dispose() {
    for (const m of this.meshes) {
      this.group.remove(m);
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
    this.meshes = [];
  }
}
