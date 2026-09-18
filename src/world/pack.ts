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

export interface PackData {
  base: string;
  manifest: PackManifest;
  /** the trees as they stand: the record with the owner's edits applied */
  trees: PackTree[];
  /** how many of the record's trees an edit took down */
  removed: number;
  survey: FeatureCollection;
  county: FeatureCollection;
  roofs: FeatureCollection;
  vision: FeatureCollection;
  edits: FeatureCollection;
  imagery: PackImagery | null;
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
//   another fact, dated and attributed, and it lives in its own layer. Each edit is one feature:
//   `op` ("remove"), the `layer` it applies to, and either a Point with `radius_m` or a Polygon with
//   `buffer_m`. Applying them here, once, at load, means every consumer sees the same present.

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

/** Apply the pack's edits to its trees. Returns what stands, and how many the edits took down. */
export function applyEdits(trees: PackTree[], edits: FeatureCollection, f: PackFrame): { trees: PackTree[]; removed: number } {
  const toXY = ([lng, lat]: [number, number]): XY => ({ x: (lng - f.origin_lng) * f.metres_per_deg_lng, y: (lat - f.origin_lat) * f.metres_per_deg_lat });
  const removals = edits.features.filter(e => e.properties.op === 'remove' && (e.properties.layer ?? 'trees') === 'trees');
  if (!removals.length) return { trees, removed: 0 };
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
  return { trees: kept, removed: trees.length - kept.length };
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

  const [treesCsv, survey, county, roofs, vision, edits] = await Promise.all([
    file('trees') ? text(file('trees')!) : Promise.resolve(null),
    fc('survey'), fc('county'), fc('roofs'), fc('vision'), fc('edits')
  ]);
  const im = L.imagery;
  const imagery: PackImagery | null =
    im && im.kind === 'xyz' && typeof im.template === 'string'
      ? { kind: 'xyz', template: im.template, maxzoom: Number(im.maxzoom) || 18, attribution: im.attribution as string | undefined, captured: im.captured as string | undefined }
      : null;
  const record = treesCsv ? parseTrees(treesCsv, manifest.frame) : [];
  const { trees, removed } = applyEdits(record, edits, manifest.frame);
  return { base, manifest, trees, removed, survey, county, roofs, vision, edits, imagery };
}
