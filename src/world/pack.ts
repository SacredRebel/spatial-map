// A property's ground truth, loaded by URL.
//
//   One engine, one pack per property. The atlas decides what is *proposed*; the pack says what is
//   *there*: the surveyed line, the roofs the lidar measured, every tree it saw, the road, and the
//   places where something is planned. It is a folder of small files with a manifest — a repository
//   on GitHub, or a directory on any host — and the world reads it the way it reads the atlas: over
//   HTTP, owning nothing, so there is exactly one copy of the truth and it is not in here.
//
//   Nothing in a pack is required. A pack with a survey and no trees is a pack; a missing file is
//   an empty layer, never an error. The only thing that fails a load is a manifest that cannot be
//   read at all, and even that only means the world runs on the rule alone, as it did before.

export interface PackFrame {
  origin_lng: number; origin_lat: number;
  metres_per_deg_lng: number; metres_per_deg_lat: number;
}

export interface PackImagery {
  kind: 'xyz';
  /** {z}/{x}/{y} template; the county's caches use {y} before {x}, which the template spells out */
  template: string;
  maxzoom: number;
  attribution?: string;
  captured?: string;
}

export interface PackManifest {
  schema: number;
  id: string;
  name: string;
  apn?: string;
  spawn?: { lng: number; lat: number; heading?: number };
  frame: PackFrame;
  aoi: { bbox: [number, number, number, number] };
  layers: Record<string, { file?: string; authority?: string; [k: string]: unknown } & Partial<PackImagery>>;
  reconciliation?: { id: string; status: string; what?: string }[];
}

/** one tree top as the lidar saw it, already in longitude and latitude */
export interface PackTree { lng: number; lat: number; height: number; crown: number; ground: number }

export interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry: { type: 'Point'; coordinates: [number, number] }
    | { type: 'LineString'; coordinates: [number, number][] }
    | { type: 'Polygon'; coordinates: [number, number][][] };
}
export interface FeatureCollection { type: 'FeatureCollection'; features: Feature[] }

/** one close-up material: what the ground, a road or a trunk looks like from a metre away */
export interface PackMaterial {
  /** absolute URLs, resolved against the pack */
  albedo: string;
  albedo_512?: string;
  normal?: string;
  /** how many metres one repeat of the tile covers */
  metres: number;
  source?: { id?: string; url?: string };
  matched_to?: { srgb?: string; photo?: string; taken?: string; what?: string } | null;
}
export type PackMaterials = Record<string, PackMaterial>;

export interface PackData {
  base: string;
  manifest: PackManifest;
  /** every tree the lidar saw — the record, never rewritten */
  record: PackTree[];
  /** the trees as they stand: the record with the edits applied */
  trees: PackTree[];
  /** how many of the record's trees an edit took down */
  removed: number;
  survey: FeatureCollection;
  county: FeatureCollection;
  roofs: FeatureCollection;
  /** the placed projects as the atlas placed them */
  vision: FeatureCollection;
  /** the placed projects as they stand: moved or removed by edits */
  visionNow: FeatureCollection;
  /** what the owner has pinned and drawn: markers with a label, fences, paths, territories */
  notes: FeatureCollection;
  lines: FeatureCollection;
  zones: FeatureCollection;
  /** the owner's shapings of the ground: pads flattened, banks raised, hollows cut */
  terrain: FeatureCollection;
  /** what has been built here, part by part: walls, floors, roofs */
  build: FeatureCollection;
  /** the pack's own edits layer, as committed */
  edits: FeatureCollection;
  imagery: PackImagery | null;
  /** where the pack keeps its own 1 m ground, when it does: a terrarium pyramid with an index */
  ground: { index: string; template: string; maxzoom: number } | null;
  /** close-up materials by name (straw, dirt, gravel, litter, asphalt, bark), or none */
  materials: PackMaterials | null;
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] };

async function json<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

async function text(url: string): Promise<string | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

/**
 * trees.csv → tree tops.
 *
 *   The file is integers in decimetres in the pack's own frame, so a hillside of several thousand
 *   trees is a few tens of kilobytes. The frame is plain equirectangular at the origin latitude,
 *   which over a kilometre is exact to the width of a trunk.
 */
export function parseTrees(csv: string, f: PackFrame): PackTree[] {
  const out: PackTree[] = [];
  const lines = csv.split(/\r?\n/);
  const head = (lines[0] || '').split(',').map(s => s.trim());
  const col = (n: string) => head.indexOf(n);
  const ix = col('x_east_dm'), iy = col('y_north_dm'), ih = col('height_dm'), ir = col('crown_radius_dm'), ig = col('ground_dm');
  if (ix < 0 || iy < 0 || ih < 0) return out;
  for (let i = 1; i < lines.length; i++) {
    const s = lines[i];
    if (!s) continue;
    const c = s.split(',');
    const x = Number(c[ix]), y = Number(c[iy]), h = Number(c[ih]);
    if (!isFinite(x) || !isFinite(y) || !isFinite(h)) continue;
    out.push({
      lng: f.origin_lng + x / 10 / f.metres_per_deg_lng,
      lat: f.origin_lat + y / 10 / f.metres_per_deg_lat,
      height: h / 10,
      crown: ir >= 0 ? Number(c[ir]) / 10 : Math.max(1, h / 4),
      ground: ig >= 0 ? Number(c[ig]) / 10 : NaN
    });
  }
  return out;
}

