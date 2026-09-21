// What was brought in from outside: a model, a scan, a photo turned into a model.
//
//   The owner walks the land with a phone. A scan app (Scaniverse, Polycam, KIRI, Luma) turns the
//   walk into a Gaussian splat; an AI turns a photo or a sketch into a model; a studio exports a
//   .glb. Any of those can be dropped on the world and set down on the hill where it belongs.
//
//   Two kinds:
//     - a MODEL (.glb): meshes, loaded with the same loader the registry's buildings use.
//     - a SCAN  (.spz .ply .splat .ksplat .sog .rad): a Gaussian splat, drawn by Spark, which fuses
//       splats with the ordinary meshes through the depth buffer. Spark is a large module (about
//       2.7 MB) and it is imported the first time a scan is shown, never before, so a world
//       with no scans in it never pays for the ability to show one.
//
//   Where they live: in THIS BROWSER, in IndexedDB, the file and its placing together. That is on
//   purpose for now. A scan of the property is the owner's photograph of it, and it must not end up
//   in a public repository by accident; a hosted copy is a later, deliberate step. A browser that
//   cannot keep them (a private window) keeps them for the session.
//
//   Setting one down: the thing is re-centred so the middle of its base sits on its position, then
//   stood on the ground there. A scan's "base" is its ground: the low 2nd percentile of its splat
//   centres, so a few stray splats under the hill do not lift the whole scan into the air. `lift`
//   corrects what the guess gets wrong; `turn` is degrees clockwise seen from above; `scale` is a
//   plain factor (a phone scan is already in metres, so 1 is right).

import * as THREE from 'three';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import { makeGltfLoader } from './gltf';

export type ImportKind = 'model' | 'splat';

export const MODEL_EXT = ['glb', 'gltf'] as const;
export const SPLAT_EXT = ['spz', 'ply', 'splat', 'ksplat', 'sog', 'rad'] as const;
export const PHOTO_EXT = ['jpg', 'jpeg', 'png', 'webp'] as const;
/** what a file picker should offer */
export const ACCEPT = [...MODEL_EXT, ...SPLAT_EXT, ...PHOTO_EXT].map(e => '.' + e).join(',');

export interface ImportItem {
  id: string;
  /** the pack it was brought into */
  pack: string;
  name: string;
  kind: ImportKind;
  ext: string;
  bytes: number;
  /** where the file itself is kept */
  fileKey: string;
  /** where it stands: lng, lat */
  position: [number, number];
  /** metres above the ground the guess put it on */
  lift: number;
  /** degrees, clockwise seen from above */
  turn: number;
  scale: number;
  /** a scan made the usual way (y down) is turned upright */
  flip: boolean;
  /** a scan's stray splats (sky, noise, reflections far outside what was scanned) are hidden */
  tidy?: boolean;
  /** where it came from: 'file', 'meshy', 'tripo' … */
  source: string;
  /** the words or the photo it was made from, when it was made */
  note?: string;
  added: string;
  /** its native size once loaded (before scale): width, depth, height in metres */
  native?: [number, number, number];
}

/** the extension of a file name, lower case, without the dot */
export function extOf(name: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(name.trim());
  return m ? m[1].toLowerCase() : '';
}

/** what a file is, by its name: a model, a scan, a photo, or nothing we can use */
export function sortOf(name: string): ImportKind | 'photo' | null {
  const e = extOf(name);
  if ((MODEL_EXT as readonly string[]).includes(e)) return 'model';
  if ((SPLAT_EXT as readonly string[]).includes(e)) return 'splat';
  if ((PHOTO_EXT as readonly string[]).includes(e)) return 'photo';
  return null;
}

