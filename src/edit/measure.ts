// Measuring: every length and area in the world, the way a builder and an appraiser read them.
//
//   The world is in true metres (world/geo.ts: WGS84 at the origin, checked against the surveyor's
//   boundary calls), so a wall drawn 32′ 6″ long here IS 32′ 6″ on the ground, and on any map that
//   measures the ground properly. This file only reads those metres out loud and back in:
//
//   - lengths as feet-and-inches to the half inch, and as metres, whichever the owner reads first;
//   - a length typed as a builder would say it — 32'6", 32.5', 9.9m, 20 — back into metres;
//   - square footage the way ANSI Z765 counts a house: GROSS to the outside face of the outside
//     walls, NET inside them, and a level whose ceiling is under 7 ft not counted as finished area.
//
//   Nothing here knows about three.js; points are { x: east, z: south } metres, as the world has them.

import type { Feature } from '../world/pack';

export type Units = 'ft' | 'm';
export interface XZ { x: number; z: number }

const FT = 0.3048;
const INCH = 0.0254;
/** ANSI Z765: a ceiling lower than this is not finished living area */
export const MIN_CEILING_M = 7 * FT;

// ---- reading numbers out ---------------------------------------------------------------------------

/** 9.906 → 32′ 6″ ; to the half inch under 100 ft, to the inch above */
export function feetInches(m: number): string {
  const neg = m < 0;
  const step = Math.abs(m) < 100 * FT ? 0.5 : 1;
  let inches = Math.round(Math.abs(m) / INCH / step) * step;
  let ft = Math.floor(inches / 12 + 1e-9);
  inches -= ft * 12;
  if (inches >= 12 - 1e-9) { ft += 1; inches = 0; }
  const whole = Math.floor(inches + 1e-9);
  const half = inches - whole > 0.25 ? '½' : '';
  // under a foot, inches alone: a wall 10″ thick, not 0′ 10″
  return ft === 0 ? `${neg ? '−' : ''}${whole}${half}″` : `${neg ? '−' : ''}${ft}′ ${whole}${half}″`;
}

export function metres(m: number): string {
  const a = Math.abs(m);
  return `${a < 10 ? m.toFixed(2) : a < 1000 ? m.toFixed(1) : Math.round(m).toLocaleString('en-US')} m`;
}

/** a length in the owner's units first, the other after: "32′ 6″ · 9.91 m" */
export function fmtLen(m: number, units: Units, both = true): string {
  const a = units === 'ft' ? feetInches(m) : metres(m);
  if (!both) return a;
  return `${a} · ${units === 'ft' ? metres(m) : feetInches(m)}`;
}

export function sqft(m2: number): string { return `${Math.round(m2 / (FT * FT)).toLocaleString('en-US')} sq ft`; }
export function sqm(m2: number): string { return `${m2 < 100 ? m2.toFixed(1) : Math.round(m2).toLocaleString('en-US')} m²`; }

/** an area in the owner's units first: "4,982 sq ft · 462.8 m²" */
export function fmtArea(m2: number, units: Units, both = true): string {
  const a = units === 'ft' ? sqft(m2) : sqm(m2);
  return both ? `${a} · ${units === 'ft' ? sqm(m2) : sqft(m2)}` : a;
}

/** a level by its height: the ground floor, so far up, or so far down */
export function levelName(level: number, units: Units): string {
  if (Math.abs(level) < 0.01) return 'ground';
  return level > 0 ? `${fmtLen(level, units, false)} up` : `${fmtLen(-level, units, false)} down`;
}

/** a compass bearing, clockwise from north, for the segment a → b */
export function bearing(a: XZ, b: XZ): number {
  const deg = Math.atan2(b.x - a.x, -(b.z - a.z)) * 180 / Math.PI;
  return (deg + 360) % 360;
}

// ---- reading numbers in ----------------------------------------------------------------------------

/**
 * A length as someone would type it, in metres, or null.
 *   32'6"  32' 6  32'  32.5'  32ft 6in  32 ft  6"  9.9m  990cm  20  (a bare number is in `units`)
 */
