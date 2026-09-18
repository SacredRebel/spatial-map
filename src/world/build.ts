// Construction: walls, floors, roofs, at real size.
//
//   A building here is not a model dropped on the ground; it is PARTS, each one a feature of the
//   pack's edits layer with a real geometry in longitude and latitude and real dimensions in
//   metres. A wall is a line with a height and a thickness, straight or smoothed into a curve, with
//   doors and windows cut where they are asked for. A floor is a polygon with a level and a
//   thickness, and you stand on it. A roof is a polygon with a form — flat, shed, gable, hip, or
//   a vault — an eaves height and a pitch. Because they are parts, a wall can be moved, extended,
//   cut through or taken out on its own, the way a Sims house or a construction site works, and
//   because they are metres on the survey, the question "would this fit" is answered by walking
//   round it.
//
//   Nothing here touches the ground: a wall's bottom is the lowest ground along it (the way a
//   footing goes in) and a floor sits on the lowest ground under it; if the site is a slope, the
//   ground tool flattens a pad first, which is what a builder does too.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import type { Solid } from './collide';
import type { Feature, PackData } from './pack';

export interface Opening { kind: 'door' | 'window'; at_m: number; width_m: number; sill_m: number; head_m: number }
/** something you can stand on: a floor, a deck */
export interface Platform { id: string; ring: { x: number; z: number }[]; top: number }

export interface BuildCounts { walls: number; floors: number; roofs: number; openings: number }

/** the palette, by material name: what a wall or a roof looks like until a real texture arrives */
export const MATERIALS: Record<string, { colour: string; glass?: boolean }> = {
  plaster: { colour: '#e8e2d4' }, lime: { colour: '#f1ece1' }, wood: { colour: '#a67c52' }, timber: { colour: '#8b6a45' },
  stone: { colour: '#9a948a' }, earth: { colour: '#b08a63' }, adobe: { colour: '#c9a27a' }, concrete: { colour: '#b9b5ae' },
  glass: { colour: '#bcd8e6', glass: true }, metal: { colour: '#9aa0a3' }, tile: { colour: '#a3563b' }, thatch: { colour: '#c2a35a' },
  shingle: { colour: '#6b625a' }, living: { colour: '#7da65a' }
};
export const MATERIAL_NAMES = Object.keys(MATERIALS);
export const ROOF_FORMS = ['flat', 'shed', 'gable', 'hip', 'vault'] as const;
export type RoofForm = typeof ROOF_FORMS[number];

const STEP = 0.5;          // a curve is sampled this often
type XZ = { x: number; z: number };

/** an opening as the feature carries it, reduced to numbers that make sense on a wall of this length and height */
export function cleanOpenings(raw: unknown, length: number, height: number): Opening[] {
  if (!Array.isArray(raw)) return [];
  const out: Opening[] = [];
  for (const o of raw as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object') continue;
    const kind = o.kind === 'window' ? 'window' : 'door';
    const width = Math.min(length - 0.1, Math.max(0.3, Number(o.width_m) || (kind === 'door' ? 0.9 : 1.2)));
    const at = Math.min(length - width / 2 - 0.05, Math.max(width / 2 + 0.05, Number(o.at_m) || 0));
    let sill = kind === 'door' ? 0 : Math.max(0, Number(o.sill_m) || 0.9);
    let head = Math.min(height - 0.05, Math.max(sill + 0.3, Number(o.head_m) || (kind === 'door' ? 2.1 : 2.1)));
    if (sill >= head - 0.3) { sill = Math.max(0, head - 0.3); }
    if (kind === 'door') sill = 0;
    if (head <= sill + 0.2 || width <= 0.3 || at < 0) continue;
    // an opening over another is a mess; keep the first
    if (out.some(p => Math.abs(p.at_m - at) < (p.width_m + width) / 2 + 0.05)) continue;
    out.push({ kind, at_m: at, width_m: width, sill_m: sill, head_m: head });
  }
  return out.sort((a, b) => a.at_m - b.at_m);
}

/** the wall's centreline in world metres: the points as given, or a curve through them sampled every half metre */
export function wallLine(coords: [number, number][], smooth: boolean, frame: Frame): XZ[] {
  const pts: XZ[] = [];
  for (const [lng, lat] of coords) {
    const w = frame.toWorld(lng, lat);
    if (!pts.length || Math.hypot(w.x - pts[pts.length - 1].x, w.z - pts[pts.length - 1].z) > 1e-3) pts.push({ x: w.x, z: w.z });
  }
  if (!smooth || pts.length < 3) return pts;
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p.x, 0, p.z)), false, 'centripetal', 0.5);
  const n = Math.max(8, Math.ceil(curve.getLength() / STEP));
  return curve.getSpacedPoints(n).map(p => ({ x: p.x, z: p.z }));
}