export function megabytes(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`;
}

// ---- the keeping ------------------------------------------------------------------------------------
//   IndexedDB: one store for the files (a key to a Blob), one for the placings (an id to an item).
//   Every call is guarded; when the browser will not keep anything, a Map keeps it for the session.

const DB = 'spatial-map-imports';

class Keep {
  private db: Promise<IDBDatabase | null>;
  private files = new Map<string, Blob>();
  private items = new Map<string, ImportItem>();

  constructor() {
    this.db = new Promise(resolve => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains('files')) d.createObjectStore('files');
          if (!d.objectStoreNames.contains('items')) d.createObjectStore('items', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }

  private async tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
    const d = await this.db;
    if (!d) return undefined;
    return new Promise(resolve => {
      try {
        const r = fn(d.transaction(store, mode).objectStore(store));
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }

  async putFile(key: string, blob: Blob) { this.files.set(key, blob); await this.tx('files', 'readwrite', s => s.put(blob, key)); }
  async getFile(key: string): Promise<Blob | null> {
    const b = await this.tx<Blob>('files', 'readonly', s => s.get(key) as IDBRequest<Blob>);
    return b ?? this.files.get(key) ?? null;
  }
  async delFile(key: string) { this.files.delete(key); await this.tx('files', 'readwrite', s => s.delete(key)); }
  async putItem(item: ImportItem) { this.items.set(item.id, item); await this.tx('items', 'readwrite', s => s.put(JSON.parse(JSON.stringify(item)))); }
  async delItem(id: string) { this.items.delete(id); await this.tx('items', 'readwrite', s => s.delete(id)); }
  async list(pack: string): Promise<ImportItem[]> {
    const all = await this.tx<ImportItem[]>('items', 'readonly', s => s.getAll() as IDBRequest<ImportItem[]>);
    const src = all ?? [...this.items.values()];
    return src.filter(i => i && i.pack === pack).sort((a, b) => a.added.localeCompare(b.added));
  }
}

// ---- the drawing --------------------------------------------------------------------------------------

interface Node {
  /** stands at the position, turned and scaled */
  root: THREE.Group;
  /** the content, re-centred so its base middle is at the root's origin */
  inner: THREE.Object3D;
  /** a box the size of the content — what a selection outlines; never picked */
  proxy: THREE.Mesh;
  /** a ring on the ground a scan can be picked by (a scan itself is not picked) */
  handle: THREE.Mesh | null;
  url: string | null;
}

interface Pending { id: string; group: THREE.Group; ring: THREE.Mesh; born: number }

/* eslint-disable @typescript-eslint/no-explicit-any */
type SparkModule = any;

export class Imports {
  group = new THREE.Group();
  items: ImportItem[] = [];
  /** the last thing that went wrong, said plainly, for the panel */
  lastError: string | null = null;
  /** told whenever what is here changes */
  onChange: (() => void) | null = null;
  private keep = new Keep();
  private nodes = new Map<string, Node>();
  private pending = new Map<string, Pending>();
  private spark: SparkModule | null = null;
  private sparkRenderer: THREE.Object3D | null = null;
  private pack = '';
  private editing = false;
  private lastGround = 0;

  constructor(private frame: Frame, private field: HeightField, private renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.group.name = 'imports';
  }

  /** everything kept for this pack, drawn */
  async restore(pack: string) {
    this.pack = pack;
    const list = await this.keep.list(pack);
    this.items = list;
    await Promise.all(list.map(i => this.draw(i)));
    this.onChange?.();
  }

  item(id: string): ImportItem | null { return this.items.find(i => i.id === id) ?? null; }

  /** what a selection outlines */
  bounds(id: string): THREE.Object3D | null { return this.nodes.get(id)?.proxy ?? null; }

  /**
   * Bring a file in and stand it at a place. Resolves with the item once it is drawn; throws with a
   * plain sentence when the file cannot be used.
   */
  async add(blob: Blob, name: string, at: [number, number], extra: Partial<ImportItem> = {}): Promise<ImportItem> {
    const kind = sortOf(name);
    if (kind !== 'model' && kind !== 'splat') throw new Error(`${name}: not a model or a scan this world can open`);
    const id = `imp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const item: ImportItem = {
      id, pack: this.pack, name: name.replace(/\.[a-z0-9]+$/i, ''), kind, ext: extOf(name), bytes: blob.size,
      fileKey: `f-${id}`, position: at, lift: 0, turn: 0, scale: 1, flip: kind === 'splat', tidy: kind === 'splat', source: 'file',
      added: new Date().toISOString(), ...extra
    };
    await this.keep.putFile(item.fileKey, blob);
    this.items.push(item);
    try { await this.draw(item, blob); }
    catch (e) {
      this.items = this.items.filter(i => i.id !== id);
      await this.keep.delFile(item.fileKey);
      throw e;
    }
    await this.keep.putItem(item);
    this.onChange?.();
    return item;
  }

  /** change where or how it stands; kept unless `save` is false (a drag saves once, at the end) */
  update(id: string, patch: Partial<Pick<ImportItem, 'position' | 'lift' | 'turn' | 'scale' | 'flip' | 'tidy' | 'name'>>, save = true) {
    const item = this.item(id);
    if (!item) return;
    const flipped = (patch.flip !== undefined && patch.flip !== item.flip) || (patch.tidy !== undefined && patch.tidy !== item.tidy);
    Object.assign(item, patch);
    if (flipped) void this.redraw(item); else this.place(item);
    if (save) void this.keep.putItem(item);
    this.onChange?.();
  }

  save(id: string) { const item = this.item(id); if (item) void this.keep.putItem(item); }

  async remove(id: string) {
    const item = this.item(id);
    if (!item) return;
    this.undraw(id);
    this.items = this.items.filter(i => i.id !== id);
    await this.keep.delItem(id);
    if (!this.items.some(i => i.fileKey === item.fileKey)) await this.keep.delFile(item.fileKey);
    this.onChange?.();
  }

  /** the file itself, to hand back to the person (a download) */
  async file(id: string): Promise<Blob | null> {
    const item = this.item(id);
    return item ? this.keep.getFile(item.fileKey) : null;
  }

  /** scans are picked by a ring on the ground, shown only while editing */
  setEditing(on: boolean) {
    this.editing = on;
    for (const n of this.nodes.values()) if (n.handle) n.handle.visible = on;
  }

  // ---- work in progress: a photo on its way to becoming a model -----------------------------------------
  /** a slowly turning ring where a model is being made, so the place is not empty while it is */
  showPending(id: string, at: [number, number]) {
    this.hidePending(id);
    const w = this.frame.toWorld(at[0], at[1]);
    const g = this.field.atOr(at[0], at[1], 0);
    const group = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(1.4, 0.07, 8, 48),
      new THREE.MeshBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.85, depthWrite: false }));
    ring.rotation.x = Math.PI / 2;
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.2, 6),
      new THREE.MeshBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.6, depthWrite: false }));
    post.position.y = 1.1;
    group.add(ring, post);
    group.position.set(w.x, g + 0.15, w.z);
    group.name = `pending:${id}`;
    this.group.add(group);
    this.pending.set(id, { id, group, ring, born: performance.now() });
  }

  hidePending(id: string) {
    const p = this.pending.get(id);
    if (!p) return;
    this.group.remove(p.group);
    p.group.traverse(o => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); (m.material as THREE.Material | undefined)?.dispose(); });
    this.pending.delete(id);
  }

  /**
   * Once a frame: the pending rings breathe, and anything standing where the ground was not yet
   * known is set down again when it is. A tile arriving after the thing was placed would otherwise
   * leave it standing at sea level, hundreds of metres under the hill.
   */
  tick() {
    const now = performance.now();
    if (now - this.lastGround > 500) {
      this.lastGround = now;
      for (const item of this.items) {
        const n = this.nodes.get(item.id);
        if (!n) continue;
        const want = this.field.atOr(item.position[0], item.position[1], 0) + item.lift;
        if (Math.abs(n.root.position.y - want) > 0.01) this.place(item);
      }
    }
    for (const p of this.pending.values()) {
      const t = (now - p.born) / 1000;
      p.ring.rotation.z = t * 1.4;
      const s = 1 + 0.12 * Math.sin(t * 3);
      p.ring.scale.set(s, s, s);
    }
  }

  // ---- drawing one -------------------------------------------------------------------------------------
  private async draw(item: ImportItem, given?: Blob) {
    this.undraw(item.id);
    const blob = given ?? await this.keep.getFile(item.fileKey);
    if (!blob) { this.lastError = `${item.name}: its file is no longer in this browser`; return; }
    const inner = item.kind === 'model' ? await this.loadModel(blob, item) : await this.loadSplat(blob, item);
    const root = new THREE.Group();
    root.name = `import:${item.id}`;
    root.add(inner.object);

    // re-centre on the base, measured in the root's frame (before the root is placed)
    const box = inner.box;
    const size = box.getSize(new THREE.Vector3());
    const cx = (box.min.x + box.max.x) / 2, cz = (box.min.z + box.max.z) / 2;
    inner.object.position.x -= cx;
    inner.object.position.z -= cz;
    inner.object.position.y -= box.min.y;
    item.native = [round2(size.x), round2(size.z), round2(size.y)];

    const proxy = new THREE.Mesh(new THREE.BoxGeometry(Math.max(size.x, 0.1), Math.max(size.y, 0.1), Math.max(size.z, 0.1)),
      new THREE.MeshBasicMaterial({ visible: false }));
    proxy.position.y = size.y / 2;
    proxy.raycast = () => { /* outlines, never picked */ };
    root.add(proxy);

    let handle: THREE.Mesh | null = null;
    if (item.kind === 'splat') {
      handle = new THREE.Mesh(new THREE.CircleGeometry(1.1, 32),
        new THREE.MeshBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide }));
      handle.rotation.x = -Math.PI / 2;
      handle.position.y = 0.08;
      handle.renderOrder = 5;
      handle.visible = this.editing;
      root.add(handle);
    }

    this.group.add(root);
    this.nodes.set(item.id, { root, inner: inner.object, proxy, handle, url: null });
    this.place(item);
  }

  private async redraw(item: ImportItem) { await this.draw(item); this.onChange?.(); }

  private undraw(id: string) {
    const n = this.nodes.get(id);
    if (!n) return;
    this.group.remove(n.root);
    n.root.traverse(o => {
      const m = o as THREE.Mesh & { dispose?: () => void };
      if ((m as unknown as { isSplatMesh?: boolean }).isSplatMesh) { try { m.dispose?.(); } catch { /* fine */ } return; }
      if (m.geometry) m.geometry.dispose();
      const mat = m.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose();
    });
    if (n.url) URL.revokeObjectURL(n.url);
    this.nodes.delete(id);
  }

  /** stand it where it says, on the ground there */
  private place(item: ImportItem) {
    const n = this.nodes.get(item.id);
    if (!n) return;
    const [lng, lat] = item.position;
    const w = this.frame.toWorld(lng, lat);
    n.root.position.set(w.x, this.field.atOr(lng, lat, 0) + item.lift, w.z);
    n.root.rotation.set(0, -item.turn * Math.PI / 180, 0);
    n.root.scale.setScalar(item.scale);
    n.root.updateMatrixWorld(true);
  }

  private async loadModel(blob: Blob, item: ImportItem): Promise<{ object: THREE.Object3D; box: THREE.Box3 }> {
    if (item.ext === 'gltf') {
      // a .gltf that points at side files cannot be opened from one dropped file; one that embeds them can
      const text = await blob.text();
      if (/"uri"\s*:\s*"(?!data:)/.test(text)) throw new Error(`${item.name}.gltf points at other files — export it as a single .glb`);
    }
    const loader = await makeGltfLoader();
    const buf = await blob.arrayBuffer();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      loader.parse(buf, '', g => resolve(g as unknown as { scene: THREE.Group }), err => reject(err));
    }).catch((e: unknown) => {
      const why = String((e as Error)?.message || e);
      if (/draco/i.test(why)) throw new Error(`${item.name}: Draco-compressed — export it again without Draco (or with meshopt)`);
      throw new Error(`${item.name}: could not be opened (${why.slice(0, 120)})`);
    });
    const root = gltf.scene;
    root.traverse(o => {
      const m = o as THREE.Mesh;
      if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
    });
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    if (box.isEmpty()) throw new Error(`${item.name}: the file holds nothing to draw`);
    return { object: root, box };
  }

  private async loadSplat(blob: Blob, item: ImportItem): Promise<{ object: THREE.Object3D; box: THREE.Box3 }> {
    const spark = await this.sparkModule();
    const types: Record<string, string> = { ply: 'ply', spz: 'spz', splat: 'splat', ksplat: 'ksplat', sog: 'pcsogszip', rad: 'rad' };
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mesh = new spark.SplatMesh({ fileBytes: bytes, fileType: types[item.ext], fileName: `${item.name}.${item.ext}`, raycastable: false });
    try { await mesh.initialized; }
    catch (e) { throw new Error(`${item.name}: the scan could not be read (${String((e as Error)?.message || e).slice(0, 120)})`); }
    mesh.raycast = () => { /* a scan is picked by its ring, not by its splats */ };
    mesh.frustumCulled = false;
    mesh.name = '';
    // the usual capture frame is y-down, z-forward; turning half round the x axis stands it up
    if (item.flip) mesh.quaternion.set(1, 0, 0, 0);
    mesh.updateMatrix();
    const box = robustBox(mesh, mesh.matrix);
    if (!box) throw new Error(`${item.name}: the scan holds no splats`);
    if (item.tidy !== false) hideStrays(mesh, mesh.matrix, box);
    return { object: mesh, box };
  }

  private async sparkModule(): Promise<SparkModule> {
    if (!this.spark) {
      this.spark = await import('@sparkjsdev/spark');
      this.sparkRenderer = new this.spark.SparkRenderer({ renderer: this.renderer });
      this.sparkRenderer!.name = 'spark';
      // it draws every splat in the scene from one object at the origin, and the origin is under the
      // hill (the ground is some 400 m up): culled by its own bounds, it would draw nothing at all
      this.sparkRenderer!.frustumCulled = false;
      this.scene.add(this.sparkRenderer!);
    }
    return this.spark;
  }
}

