// The ground, as a number you can ask for anywhere.
//
//   The atlas bakes USGS 3DEP at 1 m into terrarium PNGs, one small pyramid per property. This
//   loads those tiles and turns them into a single question the rest of the world can ask:
//   "how high is the ground at this longitude and latitude?"
//
//   Everything else falls out of that. The terrain mesh is that function sampled on a grid; the
//   player stands on it; a building sits on it. One source of truth means no seams between tiles
//   and no disagreement between what you see and what you walk on.
//
//   terrarium: elevation = (R * 256 + G + B / 256) - 32768, in metres above sea level.

import { tileBounds, tileOf, tilesCovering, type TileId } from './geo';

const SIZE = 256;

export interface Area { pid: string; bbox: [number, number, number, number]; tiles: number }
export interface Index { minzoom: number; maxzoom: number; tileSize: number; areas: Area[] }

interface Loaded { id: TileId; bounds: [number, number, number, number]; h: Float32Array }

const key = (t: TileId) => `${t.z}/${t.x}/${t.y}`;

export class HeightField {
  index: Index | null = null;
  private tiles = new Map<string, Loaded>();
  private pending = new Map<string, Promise<Loaded | null>>();
  private missing = new Set<string>();
  /** how many metres of relief the loaded tiles cover, for the camera's far plane and the fog */
  min = Infinity;
  max = -Infinity;

  constructor(private origin: string) {}

  async loadIndex(): Promise<Index | null> {
    try {
      const r = await fetch(`${this.origin}/terrain/index.json`);
      if (!r.ok) return null;
      this.index = await r.json();
      return this.index;
    } catch { return null; }
  }

  /** the area whose box contains this point, if any */
  areaAt(lng: number, lat: number): Area | null {
    for (const a of this.index?.areas ?? []) {
      if (lng >= a.bbox[0] && lng <= a.bbox[2] && lat >= a.bbox[1] && lat <= a.bbox[3]) return a;
    }
    return null;
  }

  /** load every tile at `z` covering the box; resolves once the ground there can be asked for */
  async loadBox(bbox: [number, number, number, number], z: number): Promise<number> {
    const want = tilesCovering(bbox, z);
    const got = await Promise.all(want.map(t => this.tile(t)));
    return got.filter(Boolean).length;
  }

  private tile(id: TileId): Promise<Loaded | null> {
    const k = key(id);
    const have = this.tiles.get(k);
    if (have) return Promise.resolve(have);
    if (this.missing.has(k)) return Promise.resolve(null);
    const inflight = this.pending.get(k);
    if (inflight) return inflight;
    const p = this.fetchTile(id).then(t => {
      this.pending.delete(k);
      if (t) this.tiles.set(k, t); else this.missing.add(k);
      return t;
    });
    this.pending.set(k, p);
    return p;
  }

  private async fetchTile(id: TileId): Promise<Loaded | null> {
    try {
      const r = await fetch(`${this.origin}/terrain/${id.z}/${id.x}/${id.y}.png`);
      if (!r.ok) return null;
      const bmp = await createImageBitmap(await r.blob());
      const c = new OffscreenCanvas(SIZE, SIZE);
      const g = c.getContext('2d', { willReadFrequently: true });
      if (!g) return null;
      g.drawImage(bmp, 0, 0, SIZE, SIZE);
      bmp.close();
      const px = g.getImageData(0, 0, SIZE, SIZE).data;
      const h = new Float32Array(SIZE * SIZE);
      for (let i = 0, j = 0; i < h.length; i++, j += 4) {
        const v = px[j] * 256 + px[j + 1] + px[j + 2] / 256 - 32768;
        h[i] = v;
        if (v < this.min) this.min = v;
        if (v > this.max) this.max = v;
      }
      return { id, bounds: tileBounds(id), h };
    } catch { return null; }
  }

  /** the deepest loaded tile covering a point, or null */
  private find(lng: number, lat: number): Loaded | null {
    const max = this.index?.maxzoom ?? 17, min = this.index?.minzoom ?? 13;
    for (let z = max; z >= min; z--) {
      const t = this.tiles.get(key(tileOf(lng, lat, z)));
      if (t) return t;
    }
    return null;
  }

  /** metres above sea level, bilinearly interpolated, or null where nothing is loaded */
  at(lng: number, lat: number): number | null {
    const t = this.find(lng, lat);
    if (!t) return null;
    const [w, s, e, n] = t.bounds;
    // pixel space: x grows east, y grows south, sample centres at +0.5
    const fx = ((lng - w) / (e - w)) * SIZE - 0.5;
    const fy = ((n - lat) / (n - s)) * SIZE - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const cl = (v: number) => Math.min(SIZE - 1, Math.max(0, v));
    const px = (x: number, y: number) => t.h[cl(y) * SIZE + cl(x)];
    const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  /** the ground, with a fallback so a walker never falls through a tile that has not arrived */
  atOr(lng: number, lat: number, fallback: number): number {
    const v = this.at(lng, lat);
    return v == null || !isFinite(v) ? fallback : v;
  }

  get loadedTiles(): number { return this.tiles.size; }
}
