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

import * as THREE from 'three';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';

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
}

const FT = 0.3048;

export class Structures {
  group = new THREE.Group();
  list: Structure[] = [];

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
    for (const s of this.list) {
      if (pid && s.pid !== pid) continue;
      if (s.status === 'model' && s.model && s.position) void this.addModel(s);
      else if (s.outline && s.outline.length >= 3) this.addPlan(s);
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
  private async addModel(s: Structure) {
    try {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const url = s.model!.startsWith('http') ? s.model! : `${this.origin}${s.model}`;
      const gltf = await new GLTFLoader().loadAsync(url);
      const root = gltf.scene;
      const [lng, lat] = s.position!;
      const w = this.frame.toWorld(lng, lat);
      root.position.set(w.x, this.field.atOr(lng, lat, 0) + (s.altitudeM ?? 0), w.z);
      root.rotation.y = -(s.rotationDeg ?? 0) * Math.PI / 180;
      root.scale.setScalar(s.scale ?? 1);
      root.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      root.name = `model:${s.id}`;
      this.group.add(root);
    } catch (e) { console.info('[world] model ' + s.id, e); }
  }
}