/** a polyline you can ask for the point and the outward direction at any distance along it */
export class Along {
  cum: number[] = [0];
  total = 0;
  /** the normal at each vertex: the segment's, or at a joint the mitre of the two, so offset faces meet */
  private vn: XZ[] = [];
  private sn: XZ[] = [];
  constructor(public pts: XZ[]) {
    for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    this.total = this.cum[this.cum.length - 1];
    for (let i = 0; i < pts.length - 1; i++) {
      const dx = pts[i + 1].x - pts[i].x, dz = pts[i + 1].z - pts[i].z, l = Math.hypot(dx, dz) || 1;
      this.sn.push({ x: -dz / l, z: dx / l });
    }
    // a line that comes back to its start is a closed room: its first vertex is a corner like the others
    const closed = pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1e-3;
    for (let i = 0; i < pts.length; i++) {
      const a = closed && i === 0 ? this.sn[this.sn.length - 1] : this.sn[Math.max(0, i - 1)];
      const b = closed && i === pts.length - 1 ? this.sn[0] : this.sn[Math.min(this.sn.length - 1, i)];
      let x = a.x + b.x, z = a.z + b.z;
      const l = Math.hypot(x, z);
      if (l < 1e-6) { this.vn.push(b); continue; }
      x /= l; z /= l;
      const cos = x * b.x + z * b.z;                       // the mitre is longer round a sharp corner, within reason
      const k = 1 / Math.max(0.5, cos);
      this.vn.push({ x: x * k, z: z * k });
    }
  }
  /** the segment index a distance falls in */
  seg(s: number): number {
    let i = 0;
    while (i < this.cum.length - 2 && s > this.cum[i + 1]) i++;
    return i;
  }
  at(s: number): { x: number; z: number; nx: number; nz: number } {
    const i = this.seg(s);
    const a = this.pts[i], b = this.pts[i + 1];
    const len = this.cum[i + 1] - this.cum[i];
    const t = len > 0 ? Math.max(0, Math.min(1, (s - this.cum[i]) / len)) : 0;
    const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
    // at a joint the mitre; strictly inside a segment its own normal
    const eps = 1e-4;
    const n = Math.abs(s - this.cum[i]) < eps ? this.vn[i] : Math.abs(s - this.cum[i + 1]) < eps ? this.vn[i + 1] : this.sn[i];
    return { x, z, nx: n.x, nz: n.z };
  }
}

/**
 * The wall as geometry: its elevation drawn as a shape in (distance along, height) with the doors
 * notched out of the bottom edge and the windows as holes, extruded to its thickness, and every
 * vertex then carried to its place on the centreline — so the same code makes a straight wall and a
 * curved one, and the doors and windows sit in the curve.
 *
 * One piece per segment of the centreline. The triangulation of a profile is free to join any two
 * of its corners, and a triangle whose corners land on different segments would be a plane cutting
 * across the room; a piece that spans one segment maps to one plane, exactly. At a joint the pieces
 * share the mitred edge, so a corner closes.
 */
