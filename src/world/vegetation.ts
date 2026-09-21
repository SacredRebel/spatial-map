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
  /** creeks, as world XZ lines: trees crowd along the water, the way sycamore and oak line every creek here */
  wet?: { x: number; z: number }[][];
}

/** how near water each 10 m cell is, from a set of creek lines — so the planting can ask in O(1) */
function wetIndex(lines: { x: number; z: number }[][]): (x: number, z: number) => number {
  const cell = 10, reach = 30;
  const m = new Map<string, number>();
  for (const line of lines) for (const p of line) {
    const cx = Math.floor(p.x / cell), cz = Math.floor(p.z / cell), k = Math.ceil(reach / cell);
    for (let i = -k; i <= k; i++) for (let j = -k; j <= k; j++) {
      const key = `${cx + i},${cz + j}`;
      const d = Math.hypot((cx + i + 0.5) * cell - p.x, (cz + j + 0.5) * cell - p.z);
      if (d < (m.get(key) ?? Infinity)) m.set(key, d);
    }
  }
  return (x, z) => m.get(`${Math.floor(x / cell)},${Math.floor(z / cell)}`) ?? Infinity;
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
// A tree used to be four faceted blobs on a stick — at a thousand of them the silhouette read, and
// at arm's length it read as a 1990s game. Now the crown is made the way real-time foliage is made
// everywhere: many small cards, each carrying a painted cluster of leaves with holes in it, set
// round the surface of the crown's lobes and lit as if the crown were one soft volume (every card's
// normal leans out from the crown's heart). The trunk forks into limbs that reach into the lobes.
//
// One texture carries both: leaves on the left half (cut out by their alpha), bark on the right.
// One material, one geometry per species, instanced as before — still two draw calls for a hillside.
// The crowns stir in the wind, each tree on its own phase, keyed to where it stands.

/** leaves on the left half (with holes), bark on the right: painted once */
let atlas: THREE.CanvasTexture | null = null;
function foliageAtlas(): THREE.CanvasTexture | null {
  if (atlas) return atlas;
  if (typeof document === 'undefined') return null;
  const W = 512, H = 256;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (!g) return null;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  g.clearRect(0, 0, W, H);
  // the leaf cluster: small ovals of coast live oak green, denser at the heart, ragged at the edge
  const greens = ['#33492a', '#3e5731', '#4a6536', '#56713c', '#627d42', '#6f8747', '#3a4f2c'];
  for (let i = 0; i < 900; i++) {
    const a = rnd() * Math.PI * 2, r = 118 * Math.pow(rnd(), 0.62);
    const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
    g.save();
    g.translate(x, y);
    g.rotate(rnd() * Math.PI);
    const len = 4 + rnd() * 5, wid = 2.2 + rnd() * 2;
    g.fillStyle = greens[Math.floor(rnd() * greens.length)];
    g.beginPath(); g.ellipse(0, 0, len, wid, 0, 0, Math.PI * 2); g.fill();
    // the glossy upper face catches the sky
    if (rnd() < 0.45) { g.fillStyle = 'rgba(190,210,160,0.25)'; g.beginPath(); g.ellipse(-len * 0.2, -wid * 0.25, len * 0.55, wid * 0.4, 0, 0, Math.PI * 2); g.fill(); }
    g.restore();
  }
  // twigs
  g.strokeStyle = 'rgba(70,52,36,0.8)'; g.lineWidth = 1.2;
  for (let i = 0; i < 14; i++) { const a = rnd() * Math.PI * 2; g.beginPath(); g.moveTo(128, 128); g.lineTo(128 + Math.cos(a) * 90 * rnd(), 128 + Math.sin(a) * 90 * rnd()); g.stroke(); }
  // bark: furrowed grey-brown, running up the trunk
  const bark = g.createLinearGradient(256, 0, 512, 0);
  bark.addColorStop(0, '#4a3c30'); bark.addColorStop(0.5, '#5b4a3b'); bark.addColorStop(1, '#443629');
  g.fillStyle = bark;
  g.fillRect(256, 0, 256, 256);
  for (let i = 0; i < 260; i++) {
    const x = 256 + rnd() * 256, y = rnd() * 256, l = 14 + rnd() * 40;
    g.strokeStyle = rnd() < 0.5 ? 'rgba(30,24,18,0.55)' : 'rgba(120,104,88,0.35)';
    g.lineWidth = 1 + rnd() * 2.2;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + (rnd() - 0.5) * 6, y + l); g.stroke();
  }
  atlas = new THREE.CanvasTexture(c);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  return atlas;
}