function round2(v: number) { return Math.round(v * 100) / 100; }

/**
 * Hide the splats well outside what was scanned: anything beyond the scan's robust extent grown by a
 * quarter on every side is made fully transparent. Nothing is deleted — untick "hide strays" and
 * they come back — and the file is untouched.
 */
function hideStrays(mesh: any, m: THREE.Matrix4, box: THREE.Box3) {
  const ps = mesh.packedSplats;
  if (!ps || typeof ps.setSplat !== 'function') return;
  const size = box.getSize(new THREE.Vector3());
  const grown = box.clone().expandByVector(size.multiplyScalar(0.25).max(new THREE.Vector3(1, 1, 1)));
  const v = new THREE.Vector3();
  let hidden = 0;
  mesh.forEachSplat((i: number, c: THREE.Vector3, s: THREE.Vector3, q: THREE.Quaternion, _o: number, col: THREE.Color) => {
    v.copy(c).applyMatrix4(m);
    if (grown.containsPoint(v)) return;
    ps.setSplat(i, c, s, q, 0, col);
    hidden++;
  });
  if (hidden) { ps.needsUpdate = true; mesh.updateVersion?.(); }
}

/**
 * The extent of a scan that ignores its strays: the 2nd to 98th percentile of the splat centres on
 * each axis, in the frame `m` puts them in. Scans carry sky and noise far outside the thing scanned,
 * and the plain bounding box of a real scan is often ten times the size of what anybody captured.
 */