export function parseLength(raw: string, units: Units): number | null {
  const s = raw.trim().toLowerCase().replace(/[′’‘`]/g, "'").replace(/[″“”]/g, '"').replace(/''/g, '"').replace(/\s+/g, ' ');
  if (!s) return null;
  const num = '(\\d+(?:\\.\\d*)?|\\.\\d+)';
  let m: RegExpExecArray | null;
  const ok = (v: number) => (isFinite(v) && v > 0 ? v : null);
  if ((m = new RegExp(`^${num} ?(m|meters?|metres?)$`).exec(s))) return ok(Number(m[1]));
  if ((m = new RegExp(`^${num} ?cm$`).exec(s))) return ok(Number(m[1]) / 100);
  if ((m = new RegExp(`^${num} ?mm$`).exec(s))) return ok(Number(m[1]) / 1000);
  if ((m = new RegExp(`^${num} ?('|ft|feet|foot)(?: ?-? ?${num} ?("|in|inch|inches)?)?$`).exec(s))) return ok(Number(m[1]) * FT + (m[3] ? Number(m[3]) * INCH : 0));
  if ((m = new RegExp(`^${num} ?("|in|inch|inches)$`).exec(s))) return ok(Number(m[1]) * INCH);
  if ((m = new RegExp(`^${num}$`).exec(s))) return ok(Number(m[1]) * (units === 'ft' ? FT : 1));
  return null;
}

/** an area as typed — "5000", "5,000 sq ft", "465 m2" — in square metres, or null */
export function parseArea(raw: string, units: Units): number | null {
  const s = raw.trim().toLowerCase().replace(/,/g, '').replace(/\s+/g, ' ');
  const m = /^(\d+(?:\.\d*)?)\s*(sq ?ft|sf|ft2|ft²|sqft|m2|m²|sq ?m|sqm)?$/.exec(s);
  if (!m) return null;
  const v = Number(m[1]);
  if (!isFinite(v) || v <= 0) return null;
  const unit = m[2] ? (/m/.test(m[2].replace('sq', '')) && !/ft|sf/.test(m[2]) ? 'm' : 'ft') : units;
  return unit === 'ft' ? v * FT * FT : v;
}

// ---- plane geometry ----------------------------------------------------------------------------------

export function signedArea(r: XZ[]): number {
  let a = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; a += p.x * q.z - q.x * p.z; }
  return a / 2;
}
export const area = (r: XZ[]) => Math.abs(signedArea(r));
export function perimeter(r: XZ[], closed = true): number {
  let l = 0;
  for (let i = 0; i < r.length - (closed ? 0 : 1); i++) { const p = r[i], q = r[(i + 1) % r.length]; l += Math.hypot(q.x - p.x, q.z - p.z); }
  return l;
}
export function centroid(r: XZ[]): XZ {
  const a = signedArea(r);
  if (Math.abs(a) < 1e-9) return { x: r.reduce((s, p) => s + p.x, 0) / r.length, z: r.reduce((s, p) => s + p.z, 0) / r.length };
  let cx = 0, cz = 0;
  for (let i = 0; i < r.length; i++) { const p = r[i], q = r[(i + 1) % r.length]; const k = p.x * q.z - q.x * p.z; cx += (p.x + q.x) * k; cz += (p.z + q.z) * k; }
  return { x: cx / (6 * a), z: cz / (6 * a) };
}

/** drop the closing point and near-duplicates */
export function cleanRing(r: XZ[]): XZ[] {
  const out: XZ[] = [];
  for (const p of r) if (!out.length || Math.hypot(p.x - out[out.length - 1].x, p.z - out[out.length - 1].z) > 1e-4) out.push(p);
  while (out.length > 2 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].z - out[out.length - 1].z) < 1e-4) out.pop();
  return out;
}

/**
 * A polyline moved sideways by d metres: to the LEFT of its direction of travel when d > 0 (left =
 * the side a walker along it has on their left, seen from above). Corners are mitred, and a mitre
 * longer than four times d is cut back, so a hairpin does not throw a spike.
 */
export function offsetLine(pts: XZ[], d: number, closed: boolean): XZ[] {
  const n = pts.length;
  if (n < 2) return pts.slice();
  // with x east and z south, a walker heading (dx, dz) has their left hand at (dz, -dx)
  const normal = (a: XZ, b: XZ) => { const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1; return { x: dz / l, z: -dx / l }; };
  const out: XZ[] = [];
  for (let i = 0; i < n; i++) {
    const prev = closed ? pts[(i - 1 + n) % n] : pts[i - 1];
    const next = closed ? pts[(i + 1) % n] : pts[i + 1];
    const p = pts[i];
    if (!prev) { const nn = normal(p, next); out.push({ x: p.x + nn.x * d, z: p.z + nn.z * d }); continue; }
    if (!next) { const nn = normal(prev, p); out.push({ x: p.x + nn.x * d, z: p.z + nn.z * d }); continue; }
    const n1 = normal(prev, p), n2 = normal(p, next);
    const bx = n1.x + n2.x, bz = n1.z + n2.z, bl = Math.hypot(bx, bz);
    if (bl < 1e-6) { out.push({ x: p.x + n1.x * d, z: p.z + n1.z * d }); continue; }
    const cos = (n1.x * n2.x + n1.z * n2.z + 1) / 2;          // cos² of half the turn
    const k = Math.min(4, 1 / Math.sqrt(Math.max(cos, 1e-6)));
    out.push({ x: p.x + (bx / bl) * d * k, z: p.z + (bz / bl) * d * k });
  }
  return out;
}