export function wallGeometry(along: Along, base: number, height: number, thick: number, openings: Opening[]): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  const IN = 0.01;                                        // an opening keeps this much clear of a joint, so no hole touches an edge
  for (let i = 0; i < along.pts.length - 1; i++) {
    const a = along.cum[i], b = along.cum[i + 1];
    if (b - a < 0.02) continue;
    const clip = (o: Opening): [number, number] | null => {
      const x0 = Math.max(a + IN, o.at_m - o.width_m / 2), x1 = Math.min(b - IN, o.at_m + o.width_m / 2);
      return x1 - x0 > 0.02 ? [x0, x1] : null;
    };
    const shape = new THREE.Shape();
    shape.moveTo(a, 0);
    const doors = openings.filter(o => o.sill_m <= 0.01).map(o => ({ r: clip(o), head: Math.min(height - 0.02, o.head_m) })).filter(d => d.r).sort((p, q) => p.r![0] - q.r![0]);
    let last = a;
    for (const d of doors) {
      const [x0, x1] = d.r!;
      if (x0 <= last + IN) continue;
      shape.lineTo(x0, 0); shape.lineTo(x0, d.head); shape.lineTo(x1, d.head); shape.lineTo(x1, 0);
      last = x1;
    }
    shape.lineTo(b, 0); shape.lineTo(b, height); shape.lineTo(a, height); shape.closePath();
    for (const o of openings) {
      if (o.sill_m <= 0.01) continue;
      const r = clip(o);
      if (!r) continue;
      const head = Math.min(height - IN, o.head_m), sill = Math.max(IN, o.sill_m);
      if (head - sill < 0.05) continue;
      const hole = new THREE.Path();
      hole.moveTo(r[0], sill); hole.lineTo(r[1], sill); hole.lineTo(r[1], head); hole.lineTo(r[0], head); hole.closePath();
      shape.holes.push(hole);
    }
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false, steps: 1 });
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = new Float32Array(pos.count * 2);
    for (let k = 0; k < pos.count; k++) {
      const s = Math.max(a, Math.min(b, pos.getX(k))), y = pos.getY(k), off = pos.getZ(k) - thick / 2;
      const p = along.at(s);
      pos.setXYZ(k, p.x + p.nx * off, base + y, p.z + p.nz * off);
      uv[k * 2] = s; uv[k * 2 + 1] = y;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.deleteAttribute('normal');
    pieces.push(geo);
  }
  const geo = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces, false) ?? new THREE.BufferGeometry();
  if (pieces.length > 1) for (const p of pieces) p.dispose();
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** the runs of the wall a body cannot pass: everything but the doors, as one prism per run */
export function wallSolids(id: string, along: Along, base: number, height: number, thick: number, openings: Opening[]): Solid[] {
  const L = along.total;
  const doors = openings.filter(o => o.sill_m <= 0.01 && o.head_m >= 1.2);
  const cuts: [number, number][] = doors.map(d => [d.at_m - d.width_m / 2, d.at_m + d.width_m / 2]);
  const runs: [number, number][] = [];
  let s = 0;
  for (const [a, b] of cuts) { if (a > s + 0.05) runs.push([s, a]); s = Math.max(s, b); }
  if (L > s + 0.05) runs.push([s, L]);
  const out: Solid[] = [];
  const half = thick / 2;
  for (const [a, b] of runs) {
    const stops = [a, ...along.cum.filter(c => c > a + 1e-4 && c < b - 1e-4), b];
    const left = stops.map(c => { const p = along.at(c); return { x: p.x + p.nx * half, z: p.z + p.nz * half }; });
    const right = stops.map(c => { const p = along.at(c); return { x: p.x - p.nx * half, z: p.z - p.nz * half }; }).reverse();
    out.push({ id, ring: left.concat(right), base, top: base + height });
  }
  return out;
}

/** the oriented box round a ring: the axis (from `deg`, or the longest edge), and the extents along and across it */
function orientedBox(ring: XZ[], deg?: number): { u: XZ; v: XZ; u0: number; u1: number; v0: number; v1: number } {
  let u: XZ;
  if (deg != null && isFinite(deg)) { const a = deg * Math.PI / 180; u = { x: Math.sin(a), z: -Math.cos(a) }; }   // a compass bearing: 0 is north (−z)
  else {
    let best = -1; u = { x: 1, z: 0 };
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const l = Math.hypot(b.x - a.x, b.z - a.z);
      if (l > best) { best = l; u = { x: (b.x - a.x) / l, z: (b.z - a.z) / l }; }
    }
  }
  const v = { x: -u.z, z: u.x };
  let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
  for (const p of ring) {
    const a = p.x * u.x + p.z * u.z, b = p.x * v.x + p.z * v.z;
    u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
  }
  return { u, v, u0, u1, v0, v1 };
}

export class Build {
  group = new THREE.Group();
  solids: Solid[] = [];
  platforms: Platform[] = [];
  counts: BuildCounts = { walls: 0, floors: 0, roofs: 0, openings: 0 };
  private disposables: (THREE.BufferGeometry | THREE.Material)[] = [];

  constructor(private frame: Frame, private field: HeightField) {
    this.group.name = 'build';
  }

  build(pack: PackData) {
    this.dispose();
    for (const f of pack.build.features) {
      const kind = String(f.properties.kind || '');
      try {
        if (kind === 'wall' && f.geometry.type === 'LineString') this.wall(f);
        else if (kind === 'floor' && f.geometry.type === 'Polygon') this.floor(f);
        else if (kind === 'roof' && f.geometry.type === 'Polygon') this.roof(f);
      } catch (e) { console.info('[world] build ' + f.properties.id, e); }
    }
  }

