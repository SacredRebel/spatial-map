// The editor: the world's god mode with a pencil.
//
//   Fly anywhere (G), then press B and the world becomes editable: click a tree and mark it gone,
//   pick up a project's post and put it where it really goes, pin a marker with a name on the
//   gate or the well or the place a photograph was taken, draw a fence, a path, a dirt road.
//
//   Nothing here edits the record. Every action is one FEATURE of the pack's edits layer — the
//   same `op` / `layer` grammar the pack already uses for the fourteen trees by the house — held
//   unsaved in the browser, applied on top of the record so what you see is what will be saved,
//   and committed to the pack's repository through the atlas with the owner's PIN. Undo pops the
//   last one. Reload, and the unsaved ones are still there.
//
//   Picking: trees are instanced meshes, so a hit gives an instance id and the vegetation keeps
//   the index back to the record; the ground is not raycast against the mesh at all but marched
//   along the ray against the height function, which is exact and costs nothing.

import * as THREE from 'three';
import type { Frame } from '../world/geo';
import type { HeightField } from '../world/heightfield';
import type { Vegetation } from '../world/vegetation';
import type { Today } from '../world/today';
import type { Player } from '../player/player';
import type { Feature, PackData, PackTree } from '../world/pack';

export type Tool = 'select' | 'marker' | 'tree' | 'fence' | 'path' | 'road';

export type Pick =
  | { kind: 'tree'; index: number; tree: PackTree; point: THREE.Vector3 }
  | { kind: 'vision'; id: string; name: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'note'; id: string; name: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'line'; id: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'building'; name: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'ground'; point: THREE.Vector3; lng: number; lat: number };

export interface EditorOpts {
  dom: HTMLElement;
  camera: THREE.Camera;
  frame: Frame;
  field: HeightField;
  player: Player;
  vegetation: Vegetation;
  today: Today;
  scene: THREE.Scene;
  /** the pack, once it has loaded; null before */
  pack: () => PackData | null;
  /** apply the unsaved edits on top of the record and redraw */
  rebuild: (extra: Feature[]) => void;
  /** the atlas origin — the save endpoint lives there */
  atlas: string;
  /** how to ask for a name or a number; window.prompt when absent (tests supply their own) */
  ask?: (question: string, initial: string) => string | null;
  onChange: (e: Editor) => void;
}

const KEY = (id: string) => `spatial-map:edits:${id}`;

export class Editor {
  active = false;
  tool: Tool = 'select';
  edits: Feature[] = [];
  selection: Pick | null = null;
  hover: Pick | null = null;
  /** when a project's post has been picked up and is waiting for a ground click */
  moving: { id: string; name: string } | null = null;
  /** the line being drawn, as lng/lat pairs, before it is finished */
  drawing: [number, number][] = [];
  /** what the last save said, for the panel */
  lastSave: { ok: boolean; message: string; at: number } | null = null;
  private ray = new THREE.Raycaster();
  private halo: THREE.Mesh;
  private box: THREE.BoxHelper;
  private preview: THREE.Line;
  private group = new THREE.Group();
  private counter = 0;
  private lastHover = 0;