/** a closed ring grown outward by d metres (shrunk inward when d < 0), whichever way round it was drawn */
export function growRing(r: XZ[], d: number): XZ[] {
  const ring = cleanRing(r);
  // for a ring whose signed area is positive (x east, z south), a walker's left is outside
  return offsetLine(ring, signedArea(ring) > 0 ? d : -d, true);
}

/** the nearest distance between two segments */
export function segDist(a: XZ, b: XZ, c: XZ, d: XZ): number {
  const pt = (p: XZ, s: XZ, e: XZ) => {
    const dx = e.x - s.x, dz = e.z - s.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.z - s.z) * dz) / l2)) : 0;
    return { d: Math.hypot(p.x - (s.x + t * dx), p.z - (s.z + t * dz)), at: { x: s.x + t * dx, z: s.z + t * dz } };
  };
  return Math.min(pt(a, c, d).d, pt(b, c, d).d, pt(c, a, b).d, pt(d, a, b).d);
}

/** where two rings come closest: the distance, and the two points (from `a`, on `b`) */
export function nearest(a: XZ[], b: XZ[]): { d: number; from: XZ; to: XZ } {
  let best = { d: Infinity, from: a[0], to: b[0] };
  const onSeg = (p: XZ, s: XZ, e: XZ) => {
    const dx = e.x - s.x, dz = e.z - s.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - s.x) * dx + (p.z - s.z) * dz) / l2)) : 0;
    return { x: s.x + t * dx, z: s.z + t * dz };
  };
  for (const p of a) for (let j = 0; j < b.length; j++) {
    const q = onSeg(p, b[j], b[(j + 1) % b.length]);
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d < best.d) best = { d, from: p, to: q };
  }
  for (const p of b) for (let i = 0; i < a.length; i++) {
    const q = onSeg(p, a[i], a[(i + 1) % a.length]);
    const d = Math.hypot(p.x - q.x, p.z - q.z);
    if (d < best.d) best = { d, from: q, to: p };
  }
  return best;
}

