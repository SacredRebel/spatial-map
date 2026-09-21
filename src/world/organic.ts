// Organic buildings: a living form, fitted into a piece of ground.
//
//   Draw a perimeter — or mark one and ask for it — and this makes a building that fits inside it:
//   a plan that is a smooth closed curve (following the drawn edge, or a leaf, an oval, a flower of
//   lobes, a nautilus), walls round it with a door where you asked and glass towards the view, a
//   floor, and a shell roof that grows out of the walls and droops past them into an eave. Nothing
//   of the roof leaves the perimeter: the whole building, eave and all, is inside what was drawn.
//
//   It is a GENERATOR, not a model. The result is ordinary parts — a wall, a floor, a roof, and a
//   level pad under them — each a feature of the pack like anything drawn by hand, so it can be
//   walked into, moved, cut, undone and saved. The numbers that made it ride along on the floor,
//   so it can be made again with one of them changed: that is what the sliders do. Lobes, depth,
//   height, rise, glazing: change one and the building grows again in place.
//
//   What it is made of is part of the spec, not paint: a frame (steel, timber, bamboo), an infill
//   (cob, hempcrete, straw bale, rammed earth…), an insulation, a roof finish (solar, living, metal…).
//   The model shows the frame and the panels, and the quantities say how much of each it takes.

import * as THREE from 'three';
import { poleOf, ringArea, shell, solarSpots, type XZ } from './shell';
import type { Opening } from './build';

export const ORGANIC_FORMS = ['fit', 'lobed', 'oval', 'leaf', 'shell'] as const;
export type OrganicForm = typeof ORGANIC_FORMS[number];

export interface OrganicSpec {
  /** the plan's shape language */
  form: OrganicForm;
  /** lobed: how many lobes; shell: how many turns of its curl are hinted */
  lobes: number;
  /** lobed/shell: how deep the valleys between lobes go (0..0.6), or how tight the curl */
  depth: number;
  /** turns the form about its centre, degrees */
  turn: number;
  /** how far the walls keep in from the perimeter, beyond the eave (metres) */
  inset: number;
  /** wall height, ground to eaves, metres */
  height: number;
  /** how far the shell roof rises above the eaves at its crown, metres */
  rise: number;
  /** how far the roof reaches past the walls, metres */
  overhang: number;
  /** wall thickness, metres (cob is thick) */
  thick: number;
  /** what carries it */
  structure: string;
  /** what fills the walls — also the wall's material */
  infill: string;
  /** what insulates the roof (and a frame wall) */
  insulation: string;
  /** what the roof is finished in */
  roof: string;
  /** of the roof that faces the sun, how much carries panels (0..1) */
  solar: number;
  /** of the wall that faces the view, how much is glass (0..1) */
  glazing: number;
  /** the bearing the glass faces, degrees (0 north, 90 east, 180 south) */
  facing: number;
  /** the bearing of the door from the middle of the plan */
  door: number;
  /** what the floor is */
  floor: string;
  /** flatten a level pad under it first */
  pad: boolean;
}