  private material(name: unknown, fallback = 'plaster'): THREE.MeshLambertMaterial {
    const m = MATERIALS[String(name)] ?? MATERIALS[fallback];
    // a little self-light, so a room with its roof on is dim rather than black until interiors are lit properly
    const mat = new THREE.MeshLambertMaterial({ color: m.colour, emissive: m.colour, emissiveIntensity: 0.22, side: THREE.DoubleSide, transparent: !!m.glass, opacity: m.glass ? 0.38 : 1, depthWrite: !m.glass });
    this.disposables.push(mat);
    return mat;
  }

  /** the lowest ground along a set of lng/lat points: where a footing goes */
  private lowest(coords: [number, number][]): number {
    let base = Infinity;
    for (const [lng, lat] of coords) { const h = this.field.atOr(lng, lat, NaN); if (isFinite(h) && h < base) base = h; }
    return isFinite(base) ? base : 0;
  }

  private ringXZ(coords: [number, number][]): XZ[] {
    const pts = coords.map(([lng, lat]) => { const w = this.frame.toWorld(lng, lat); return { x: w.x, z: w.z }; });
    if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1e-6) pts.pop();
    return pts;
  }

  private wall(f: Feature) {
    if (f.geometry.type !== 'LineString') return;
    const p = f.properties;
    const id = String(p.id || this.counts.walls);
    const line = wallLine(f.geometry.coordinates, !!p.smooth, this.frame);
    if (line.length < 2) return;
    const along = new Along(line);
    if (along.total < 0.2) return;
    const height = Math.min(12, Math.max(0.3, Number(p.height_m) || 2.7));
    const thick = Math.min(1.5, Math.max(0.05, Number(p.thick_m) || 0.25));
    const base = this.lowest(f.geometry.coordinates) + (Number(p.base_m) || 0);
    const openings = cleanOpenings(p.openings, along.total, height);
    const geo = wallGeometry(along, base, height, thick, openings);
    const mesh = new THREE.Mesh(geo, this.material(p.material));
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = `build:${id}`;
    this.group.add(mesh);
    this.disposables.push(geo);
    this.solids.push(...wallSolids(id, along, base, height, thick, openings));
    this.counts.walls++;
    this.counts.openings += openings.length;
  }

  private floor(f: Feature) {
    if (f.geometry.type !== 'Polygon') return;
    const p = f.properties;
    const id = String(p.id || this.counts.floors);
    const coords = f.geometry.coordinates[0] || [];
    const ring = this.ringXZ(coords);
    if (ring.length < 3) return;
    const thick = Math.min(1, Math.max(0.05, Number(p.thick_m) || 0.2));
    const level = Number(p.level_m) || 0;
    const bottom = this.lowest(coords) + level;
    const shape = new THREE.Shape(ring.map(q => new THREE.Vector2(q.x, q.z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);                 // the extrusion grows in +z; lay it flat, growing down from y = 0
    const mesh = new THREE.Mesh(geo, this.material(p.material, 'wood'));
    mesh.position.y = bottom + thick;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.name = `build:${id}`;
    this.group.add(mesh);
    this.disposables.push(geo);
    this.platforms.push({ id, ring, top: bottom + thick });
    this.counts.floors++;
  }

  private roof(f: Feature) {
    if (f.geometry.type !== 'Polygon') return;
    const p = f.properties;
    const id = String(p.id || this.counts.roofs);
    const coords = f.geometry.coordinates[0] || [];
    const ring = this.ringXZ(coords);
    if (ring.length < 3) return;
    const form = (ROOF_FORMS as readonly string[]).includes(String(p.form)) ? String(p.form) as RoofForm : 'gable';
    const eaves = this.lowest(coords) + Math.min(30, Math.max(0.5, Number(p.eaves_m) || 3));
    const pitch = Math.min(60, Math.max(0, Number(p.pitch_deg ?? 25))) * Math.PI / 180;
    const over = Math.min(3, Math.max(0, Number(p.overhang_m ?? 0.5)));
    const t = 0.15;
    const box = orientedBox(ring, p.ridge_deg == null ? undefined : Number(p.ridge_deg));
    const u0 = box.u0 - over, u1 = box.u1 + over, v0 = box.v0 - over, v1 = box.v1 + over;
    const hw = (v1 - v0) / 2, vm = (v0 + v1) / 2;
    const rise = form === 'flat' ? 0 : form === 'shed' ? Math.tan(pitch) * (v1 - v0) : Math.tan(pitch) * hw;
    const g = new THREE.Group();
    g.name = `build:${id}`;
    const mat = this.material(p.material, form === 'vault' ? 'metal' : 'tile');
    if (form === 'hip') {
      // four planes from the eaves to a ridge shortened by the half width at each end (a pyramid on a square)
      const A = [u0, v0], B = [u1, v0], C = [u1, v1], D = [u0, v1];
      const ru0 = Math.min(u0 + hw, (u0 + u1) / 2), ru1 = Math.max(u1 - hw, (u0 + u1) / 2);
      const R1 = [ru0, vm], R2 = [ru1, vm];
      const P = (uv: number[], y: number) => [box.u.x * uv[0] + box.v.x * uv[1], y, box.u.z * uv[0] + box.v.z * uv[1]];
      const top = eaves + rise;
      const tri: number[] = [];
      const quad = (a: number[], b: number[], c: number[], d: number[]) => tri.push(...a, ...b, ...c, ...a, ...c, ...d);
      quad(P(A, eaves), P(B, eaves), P(R2, top), P(R1, top));
      tri.push(...P(B, eaves), ...P(C, eaves), ...P(R2, top));
      quad(P(C, eaves), P(D, eaves), P(R1, top), P(R2, top));
      tri.push(...P(D, eaves), ...P(A, eaves), ...P(R1, top));
      const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      g.add(mesh);
      this.disposables.push(geo);
    } else {
      // the cross-section across the roof, in (across, up), extruded along the ridge
      const s = new THREE.Shape();
      if (form === 'flat') { s.moveTo(v0, eaves); s.lineTo(v1, eaves); s.lineTo(v1, eaves + t); s.lineTo(v0, eaves + t); }
      else if (form === 'shed') { s.moveTo(v0, eaves); s.lineTo(v1, eaves + rise); s.lineTo(v1, eaves + rise + t); s.lineTo(v0, eaves + t); }
      else if (form === 'gable') { s.moveTo(v0, eaves); s.lineTo(vm, eaves + rise); s.lineTo(v1, eaves); s.lineTo(v1, eaves + t); s.lineTo(vm, eaves + rise + t); s.lineTo(v0, eaves + t); }
      else {
        // a vault: an elliptical arc, its rise set by the pitch at the eaves
        const n = 24;
        for (let i = 0; i <= n; i++) { const x = -1 + 2 * i / n; const y = eaves + rise * Math.sqrt(Math.max(0, 1 - x * x)); if (i === 0) s.moveTo(vm + x * hw, y); else s.lineTo(vm + x * hw, y); }
        for (let i = n; i >= 0; i--) { const x = -1 + 2 * i / n; s.lineTo(vm + x * hw, eaves + t + rise * Math.sqrt(Math.max(0, 1 - x * x))); }
      }
      s.closePath();
      const geo = new THREE.ExtrudeGeometry(s, { depth: u1 - u0, bevelEnabled: false, steps: 1 });
      // the shape's x is across (v), its y is up, the extrusion runs along the ridge (u), starting at u0
      const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(box.v.x, 0, box.v.z), new THREE.Vector3(0, 1, 0), new THREE.Vector3(box.u.x, 0, box.u.z));
      m.setPosition(box.u.x * u0, 0, box.u.z * u0);
      geo.applyMatrix4(m);
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      g.add(mesh);
      this.disposables.push(geo);
      if (form === 'gable' && p.gable_walls !== false) {
        // the triangles under the ridge at each end, at the ring's own edge, in the wall's material
        const tri: number[] = [];
        const P = (uu: number, vv: number, y: number) => [box.u.x * uu + box.v.x * vv, y, box.u.z * uu + box.v.z * vv];
        // a pentagon: up the wall line to where the roof's underside crosses it, then along that to the ridge
        const y0 = eaves + Math.tan(pitch) * over, top = eaves + rise, e = eaves - 0.02;
        for (const uu of [box.u0, box.u1]) {
          tri.push(...P(uu, box.v0, e), ...P(uu, box.v0, y0), ...P(uu, vm, top));
          tri.push(...P(uu, box.v0, e), ...P(uu, vm, top), ...P(uu, box.v1, y0));
          tri.push(...P(uu, box.v0, e), ...P(uu, box.v1, y0), ...P(uu, box.v1, e));
        }
        const geo2 = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(tri, 3));
        geo2.computeVertexNormals();
        const ends = new THREE.Mesh(geo2, this.material(p.gable_material ?? 'plaster'));
        ends.castShadow = true;
        g.add(ends);
        this.disposables.push(geo2);
      }
    }
    this.group.add(g);
    this.counts.roofs++;
  }

  dispose() {
    for (const o of this.group.children.slice()) this.group.remove(o);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.solids = [];
    this.platforms = [];
    this.counts = { walls: 0, floors: 0, roofs: 0, openings: 0 };
  }
}
