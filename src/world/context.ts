// The streets and the creeks.
//
//   A property is reached by a road and drained by a creek, and a world without either is a
//   parcel floating in a green field. The atlas knows the parcel; OpenStreetMap knows the country
//   round it — Big Canyon Road twenty metres from the house, Ojai–Santa Paula Road down in the
//   valley, the driveways and fire roads, Lion Creek forty metres away in its oak-shaded bed — and
//   one small file per community carries that (public/context/<community>.json, © OpenStreetMap
//   contributors, ODbL). This lays it on the ground.
//
//   ON the ground, meaning the ground as drawn: every strip is sampled every two metres against the
//   exact triangles of whichever terrain ring is showing there (Terrain.surfaceAt), so a road never
//   sinks under the coarse ring's long spans or floats over a hollow. And because the near ring
//   follows you, the streets are laid again whenever it moves.
//
//   A creek is not where the map line says to the metre — a stream traced from an aerial wanders
//   ten metres either side of its bed. The bed, though, is in the 1 m lidar: it is the lowest ground
//   across the line. So each point of a creek slides sideways to the bottom of its own channel
//   before the water is laid, and the water runs where the water actually runs.

import * as THREE from 'three';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import type { Terrain } from './terrain';
import { surfaceMaterial, waterMaterial } from './materials';

type LL = [number, number];
export interface ContextData {
  attribution?: string;
  roads: { k: string; n?: string; s?: string; b?: number; c: LL[] }[];
  water: { k: string; n?: string; i?: number; c: LL[] }[];
  lakes: { n?: string; k?: string; c: LL[] }[];
}

/** how wide each kind of way is, and what it is made of unless its surface tag says otherwise */
const WAYS: Record<string, { w: number; m: string; paint?: 'centre' | 'edges' }> = {
  primary: { w: 8.4, m: 'asphalt', paint: 'centre' }, primary_link: { w: 5, m: 'asphalt' }, secondary: { w: 7.6, m: 'asphalt', paint: 'centre' },
  tertiary: { w: 7, m: 'asphalt', paint: 'centre' }, residential: { w: 6, m: 'asphalt' }, unclassified: { w: 5.5, m: 'asphalt' },
  living_street: { w: 5, m: 'asphalt' }, road: { w: 5, m: 'asphalt' }, service: { w: 3.6, m: 'gravel' }, track: { w: 3.2, m: 'dirt' },
  path: { w: 1.2, m: 'dirt' }, footway: { w: 1.4, m: 'dirt' }, bridleway: { w: 1.8, m: 'dirt' }
};
const SURFACE: Record<string, string> = {
  asphalt: 'asphalt', paved: 'asphalt', concrete: 'asphalt', chipseal: 'asphalt',
  gravel: 'gravel', fine_gravel: 'gravel', compacted: 'gravel', pebblestone: 'gravel',
  unpaved: 'dirt', dirt: 'dirt', ground: 'dirt', earth: 'dirt', sand: 'dirt', grass: 'dirt', mud: 'dirt'
};

export interface ContextOpts {
  /** how far from where you stand the streets are laid, metres */
  radius: number;
}

interface Built { strips: Map<string, { pos: number[]; uv: number[]; idx: number[] }> }

export class Context {
  group = new THREE.Group();
  data: ContextData | null = null;
  /** what was laid last time — the tests and the HUD read this */
  counts = { roads: 0, roadM: 0, creeks: 0, creekM: 0, lakes: 0, labels: 0 };
  /** the creeks as laid (world XZ, snapped to their beds) — the planting reads these to put trees along the water */
  creekLines: { x: number; z: number }[][] = [];
  private laidFor = -1;
  private centre = new THREE.Vector2(NaN, NaN);
  private geos: THREE.BufferGeometry[] = [];
  private labels: THREE.Sprite[] = [];

  constructor(private frame: Frame, private field: HeightField, private terrain: Terrain) {
    this.group.name = 'context';
  }

  async load(url: string): Promise<boolean> {
    try {
      const r = await fetch(url);
      if (!r.ok) return false;
      const j = await r.json();
      if (!j || !Array.isArray(j.roads) || !Array.isArray(j.water)) return false;
      this.data = { attribution: j.attribution, roads: j.roads, water: j.water, lakes: Array.isArray(j.lakes) ? j.lakes : [] };
      return true;
    } catch { return false; }
  }