export const ORGANIC_DEFAULT: OrganicSpec = {
  form: 'fit', lobes: 5, depth: 0.25, turn: 0, inset: 0.3, height: 3.2, rise: 2.4, overhang: 1.1, thick: 0.45,
  structure: 'steel', infill: 'cob', insulation: 'hemp', roof: 'solar', solar: 0.7, glazing: 0.5, facing: 180, door: 90,
  floor: 'earth', pad: true
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** a spec with every number inside the range the builder accepts, whatever came in */
export function cleanSpec(raw: Partial<OrganicSpec> | Record<string, unknown> | null | undefined): OrganicSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const d = ORGANIC_DEFAULT;
  const num = (k: keyof OrganicSpec, lo: number, hi: number) => { const v = Number(r[k]); return isFinite(v) && r[k] !== null && r[k] !== '' ? clamp(v, lo, hi) : d[k] as number; };
  const str = (k: keyof OrganicSpec) => typeof r[k] === 'string' && (r[k] as string).trim() ? (r[k] as string).trim().slice(0, 30) : d[k] as string;
  const form = (ORGANIC_FORMS as readonly string[]).includes(String(r.form)) ? r.form as OrganicForm : d.form;
  return {
    form, lobes: Math.round(num('lobes', 2, 12)), depth: num('depth', 0, 0.6), turn: num('turn', -360, 360),
    inset: num('inset', 0, 10), height: num('height', 2.2, 9), rise: num('rise', 0.3, 8), overhang: num('overhang', 0, 3),
    thick: num('thick', 0.12, 1), structure: str('structure'), infill: str('infill'), insulation: str('insulation'),
    roof: str('roof'), solar: num('solar', 0, 1), glazing: num('glazing', 0, 1), facing: ((num('facing', -720, 720) % 360) + 360) % 360,
    door: ((num('door', -720, 720) % 360) + 360) % 360, floor: str('floor'), pad: r.pad === undefined ? d.pad : r.pad !== false
  };
}

/** a compass bearing (0 north, clockwise) as a world angle for atan2(z, x) — world z points south */
const bearingToAngle = (deg: number) => ((deg - 90) * Math.PI) / 180;
const angleToBearing = (a: number) => ((((a * 180) / Math.PI + 90) % 360) + 360) % 360;
const angDiff = (a: number, b: number) => { let d = Math.abs(a - b) % 360; if (d > 180) d = 360 - d; return d; };

/** distance from c along direction a to the first edge of the ring, or 0 if none */
function rayToRing(c: XZ, a: number, ring: XZ[]): number {
  const dx = Math.cos(a), dz = Math.sin(a);
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const p = ring[j], q = ring[i];
    const ex = q.x - p.x, ez = q.z - p.z;
    const den = dx * ez - dz * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((p.x - c.x) * ez - (p.z - c.z) * ex) / den;
    const u = ((p.x - c.x) * dz - (p.z - c.z) * dx) / den;
    if (t > 1e-6 && u >= 0 && u <= 1 && t < best) best = t;
  }
  return isFinite(best) ? best : 0;
}

/** circular moving average */
function smoothCirc(v: number[], w: number): number[] {
  const n = v.length;
  return v.map((_, i) => { let s = 0; for (let k = -w; k <= w; k++) s += v[(i + k + n) % n]; return s / (2 * w + 1); });
}

/** the principal axis of a ring's points, as a world angle */
function majorAxis(ring: XZ[], c: XZ): number {
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of ring) { const x = p.x - c.x, z = p.z - c.z; sxx += x * x; szz += z * z; sxz += x * z; }
  return 0.5 * Math.atan2(2 * sxz, sxx - szz);
}

/** the same smooth closed curve Build draws through a closed wall's points (so distances along it agree) */
export function smoothClosed(ctrl: XZ[]): XZ[] {
  const curve = new THREE.CatmullRomCurve3(ctrl.map(p => new THREE.Vector3(p.x, 0, p.z)), true, 'centripetal', 0.5);
  const n = Math.max(8, Math.ceil(curve.getLength() / 0.5));
  const out = curve.getSpacedPoints(n).map(p => ({ x: p.x, z: p.z }));
  out[out.length - 1] = { ...out[0] };
  return out;
}

function offsetClosed(pts: XZ[], d: number, centre: XZ): XZ[] {
  // pts is closed (first == last); offset away from the centre by d along each vertex normal
  const ring = pts.slice(0, -1), n = ring.length;
  const out = ring.map((p, i) => {
    const a = ring[(i - 1 + n) % n], b = ring[(i + 1) % n];
    let nx = b.z - a.z, nz = -(b.x - a.x);
    const l = Math.hypot(nx, nz) || 1; nx /= l; nz /= l;
    if ((p.x - centre.x) * nx + (p.z - centre.z) * nz < 0) { nx = -nx; nz = -nz; }
    return { x: p.x + nx * d, z: p.z + nz * d };
  });
  out.push({ ...out[0] });
  return out;
}