// ---- what the owner has said differs from the record ----------------------------------------------
//
//   The record is never rewritten. A lidar flight is a fact about one day; what has changed since is
//   another fact, dated and attributed, and it lives in its own layer. Each edit is one feature with
//   an `op` and a `layer`:
//
//     remove · trees   — a Point with `radius_m`, or a Polygon with `buffer_m`: those tree tops are gone
//     add    · trees   — a Point with `height_m` and `crown_m`: a tree that is there now
//     move   · vision  — `target`, the id of a placed project, and the Point it really goes at
//     remove · vision  — `target`, the id of a placed project that is off the table
//     add    · notes   — a Point with a `name`: a marker the owner pinned (a gate, a well, a photo);
//                        `kind: magic` is a box you talk to
//     add    · lines   — a LineString with a `kind` (fence, path, road) and a `name`
//     add    · zones   — a Polygon with a `name` and a `kind`: a territory drawn on the ground
//     add    · terrain — a Polygon with `terrain_op` (flatten, raise, lower), `height_m` or `to_m`,
//                        `edge_m`: the ground shaped, with a bank that eases into the hill
//     add    · build   — a part of a building, by `kind`: a `wall` (LineString; `height_m`,
//                        `thick_m`, `material`, `smooth`, `base_m`, `openings[]`, `structure`), a
//                        `floor` (Polygon; `level_m`, `thick_m`, `material`) or a `roof` (Polygon;
//                        `form`, `eaves_m`, `pitch_deg`, `overhang_m`, `ridge_deg`, `material`)
//     remove · build   — `target`, the id of a part that has been taken down
//
//   A later feature with the same id replaces an earlier one — that is how a wall is changed —
//   which is the atlas's own merge rule. Applying them here, once, at load, means every consumer
//   sees the same present.

type XY = { x: number; y: number };

function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function ringDistance(p: XY, ring: XY[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) best = d;
  }
  return best;
}

/** Apply tree edits to the record. Returns what stands, and how many the edits took down. */
export function applyTreeEdits(trees: PackTree[], edits: Feature[], f: PackFrame): { trees: PackTree[]; removed: number } {
  const toXY = ([lng, lat]: [number, number]): XY => ({ x: (lng - f.origin_lng) * f.metres_per_deg_lng, y: (lat - f.origin_lat) * f.metres_per_deg_lat });
  const removals = edits.filter(e => e.properties.op === 'remove' && (e.properties.layer ?? 'trees') === 'trees');
  const additions = edits.filter(e => e.properties.op === 'add' && e.properties.layer === 'trees' && e.geometry.type === 'Point');
  const added: PackTree[] = additions.map(e => {
    const [lng, lat] = (e.geometry as { coordinates: [number, number] }).coordinates;
    const h = Number(e.properties.height_m) || 6;
    return { lng, lat, height: h, crown: Number(e.properties.crown_m) || Math.max(1, h / 3), ground: NaN };
  });
  if (!removals.length) return { trees: trees.concat(added), removed: 0 };
  const gone = (t: PackTree): boolean => {
    const p = toXY([t.lng, t.lat]);
    for (const e of removals) {
      const g = e.geometry;
      if (g.type === 'Point') {
        const r = Number(e.properties.radius_m);
        if (isFinite(r) && Math.hypot(p.x - toXY(g.coordinates).x, p.y - toXY(g.coordinates).y) <= r) return true;
      } else if (g.type === 'Polygon' && g.coordinates[0] && g.coordinates[0].length >= 3) {
        const ring = g.coordinates[0].map(toXY);
        const buffer = Math.max(0, Number(e.properties.buffer_m) || 0);
        if (inRing(p, ring) || ringDistance(p, ring) <= buffer) return true;
      }
    }
    return false;
  };
  const kept = trees.filter(t => !gone(t));
  return { trees: kept.concat(added), removed: trees.length - kept.length };
}

/**
 * Apply every edit — the pack's own layer plus any the editor holds unsaved — and write the
 * present into the pack: the trees that stand, the projects where they now go, the notes and
 * the lines. Called at load and again after every edit, so what you see is always the record
 * plus the edits and never a third thing.
 */