  /** lay again when the near ring has moved (its triangles are what the strips lie on), or you have walked far */
  update(x: number, z: number, o: ContextOpts) {
    if (!this.data) return;
    if (this.laidFor !== this.terrain.fineVersion || !isFinite(this.centre.x) || Math.hypot(x - this.centre.x, z - this.centre.y) > o.radius * 0.35) this.lay(x, z, o);
  }

  lay(cx: number, cz: number, o: ContextOpts) {
    if (!this.data) return;
    this.dispose();
    this.laidFor = this.terrain.fineVersion;
    this.centre.set(cx, cz);
    const counts = { roads: 0, roadM: 0, creeks: 0, creekM: 0, lakes: 0, labels: 0 };
    const built: Built = { strips: new Map() };
    const near = (pts: { x: number; z: number }[]) => pts.some(p => Math.abs(p.x - cx) < o.radius && Math.abs(p.z - cz) < o.radius);
    const toXZ = (c: LL[]) => c.map(([lng, lat]) => this.frame.toWorld(lng, lat));
    const named: Map<string, { x: number; z: number; d: number; kind: 'road' | 'water' }> = new Map();

    // ---- the water first: the beds, then the water in them --------------------------------------
    this.creekLines = [];
    for (const w of this.data.water) {
      const raw = toXZ(w.c);
      if (raw.length < 2 || !near(raw)) continue;
      const line = this.snapToBed(resample(raw, 2));
      if (line.length < 2) continue;
      this.creekLines.push(line);
      const big = w.k === 'river' || w.k === 'canal';
      const bedW = big ? 9 : w.i ? 3.8 : 4.4, waterW = big ? 7 : w.i ? 1.7 : 2.6;
      const L = this.strip(built, 'creekbed', line, bedW, 0.05, 0.05, cx, cz, o.radius);
      this.strip(built, 'water', line, waterW, 0.16, 0.16, cx, cz, o.radius);
      counts.creeks++; counts.creekM += L;
      if (w.n) this.nameAt(named, w.n, line, cx, cz, 'water');
    }
    // ---- ponds -------------------------------------------------------------------------------------
    for (const l of this.data.lakes) {
      const ring = toXZ(l.c);
      if (ring.length < 4 || !near(ring)) continue;
      let lo = Infinity;
      for (const p of ring) { const h = this.terrain.surfaceAt(p.x, p.z); if (h != null) lo = Math.min(lo, h); }
      if (!isFinite(lo)) continue;
      const shape = new THREE.Shape(ring.map(p => new THREE.Vector2(p.x, p.z)));
      const g = new THREE.ShapeGeometry(shape);
      g.rotateX(Math.PI / 2);
      g.translate(0, lo + 0.2, 0);
      const pos = g.getAttribute('position') as THREE.BufferAttribute;
      g.computeVertexNormals();
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i), pos.getZ(i));
      const mesh = new THREE.Mesh(g, waterMaterial());
      mesh.name = 'context:pond';
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.geos.push(g);
      counts.lakes++;
    }

    // ---- the streets --------------------------------------------------------------------------------
    for (const r of this.data.roads) {
      const raw = toXZ(r.c);
      if (raw.length < 2 || !near(raw)) continue;
      const way = WAYS[r.k] ?? WAYS.road;
      const mat = (r.s && SURFACE[r.s]) || way.m;
      const line = resample(raw, 2);
      // a bridge is level between its ends; the lidar under it is the creek it crosses
      const flat = r.b ? [this.terrain.surfaceAt(line[0].x, line[0].z), this.terrain.surfaceAt(line[line.length - 1].x, line[line.length - 1].z)] : null;
      const L = this.strip(built, mat, line, way.w, 0.1, 0.08, cx, cz, o.radius, flat && flat[0] != null && flat[1] != null ? [flat[0], flat[1]] : undefined);
      if (way.paint === 'centre' && mat === 'asphalt') {
        // a double yellow down the middle, and white edge lines
        this.strip(built, 'paint', offset(line, 0.12), 0.1, 0.13, 0.13, cx, cz, o.radius);
        this.strip(built, 'paint', offset(line, -0.12), 0.1, 0.13, 0.13, cx, cz, o.radius);
        this.strip(built, 'paint_white', offset(line, way.w / 2 - 0.35), 0.1, 0.13, 0.13, cx, cz, o.radius);
        this.strip(built, 'paint_white', offset(line, -(way.w / 2 - 0.35)), 0.1, 0.13, 0.13, cx, cz, o.radius);
      }
      counts.roads++; counts.roadM += L;
      if (r.n) this.nameAt(named, r.n, line, cx, cz, 'road');
    }

    // one mesh per surface
    for (const [mat, s] of built.strips) {
      if (!s.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(s.uv, 2));
      g.setIndex(s.idx);
      g.computeVertexNormals();
      const m = mat === 'water' ? waterMaterial() : groundMaterial(mat);
      const mesh = new THREE.Mesh(g, m);
      mesh.name = `context:${mat}`;
      mesh.receiveShadow = true;
      mesh.renderOrder = mat === 'water' ? 2 : mat.startsWith('paint') ? 1 : 0;
      this.group.add(mesh);
      this.geos.push(g);
    }

    // names, where the eye can use them: one per street or creek, at its nearest point to you
    for (const [name, at] of named) {
      if (at.d > Math.min(o.radius, 900) || this.labels.length >= 40) continue;
      const h = this.terrain.surfaceAt(at.x, at.z);
      if (h == null) continue;
      const sp = label(name, at.kind);
      sp.position.set(at.x, h + (at.kind === 'road' ? 3 : 2.4), at.z);
      this.group.add(sp);
      this.labels.push(sp);
    }
    counts.labels = this.labels.length;
    counts.roadM = Math.round(counts.roadM); counts.creekM = Math.round(counts.creekM);
    this.counts = counts;
  }

  /** what is not grass: every street and creek bed laid, with its half width — the grass keeps off them */
  bare(): { pts: { x: number; z: number }[]; half: number }[] {
    if (!this.data) return [];
    const out: { pts: { x: number; z: number }[]; half: number }[] = [];
    for (const line of this.creekLines) out.push({ pts: line, half: 2.3 });
    for (const r of this.data.roads) {
      const w = (WAYS[r.k] ?? WAYS.road).w;
      out.push({ pts: r.c.map(([lng, lat]) => this.frame.toWorld(lng, lat)), half: w / 2 + 0.2 });
    }
    return out;
  }

  /** slide each point of a creek to the lowest ground within eight metres across its line, then smooth the slide */
  private snapToBed(line: { x: number; z: number }[]): { x: number; z: number }[] {
    const n = line.length;
    const shift: number[] = new Array(n).fill(0);
    const nrm = line.map((_p, i) => {
      const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      return { x: -dz / l, z: dx / l };
    });
    for (let i = 0; i < n; i++) {
      let best = Infinity, at = 0;
      for (let s = -8; s <= 8; s += 0.5) {
        const x = line[i].x + nrm[i].x * s, z = line[i].z + nrm[i].z * s;
        const ll = this.frame.toLngLat(x, z);
        const h = this.field.atOr(ll.lng, ll.lat, NaN);
        // a slight preference for the mapped line, so a flat meadow does not send the creek wandering
        const score = h + Math.abs(s) * 0.02;
        if (isFinite(h) && score < best) { best = score; at = s; }
      }
      shift[i] = at;
    }
    const sm = shift.map((_, i) => { let t = 0, c = 0; for (let k = -3; k <= 3; k++) { const j = i + k; if (j >= 0 && j < n) { t += shift[j]; c++; } } return t / c; });
    return line.map((p, i) => ({ x: p.x + nrm[i].x * sm[i], z: p.z + nrm[i].z * sm[i] }));
  }

  /** remember where a name is nearest you, so its label goes where you will see it */
  private nameAt(named: Map<string, { x: number; z: number; d: number; kind: 'road' | 'water' }>, name: string, line: { x: number; z: number }[], cx: number, cz: number, kind: 'road' | 'water') {
    for (const p of line) {
      const d = Math.hypot(p.x - cx, p.z - cz);
      const have = named.get(name);
      if (!have || d < have.d) named.set(name, { x: p.x, z: p.z, d, kind });
    }
  }

  /**
   * A strip `width` wide along a line, on the drawn ground, lifted a little (more with distance, so the
   * coarse ring's long spans never swallow it). Returns the length laid, metres.
   */
  private strip(built: Built, mat: string, line: { x: number; z: number }[], width: number, lift: number, liftCentre: number, cx: number, cz: number, radius: number, flat?: [number, number]): number {
    let s = built.strips.get(mat);
    if (!s) { s = { pos: [], uv: [], idx: [] }; built.strips.set(mat, s); }
    const half = width / 2;
    let along = 0, laid = 0, prevOk = false;
    const n = line.length;
    const total = line.reduce((acc, p, i) => i ? acc + Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z) : 0, 0);
    for (let i = 0; i < n; i++) {
      const p = line[i];
      if (i) along += Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z);
      const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      const d = Math.hypot(p.x - cx, p.z - cz);
      const inRange = d < radius;
      const extra = d > 300 ? Math.min(0.9, (d - 300) / 1500) : 0;
      const lx = p.x + nx * half, lz = p.z + nz * half, rx = p.x - nx * half, rz = p.z - nz * half;
      let hl = this.terrain.surfaceAt(lx, lz), hr = this.terrain.surfaceAt(rx, rz), hc = this.terrain.surfaceAt(p.x, p.z);
      if (flat) { const t = total > 0 ? along / total : 0; hl = hr = hc = flat[0] + (flat[1] - flat[0]) * t; }
      const ok = inRange && hl != null && hr != null && hc != null;
      if (ok) {
        const base = s.pos.length / 3;
        const yc = Math.max(hc!, (hl! + hr!) / 2) + liftCentre + extra;
        s.pos.push(lx, hl! + lift + extra, lz, p.x, yc, p.z, rx, hr! + lift + extra, rz);
        s.uv.push(0, along, half, along, width, along);
        if (prevOk) {
          const q = base - 3;
          // wound so the strip faces the sky
          s.idx.push(q, base, q + 1, base, base + 1, q + 1, q + 1, base + 1, q + 2, base + 1, base + 2, q + 2);
          laid += Math.hypot(p.x - line[i - 1].x, p.z - line[i - 1].z);
        }
      }
      prevOk = ok;
    }
    return laid;
  }

  dispose() {
    for (const o of this.group.children.slice()) this.group.remove(o);
    for (const g of this.geos) g.dispose();
    for (const l of this.labels) { l.material.map?.dispose(); l.material.dispose(); }
    this.geos = [];
    this.labels = [];
  }
}