  constructor(private o: EditorOpts) {
    this.group.name = 'editor';
    this.halo = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: '#4fd1c5', wireframe: true, transparent: true, opacity: 0.55, depthTest: false })
    );
    this.halo.visible = false;
    this.halo.renderOrder = 10;
    this.box = new THREE.BoxHelper(new THREE.Object3D(), '#4fd1c5');
    this.box.visible = false;
    (this.box.material as THREE.LineBasicMaterial).depthTest = false;
    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#4fd1c5', depthTest: false }));
    this.preview.visible = false;
    this.preview.renderOrder = 10;
    this.group.add(this.halo, this.box, this.preview);
    o.scene.add(this.group);
    this.ray.params.Line = { threshold: 0.6 };
    this.wire();
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  /** once the pack is known: the unsaved edits from last time, minus any the pack has since taken in */
  restore() {
    const pack = this.o.pack();
    if (!pack) return;
    try {
      const raw = localStorage.getItem(KEY(pack.manifest.id));
      const list = raw ? (JSON.parse(raw) as Feature[]) : [];
      const have = new Set(pack.edits.features.map(f => String(f.properties.id)));
      this.edits = list.filter(f => f && f.properties && !have.has(String(f.properties.id)));
    } catch { this.edits = []; }
    if (this.edits.length) this.o.rebuild(this.edits);
    this.o.onChange(this);
  }

  setActive(on: boolean) {
    if (on === this.active) return;
    this.active = on;
    this.o.player.editing = on;
    this.o.dom.style.cursor = on ? 'crosshair' : '';
    if (!on) { this.cancel(); this.select(null); this.setHover(null); }
    this.o.onChange(this);
  }
  toggle() { this.setActive(!this.active); }

  setTool(t: Tool) {
    this.cancel();
    this.tool = t;
    this.o.onChange(this);
  }

  /** abandon whatever is half done: a move, a line */
  cancel() {
    this.moving = null;
    this.drawing = [];
    this.preview.visible = false;
    this.o.onChange(this);
  }

  // ---- picking ---------------------------------------------------------------------------------
  /** the ray under a client position */
  private rayAt(clientX: number, clientY: number): THREE.Raycaster {
    const r = this.o.dom.getBoundingClientRect();
    const nd = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(nd, this.o.camera);
    return this.ray;
  }

  /** where a ray meets the hillside: marched against the height function, then bisected */
  ground(ray: THREE.Ray): THREE.Vector3 | null {
    const h = (p: THREE.Vector3) => { const ll = this.o.frame.toLngLat(p.x, p.z); return this.o.field.atOr(ll.lng, ll.lat, NaN); };
    let t = 0;
    const p = new THREE.Vector3();
    let prev = 0;
    for (let i = 0; i < 4000; i++) {
      t += i < 200 ? 0.5 : 2;
      p.copy(ray.origin).addScaledVector(ray.direction, t);
      const g = h(p);
      if (!isFinite(g)) return null;
      if (p.y <= g) {
        let lo = prev, hi = t;
        for (let k = 0; k < 20; k++) {
          const mid = (lo + hi) / 2;
          p.copy(ray.origin).addScaledVector(ray.direction, mid);
          if (p.y <= h(p)) hi = mid; else lo = mid;
        }
        return p.copy(ray.origin).addScaledVector(ray.direction, hi);
      }
      prev = t;
      if (t > 3000) break;
    }
    return null;
  }

  /** what is under a client position: the nearest thing, or the ground */
  pick(clientX: number, clientY: number): Pick | null {
    const pack = this.o.pack();
    const ray = this.rayAt(clientX, clientY);
    const targets: THREE.Object3D[] = [...this.o.vegetation.recordMeshes, this.o.today.group];
    const hits = ray.intersectObjects(targets, true);
    const groundPoint = this.ground(ray.ray);
    const groundDist = groundPoint ? groundPoint.distanceTo(ray.ray.origin) : Infinity;
    for (const hit of hits) {
      if (hit.distance > groundDist + 0.5) break;
      const obj = hit.object;
      if ((obj as THREE.InstancedMesh).isInstancedMesh && hit.instanceId != null && pack) {
        const idx = this.o.vegetation.recordIndex.get(obj as THREE.InstancedMesh)?.[hit.instanceId];
        if (idx != null && pack.trees[idx]) return { kind: 'tree', index: idx, tree: pack.trees[idx], point: hit.point };
        continue;
      }
      // walk up to the named marker / line / building
      let o: THREE.Object3D | null = obj;
      while (o && !o.name && o.parent) o = o.parent;
      if (!o || !o.name) continue;
      const [type, id] = o.name.split(':');
      if (type === 'vision') return { kind: 'vision', id, name: this.visionName(id), object: o, point: hit.point };
      if (type === 'note') return { kind: 'note', id, name: this.noteName(id), object: o, point: hit.point };
      if (type === 'line') return { kind: 'line', id, object: o, point: hit.point };
      if (type === 'today') return { kind: 'building', name: id, object: o, point: hit.point };
    }
    if (groundPoint) {
      const ll = this.o.frame.toLngLat(groundPoint.x, groundPoint.z);
      return { kind: 'ground', point: groundPoint, lng: ll.lng, lat: ll.lat };
    }
    return null;
  }

  private visionName(id: string): string {
    const f = this.o.pack()?.visionNow.features.find(x => String(x.properties.id) === id);
    return String(f?.properties.name || id);
  }
  private noteName(id: string): string {
    const f = this.o.pack()?.notes.features.find(x => String(x.properties.id) === id);
    return String(f?.properties.name || id);
  }

  // ---- the visuals -----------------------------------------------------------------------------
  private setHover(p: Pick | null) {
    this.hover = p;
    this.halo.visible = false;
    this.box.visible = false;
    const shown = this.selection && this.selection.kind !== 'ground' ? this.selection : p;
    if (!shown) return;
    if (shown.kind === 'tree') {
      const w = this.o.frame.toWorld(shown.tree.lng, shown.tree.lat);
      const g = this.o.field.atOr(shown.tree.lng, shown.tree.lat, shown.point.y);
      // the crown as drawn: the vegetation widens a thin record crown to at least a fifth of the height
      const r = Math.min(0.6 * shown.tree.height, Math.max(shown.tree.crown, 0.22 * shown.tree.height, 0.6));
      this.halo.scale.set(r, shown.tree.height, r);
      this.halo.position.set(w.x, g + shown.tree.height / 2, w.z);
      this.halo.visible = true;
    } else if (shown.kind !== 'ground') {
      this.box.setFromObject(shown.object);
      this.box.visible = true;
    }
  }

  select(p: Pick | null) {
    this.selection = p;
    this.setHover(this.hover);
    this.o.onChange(this);
  }

  // ---- input -----------------------------------------------------------------------------------
  private wire() {
    const d = this.o.dom;
    d.addEventListener('pointermove', e => {
      if (!this.active) return;
      const now = performance.now();
      if (now - this.lastHover < 60) return;         // the pick is not free; fifteen a second is plenty
      this.lastHover = now;
      if (this.drawing.length) { const g = this.ground(this.rayAt(e.clientX, e.clientY).ray); this.previewLine(g); }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    d.addEventListener('click', e => {
      if (!this.active || e.button !== 0) return;
      this.click(e.clientX, e.clientY);
    });
    d.addEventListener('dblclick', e => { if (this.active && this.drawing.length >= 2) { e.preventDefault(); this.finishLine(); } });
    window.addEventListener('keydown', e => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'b') { this.toggle(); return; }
      if (!this.active) return;
      if (k === 'escape') this.cancel();
      else if (k === 'enter' && this.drawing.length >= 2) this.finishLine();
      else if (k === 'backspace' && this.drawing.length) { this.drawing.pop(); this.previewLine(null); this.o.onChange(this); }
      else if (k === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.undo(); }
      else if (k === 'delete' && this.selection) { this.remove(this.selection); }
      else if (k === '1') this.setTool('select');
      else if (k === '2') this.setTool('marker');
      else if (k === '3') this.setTool('tree');
      else if (k === '4') this.setTool('fence');
      else if (k === '5') this.setTool('path');
      else if (k === '6') this.setTool('road');
    });
  }

  /** a click, by tool */
  click(clientX: number, clientY: number) {
    const p = this.pick(clientX, clientY);
    if (!p) return;
    if (this.moving) {
      if (p.kind === 'ground') this.moveVision(this.moving.id, p.lng, p.lat);
      return;
    }
    switch (this.tool) {
      case 'select': this.select(p); break;
      case 'marker': if (p.kind === 'ground') this.promptNote(p.lng, p.lat); break;
      case 'tree': if (p.kind === 'ground') this.promptTree(p.lng, p.lat); break;
      case 'fence': case 'path': case 'road':
        if (p.kind === 'ground') { this.drawing.push([p.lng, p.lat]); this.previewLine(null); this.o.onChange(this); }
        break;
    }
  }

  // ---- the edits themselves --------------------------------------------------------------------
  private stamp(props: Record<string, unknown>): Record<string, unknown> {
    return { id: `e-${Date.now().toString(36)}-${(this.counter++).toString(36)}`, by: 'owner', authority: 'owner', reported: new Date().toISOString().slice(0, 10), via: 'world', ...props };
  }

  private commit(f: Feature) {
    this.edits.push(f);
    this.persist();
    this.o.rebuild(this.edits);
    this.select(null);
    this.setHover(null);
    this.o.onChange(this);
  }

  /** a tree is gone: a removal at its own position, tight enough to take only it */
  markGone(t: PackTree) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'remove', layer: 'trees', radius_m: 0.6, what: `tree ${t.height.toFixed(1)} m` }), geometry: { type: 'Point', coordinates: [t.lng, t.lat] } });
  }

  /** a tree that is there now */
  addTree(lng: number, lat: number, height: number, crown?: number) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'trees', height_m: height, crown_m: crown ?? Math.max(1, height / 3) }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  addNote(lng: number, lat: number, name: string) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'notes', name }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  addLine(kind: 'fence' | 'path' | 'road', coords: [number, number][], name: string) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'lines', kind, name }), geometry: { type: 'LineString', coordinates: coords } });
  }

  /** pick up a project's post; the next ground click puts it down */
  beginMove(id: string, name: string) { this.moving = { id, name }; this.o.onChange(this); }

  moveVision(id: string, lng: number, lat: number) {
    // one move per project in a session: a second move replaces the first
    this.edits = this.edits.filter(f => !(f.properties.op === 'move' && f.properties.layer === 'vision' && f.properties.target === id));
    this.moving = null;
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'move', layer: 'vision', target: id }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  /** remove whatever is selected: a tree is marked gone; a project is taken off; a session note or line is dropped */
  remove(p: Pick) {
    if (p.kind === 'tree') this.markGone(p.tree);
    else if (p.kind === 'vision') {
      const f = this.o.pack()?.visionNow.features.find(x => String(x.properties.id) === p.id);
      const where = f && f.geometry.type === 'Point' ? f.geometry.coordinates : [p.point.x, p.point.y] as [number, number];
      this.commit({ type: 'Feature', properties: this.stamp({ op: 'remove', layer: 'vision', target: p.id }), geometry: { type: 'Point', coordinates: where } });
    }
    else if (p.kind === 'note' || p.kind === 'line') {
      const before = this.edits.length;
      this.edits = this.edits.filter(f => String(f.properties.id) !== p.id);
      if (this.edits.length !== before) { this.persist(); this.o.rebuild(this.edits); this.select(null); this.setHover(null); this.o.onChange(this); }
    }
  }

  undo() {
    if (!this.edits.length) return;
    this.edits.pop();
    this.persist();
    this.o.rebuild(this.edits);
    this.select(null);
    this.setHover(null);
    this.o.onChange(this);
  }

  private promptNote(lng: number, lat: number) {
    const name = (this.o.ask?.('What is here?', 'gate') ?? window.prompt('What is here?', 'gate'))?.trim();
    if (name) this.addNote(lng, lat, name);
  }
  private promptTree(lng: number, lat: number) {
    const v = (this.o.ask?.('How tall, in metres?', '6') ?? window.prompt('How tall, in metres?', '6'));
    const h = Number(v);
    if (isFinite(h) && h > 0.5 && h < 60) this.addTree(lng, lat, h);
  }

  private previewLine(cursor: THREE.Vector3 | null) {
    const pts = this.drawing.map(([lng, lat]) => {
      const w = this.o.frame.toWorld(lng, lat);
      return new THREE.Vector3(w.x, this.o.field.atOr(lng, lat, 0) + 0.3, w.z);
    });
    if (cursor) pts.push(cursor.clone().setY(cursor.y + 0.3));
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.preview.visible = pts.length >= 1;
  }

  finishLine() {
    if (this.drawing.length < 2) return;
    const kind = (this.tool === 'fence' || this.tool === 'path' || this.tool === 'road') ? this.tool : 'fence';
    const name = (this.o.ask?.(`Name this ${kind}`, kind) ?? window.prompt(`Name this ${kind}`, kind))?.trim() || kind;
    const coords = this.drawing.slice();
    this.drawing = [];
    this.preview.visible = false;
    this.addLine(kind, coords, name);
  }

  // ---- keeping and saving ----------------------------------------------------------------------
  private persist() {
    const pack = this.o.pack();
    if (!pack) return;
    try { localStorage.setItem(KEY(pack.manifest.id), JSON.stringify(this.edits)); } catch { /* private mode: the edits live for the session */ }
  }

  /** the unsaved edits as a file the pack would accept as its edits layer */
  toGeoJSON(): string {
    return JSON.stringify({ type: 'FeatureCollection', name: 'edits', features: this.edits }, null, 1);
  }

  download() {
    const blob = new Blob([this.toGeoJSON()], { type: 'application/geo+json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'edits.geojson';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /**
   * Commit the unsaved edits to the pack through the atlas.
   *
   *   The atlas holds the PIN and the token; the world only ever sends the PIN it was given and the
   *   features. On success the features become part of the pack's own edits layer here, so what
   *   is drawn does not change, and the unsaved list is empty.
   */
  async save(pin: string): Promise<{ ok: boolean; message: string }> {
    const pack = this.o.pack();
    if (!pack) return this.said(false, 'no pack loaded');
    if (!this.edits.length) return this.said(true, 'nothing to save');
    try {
      const r = await fetch(`${this.o.atlas}/api/pack/edits`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, pack: pack.manifest.id, features: this.edits })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const why = j.error === 'bad_pin' ? 'wrong PIN' : j.error === 'not_configured' ? 'the atlas has no token for this pack yet' : (j.error || `HTTP ${r.status}`);
        return this.said(false, `not saved: ${why}`);
      }
      pack.edits.features.push(...this.edits);
      this.edits = [];
      this.persist();
      this.o.rebuild(this.edits);
      return this.said(true, `saved ${j.count ?? ''} to the pack${j.commit ? ` · ${String(j.commit).slice(0, 7)}` : ''}`);
    } catch (e) {
      return this.said(false, `not saved: ${(e as Error).message}`);
    }
  }

  private said(ok: boolean, message: string) {
    this.lastSave = { ok, message, at: Date.now() };
    this.o.onChange(this);
    return { ok, message };
  }
}