export function inside(p: XZ, r: XZ[]): boolean {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i], b = r[j];
    if ((a.z > p.z) !== (b.z > p.z) && p.x < ((b.x - a.x) * (p.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}

/**
 * The box a building fills, turned to the building rather than to north: its long straight wall
 * sets the axis. Returns the axis (a unit vector), the width along it and the depth across it.
 */
export function orientedBox(r: XZ[]): { u: XZ; v: XZ; w: number; d: number; min: [number, number]; max: [number, number]; angleDeg: number } {
  let best = 0, u = { x: 1, z: 0 };
  for (let i = 0; i < r.length; i++) {
    const p = r[i], q = r[(i + 1) % r.length];
    const l = Math.hypot(q.x - p.x, q.z - p.z);
    if (l > best) { best = l; u = { x: (q.x - p.x) / l, z: (q.z - p.z) / l }; }
  }
  // a curved outline has no long wall: take the axis of least spread instead
  if (best < 0.25 * perimeter(r) / 4) {
    const c = centroid(r);
    let sxx = 0, szz = 0, sxz = 0;
    for (const p of r) { const x = p.x - c.x, z = p.z - c.z; sxx += x * x; szz += z * z; sxz += x * z; }
    const t = 0.5 * Math.atan2(2 * sxz, sxx - szz);
    u = { x: Math.cos(t), z: Math.sin(t) };
  }
  const v = { x: -u.z, z: u.x };
  let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
  for (const p of r) { const a = p.x * u.x + p.z * u.z, b = p.x * v.x + p.z * v.z; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
  return { u, v, w: a1 - a0, d: b1 - b0, min: [a0, b0], max: [a1, b1], angleDeg: Math.atan2(u.z, u.x) * 180 / Math.PI };
}

// ---- a building, measured ------------------------------------------------------------------------------

export interface LevelSize {
  /** metres above the ground, as the floor carries it */
  level: number;
  /** ANSI Z765 gross: to the outside face of the outside walls */
  grossM2: number;
  /** inside the inside face of the outside walls */
  netM2: number;
  /** floor to ceiling, where it can be told */
  ceilingM: number | null;
  /** finished area: a ceiling of 7 ft or more (or no way to tell) */
  counted: boolean;
  /** what the number was taken from */
  from: 'walls' | 'floor' | 'model';
  /** the outline the gross area was taken from, world metres */
  outline: XZ[];
  /** the inside outline, when there are walls */
  inner?: XZ[];
}

export interface BuildingSize {
  levels: LevelSize[];
  grossM2: number;
  netM2: number;
  /** the ground it covers: the lowest level's gross outline */
  footprintM2: number;
  footprint: XZ[];
  /** width along the building's own axis and depth across it, outside to outside */
  width: number;
  depth: number;
  /** how many metres of wall, measured along their centrelines */
  wallLengthM: number;
  /** what the numbers were taken from, in a word */
  basis: string;
}

export interface WallGeom { centre: XZ[]; thick: number; height: number; base: number; closed: boolean; smooth: boolean; openings: { kind: 'door' | 'window'; at_m: number; width_m: number }[]; id: string }
export interface FloorGeom { ring: XZ[]; level: number; thick: number; id: string; name?: string }

/** join open walls whose ends meet into longer runs; a run that comes back to its start is a room */
export function chainWalls(walls: WallGeom[]): { pts: XZ[]; closed: boolean; thick: number; height: number; base: number }[] {
  const TOL = 0.35;
  const runs = walls.map(w => ({ pts: w.centre.slice(), closed: w.closed, thick: w.thick, height: w.height, base: w.base }));
  const near = (a: XZ, b: XZ) => Math.hypot(a.x - b.x, a.z - b.z) < TOL;
  let joined = true;
  while (joined) {
    joined = false;
    for (let i = 0; i < runs.length && !joined; i++) {
      const a = runs[i];
      if (a.closed) continue;
      for (let j = 0; j < runs.length && !joined; j++) {
        if (i === j) continue;
        const b = runs[j];
        if (b.closed) continue;
        const aS = a.pts[0], aE = a.pts[a.pts.length - 1], bS = b.pts[0], bE = b.pts[b.pts.length - 1];
        let pts: XZ[] | null = null;
        if (near(aE, bS)) pts = a.pts.concat(b.pts.slice(1));
        else if (near(aE, bE)) pts = a.pts.concat(b.pts.slice(0, -1).reverse());
        else if (near(aS, bE)) pts = b.pts.concat(a.pts.slice(1));
        else if (near(aS, bS)) pts = b.pts.slice().reverse().concat(a.pts.slice(1));
        if (pts) {
          runs[i] = { pts, closed: false, thick: Math.max(a.thick, b.thick), height: Math.min(a.height, b.height), base: Math.max(a.base, b.base) };
          runs.splice(j, 1);
          joined = true;
        }
      }
    }
  }
  for (const r of runs) {
    if (!r.closed && r.pts.length >= 4 && near(r.pts[0], r.pts[r.pts.length - 1])) r.closed = true;
    if (r.closed) r.pts = cleanRing(r.pts);
  }
  return runs;
}

/**
 * How big a building is, the way an appraiser would say it. Each level is measured from the walls
 * that stand round it when there are any (gross to their outside face, net to their inside face),
 * or from its floor when there are none.
 */
export function measureBuilding(walls: WallGeom[], floors: FloorGeom[]): BuildingSize {
  const runs = chainWalls(walls);
  const rooms = runs.filter(r => r.closed && r.pts.length >= 3).sort((a, b) => area(b.pts) - area(a.pts));
  const levelsAt = [...new Set(floors.map(f => Math.round(f.level * 100) / 100))].sort((a, b) => a - b);
  if (!levelsAt.length) levelsAt.push(rooms.length ? Math.max(0, Math.min(...rooms.map(r => r.base))) : 0);
  const levels: LevelSize[] = [];
  for (let i = 0; i < levelsAt.length; i++) {
    const L = levelsAt[i];
    const next = levelsAt[i + 1];
    const floorsHere = floors.filter(f => Math.abs(f.level - L) < 0.01);
    // the walls round this level at all, and whether they stand to head height from its floor — the
    // biggest closed run is the outside wall
    const enclosing = rooms.find(r => r.base <= L + 0.35 && r.base + r.height > L + 0.1);
    const room = enclosing && enclosing.base + enclosing.height >= L + 2.0 ? enclosing : undefined;
    const hereArea = room ? area(room.pts) : floorsHere.reduce((s, f) => s + area(f.ring), 0);
    // the floor above caps this one's ceiling only where it covers it: a mezzanine over a corner does not
    const above = next != null ? floors.filter(f => Math.abs(f.level - next) < 0.01) : [];
    const aboveArea = above.reduce((s, f) => s + area(f.ring), 0);
    let ceiling: number | null = null;
    if (next != null && aboveArea >= 0.5 * hereArea) ceiling = next - Math.max(0.05, ...above.map(f => f.thick)) - L;
    if (enclosing) ceiling = Math.min(ceiling ?? Infinity, enclosing.base + enclosing.height - L);
    if (room) {
      const outer = growRing(room.pts, room.thick / 2), inner = growRing(room.pts, -room.thick / 2);
      levels.push({ level: L, grossM2: area(outer), netM2: area(inner), ceilingM: ceiling, counted: ceiling == null || ceiling >= MIN_CEILING_M - 1e-6, from: 'walls', outline: outer, inner });
    } else if (floorsHere.length) {
      const big = floorsHere.slice().sort((a, b) => area(b.ring) - area(a.ring));
      const g = floorsHere.reduce((s, f) => s + area(f.ring), 0);
      levels.push({ level: L, grossM2: g, netM2: g, ceilingM: ceiling, counted: ceiling == null || ceiling >= MIN_CEILING_M - 1e-6, from: 'floor', outline: cleanRing(big[0].ring) });
    }
  }
  const counted = levels.filter(l => l.counted);
  const low = levels[0];
  const box = low ? orientedBox(low.outline) : { w: 0, d: 0 };
  return {
    levels,
    grossM2: counted.reduce((s, l) => s + l.grossM2, 0),
    netM2: counted.reduce((s, l) => s + l.netM2, 0),
    footprintM2: low ? low.grossM2 : 0,
    footprint: low ? low.outline : [],
    width: box.w, depth: box.d,
    wallLengthM: walls.reduce((s, w) => s + perimeter(w.centre, w.closed), 0),
    basis: rooms.length ? 'outside face of the outside walls (ANSI Z765)' : levels.length ? 'the floor slabs' : 'nothing measurable yet'
  };
}

/** the scale a building needs so its gross area comes to `target` square metres (area goes with the square) */
export function scaleFor(currentM2: number, targetM2: number): number {
  return currentM2 > 0 && targetM2 > 0 ? Math.sqrt(targetM2 / currentM2) : 1;
}

// ---- the building as the pack carries it ----------------------------------------------------------------

/** walls and floors of a set of build features, in world metres (the caller turns lng/lat into metres) */
export function geomOf(parts: Feature[], toXZ: (c: [number, number]) => XZ, lineOf: (f: Feature) => XZ[]): { walls: WallGeom[]; floors: FloorGeom[] } {
  const walls: WallGeom[] = [], floors: FloorGeom[] = [];
  for (const f of parts) {
    const p = f.properties;
    if (p.kind === 'wall' && f.geometry.type === 'LineString') {
      const c = f.geometry.coordinates;
      const centre = lineOf(f);
      if (centre.length < 2) continue;
      const a = toXZ(c[0]), b = toXZ(c[c.length - 1]);
      const closed = c.length >= 4 && Math.hypot(a.x - b.x, a.z - b.z) < 0.35;
      const openings = (Array.isArray(p.openings) ? p.openings : []) as { kind: 'door' | 'window'; at_m: number; width_m: number }[];
      walls.push({ centre: closed ? cleanRing(centre) : centre, thick: Number(p.thick_m) || 0.25, height: Number(p.height_m) || 2.7, base: Number(p.base_m) || 0, closed, smooth: !!p.smooth, openings, id: String(p.id) });
    } else if (p.kind === 'floor' && f.geometry.type === 'Polygon') {
      const ring = cleanRing((f.geometry.coordinates[0] || []).map(toXZ));
      if (ring.length >= 3) floors.push({ ring, level: Number(p.level_m) || 0, thick: Number(p.thick_m) || 0.2, id: String(p.id) });
    }
  }
  return { walls, floors };
}