/** a line's points about `step` apart */
function resample(pts: { x: number; z: number }[], step: number): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const l = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.ceil(l / step));
    for (let j = 1; j <= k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, z: a.z + ((b.z - a.z) * j) / k });
  }
  return out;
}

/** a line moved sideways by `d` metres (left of travel is positive) */
function offset(line: { x: number; z: number }[], d: number): { x: number; z: number }[] {
  const n = line.length;
  return line.map((p, i) => {
    const a = line[Math.max(0, i - 1)], b = line[Math.min(n - 1, i + 1)];
    const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
    return { x: p.x - (dz / l) * d, z: p.z + (dx / l) * d };
  });
}

/** the street surfaces, with a polygon offset so they win against the ground they lie on */
const groundMats = new Map<string, THREE.Material>();
function groundMaterial(name: string): THREE.Material {
  const have = groundMats.get(name);
  if (have) return have;
  const base = surfaceMaterial(name, 'gravel') as THREE.MeshStandardMaterial;
  const m = base.clone();
  m.side = THREE.FrontSide;
  m.polygonOffset = true;
  m.polygonOffsetFactor = name.startsWith('paint') ? -4 : -2;
  m.polygonOffsetUnits = name.startsWith('paint') ? -4 : -2;
  groundMats.set(name, m);
  return m;
}

function label(text: string, kind: 'road' | 'water'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 72;
  const g = c.getContext('2d')!;
  g.font = '600 34px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
  const w = Math.min(500, g.measureText(text).width + 36);
  g.fillStyle = kind === 'water' ? 'rgba(20,48,60,0.78)' : 'rgba(18,20,22,0.72)';
  g.beginPath(); g.roundRect((512 - w) / 2, 6, w, 60, 30); g.fill();
  g.fillStyle = kind === 'water' ? '#bfe6f2' : '#f2efe6';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 256, 38);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set(14, 14 * 72 / 512, 1);
  sp.name = `label:${text}`;
  return sp;
}
