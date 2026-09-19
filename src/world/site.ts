// The site: what the world hands the studio so a design is made on the real ground.
//
//   A regular grid of true heights around the model origin, the surveyed line, the easement,
//   the standing roofs and the massing outline as guide lines, and the massing itself as a
//   ghost to trace or replace. The shapes mirror ECO-DEVPLAN-01 §5 exactly — the builder side
//   compiles against the same text. Local metres, x east, z NORTH in this payload; the bridge
//   on the builder side converts to the world's z-south once, in one place.

import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import type { PackData } from './pack';
import type { Structure } from './structures';

export interface EcoSite {
  v: 'eco/1';
  originLL: [number, number];
  originElevM: number;
  terrain: { w: number; h: number; stepM: number; originOffsetM: [number, number]; heights: number[] };
  guides: { kind: 'boundary' | 'easement' | 'footprint' | 'massing-outline' | 'road'; pts: [number, number][]; name?: string }[];
  refGlb?: string;
  northDeg?: number;
}

export interface EcoWalk {
  floors: { name: string; ring: [number, number][]; top: number }[];
  solids: { name: string; ring: [number, number][]; base: number; top: number }[];
}

const SPAN_M = 144, STEP_M = 1.5, REF_CAP = 6 * 1024 * 1024;

/** every-nth thinning so a 300-point surveyed ring travels light without losing its shape */
function thin(pts: [number, number][], cap = 400): [number, number][] {
  if (pts.length <= cap) return pts;
  const step = Math.ceil(pts.length / cap);
  const out: [number, number][] = [];
  for (let i = 0; i < pts.length; i += step) out.push(pts[i]);
  if (out[out.length - 1] !== pts[pts.length - 1]) out.push(pts[pts.length - 1]);
  return out;
}

/**
 * Build the site payload around an origin — the designed structure's position when there is
 * one (the chimney), else where the player stands.
 */
export function buildSite(
  frame: Frame, field: HeightField, pack: PackData | null,
  structure: Structure | null, playerLL: { lng: number; lat: number }
): EcoSite {
  const originLL: [number, number] = structure?.position ? [structure.position[0], structure.position[1]] : [playerLL.lng, playerLL.lat];
  const [olng, olat] = originLL;
  const originElevM = field.atOr(olng, olat, 0);
  const w0 = frame.toWorld(olng, olat);

  // metres east/north of the origin → lng/lat, through the frame so both apps share one answer
  const at = (e: number, n: number) => frame.toLngLat(w0.x + e, w0.z - n);

  const n = Math.round(SPAN_M / STEP_M) + 1;                 // 97 × 97 at 1.5 m covers the knoll
  const half = SPAN_M / 2;
  const heights = new Array<number>(n * n);
  for (let j = 0; j < n; j++) {                              // row 0 is the NORTH edge, per contract
    const north = half - j * STEP_M;
    for (let i = 0; i < n; i++) {
      const ll = at(i * STEP_M - half, north);
      heights[j * n + i] = field.atOr(ll.lng, ll.lat, originElevM);
    }
  }

  const toLocal = (lng: number, lat: number): [number, number] => {
    const w = frame.toWorld(lng, lat);
    return [+(w.x - w0.x).toFixed(2), +(w0.z - w.z).toFixed(2)];   // z-north here, by design
  };
  const ringOf = (coords: number[][]): [number, number][] => thin(coords.map(c => toLocal(c[0], c[1])));

  const guides: EcoSite['guides'] = [];
  if (pack) {
    for (const f of pack.survey.features) {
      const L = f.properties?.layer;
      if (L === 'boundary' && f.geometry.type === 'Polygon') guides.push({ kind: 'boundary', pts: ringOf(f.geometry.coordinates[0]), name: 'surveyed line' });
      else if (L === 'easement' && f.geometry.type === 'Polygon') guides.push({ kind: 'easement', pts: ringOf(f.geometry.coordinates[0]), name: 'easement' });
    }
    for (const f of pack.roofs.features) {
      if (f.geometry.type === 'Polygon') guides.push({ kind: 'footprint', pts: ringOf(f.geometry.coordinates[0]), name: String(f.properties?.name ?? 'standing roof') });
    }
    for (const f of pack.county.features) {
      if (f.properties?.layer === 'road' && f.geometry.type === 'LineString') guides.push({ kind: 'road', pts: ringOf(f.geometry.coordinates), name: 'road' });
    }
  }
  if (structure?.outline) guides.push({ kind: 'massing-outline', pts: thin(structure.outline.map(p => toLocal(p[0], p[1]))), name: structure.name });

  return { v: 'eco/1', originLL, originElevM, terrain: { w: n, h: n, stepM: STEP_M, originOffsetM: [-half, half], heights }, guides, northDeg: 0 };
}

/** fetch the standing massing so the studio can show it as a ghost; quietly nothing on failure */
export async function refGlbOf(structure: Structure | null): Promise<string | null> {
  const url = structure?.model;
  if (!url || structure?.status !== 'model') return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const buf = await r.arrayBuffer();
    if (buf.byteLength > REF_CAP) return null;
    let s = '';
    const b = new Uint8Array(buf);
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return btoa(s);
  } catch { return null; }
}