type Lobe = [number, number, number, number];

/** leaf cards round a set of lobes, with normals leaning out from the crown's heart */
function crownCards(lobes: Lobe[], heart: THREE.Vector3, perR2: number, size: number, seed: number): THREE.BufferGeometry {
  let st = seed;
  const rnd = () => { st = (st * 16807) % 2147483647; return st / 2147483647; };
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = [];
  const up = new THREE.Vector3(0, 1, 0);
  for (const [lx, ly, lz, r] of lobes) {
    const n = Math.max(6, Math.round(perR2 * r * r));
    for (let i = 0; i < n; i++) {
      // a point in the lobe, mostly near its skin
      const u = rnd() * 2 - 1, th = rnd() * Math.PI * 2, rr = r * (0.55 + 0.45 * Math.pow(rnd(), 0.5));
      const dir = new THREE.Vector3(Math.sqrt(1 - u * u) * Math.cos(th), u * 0.78, Math.sqrt(1 - u * u) * Math.sin(th));
      const c = new THREE.Vector3(lx, ly, lz).addScaledVector(dir, rr);
      // the card faces out, turned about its own normal at random
      const nrm = c.clone().sub(heart).normalize().lerp(dir, 0.5).normalize();
      const t1 = new THREE.Vector3().crossVectors(nrm, Math.abs(nrm.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : up).normalize();
      const t2 = new THREE.Vector3().crossVectors(nrm, t1).normalize();
      const roll = rnd() * Math.PI * 2, cs = Math.cos(roll), sn = Math.sin(roll);
      const ax = t1.clone().multiplyScalar(cs).addScaledVector(t2, sn), ay = t2.clone().multiplyScalar(cs).addScaledVector(t1, -sn);
      const h = size * (0.75 + 0.5 * rnd()) * (0.6 + 0.4 * r) / 2;
      const base = pos.length / 3;
      const lightN = c.clone().sub(heart).normalize().lerp(up, 0.25).normalize();
      for (const [sx, sy, uu, vv] of [[-1, -1, 0, 0], [1, -1, 0.5, 0], [1, 1, 0.5, 1], [-1, 1, 0, 1]]) {
        const p = c.clone().addScaledVector(ax, sx * h).addScaledVector(ay, sy * h);
        pos.push(p.x, p.y, p.z); nor.push(lightN.x, lightN.y, lightN.z); uv.push(uu * 0.98 + 0.005, vv);
        // the inside of the crown is darker: self-shadow, painted in
        const depth = Math.min(1, c.distanceTo(heart) / 2.4);
        const k = 0.72 + 0.28 * depth;
        col.push(k, k, k);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx);
  return geo;
}

/** a limb: a tapered cylinder from a to b, its UVs on the bark half of the atlas */
function limb(a: THREE.Vector3, b: THREE.Vector3, r0: number, r1: number): THREE.BufferGeometry {
  const len = a.distanceTo(b);
  const g = new THREE.CylinderGeometry(r1, r0, len, 5, 1, true);
  g.translate(0, len / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
  g.applyQuaternion(q);
  g.translate(a.x, a.y, a.z);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.52 + uv.getX(i) * 0.46, uv.getY(i) * Math.min(1, len / 2.5));
  const n = g.getAttribute('position').count;
  g.setAttribute('color', new THREE.Float32BufferAttribute(new Array(n * 3).fill(1), 3));
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  const flat = g.index ? g.toNonIndexed() : g;
  if (flat !== g) g.dispose();
  return flat;
}

/** scale a geometry so its top is `h` and its widest reach from the axis is `r` — the record trees are scaled against these */
function normalise(geo: THREE.BufferGeometry, h: number, r: number): THREE.BufferGeometry {
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const pos = geo.getAttribute('position') as THREE.BufferAttribute;
  let reach = 0;
  for (let i = 0; i < pos.count; i++) reach = Math.max(reach, Math.hypot(pos.getX(i), pos.getZ(i)));
  geo.scale(r / (reach || 1), h / (bb.max.y || 1), r / (reach || 1));
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** a coast live oak: a short leaning trunk forking into limbs, under a broad low crown, about 4.9 m to the top */
function oakGeometry(): THREE.BufferGeometry {
  const lobes: Lobe[] = [
    [0, 3.5, 0, 1.75], [-1.15, 3.05, 0.35, 1.2], [1.0, 3.15, -0.5, 1.3], [0.2, 4.1, 0.6, 1.05], [-0.45, 3.35, -1.0, 1.1], [0.95, 3.55, 0.95, 1.0]
  ];
  const heart = new THREE.Vector3(0, 3.4, 0);
  const parts: THREE.BufferGeometry[] = [];
  const fork = new THREE.Vector3(0.08, 2.0, 0.05);
  parts.push(limb(new THREE.Vector3(0, -0.2, 0), fork, 0.32, 0.2));
  for (const [x, y, z] of lobes.slice(1, 5)) parts.push(limb(fork, new THREE.Vector3(x * 0.72, y * 0.82, z * 0.72), 0.14, 0.06));
  parts.push(limb(fork, new THREE.Vector3(0.1, 3.4, 0.05), 0.15, 0.07));
  const crown = crownCards(lobes, heart, 6, 1.38, 11);
  parts.push(crown.index ? crown.toNonIndexed() : crown);
  const merged = mergeGeometries(parts.map(p => { p.deleteAttribute('uv1'); return p; }), false)!;
  return normalise(merged, 4.9, 2.35);
}

/** chamise / ceanothus: a low dense cushion of leaf, knee to chest high */
function shrubGeometry(): THREE.BufferGeometry {
  const lobes: Lobe[] = [[0, 0.5, 0, 0.62], [0.42, 0.36, 0.22, 0.42], [-0.34, 0.33, -0.28, 0.38], [0.1, 0.3, -0.4, 0.35]];
  const g = crownCards(lobes, new THREE.Vector3(0, 0.35, 0), 24, 0.6, 23);
  const flat = g.toNonIndexed();
  g.dispose();
  return normalise(flat, 1.03, 0.8);
}

/** the shared plant material: the atlas cut out by its alpha, the crowns stirring in the wind */
const wind = { value: 0 };
function plantMaterial(sway: number): THREE.Material {
  const map = foliageAtlas();
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, map, alphaTest: map ? 0.42 : 0, side: THREE.DoubleSide, roughness: 0.82, metalness: 0 });
  m.onBeforeCompile = shader => {
    shader.uniforms.uWind = wind;
    // a leaf card is lit by the crown's normal on both faces; flipping it on the back would blacken half the leaves
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  #ifdef USE_INSTANCING
    vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  #else
    vec2 ip = vec2(0.0);
  #endif
  float h = max(0.0, position.y - ${sway.toFixed(2)});
  float ph = uWind * 1.1 + ip.x * 0.21 + ip.y * 0.17;
  transformed.x += (sin(ph) * 0.03 + sin(ph * 2.9 + position.x * 1.7) * 0.012) * h;
  transformed.z += (cos(ph * 0.8) * 0.025 + sin(ph * 3.3 + position.z * 1.9) * 0.01) * h;
}`);
  };
  m.customProgramCacheKey = () => `plant-${sway}`;
  return m;
}
function plantDepth(): THREE.Material {
  return new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: foliageAtlas(), alphaTest: 0.42 });
}

/** the wind's clock, shared with the grass so a gust moves both */
export const WIND = wind;
/** advance the wind; the loop calls this once a frame with the seconds since the world began */
export function setWind(seconds: number) { wind.value = seconds; }

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface Species {
  name: 'oak' | 'shrub';
  geometry: THREE.BufferGeometry;
  /** below this height nothing sways — a trunk stands still, a crown moves */
  sway: number;
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
    sway: 1.6,
    cell: 13,
    // oaks want the gentler, cooler ground: they thin out fast on a steep face and prefer north
    chance: (slope, northness) =>
      clamp(0.95 - 1.75 * slope, 0, 1) * (0.32 + 0.68 * clamp((northness + 1) / 2, 0, 1)),
    scale: [0.72, 1.35]
  },
  {
    name: 'shrub',
    geometry: shrubGeometry(),
    sway: 0,
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

    const wet = o.wet && o.wet.length ? wetIndex(o.wet) : null;
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
          // along a creek the trees close in over the water, and the chaparral gives way to them
          const dw = wet ? wet(x, z) : Infinity;
          const riparian = dw < 28 ? 1 - dw / 28 : 0;
          const base = sp.name === 'oak' ? Math.min(1, sp.chance(slope, northness) + 0.75 * riparian) : sp.chance(slope, northness) * (1 - 0.6 * riparian);
          const p = base * density * falloff;
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

      const mat = plantMaterial(sp.sway);
      const mesh = new THREE.InstancedMesh(sp.geometry, mat, rows.length);
      mesh.customDepthMaterial = plantDepth();
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
      const mat = plantMaterial(sp.sway);
      const mesh = new THREE.InstancedMesh(sp.geometry, mat, rows.length);
      mesh.customDepthMaterial = plantDepth();
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
