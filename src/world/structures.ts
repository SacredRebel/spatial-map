// What is proposed to stand here.
//
//   The atlas is the planner: a designed building is a row in its data/structures.json, sited in
//   its placement studio and served from /api/structures. This world reads that same registry, so
//   a building moved on the map moves here too, and neither has an opinion of its own about where
//   anything is.
//
//   Three states, the same three the atlas draws. A `site` is ground reserved and nothing more. A
//   `massing` is a block at the right footprint and height, to judge bulk. A `model` is the real
//   thing — a .glb, loaded only when there is one to load, so a world with no buildings never pays
//   for the loader.
//
//   A model you can go into says so: `enter` means the .glb carries its own floors and walls, as
//   plan rings in its `extras.walk`, and the world walks those instead of treating the outline as
//   one solid block. And a proposal that stands where something stands today says that too:
//   `clears` names the standing things (the today layer's kinds) that come down when it goes up,
//   so the two are never drawn through each other.

import * as THREE from 'three';
import { makeGltfLoader } from './gltf';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import type { Solid } from './collide';
import type { Platform } from './build';

export interface Structure {
  id: string; pid: string; mode: 'vision' | 'current' | 'both';
  name: string; note?: string;
  status: 'site' | 'massing' | 'model';
  outline?: [number, number][] | null;
  heightFt?: number | null;
  model?: string | null;
  position?: [number, number] | null;
  altitudeM?: number | null;
  rotationDeg?: number;
  scale?: number;
  /** the model carries its own floors and walls (extras.walk) — go in, do not bounce off the outline */
  enter?: boolean;
  /** what stands here today and comes down for this: kinds from the today layer (`house`, `shed`…) */
  clears?: string[];

  //   What it costs and when it happens, carried onto the row from the project zones the owner
  //   wrote. Optional throughout: a community that has not costed anything is a community whose
  //   map should say nothing about money rather than say zero.
  /** the project zone this structure belongs to, which is where the money comes from */
  zone?: string;
  /** the phase it starts in */
  phase?: number | null;
  /** the phases it spans, inclusive — `[1, 3]` runs from the first to the third */
  phaseSpan?: [number, number] | null;
  /** parsed for sorting and summing only; null when the source could not honestly become a range */
  costUSD?: { low: number; high: number } | null;
  /** how much that figure is worth: a quote, a takeoff, an estimate, or a stand-in */
  costBasis?: 'takeoff' | 'quoted' | 'estimate' | 'placeholder';
  /** the budget exactly as it was written — THIS is what a reader should be shown */
  costSource?: string | null;
  /** the timeline exactly as it was written */
  timeline?: string | null;
}

/**
 * Where a structure IS, whether or not anything stands there yet.
 *
 *   A row with a model carries a position. A reserved SITE carries only an outline — ground set
 *   aside with nothing on it — and it still has a place on the earth. Both a deep link and the
 *   tour need the same answer, so they ask the same function rather than each inventing a rule
 *   and drifting apart.
 */
export function placeOf(s: Structure): [number, number] | null {
  if (s.position) return s.position;
  if (s.outline && s.outline.length >= 3) {
    return [s.outline.reduce((t, q) => t + q[0], 0) / s.outline.length,
            s.outline.reduce((t, q) => t + q[1], 0) / s.outline.length];
  }
  return null;
}

/** what a model's extras.walk holds: plan rings in model metres, heights in model metres */
interface Walk {
  floors?: { name?: string; ring: [number, number][]; top: number }[];
  solids?: { name?: string; ring: [number, number][]; base: number; top: number }[];
}

/** a structure as a proposal carries it: a full row, or an id to take off the map */
export type StructureChange = Structure & { remove?: boolean };

const FT = 0.3048;

export class Structures {
  group = new THREE.Group();
  list: Structure[] = [];
  /** floors and walls the loaded models brought with them, in world metres */
  platforms: Platform[] = [];
  solids: Solid[] = [];
  private gen = 0;
  /** called when a model's floors and walls have arrived, so the walker can be told */
  onWalk: (() => void) | null = null;

  constructor(private frame: Frame, private field: HeightField, private origin: string) {
    this.group.name = 'structures';
  }

  async load(pid?: string): Promise<Structure[]> {
    try {
      const url = `${this.origin}/api/structures${pid ? `?property=${encodeURIComponent(pid)}` : ''}`;
      const r = await fetch(url);
      if (!r.ok) return [];
      const j = await r.json();
      this.list = Array.isArray(j?.structures) ? j.structures : [];
    } catch { this.list = []; }
    return this.list;
  }

  /** draw everything that belongs to this property; models are fetched in the background */
  build(pid?: string) {
    this.clear();
    // a model still loading from an earlier build must not land in this one: without this, a burst
    // of edits drew the same house several times over, and walked on each copy's floors
    const gen = ++this.gen;
    for (const s of this.list) {
      if (pid && s.pid !== pid) continue;
      if (s.status === 'model' && s.model && s.position) void this.addModel(s, gen);
      else if (s.outline && s.outline.length >= 3) this.addPlan(s);
    }
  }

  /** the standing things every model here clears: what today's layer must not draw */
  cleared(pid?: string): Set<string> {
    const out = new Set<string>();
    for (const s of this.list) {
      if (pid && s.pid !== pid) continue;
      if (s.status !== 'model' || !Array.isArray(s.clears)) continue;
      for (const k of s.clears) out.add(String(k));
    }
    return out;
  }