export function applyEdits(pack: PackData, extra: Feature[] = []): PackData {
  const all = pack.edits.features.concat(extra);
  const t = applyTreeEdits(pack.record, all, pack.manifest.frame);
  pack.trees = t.trees;
  pack.removed = t.removed;
  const moved = new Map<string, [number, number]>();
  const dropped = new Set<string>();
  for (const e of all) {
    if (e.properties.layer !== 'vision') continue;
    // the project is named by `target`; older edits named it by `id`
    const who = typeof e.properties.target === 'string' ? e.properties.target : typeof e.properties.id === 'string' ? e.properties.id : null;
    if (!who) continue;
    if (e.properties.op === 'move' && e.geometry.type === 'Point') moved.set(who, e.geometry.coordinates);
    if (e.properties.op === 'remove') dropped.add(who);
  }
  pack.visionNow = {
    type: 'FeatureCollection',
    features: pack.vision.features
      .filter(f => !dropped.has(String(f.properties.id)))
      .map(f => {
        const to = moved.get(String(f.properties.id));
        return to && f.geometry.type === 'Point' ? { ...f, properties: { ...f.properties, moved: true }, geometry: { type: 'Point', coordinates: to } } : f;
      })
  };
  const added = (layer: string, ...types: string[]) => lastById(all.filter(e => e.properties.op === 'add' && e.properties.layer === layer && types.includes(e.geometry.type)));
  pack.notes = { type: 'FeatureCollection', features: added('notes', 'Point') };
  pack.lines = { type: 'FeatureCollection', features: added('lines', 'LineString') };
  pack.zones = { type: 'FeatureCollection', features: added('zones', 'Polygon') };
  pack.terrain = { type: 'FeatureCollection', features: added('terrain', 'Polygon') };
  // a part taken down is gone, whichever feature added it
  const down = new Set(all.filter(e => e.properties.op === 'remove' && e.properties.layer === 'build' && typeof e.properties.target === 'string').map(e => String(e.properties.target)));
  pack.build = { type: 'FeatureCollection', features: added('build', 'LineString', 'Polygon').filter(f => !down.has(String(f.properties.id))) };
  return pack;
}

/** the same list with a later feature replacing an earlier one of the same id, in first-seen order */
function lastById(list: Feature[]): Feature[] {
  const at = new Map<string, number>();
  const out: Feature[] = [];
  for (const f of list) {
    const id = String(f.properties.id ?? '');
    if (id && at.has(id)) { out[at.get(id)!] = f; continue; }
    if (id) at.set(id, out.length);
    out.push(f);
  }
  return out;
}

/** the directory the manifest lives in, whether the url named the file or the folder */
export function packBase(url: string): string {
  const u = url.replace(/\/pack\.json$/, '');
  return u.endsWith('/') ? u : u + '/';
}

/** Load a pack. Resolves to null only when the manifest itself cannot be read. */
export async function loadPack(url: string): Promise<PackData | null> {
  const base = packBase(url);
  const manifest = await json<PackManifest>(base + 'pack.json');
  if (!manifest || !manifest.frame || !manifest.layers) return null;
  const L = manifest.layers;
  const file = (k: string) => (L[k] && typeof L[k].file === 'string' ? base + (L[k].file as string) : null);
  const fc = async (k: string) => (file(k) ? (await json<FeatureCollection>(file(k)!)) ?? EMPTY : EMPTY);

  const [treesCsv, survey, county, roofs, vision, edits, mats] = await Promise.all([
    file('trees') ? text(file('trees')!) : Promise.resolve(null),
    fc('survey'), fc('county'), fc('roofs'), fc('vision'), fc('edits'),
    file('materials') ? json<{ materials?: Record<string, PackMaterial> }>(file('materials')!) : Promise.resolve(null)
  ]);
  // the materials, with every path made absolute so the renderer can fetch them without knowing the pack
  let materials: PackMaterials | null = null;
  if (mats && mats.materials) {
    materials = {};
    for (const [name, m] of Object.entries(mats.materials)) {
      if (!m || typeof m.albedo !== 'string') continue;
      const abs = (u?: string) => (u ? (/^https?:/.test(u) ? u : base + u) : undefined);
      materials[name] = { ...m, albedo: abs(m.albedo)!, albedo_512: abs(m.albedo_512), normal: abs(m.normal), metres: Number(m.metres) || 2 };
    }
  }
  const im = L.imagery;
  const imagery: PackImagery | null =
    im && im.kind === 'xyz' && typeof im.template === 'string'
      ? { kind: 'xyz', template: im.template, maxzoom: Number(im.maxzoom) || 18, attribution: im.attribution as string | undefined, captured: im.captured as string | undefined }
      : null;
  // the ground: a pack may carry its own pyramid (paths relative to the pack, or absolute)
  const tl = L.terrain;
  const abs = (u: unknown) => (typeof u === 'string' && u ? (/^https?:/.test(u) ? u : base + u) : null);
  const ground = tl && String(tl.kind) === 'terrarium' && abs(tl.index) && abs(tl.template)
    ? { index: abs(tl.index)!, template: abs(tl.template)!, maxzoom: Number(tl.maxzoom) || 17 }
    : null;
  const record = treesCsv ? parseTrees(treesCsv, manifest.frame) : [];
  return applyEdits({
    base, manifest, record, trees: record, removed: 0, survey, county, roofs, vision,
    visionNow: vision, notes: EMPTY, lines: EMPTY, zones: EMPTY, terrain: EMPTY, build: EMPTY, edits, imagery, ground, materials
  });
}
