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
  trees: PackTree[];
  survey: FeatureCollection;
  county: FeatureCollection;
  roofs: FeatureCollection;
  vision: FeatureCollection;
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

  const [treesCsv, survey, county, roofs, vision] = await Promise.all([
    file('trees') ? text(file('trees')!) : Promise.resolve(null),
    fc('survey'), fc('county'), fc('roofs'), fc('vision')
  ]);
  const im = L.imagery;
  const imagery: PackImagery | null =
    im && im.kind === 'xyz' && typeof im.template === 'string'
      ? { kind: 'xyz', template: im.template, maxzoom: Number(im.maxzoom) || 18, attribution: im.attribution as string | undefined, captured: im.captured as string | undefined }
      : null;
  return {
    base, manifest,
    trees: treesCsv ? parseTrees(treesCsv, manifest.frame) : [],
    survey, county, roofs, vision, imagery
  };
}