export interface Quantities {
  floorM2: number; floorSqft: number;
  wallLengthM: number; wallHeightM: number; wallGrossM2: number; wallNetM2: number;
  infillM3: number; glazingM2: number;
  roofPlanM2: number; roofSurfaceM2: number; insulationM3: number;
  frameKg: number; panels: number; solarKwp: number; solarKwhYear: number;
  doors: number; windows: number;
}

export interface OrganicPlan {
  /** the wall's control points: a closed ring (first == last), drawn as a smooth curve */
  wall: XZ[];
  /** the smooth curve itself, closed, as Build will draw it */
  curve: XZ[];
  /** the floor and the roof's base, at the outer face of the wall, closed */
  floor: XZ[];
  roof: XZ[];
  /** the pad under it: the floor ring pushed out a metre */
  pad: XZ[];
  openings: Opening[];
  pole: XZ;
  quantities: Quantities;
  /** false when the perimeter was too small for anything to fit */
  ok: boolean;
  why?: string;
}

/**
 * The plan for an organic building inside a perimeter (world XZ, closed or not).
 */
export function organicPlan(perimeterIn: XZ[], specIn: Partial<OrganicSpec>): OrganicPlan {
  const spec = cleanSpec(specIn);
  const per = perimeterIn.slice();
  if (per.length > 1 && Math.hypot(per[0].x - per[per.length - 1].x, per[0].z - per[per.length - 1].z) < 1e-6) per.pop();
  const empty = (why: string): OrganicPlan => ({ wall: [], curve: [], floor: [], roof: [], pad: [], openings: [], pole: { x: 0, z: 0 }, quantities: emptyQ(), ok: false, why });
  if (per.length < 3 || Math.abs(ringArea(per)) < 8) return empty('the perimeter is too small for a building');

  const c = poleOf(per);
  const M = 96;
  const keep = spec.overhang + spec.thick / 2 + spec.inset;
  const allowed: number[] = [];
  for (let i = 0; i < M; i++) allowed.push(Math.max(0, rayToRing(c, (i / M) * Math.PI * 2, per) - keep));
  if (Math.min(...smoothCirc(allowed, 3)) < 1.2) {
    const room = Math.min(...allowed);
    if (room < 1.2) return empty(`the perimeter leaves no room once the ${spec.overhang.toFixed(1)} m eave is inside it — draw it larger or ask for a smaller overhang`);
  }

  // the shape language, as a radius at each of M angles about the pole
  const turn = (spec.turn * Math.PI) / 180;
  const fitted = (() => { let r = allowed.slice(); for (let k = 0; k < 3; k++) r = smoothCirc(r.map((v, i) => Math.min(v, allowed[i])), 4); return r.map((v, i) => Math.min(v, allowed[i])); })();
  const scaleToFit = (e: number[]) => { let s = Infinity; e.forEach((v, i) => { if (v > 1e-6) s = Math.min(s, allowed[i] / v); }); return e.map(v => v * Math.min(s, 1e6)); };
  let r: number[];
  const axis = majorAxis(per, c) + turn;
  if (spec.form === 'oval' || spec.form === 'leaf') {
    // an ellipse on the ground's own long axis, then as large as fits; a leaf is an ellipse with points
    const ra = Math.max(rayToRing(c, axis, per), rayToRing(c, axis + Math.PI, per));
    const rb = Math.max(rayToRing(c, axis + Math.PI / 2, per), rayToRing(c, axis - Math.PI / 2, per));
    const a = Math.max(ra, rb * 1.05), b = Math.min(rb, ra) * 0.95;
    r = [];
    for (let i = 0; i < M; i++) {
      const t = (i / M) * Math.PI * 2 - axis;
      let e = (a * b) / Math.hypot(b * Math.cos(t), a * Math.sin(t));
      if (spec.form === 'leaf') e *= 0.62 + 0.38 * Math.pow(Math.abs(Math.cos(t)), 0.35) * (1 + 0.15 * Math.cos(t));
      r.push(e);
    }
    r = scaleToFit(r);
  } else if (spec.form === 'lobed') {
    const n = spec.lobes;
    r = fitted.map((v, i) => {
      const t = (i / M) * Math.PI * 2 - turn;
      return v * ((1 - spec.depth) + spec.depth * Math.pow(Math.abs(Math.cos((n * t) / 2)), 0.6));
    });
  } else if (spec.form === 'shell') {
    // a nautilus: the radius winds out once round, and the step where it comes back is the mouth
    const tight = 0.25 + 0.6 * spec.depth;
    r = [];
    for (let i = 0; i < M; i++) {
      const t = (((i / M) * Math.PI * 2 - turn) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      r.push(Math.exp(Math.log(1 / (1 - tight)) * (t / (Math.PI * 2))) * (1 - tight));
    }
    // soften the step into a curl so the wall is one smooth line
    r = smoothCirc(r, 2);
    r = scaleToFit(r);
  } else r = fitted;

  // control points for the wall, starting at the back — away from both the door and the glass — so
  // neither the door nor a window ever straddles the join at the start of the ring
  const facing = spec.form === 'shell' ? spec.facing : spec.facing;
  const doorBearing = spec.form === 'shell' ? angleToBearing(turn) : spec.door;
  let back = 0, backScore = -1;
  for (let b = 0; b < 360; b += 5) { const s = Math.min(angDiff(b, facing), angDiff(b, doorBearing)); if (s > backScore) { backScore = s; back = b; } }
  const CTRL = 40;
  const start = bearingToAngle(back);
  const radiusAt = (a: number) => {
    const u = ((a / (Math.PI * 2)) % 1 + 1) % 1 * M;
    const i0 = Math.floor(u) % M, i1 = (i0 + 1) % M, t = u - Math.floor(u);
    return r[i0] * (1 - t) + r[i1] * t;
  };
  const ctrl: XZ[] = [];
  for (let k = 0; k < CTRL; k++) {
    const a = start + (k / CTRL) * Math.PI * 2;
    const rr = radiusAt(a);
    ctrl.push({ x: c.x + Math.cos(a) * rr, z: c.z + Math.sin(a) * rr });
  }
  const curve = smoothClosed(ctrl);
  const wall = ctrl.concat([{ ...ctrl[0] }]);
  if (Math.abs(ringArea(curve)) < 6) return empty('the form came out too small to stand in');

  // distance along the curve, and the bearing of each point from the pole
  const cum = [0];
  for (let i = 1; i < curve.length; i++) cum.push(cum[i - 1] + Math.hypot(curve[i].x - curve[i - 1].x, curve[i].z - curve[i - 1].z));
  const L = cum[cum.length - 1];
  const bearingAt = curve.map(p => angleToBearing(Math.atan2(p.z - c.z, p.x - c.x)));

  const openings: Opening[] = [];
  const head = Math.min(spec.height - 0.3, 2.4);
  // the door: where the curve points the way the door was asked for
  let di = 0, dd = 999;
  bearingAt.forEach((b, i) => { const d = angDiff(b, doorBearing); if (d < dd) { dd = d; di = i; } });
  const doorAt = clamp(cum[di], 0.8, L - 0.8);
  openings.push({ kind: 'door', at_m: +doorAt.toFixed(2), width_m: 1.0, sill_m: 0, head_m: +Math.min(2.2, spec.height - 0.3).toFixed(2) });
  // the glass: across the arc that faces the view, as much of it as asked for
  if (spec.glazing > 0.01) {
    const tall = spec.glazing > 0.6;
    const w = tall ? 2.2 : 1.5, gap = tall ? 0.45 : 1.1;
    const arc = cum.filter((_, i) => angDiff(bearingAt[i], facing) < 65);
    if (arc.length > 1) {
      const s0 = Math.min(...arc), s1 = Math.max(...arc);
      const span = s1 - s0;
      const count = Math.max(1, Math.floor((span * spec.glazing + gap) / (w + gap)));
      const used = count * w + (count - 1) * gap;
      const first = s0 + (span - used) / 2 + w / 2;
      for (let k = 0; k < count; k++) {
        const at = first + k * (w + gap);
        if (Math.abs(at - doorAt) < (w + 1.0) / 2 + 0.4) continue;
        if (at < w / 2 + 0.1 || at > L - w / 2 - 0.1) continue;
        openings.push({ kind: 'window', at_m: +at.toFixed(2), width_m: w, sill_m: tall ? 0.15 : 0.7, head_m: +head.toFixed(2) });
      }
    }
  }
  openings.sort((a, b) => a.at_m - b.at_m);

  const floor = offsetClosed(curve, spec.thick / 2, c);
  const roof = floor;
  const pad = offsetClosed(curve, spec.thick / 2 + 1, c);

  // the quantities, from the same shell and panels the model draws
  const sh = shell(roof, { eaves: 0, rise: spec.rise, overhang: spec.overhang, thick: 0.22 });
  const spots = spec.roof === 'solar' ? solarSpots(sh, { ratio: spec.solar, facingDeg: 180 }) : [];
  sh.geometry.dispose();
  const floorM2 = Math.abs(ringArea(floor));
  const doorM2 = openings.filter(o => o.kind === 'door').reduce((s, o) => s + o.width_m * o.head_m, 0);
  const glazingM2 = openings.filter(o => o.kind === 'window').reduce((s, o) => s + o.width_m * (o.head_m - o.sill_m), 0);
  const gross = L * spec.height;
  const net = Math.max(0, gross - doorM2 - glazingM2);
  const posts = Math.floor(L / 1.2), ribs = Math.floor(L / 1.6);
  const meanR = r.reduce((s, v) => s + v, 0) / r.length;
  const frameKg = spec.structure === 'steel' ? Math.round((posts * spec.height + ribs * (meanR + spec.overhang) * 1.15) * 7.5)
    : spec.structure === 'timber' ? Math.round((posts * spec.height + ribs * (meanR + spec.overhang) * 1.15) * 14) : 0;
  const kwp = spots.length * 0.43;
  const quantities: Quantities = {
    floorM2: +floorM2.toFixed(1), floorSqft: Math.round(floorM2 / 0.092903),
    wallLengthM: +L.toFixed(1), wallHeightM: spec.height, wallGrossM2: +gross.toFixed(1), wallNetM2: +net.toFixed(1),
    infillM3: +(net * spec.thick).toFixed(1), glazingM2: +glazingM2.toFixed(1),
    roofPlanM2: +sh.planArea.toFixed(1), roofSurfaceM2: +sh.surfaceArea.toFixed(1),
    insulationM3: spec.insulation === 'none' ? 0 : +(sh.planArea * 0.25).toFixed(1),
    frameKg, panels: spots.length, solarKwp: +kwp.toFixed(1), solarKwhYear: Math.round(kwp * 1650),
    doors: openings.filter(o => o.kind === 'door').length, windows: openings.filter(o => o.kind === 'window').length
  };
  return { wall, curve, floor, roof, pad, openings, pole: c, quantities, ok: true };
}

function emptyQ(): Quantities {
  return { floorM2: 0, floorSqft: 0, wallLengthM: 0, wallHeightM: 0, wallGrossM2: 0, wallNetM2: 0, infillM3: 0, glazingM2: 0, roofPlanM2: 0, roofSurfaceM2: 0, insulationM3: 0, frameKg: 0, panels: 0, solarKwp: 0, solarKwhYear: 0, doors: 0, windows: 0 };
}

/** what the roof is made of, for a finish */
export function roofMaterialFor(finish: string): string {
  return finish === 'living' ? 'living' : finish === 'thatch' ? 'thatch' : finish === 'tile' ? 'tile' : finish === 'shingle' ? 'shingle' : 'metal';
}

// ---- words to a spec ---------------------------------------------------------------------------------
//
//   The agent on the atlas turns a sentence into a spec. When it cannot be reached — no PIN, no key,
//   no network — this reads the plain words the same sentence usually carries, so "a bio shape with
//   a steel frame, cob walls, hemp insulation and a solar roof" still means something here.

const WORDS: [RegExp, Partial<OrganicSpec>][] = [
  [/\bleaf\b/, { form: 'leaf' }], [/\b(oval|egg|seed|pebble)\b/, { form: 'oval' }],
  [/\b(nautilus|spiral|snail|shell[- ]?shaped)\b/, { form: 'shell' }],
  [/\b(flower|petal|lobe[sd]?|clover|trefoil|cells?)\b/, { form: 'lobed' }],
  [/\bsteel\b/, { structure: 'steel' }], [/\b(timber|wood(en)?) frame\b/, { structure: 'timber' }], [/\bbamboo\b/, { structure: 'bamboo' }],
  [/\bcob\b/, { infill: 'cob' }], [/\bhempcrete\b/, { infill: 'hempcrete' }], [/\bstraw ?bale\b/, { infill: 'strawbale' }],
  [/\brammed earth\b/, { infill: 'rammed_earth' }], [/\badobe\b/, { infill: 'adobe' }], [/\bstone\b/, { infill: 'stone' }],
  [/\bhemp (insulation|batts?|wool)\b|\bhemp\b(?!crete)/, { insulation: 'hemp' }], [/\bsheep'?s? ?wool\b|\bwool\b/, { insulation: 'wool' }], [/\bcork\b/, { insulation: 'cork' }],
  [/\bsolar\b/, { roof: 'solar' }], [/\b(living|green|sedum) roof\b/, { roof: 'living' }], [/\bthatch/, { roof: 'thatch' }],
  [/\bmetal roof\b/, { roof: 'metal' }], [/\btile roof\b/, { roof: 'tile' }],
  [/\bno pad\b|\bdon'?t (level|flatten)\b/, { pad: false }]
];
const BEARINGS: Record<string, number> = { north: 0, northeast: 45, east: 90, southeast: 135, south: 180, southwest: 225, west: 270, northwest: 315 };

export function specFromWords(text: string, base: Partial<OrganicSpec> = {}): Partial<OrganicSpec> {
  const t = text.toLowerCase().replace(/-/g, ' ');
  const out: Partial<OrganicSpec> = { ...base };
  for (const [re, v] of WORDS) if (re.test(t)) Object.assign(out, v);
  const lobes = /(\d+|three|four|five|six|seven|eight)\s*(lobes?|petals?|cells?)/.exec(t);
  if (lobes) { const w: Record<string, number> = { three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 }; out.lobes = Number(lobes[1]) || w[lobes[1]]; out.form = out.form ?? 'lobed'; }
  const high = /(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\s*(?:high|tall|walls?)/.exec(t);
  if (high) out.height = Number(high[1]);
  const glass = /(glass|glazing|windows?|views?)\s+(?:to(?:wards)?|facing)\s+(?:the\s+)?(north|south|east|west|northeast|northwest|southeast|southwest)/.exec(t);
  if (glass) out.facing = BEARINGS[glass[2]];
  const door = /(door|entrance|entry)\s+(?:to(?:wards)?|on|facing|at)\s+(?:the\s+)?(north|south|east|west|northeast|northwest|southeast|southwest)/.exec(t);
  if (door) out.door = BEARINGS[door[2]];
  if (/\b(lots of|more|big|floor to ceiling|full) (glass|glazing|windows)\b/.test(t)) out.glazing = 0.8;
  return out;
}