  /** the ground the models occupy, as world rings: a recorded tree inside one is not drawn */
  occupied(pid?: string): { x: number; z: number }[][] {
    const out: { x: number; z: number }[][] = [];
    for (const s of this.list) {
      if (pid && s.pid !== pid) continue;
      if (s.status !== 'model' || !s.outline || s.outline.length < 3) continue;
      out.push(s.outline.map(([lng, lat]) => { const w = this.frame.toWorld(lng, lat); return { x: w.x, z: w.z }; }));
    }
    return out;
  }

  /** take everything down and free it, so a build after a change draws only what is now true */
  clear() {
    this.platforms = []; this.solids = [];
    for (const o of this.group.children.slice()) {
      o.traverse(c => {
        const m = c as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose();
      });
      this.group.remove(o);
    }
  }


  /** a ring of lng/lat as a world-space shape lying on the ground */
  private ring(outline: [number, number][]): { pts: THREE.Vector3[]; base: number } {
    let base = Infinity;
    const pts = outline.map(([lng, lat]) => {
      const w = this.frame.toWorld(lng, lat);
      const h = this.field.atOr(lng, lat, 0);
      if (h < base) base = h;
      return new THREE.Vector3(w.x, h, w.z);
    });
    return { pts, base: isFinite(base) ? base : 0 };
  }

  private addPlan(s: Structure) {
    const { pts, base } = this.ring(s.outline!);
    const closed = pts.slice();
    if (!closed[0].equals(closed[closed.length - 1])) closed.push(closed[0].clone());

    // the outline itself, hovering a hand's width over the ground so it never z-fights the hill
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(closed.map(p => new THREE.Vector3(p.x, p.y + 0.12, p.z))),
      new THREE.LineBasicMaterial({ color: '#c9a2ff' })
    );
    line.name = `site:${s.id}`;
    this.group.add(line);

    if (s.status === 'massing') {
      const h = (s.heightFt ?? 20) * FT;
      const shape = new THREE.Shape(closed.map(p => new THREE.Vector2(p.x, p.z)));
      const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);          // extrude grows in +z; stand it up
      const mesh = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({
        color: '#c9a2ff', transparent: true, opacity: 0.55
      }));
      mesh.position.y = base + h;
      mesh.castShadow = true;
      mesh.name = `massing:${s.id}`;
      this.group.add(mesh);
    } else {
      // reserved ground: a translucent slab over the footprint
      const shape = new THREE.Shape(closed.map(p => new THREE.Vector2(p.x, p.z)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(Math.PI / 2);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        color: '#8e5cf5', transparent: true, opacity: 0.2, side: THREE.DoubleSide, depthWrite: false
      }));
      mesh.position.y = base + 0.06;
      mesh.name = `plan:${s.id}`;
      this.group.add(mesh);
    }
  }

  /** a real building. The loader is imported here and nowhere else, so it ships only when used. */
  private async addModel(s: Structure, gen = this.gen) {
    try {
      const loader = await makeGltfLoader();
      // absolute (another of ours serves it), a blob the studio just handed over, or the atlas's own path
      const url = s.model!.startsWith('http') || s.model!.startsWith('blob:') ? s.model! : `${this.origin}${s.model}`;
      const gltf = await loader.loadAsync(url);
      if (gen !== this.gen) return;            // the world was rebuilt while this loaded
      const root = gltf.scene;
      const [lng, lat] = s.position!;
      const w = this.frame.toWorld(lng, lat);
      root.position.set(w.x, this.field.atOr(lng, lat, 0) + (s.altitudeM ?? 0), w.z);
      root.rotation.y = -(s.rotationDeg ?? 0) * Math.PI / 180;
      root.scale.setScalar(s.scale ?? 1);
      root.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      root.name = `model:${s.id}`;
      this.group.add(root);
      if (s.enter) this.walk(s, root);
    } catch (e) { console.info('[world] model ' + s.id, e); }
  }

  /** read the floors and walls a model carries and set them down where the model stands */
  private walk(s: Structure, root: THREE.Object3D) {
    const walk = (root.userData?.walk || root.children[0]?.userData?.walk) as Walk | undefined;
    if (!walk) return;
    root.updateMatrixWorld(true);
    const k = s.scale ?? 1;
    const place = (ring: [number, number][]) => ring.map(([x, z]) => {
      const w = root.localToWorld(new THREE.Vector3(x, 0, z));
      return { x: w.x, z: w.z };
    });
    let n = 0;
    for (const f of walk.floors || []) {
      if (!Array.isArray(f.ring) || f.ring.length < 3 || !isFinite(f.top)) continue;
      this.platforms.push({ id: `${s.id}:${f.name || 'floor'}`, ring: place(f.ring), top: root.position.y + f.top * k });
      n++;
    }
    for (const w of walk.solids || []) {
      if (!Array.isArray(w.ring) || w.ring.length < 3 || !isFinite(w.top)) continue;
      this.solids.push({ id: `${s.id}:${w.name || 'wall'}`, ring: place(w.ring), base: root.position.y + (w.base ?? 0) * k, top: root.position.y + w.top * k });
      n++;
    }
    if (n) this.onWalk?.();
  }
}

/**
 * The registry with a set of changes laid over it: a change with an id the list has replaces
 * that row; a new id is appended; `remove: true` drops it. The atlas merges the same way, so what
 * is drawn here is what the atlas will hold once the changes are saved.
 */
export function mergeChanges(list: Structure[], changes: StructureChange[]): Structure[] {
  const out = list.slice();
  for (const c of changes) {
    const at = out.findIndex(s => s.id === c.id);
    if (c.remove) { if (at >= 0) out.splice(at, 1); continue; }
    const row = { ...c } as StructureChange; delete row.remove;
    if (at >= 0) out[at] = row; else out.push(row);
  }
  return out;
}