function robustBox(mesh: { forEachSplat: (cb: (i: number, c: THREE.Vector3) => void) => void; numSplats?: number; packedSplats?: { numSplats: number } }, m: THREE.Matrix4): THREE.Box3 | null {
  const total = Number(mesh.packedSplats?.numSplats ?? mesh.numSplats ?? 0) || 0;
  const every = Math.max(1, Math.floor(total / 120000));
  const xs: number[] = [], ys: number[] = [], zs: number[] = [];
  const v = new THREE.Vector3();
  mesh.forEachSplat((i, c) => {
    if (i % every) return;
    v.copy(c).applyMatrix4(m);
    if (!isFinite(v.x) || !isFinite(v.y) || !isFinite(v.z)) return;
    xs.push(v.x); ys.push(v.y); zs.push(v.z);
  });
  if (!xs.length) return null;
  const q = (a: number[], p: number) => { a.sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))]; };
  if (xs.length < 50) {
    return new THREE.Box3(new THREE.Vector3(Math.min(...xs), Math.min(...ys), Math.min(...zs)), new THREE.Vector3(Math.max(...xs), Math.max(...ys), Math.max(...zs)));
  }
  return new THREE.Box3(new THREE.Vector3(q(xs, 0.02), q(ys, 0.02), q(zs, 0.02)), new THREE.Vector3(q(xs, 0.98), q(ys, 0.98), q(zs, 0.98)));
}
