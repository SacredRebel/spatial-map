// The editor: the world's god mode with a pencil.
//
//   Fly anywhere (G), then press B and the world becomes editable: click a tree and mark it gone,
//   pick up a project's post and put it where it really goes, pin a marker with a name on the
//   gate or the well or the place a photograph was taken, draw a fence, a path, a dirt road. Put
//   down a BLOCK — so many metres by so many, so high — and drag it about on a metre grid until it
//   sits where the house would sit, and read off whether it fits.
//
//   Nothing here edits the record. Every action is one FEATURE of the pack's edits layer, or one
//   CHANGE to the atlas's registry of designed structures — held unsaved in the browser, applied on
//   top of what is known so what you see is what will be saved, and sent to the atlas as a
//   PROPOSAL. An admin's proposal is applied at once; a builder's waits for an admin. Undo steps
//   back through snapshots. Reload, and the unsaved ones are still there.
//
//   Picking: trees are instanced meshes, so a hit gives an instance id and the vegetation keeps
//   the index back to the record; the ground is not raycast against the mesh at all but marched
//   along the ray against the height function, which is exact and costs nothing.
//
//   Construction (v0.9): walls, floors and roofs are parts — each one a feature of the build layer
//   — drawn on the metre grid, snapped to the half metre and to the ends of other walls, cut
//   through with doors and windows, moved and turned like blocks, changed in place (a later
//   feature with the same id replaces the earlier one), and taken down. A room is a floor, a
//   closed wall with a door, and a roof, put down in one go.

import * as THREE from 'three';
import type { Frame } from '../world/geo';
import type { HeightField } from '../world/heightfield';
import type { Vegetation } from '../world/vegetation';
import type { Today } from '../world/today';
import type { Player } from '../player/player';
import type { Feature, PackData, PackTree } from '../world/pack';
import { mergeChanges, type Structures, type Structure, type StructureChange } from '../world/structures';
import { Along, wallLine, MATERIALS, type Build, type Opening, type RoofForm } from '../world/build';
import type { Caps } from '../world/roles';
import type { GroundGrid } from './grid';

export type Tool = 'select' | 'marker' | 'tree' | 'fence' | 'path' | 'road' | 'block' | 'magic' | 'zone' | 'terrain' | 'wall' | 'floor' | 'roof' | 'opening';

export interface ShapeSpec { op: 'flatten' | 'raise' | 'lower'; height: number; edge: number }
export interface ZoneSpec { name: string; kind: string }
export interface WallSpec { height: number; thick: number; material: string; smooth: boolean; base: number; structure: string }
export interface FloorSpec { level: number; thick: number; material: string; structure: string }
export interface RoofSpec { form: RoofForm; eaves: number; pitch: number; overhang: number; material: string; structure: string }
export interface OpeningSpec { kind: 'door' | 'window'; width: number; sill: number; head: number }
export interface RoomSpec { name: string; w: number; d: number; h: number; wall: string; floor: string; roof: RoofForm; roofMaterial: string; door: boolean }

export type Pick =
  | { kind: 'tree'; index: number; tree: PackTree; point: THREE.Vector3 }
  | { kind: 'vision'; id: string; name: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'note'; id: string; name: string; magic: boolean; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'line'; id: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'zone'; id: string; name: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'building'; name: string; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'structure'; id: string; structure: Structure; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'build'; id: string; feature: Feature; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'ground'; point: THREE.Vector3; lng: number; lat: number };

export interface BlockSpec { name: string; w: number; d: number; h: number }

export interface EditorOpts {
  dom: HTMLElement;
  camera: THREE.Camera;
  frame: Frame;
  field: HeightField;
  player: Player;
  vegetation: Vegetation;
  today: Today;
  structures: Structures;
  build: Build;
  grid: GroundGrid;
  scene: THREE.Scene;
  /** the pack, once it has loaded; null before */
  pack: () => PackData | null;
  /** the atlas's property id the structures belong to */
  pid: () => string;
  /** the atlas's registry as loaded, before any change made here */
  structuresBase: () => Structure[];
  /** what the current role may do */
  caps: () => Caps;
  /** apply the unsaved edits and structure changes on top of what is known and redraw */
  rebuild: (edits: Feature[], structures: StructureChange[]) => void;
  /** the atlas origin — the save endpoint lives there */
  atlas: string;
  /** how to ask for a name or a number; window.prompt when absent (tests supply their own) */
  ask?: (question: string, initial: string) => string | null;
  onChange: (e: Editor) => void;
}

interface Snapshot { edits: Feature[]; structures: StructureChange[] }

const KEY = (id: string) => `spatial-map:edits:${id}`;
const FT = 0.3048;
const SNAP_M = 0.5;
const SNAP_DEG = 15;
const TEAL = '#4fd1c5';

export class Editor {
  active = false;
  tool: Tool = 'select';
  /** unsaved edits to the pack's layers */
  edits: Feature[] = [];
  /** unsaved changes to the atlas's structures */
  structures: StructureChange[] = [];
  /** sent as a proposal, still drawn here, waiting for an admin */
  proposed: Snapshot = { edits: [], structures: [] };
  selection: Pick | null = null;
  hover: Pick | null = null;
  /** when a project's post has been picked up and is waiting for a ground click */
  moving: { id: string; name: string } | null = null;
  /** the line being drawn, as lng/lat pairs, before it is finished */
  drawing: [number, number][] = [];
  /** the block the next ground click puts down */
  block: BlockSpec = { name: 'block', w: 12, d: 8, h: 4 };
  /** how the next drawn polygon shapes the ground */
  shape: ShapeSpec = { op: 'flatten', height: 1, edge: 3 };
  /** what the next drawn territory is */
  zone: ZoneSpec = { name: '', kind: 'zone' };
  /** the next wall, floor, roof, opening and room */
  wall: WallSpec = { height: 2.7, thick: 0.25, material: 'plaster', smooth: false, base: 0, structure: '' };
  floor: FloorSpec = { level: 0, thick: 0.2, material: 'wood', structure: '' };
  roof: RoofSpec = { form: 'gable', eaves: 2.7, pitch: 25, overhang: 0.5, material: 'tile', structure: '' };
  opening: OpeningSpec = { kind: 'door', width: 0.9, sill: 0.9, head: 2.1 };
  room: RoomSpec = { name: 'room', w: 6, d: 4, h: 2.7, wall: 'plaster', floor: 'wood', roof: 'gable', roofMaterial: 'tile', door: true };
  /** what the last save said, for the panel */
  lastSave: { ok: boolean; message: string; at: number } | null = null;
  private history: Snapshot[] = [];
  private ray = new THREE.Raycaster();
  private halo: THREE.Mesh;
  private box: THREE.BoxHelper;
  private preview: THREE.Line;
  private dims: THREE.Sprite;
  private group = new THREE.Group();
  private counter = 0;
  private lastHover = 0;
  private drag: { id: string; kind: 'structure' | 'build'; start: Structure | Feature; from: THREE.Vector3; moved: boolean } | null = null;

  constructor(private o: EditorOpts) {
    this.group.name = 'editor';
    this.halo = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, 1, 24, 1, true),
      new THREE.MeshBasicMaterial({ color: TEAL, wireframe: true, transparent: true, opacity: 0.55, depthTest: false })
    );
    this.halo.visible = false;
    this.halo.renderOrder = 10;
    this.box = new THREE.BoxHelper(new THREE.Object3D(), TEAL);
    this.box.visible = false;
    (this.box.material as THREE.LineBasicMaterial).depthTest = false;
    this.preview = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: TEAL, depthTest: false }));
    this.preview.visible = false;
    this.preview.renderOrder = 10;
    this.dims = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false }));
    this.dims.visible = false;
    this.dims.renderOrder = 11;
    this.group.add(this.halo, this.box, this.preview, this.dims);
    o.scene.add(this.group);
    this.ray.params.Line = { threshold: 0.6 };
    this.wire();
  }

  // ---- lifecycle -------------------------------------------------------------------------------
  /** once the pack is known: the unsaved edits from last time, minus any the pack has since taken in */
  restore() {
    const pack = this.o.pack();
    if (!pack) return;
    // an edit the pack already holds, word for word, was saved meanwhile and is dropped; one with the
    // same id and different words is a change to it, and stays
    const have = new Map(pack.edits.features.map(f => [String(f.properties.id), JSON.stringify(f)]));
    const keep = (list: Feature[]) => list.filter(f => f && f.properties && have.get(String(f.properties.id)) !== JSON.stringify(f));
    try {
      const raw = localStorage.getItem(KEY(pack.manifest.id));
      const stored = raw ? JSON.parse(raw) : null;
      if (Array.isArray(stored)) { this.edits = keep(stored); }                              // v0.5 kept a bare list
      else if (stored && typeof stored === 'object') {
        this.edits = keep(Array.isArray(stored.edits) ? stored.edits : []);
        this.structures = Array.isArray(stored.structures) ? stored.structures : [];
        const p = stored.proposed;
        this.proposed = { edits: keep(p && Array.isArray(p.edits) ? p.edits : []), structures: p && Array.isArray(p.structures) ? p.structures : [] };
      }
    } catch { this.edits = []; this.structures = []; }
    if (this.edits.length || this.structures.length || this.proposed.edits.length || this.proposed.structures.length) this.redraw();
    this.o.onChange(this);
  }

  /** everything drawn on top of what is known: what was proposed, then what is still unsaved */
  private redraw() {
    this.o.rebuild(this.proposed.edits.concat(this.edits), this.proposed.structures.concat(this.structures));
  }

  get unsaved(): number { return this.edits.length + this.structures.length; }

  setActive(on: boolean) {
    if (on === this.active) return;
    if (on && !this.o.caps().edit) { this.said(false, 'editing needs a builder or admin PIN'); return; }
    this.active = on;
    this.o.player.editing = on;
    this.o.dom.style.cursor = on ? 'crosshair' : '';
    this.o.grid.visible = on;
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
    this.drag = null;
    this.preview.visible = false;
    this.o.onChange(this);
  }

  /** redraw the panel and the buttons after something outside changed (the role, say) */
  refresh() { this.o.onChange(this); }

  /** the metre grid on the ground, on or off (V) */
  toggleGrid() { this.o.grid.visible = !this.o.grid.visible; this.o.onChange(this); }

  /** each frame: the grid follows whoever is looking, or the thing they are holding */
  frame() {
    if (!this.active) return;
    const p = this.selection && this.selection.kind === 'structure' ? this.centroid(this.selection.structure)
      : this.selection && this.selection.kind === 'build' ? this.buildCentre(this.selection.feature) : this.o.player.position;
    if (p) this.o.grid.update(p.x, p.z);
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
    const targets: THREE.Object3D[] = [...this.o.vegetation.recordMeshes, this.o.today.group, this.o.structures.group, this.o.build.group];
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
      // walk up to the named marker / line / building / structure
      let o: THREE.Object3D | null = obj;
      while (o && !o.name && o.parent) o = o.parent;
      if (!o || !o.name) continue;
      const [type, id] = o.name.split(':');
      if (type === 'vision') return { kind: 'vision', id, name: this.visionName(id), object: o, point: hit.point };
      if (type === 'note') return { kind: 'note', id, name: this.noteName(id), magic: this.noteIsMagic(id), object: o, point: hit.point };
      if (type === 'line') return { kind: 'line', id, object: o, point: hit.point };
      if (type === 'zone') return { kind: 'zone', id, name: this.zoneName(id), object: o, point: hit.point };
      if (type === 'today') return { kind: 'building', name: id, object: o, point: hit.point };
      if (type === 'build') { const f = this.buildFeature(id); if (f) return { kind: 'build', id, feature: f, object: o, point: hit.point }; continue; }
      if (type === 'massing' || type === 'model' || type === 'plan' || type === 'site') {
        const s = this.structure(id);
        if (s) return { kind: 'structure', id, structure: s, object: o, point: hit.point };
      }
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
  private zoneName(id: string): string {
    const f = this.o.pack()?.zones.features.find(x => String(x.properties.id) === id);
    return String(f?.properties.name || f?.properties.kind || id);
  }
  private noteIsMagic(id: string): boolean {
    const f = this.o.pack()?.notes.features.find(x => String(x.properties.id) === id);
    return f?.properties.kind === 'magic';
  }
  /** a note as the pack now holds it */
  note(id: string): Feature | null {
    return this.o.pack()?.notes.features.find(x => String(x.properties.id) === id) ?? null;
  }

  // ---- structures: what is where, right now --------------------------------------------------------
  /** a structure as it currently stands: the unsaved change, else the proposed one, else the registry's row */
  structure(id: string): Structure | null {
    const pending = this.structures.find(s => s.id === id) ?? this.proposed.structures.find(s => s.id === id);
    if (pending) return pending.remove ? null : pending;
    return this.o.structuresBase().find(s => s.id === id) ?? null;
  }

  /** the footprint's centre in world metres */
  centroid(s: Structure): THREE.Vector3 | null {
    if (s.position) { const w = this.o.frame.toWorld(s.position[0], s.position[1]); return new THREE.Vector3(w.x, this.o.field.atOr(s.position[0], s.position[1], 0), w.z); }
    if (!s.outline || !s.outline.length) return null;
    const ring = this.ring(s.outline);
    const c = ring.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    const ll = this.o.frame.toLngLat(c.x, c.z);
    c.y = this.o.field.atOr(ll.lng, ll.lat, 0);
    return c;
  }

  private ring(outline: [number, number][]): THREE.Vector3[] {
    const pts = outline.map(([lng, lat]) => { const w = this.o.frame.toWorld(lng, lat); return new THREE.Vector3(w.x, 0, w.z); });
    if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-6) pts.pop();     // closed rings repeat the first point
    return pts;
  }

  private outlineFrom(ring: THREE.Vector3[]): [number, number][] {
    const out = ring.map(p => { const ll = this.o.frame.toLngLat(p.x, p.z); return [ll.lng, ll.lat] as [number, number]; });
    out.push(out[0]);
    return out;
  }

  /** the footprint read along its own first edge: width × depth in metres, and the height */
  dimensions(s: Structure): { w: number; d: number; h: number } {
    const h = s.status === 'massing' ? (s.heightFt ?? 20) * FT : s.status === 'model' ? 0 : 0;
    if (!s.outline || s.outline.length < 3) return { w: 0, d: 0, h };
    const ring = this.ring(s.outline);
    const u = new THREE.Vector3().subVectors(ring[1], ring[0]).setY(0).normalize();
    const v = new THREE.Vector3(-u.z, 0, u.x);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) {
      const a = p.dot(u), b = p.dot(v);
      u0 = Math.min(u0, a); u1 = Math.max(u1, a); v0 = Math.min(v0, b); v1 = Math.max(v1, b);
    }
    return { w: u1 - u0, d: v1 - v0, h };
  }

  // ---- the visuals -----------------------------------------------------------------------------
  private setHover(p: Pick | null) {
    this.hover = p;
    this.halo.visible = false;
    this.box.visible = false;
    this.dims.visible = false;
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
      if (shown.kind === 'structure') this.showDims(shown.structure);
      if (shown.kind === 'build') this.showBuildDims(shown.feature, shown.object);
    }
  }

  private showBuildDims(f: Feature, obj: THREE.Object3D) {
    const c = this.buildCentre(f);
    if (!c) return;
    const box = new THREE.Box3().setFromObject(obj);
    this.showLabel(this.describeBuild(f), c.x, box.max.y + 1.2, c.z);
  }

  /** one line for a part: what it is and how big */
  describeBuild(f: Feature): string {
    const p = f.properties;
    const kind = String(p.kind);
    const name = p.structure ? `${p.structure} · ` : '';
    if (kind === 'wall') {
      const L = this.wallAlong(f)?.total ?? 0;
      const n = Array.isArray(p.openings) ? p.openings.length : 0;
      return `${name}wall ${L.toFixed(1)} m long · ${Number(p.height_m || 2.7).toFixed(1)} m high · ${Number(p.thick_m || 0.25).toFixed(2)} m ${p.material || 'plaster'}${p.smooth ? ' · curved' : ''}${n ? ` · ${n} opening${n === 1 ? '' : 's'}` : ''}`;
    }
    const area = this.ringArea(f);
    if (kind === 'floor') return `${name}floor ${area.toFixed(0)} m² (${Math.round(area / (FT * FT))} sq ft) · ${p.material || 'wood'}${Number(p.level_m) ? ` · ${Number(p.level_m).toFixed(1)} m up` : ''}`;
    if (kind === 'roof') return `${name}${p.form || 'gable'} roof ${area.toFixed(0)} m² · eaves ${Number(p.eaves_m || 3).toFixed(1)} m · ${Number(p.pitch_deg ?? 25)}° · ${p.material || 'tile'}`;
    return `${name}${kind}`;
  }

  private ringArea(f: Feature): number {
    if (f.geometry.type !== 'Polygon') return 0;
    const ring = this.ring(f.geometry.coordinates[0] || []);
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += (ring[j].x + ring[i].x) * (ring[j].z - ring[i].z);
    return Math.abs(a / 2);
  }

  private showLabel(text: string, x: number, y: number, z: number) {
    const tex = this.labelTexture(text);
    const old = this.dims.material.map;
    this.dims.material.map = tex;
    this.dims.material.needsUpdate = true;
    old?.dispose();
    const w = Math.min(26, Math.max(6, text.length * 0.42));
    this.dims.scale.set(w, w / 8, 1);
    this.dims.position.set(x, y, z);
    this.dims.visible = true;
  }

  private showDims(s: Structure) {
    const c = this.centroid(s);
    if (!c) return;
    const { w, d, h } = this.dimensions(s);
    const ft = (m: number) => Math.round(m / FT);
    const text = s.status === 'model'
      ? `${s.name} · model${s.rotationDeg ? ` · ${s.rotationDeg}°` : ''}${s.altitudeM ? ` · ${s.altitudeM > 0 ? '+' : ''}${s.altitudeM.toFixed(2)} m` : ''}`
      : `${w.toFixed(1)} × ${d.toFixed(1)} m  (${ft(w)} × ${ft(d)} ft)${h ? ` · ${h.toFixed(1)} m high` : ''}`;
    this.showLabel(text, c.x, c.y + h + 2.2, c.z);
  }

  private labelTexture(text: string): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 96;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(12,16,14,0.85)';
    g.beginPath(); g.roundRect(0, 0, c.width, c.height, 22); g.fill();
    g.strokeStyle = TEAL; g.lineWidth = 4; g.stroke();
    g.fillStyle = '#f2efe6';
    g.font = '600 40px -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let t = text;
    while (t.length > 3 && g.measureText(t).width > c.width - 40) t = t.slice(0, -2);
    if (t !== text) t = t.replace(/\s+\S*$/, '') + '…';
    g.fillText(t, c.width / 2, c.height / 2);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  select(p: Pick | null) {
    this.selection = p;
    if (p && p.kind === 'note' && p.magic && this.o.caps().magic) this.magicOpen = p.id;
    this.setHover(this.hover);
    this.o.onChange(this);
  }

  // ---- input -----------------------------------------------------------------------------------
  private wire() {
    const d = this.o.dom;
    d.addEventListener('pointermove', e => {
      if (!this.active) return;
      if (this.drag) { this.dragTo(e.clientX, e.clientY); return; }
      const now = performance.now();
      if (now - this.lastHover < 60) return;         // the pick is not free; fifteen a second is plenty
      this.lastHover = now;
      if (this.drawing.length) { const g = this.ground(this.rayAt(e.clientX, e.clientY).ray); this.previewLine(g); }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    d.addEventListener('pointerdown', e => {
      if (!this.active || e.button !== 0 || this.tool !== 'select' || this.moving || !this.o.caps().place) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p && (p.kind === 'structure' || p.kind === 'build')) {
        const g = this.ground(this.rayAt(e.clientX, e.clientY).ray);
        if (g) {
          // the one history step for the whole move is taken now; a click that never moves gives it back
          this.snapshot();
          this.drag = { id: p.id, kind: p.kind, start: JSON.parse(JSON.stringify(p.kind === 'structure' ? p.structure : p.feature)), from: g, moved: false };
          d.setPointerCapture?.(e.pointerId);
        }
      }
    });
    d.addEventListener('pointerup', () => {
      if (!this.drag) return;
      const was = this.drag;
      this.drag = null;
      if (!was.moved) { this.history.pop(); return; }
      if (was.kind === 'structure') this.selectStructure(was.id); else this.selectBuild(was.id);
      this.persist();
      this.o.onChange(this);
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
      else if (k === 'v') this.toggleGrid();
      else if (k === '[' && this.selection?.kind === 'structure') this.rotateStructure(this.selection.id, -SNAP_DEG);
      else if (k === ']' && this.selection?.kind === 'structure') this.rotateStructure(this.selection.id, SNAP_DEG);
      else if (k === '[' && this.selection?.kind === 'build') this.rotateBuild(this.selection.id, -SNAP_DEG);
      else if (k === ']' && this.selection?.kind === 'build') this.rotateBuild(this.selection.id, SNAP_DEG);
      else if (k === 'l') this.setTool('wall');
      else if (k === 'f') this.setTool('floor');
      else if (k === 'r') this.setTool('roof');
      else if (k === 'o') this.setTool('opening');
      else if ((k === '+' || k === '=') && this.selection?.kind === 'structure') this.raiseStructure(this.selection.id, 0.25);
      else if ((k === '-' || k === '_') && this.selection?.kind === 'structure') this.raiseStructure(this.selection.id, -0.25);
      else if (k === '1') this.setTool('select');
      else if (k === '2') this.setTool('marker');
      else if (k === '3') this.setTool('tree');
      else if (k === '4') this.setTool('fence');
      else if (k === '5') this.setTool('path');
      else if (k === '6') this.setTool('road');
      else if (k === '7') this.setTool('block');
      else if (k === '8') this.setTool('magic');
      else if (k === '9') this.setTool('zone');
      else if (k === '0') this.setTool('terrain');
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
      case 'block': if (p.kind === 'ground' && this.o.caps().place) this.addBlock(p.lng, p.lat, this.block, this.o.player.state().headingDeg); break;
      case 'magic': if (p.kind === 'ground' && this.o.caps().magic) this.promptMagic(p.lng, p.lat); break;
      case 'fence': case 'path': case 'road': case 'zone': case 'terrain':
        if (p.kind === 'ground') { this.drawing.push([p.lng, p.lat]); this.previewLine(null); this.o.onChange(this); }
        break;
      case 'wall': case 'floor': case 'roof': {
        // construction draws on the grid: the point snaps to the half metre, and to the end of a wall near it
        if (!this.o.caps().place) break;
        const at = p.kind === 'ground' ? p.point : p.kind === 'build' || p.kind === 'structure' || p.kind === 'building' ? p.point : null;
        if (!at) break;
        const s = this.snapPoint(at.x, at.z);
        // a wall that comes back to its own start closes, and is finished
        if (this.tool === 'wall' && this.drawing.length >= 3) {
          const w0 = this.o.frame.toWorld(this.drawing[0][0], this.drawing[0][1]);
          if (Math.hypot(w0.x - s.x, w0.z - s.z) < 0.3) { this.drawing.push(this.drawing[0]); this.finishLine(); break; }
        }
        this.drawing.push(s.ll);
        this.previewLine(null);
        this.o.onChange(this);
        break;
      }
      case 'opening':
        if (p.kind === 'build' && p.feature.properties.kind === 'wall' && this.o.caps().place) {
          const at = this.wallDistance(p.feature, p.point);
          if (at != null) this.addOpening(p.id, Math.round(at * 2) / 2, this.opening);
        }
        break;
    }
  }

  /** a world point snapped to the half metre, or to the end of a wall within reach; back as lng/lat too */
  private snapPoint(x: number, z: number): { x: number; z: number; ll: [number, number] } {
    let sx = Math.round(x / SNAP_M) * SNAP_M, sz = Math.round(z / SNAP_M) * SNAP_M;
    let best = 0.6;
    for (const f of this.o.pack()?.build.features ?? []) {
      if (f.properties.kind !== 'wall' || f.geometry.type !== 'LineString') continue;
      const c = f.geometry.coordinates;
      for (const [lng, lat] of [c[0], c[c.length - 1]]) {
        const w = this.o.frame.toWorld(lng, lat);
        const d = Math.hypot(w.x - x, w.z - z);
        if (d < best) { best = d; sx = w.x; sz = w.z; }
      }
    }
    const ll = this.o.frame.toLngLat(sx, sz);
    return { x: sx, z: sz, ll: [ll.lng, ll.lat] };
  }

  // ---- history ---------------------------------------------------------------------------------------
  /** remember the state before a change, so undo can bring it back */
  private snapshot() {
    this.history.push({ edits: JSON.parse(JSON.stringify(this.edits)), structures: JSON.parse(JSON.stringify(this.structures)) });
    if (this.history.length > 100) this.history.shift();
  }

  undo() {
    const s = this.history.pop();
    if (!s) return;
    this.edits = s.edits;
    this.structures = s.structures;
    this.persist();
    this.redraw();
    this.select(null);
    this.setHover(null);
    this.o.onChange(this);
  }

  // ---- the edits themselves --------------------------------------------------------------------
  private stamp(props: Record<string, unknown>): Record<string, unknown> {
    return { id: `e-${Date.now().toString(36)}-${(this.counter++).toString(36)}`, by: 'owner', authority: 'owner', reported: new Date().toISOString().slice(0, 10), via: 'world', ...props };
  }

  private commit(f: Feature) {
    this.snapshot();
    this.edits.push(f);
    this.persist();
    this.redraw();
    this.select(null);
    this.setHover(null);
    this.o.onChange(this);
  }

  /** a tree is gone: a removal at its own position, tight enough to take only it */
  markGone(t: PackTree) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'remove', layer: 'trees', radius_m: 0.6, what: `tree ${t.height.toFixed(1)} m` }), geometry: { type: 'Point', coordinates: [t.lng, t.lat] } });
  }

  /** every tree within so many metres of a point is gone — the agent's "clear this" */
  removeTreesAround(lng: number, lat: number, radius: number) {
    const r = Math.min(50, Math.max(0.5, radius));
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'remove', layer: 'trees', radius_m: r, what: `trees within ${r} m` }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  /** a tree that is there now */
  addTree(lng: number, lat: number, height: number, crown?: number) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'trees', height_m: height, crown_m: crown ?? Math.max(1, height / 3) }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  addNote(lng: number, lat: number, name: string) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'notes', name }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  /** a magic box: a marker you talk to. Returns its id, and the box's chat opens on it. */
  addMagic(lng: number, lat: number, name: string): string {
    const f: Feature = { type: 'Feature', properties: this.stamp({ op: 'add', layer: 'notes', kind: 'magic', name }), geometry: { type: 'Point', coordinates: [lng, lat] } };
    this.commit(f);
    const id = String(f.properties.id);
    this.openMagic(id);
    return id;
  }

  /** the box whose chat is open, if any; the magic panel watches this */
  magicOpen: string | null = null;
  openMagic(id: string | null) { this.magicOpen = id; this.o.onChange(this); }

  private promptMagic(lng: number, lat: number) {
    const name = (this.o.ask?.('Name this magic box', 'magic box') ?? window.prompt('Name this magic box', 'magic box'))?.trim();
    if (name) this.addMagic(lng, lat, name);
  }

  addLine(kind: 'fence' | 'path' | 'road', coords: [number, number][], name: string) {
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'lines', kind, name }), geometry: { type: 'LineString', coordinates: coords } });
  }

  /** a territory drawn on the ground: a ring with a name and what it is for */
  addZone(coords: [number, number][], name: string, kind = 'zone') {
    const ring = coords.slice();
    if (ring.length < 3) return;
    ring.push(ring[0]);
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'add', layer: 'zones', name, kind }), geometry: { type: 'Polygon', coordinates: [ring] } });
  }

  /**
   * The ground shaped inside a ring: flattened to a level (the mean of the ring's ground when none
   * is given), raised or lowered by so many metres, with a bank of `edge` metres outside it.
   */
  addShaping(coords: [number, number][], op: 'flatten' | 'raise' | 'lower', height: number, edge = 3, toM?: number) {
    const ring = coords.slice();
    if (ring.length < 3) return;
    ring.push(ring[0]);
    const props: Record<string, unknown> = { op: 'add', layer: 'terrain', terrain_op: op, edge_m: Math.min(40, Math.max(0, edge)) };
    if (op === 'flatten') { if (toM != null && isFinite(toM)) props.to_m = toM; }
    else props.height_m = Math.min(20, Math.max(0.1, Math.abs(height)));
    this.commit({ type: 'Feature', properties: this.stamp(props), geometry: { type: 'Polygon', coordinates: [ring] } });
  }

  /** pick up a project's post; the next ground click puts it down */
  beginMove(id: string, name: string) { this.moving = { id, name }; this.o.onChange(this); }

  moveVision(id: string, lng: number, lat: number) {
    this.snapshot();
    // one move per project in a session: a second move replaces the first
    this.edits = this.edits.filter(f => !(f.properties.op === 'move' && f.properties.layer === 'vision' && f.properties.target === id));
    this.moving = null;
    this.history.pop();   // commit takes its own snapshot; keep one step per move
    this.commit({ type: 'Feature', properties: this.stamp({ op: 'move', layer: 'vision', target: id }), geometry: { type: 'Point', coordinates: [lng, lat] } });
  }

  /** remove whatever is selected: a tree is marked gone; a project is taken off; a session note or line is dropped; a structure is taken off the registry */
  remove(p: Pick) {
    if (p.kind === 'tree') this.markGone(p.tree);
    else if (p.kind === 'vision') {
      const f = this.o.pack()?.visionNow.features.find(x => String(x.properties.id) === p.id);
      const where = f && f.geometry.type === 'Point' ? f.geometry.coordinates : [p.point.x, p.point.y] as [number, number];
      this.commit({ type: 'Feature', properties: this.stamp({ op: 'remove', layer: 'vision', target: p.id }), geometry: { type: 'Point', coordinates: where } });
    }
    else if (p.kind === 'note' || p.kind === 'line' || p.kind === 'zone') {
      const before = this.edits.length;
      const next = this.edits.filter(f => String(f.properties.id) !== p.id);
      if (next.length !== before) { this.snapshot(); this.edits = next; this.persist(); this.redraw(); this.select(null); this.setHover(null); this.o.onChange(this); }
    }
    else if (p.kind === 'structure') this.removeStructure(p.id);
    else if (p.kind === 'build') this.removeBuild(p.id);
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

  /** the tool draws a ring rather than a line */
  private get polygonal(): boolean { return this.tool === 'zone' || this.tool === 'terrain' || this.tool === 'floor' || this.tool === 'roof'; }

  private previewLine(cursor: THREE.Vector3 | null) {
    const pts = this.drawing.map(([lng, lat]) => {
      const w = this.o.frame.toWorld(lng, lat);
      return new THREE.Vector3(w.x, this.o.field.atOr(lng, lat, 0) + 0.3, w.z);
    });
    if (cursor) pts.push(cursor.clone().setY(cursor.y + 0.3));
    if (this.polygonal && pts.length >= 3) pts.push(pts[0].clone());        // a ring closes on itself
    this.preview.geometry.dispose();
    this.preview.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.preview.visible = pts.length >= 1;
  }

  finishLine() {
    if (this.polygonal) {
      if (this.drawing.length < 3) return;
      const coords = this.drawing.slice();
      this.drawing = [];
      this.preview.visible = false;
      if (this.tool === 'zone') {
        const name = (this.o.ask?.('Name this territory', this.zone.name || this.zone.kind) ?? window.prompt('Name this territory', this.zone.name || this.zone.kind))?.trim() || this.zone.kind;
        this.addZone(coords, name, this.zone.kind);
      } else if (this.tool === 'floor') this.addFloor(coords, this.floor);
      else if (this.tool === 'roof') this.addRoof(coords, this.roof);
      else this.addShaping(coords, this.shape.op, this.shape.height, this.shape.edge);
      return;
    }
    if (this.drawing.length < 2) return;
    if (this.tool === 'wall') {
      const coords = this.drawing.slice();
      this.drawing = [];
      this.preview.visible = false;
      this.addWall(coords, this.wall);
      return;
    }
    const kind = (this.tool === 'fence' || this.tool === 'path' || this.tool === 'road') ? this.tool : 'fence';
    const name = (this.o.ask?.(`Name this ${kind}`, kind) ?? window.prompt(`Name this ${kind}`, kind))?.trim() || kind;
    const coords = this.drawing.slice();
    this.drawing = [];
    this.preview.visible = false;
    this.addLine(kind, coords, name);
  }

  // ---- structures: placing at real size -----------------------------------------------------------
  /** record a change to a structure (the whole row, as the atlas will hold it) */
  private change(row: StructureChange) {
    this.snapshot();
    this.structures = this.structures.filter(s => s.id !== row.id).concat([row]);
    this.persist();
    this.redraw();
    this.selectStructure(row.id);
    this.o.onChange(this);
  }

  /** after a redraw the old object is gone; find the new one for the same id */
  private selectStructure(id: string) {
    const s = this.structure(id);
    const obj = s ? (this.o.structures.group.getObjectByName(`massing:${id}`) ?? this.o.structures.group.getObjectByName(`model:${id}`) ?? this.o.structures.group.getObjectByName(`plan:${id}`) ?? this.o.structures.group.getObjectByName(`site:${id}`)) : null;
    if (s && obj) { const c = this.centroid(s) ?? new THREE.Vector3(); this.select({ kind: 'structure', id, structure: s, object: obj, point: c }); }
    else this.select(null);
  }

  /** a block of so many metres, put down at a point and turned to a heading, as a massing structure */
  addBlock(lng: number, lat: number, spec: BlockSpec, headingDeg = 0) {
    const w = Math.max(0.5, spec.w), d = Math.max(0.5, spec.d), h = Math.max(0.5, spec.h);
    const c = this.o.frame.toWorld(lng, lat);
    const cs = new THREE.Vector3(Math.round(c.x / SNAP_M) * SNAP_M, 0, Math.round(c.z / SNAP_M) * SNAP_M);
    const a = headingDeg * Math.PI / 180;       // world x is east, z is south; a heading turns clockwise from north, seen from above
    const corners = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) =>
      new THREE.Vector3(cs.x + x * Math.cos(a) - z * Math.sin(a), 0, cs.z + x * Math.sin(a) + z * Math.cos(a)));
    const id = `b-${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
    this.change({
      id, pid: this.o.pid(), mode: 'vision', name: spec.name || 'block', status: 'massing',
      outline: this.outlineFrom(corners), heightFt: Math.round(h / FT * 10) / 10, note: 'placed in the world'
    });
    return id;
  }

  /** move a structure by so many metres east and south, snapped to the half metre */
  moveStructure(id: string, dx: number, dz: number, snap = true) {
    const s = this.structure(id);
    if (!s) return;
    const row: StructureChange = JSON.parse(JSON.stringify(s));
    if (row.outline) {
      const ring = this.ring(row.outline);
      const c = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
      let tx = c.x + dx, tz = c.z + dz;
      if (snap) { tx = Math.round(tx / SNAP_M) * SNAP_M; tz = Math.round(tz / SNAP_M) * SNAP_M; }
      const off = new THREE.Vector3(tx - c.x, 0, tz - c.z);
      row.outline = this.outlineFrom(ring.map(p => p.clone().add(off)));
    }
    if (row.position) {
      const wpos = this.o.frame.toWorld(row.position[0], row.position[1]);
      let tx = wpos.x + dx, tz = wpos.z + dz;
      if (snap) { tx = Math.round(tx / SNAP_M) * SNAP_M; tz = Math.round(tz / SNAP_M) * SNAP_M; }
      const ll = this.o.frame.toLngLat(tx, tz);
      row.position = [ll.lng, ll.lat];
    }
    this.change(row);
  }

  /** turn a structure about its centre, in steps of fifteen degrees */
  rotateStructure(id: string, deg: number) {
    const s = this.structure(id);
    if (!s) return;
    const row: StructureChange = JSON.parse(JSON.stringify(s));
    if (row.outline) {
      const ring = this.ring(row.outline);
      const c = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
      const a = deg * Math.PI / 180;
      row.outline = this.outlineFrom(ring.map(p => {
        const x = p.x - c.x, z = p.z - c.z;
        return new THREE.Vector3(c.x + x * Math.cos(a) - z * Math.sin(a), 0, c.z + x * Math.sin(a) + z * Math.cos(a));
      }));
    }
    if (row.status === 'model') row.rotationDeg = ((Math.round(((row.rotationDeg ?? 0) + deg) / SNAP_DEG) * SNAP_DEG) % 360 + 360) % 360;
    this.change(row);
  }

  /** lift or sink a model, in quarter metres (a block sits on the ground and cannot) */
  raiseStructure(id: string, dm: number) {
    const s = this.structure(id);
    if (!s || s.status !== 'model') return;
    const row: StructureChange = JSON.parse(JSON.stringify(s));
    row.altitudeM = Math.round(((row.altitudeM ?? 0) + dm) * 100) / 100;
    this.change(row);
  }

  /** a block's height, in metres */
  setHeight(id: string, metres: number) {
    const s = this.structure(id);
    if (!s || s.status !== 'massing' || !isFinite(metres) || metres < 0.5 || metres > 90) return;
    const row: StructureChange = JSON.parse(JSON.stringify(s));
    row.heightFt = Math.round(metres / FT * 10) / 10;
    this.change(row);
  }

  /** the structure's name */
  rename(id: string, name: string) {
    const s = this.structure(id);
    if (!s || !name.trim()) return;
    const row: StructureChange = JSON.parse(JSON.stringify(s));
    row.name = name.trim().slice(0, 120);
    this.change(row);
  }

  /** take a structure off the registry: a block placed here and never saved simply vanishes; a registered one is a removal to propose */
  removeStructure(id: string) {
    const known = this.o.structuresBase().some(s => s.id === id) || this.proposed.structures.some(s => s.id === id);
    this.snapshot();
    this.structures = this.structures.filter(s => s.id !== id);
    if (known) this.structures.push({ id, pid: this.o.pid(), mode: 'vision', name: id, status: 'site', remove: true });
    this.persist();
    this.redraw();
    this.select(null);
    this.setHover(null);
    this.o.onChange(this);
  }

  /** while the button is down: the structure follows the cursor across the ground */
  private dragTo(clientX: number, clientY: number) {
    if (!this.drag) return;
    const g = this.ground(this.rayAt(clientX, clientY).ray);
    if (!g) return;
    const dx = g.x - this.drag.from.x, dz = g.z - this.drag.from.z;
    if (!this.drag.moved && Math.hypot(dx, dz) < 0.25) return;
    this.drag.moved = true;
    if (this.drag.kind === 'build') {
      // from where it started, not from the last frame, so the snap never walks; drawn live, no history entry per frame
      const next = this.shifted(this.drag.start as Feature, dx, dz, true);
      const at = this.edits.findIndex(x => String(x.properties.id) === String(next.properties.id) && x.properties.op === 'add');
      if (at >= 0) this.edits[at] = next; else this.edits.push(next);
      this.redraw();
      this.selectBuild(this.drag.id);
      return;
    }
    // move from the start, not from the last frame, so the snap never walks
    const start = this.drag.start as Structure;
    const row: StructureChange = JSON.parse(JSON.stringify(start));
    if (row.outline) {
      const ring = this.ring(row.outline);
      const c = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
      const tx = Math.round((c.x + dx) / SNAP_M) * SNAP_M, tz = Math.round((c.z + dz) / SNAP_M) * SNAP_M;
      const off = new THREE.Vector3(tx - c.x, 0, tz - c.z);
      row.outline = this.outlineFrom(ring.map(p => p.clone().add(off)));
    }
    if (row.position) {
      const wpos = this.o.frame.toWorld(row.position[0], row.position[1]);
      const ll = this.o.frame.toLngLat(Math.round((wpos.x + dx) / SNAP_M) * SNAP_M, Math.round((wpos.z + dz) / SNAP_M) * SNAP_M);
      row.position = [ll.lng, ll.lat];
    }
    // drawn live, without a history entry each frame: the snapshot is taken once, on release
    this.structures = this.structures.filter(s => s.id !== row.id).concat([row]);
    this.redraw();
    this.selectStructure(row.id);
  }

  // ---- construction: walls, floors, roofs ---------------------------------------------------------
  /** a part as it now stands — the pack after every edit has been applied */
  buildFeature(id: string): Feature | null {
    return this.o.pack()?.build.features.find(f => String(f.properties.id) === id) ?? null;
  }

  /** every part that belongs to a named structure */
  buildParts(structure: string): Feature[] {
    return (this.o.pack()?.build.features ?? []).filter(f => f.properties.structure === structure);
  }

  private wallAlong(f: Feature): Along | null {
    if (f.geometry.type !== 'LineString') return null;
    const line = wallLine(f.geometry.coordinates, !!f.properties.smooth, this.o.frame);
    return line.length >= 2 ? new Along(line) : null;
  }

  /** how far along a wall a world point is — where a click on it lands */
  wallDistance(f: Feature, point: THREE.Vector3): number | null {
    const along = this.wallAlong(f);
    if (!along) return null;
    let best = Infinity, at = 0;
    for (let i = 0; i < along.pts.length - 1; i++) {
      const a = along.pts[i], b = along.pts[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.z - a.z) * dz) / l2)) : 0;
      const d = Math.hypot(point.x - (a.x + t * dx), point.z - (a.z + t * dz));
      if (d < best) { best = d; at = along.cum[i] + t * Math.sqrt(l2); }
    }
    return at;
  }

  /** the middle of a part, on the ground */
  buildCentre(f: Feature): THREE.Vector3 | null {
    const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.type === 'Polygon' ? (f.geometry.coordinates[0] || []) : [f.geometry.coordinates];
    if (!coords.length) return null;
    const pts = this.ring(coords);
    const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).multiplyScalar(1 / pts.length);
    const ll = this.o.frame.toLngLat(c.x, c.z);
    c.y = this.o.field.atOr(ll.lng, ll.lat, 0);
    return c;
  }

  private material(name: string, fallback: string): string { return MATERIALS[name] ? name : fallback; }

  /** a wall along a line of points, of a height and a thickness; `smooth` bends it into a curve through them */
  addWall(coords: [number, number][], spec: WallSpec): string | null {
    if (coords.length < 2) return null;
    const props: Record<string, unknown> = {
      op: 'add', layer: 'build', kind: 'wall',
      height_m: Math.min(12, Math.max(0.3, spec.height)), thick_m: Math.min(1.5, Math.max(0.05, spec.thick)),
      material: this.material(spec.material, 'plaster'), openings: []
    };
    if (spec.smooth) props.smooth = true;
    if (spec.base) props.base_m = Math.min(30, Math.max(-5, spec.base));
    if (spec.structure.trim()) props.structure = spec.structure.trim().slice(0, 60);
    const f: Feature = { type: 'Feature', properties: this.stamp(props), geometry: { type: 'LineString', coordinates: coords.map(c => [c[0], c[1]]) } };
    this.commitBuild([f]);
    return String(f.properties.id);
  }

  /** a floor over a ring, at a level above the ground, of a thickness; you stand on it */
  addFloor(coords: [number, number][], spec: FloorSpec): string | null {
    if (coords.length < 3) return null;
    const ring = coords.slice(); ring.push(ring[0]);
    const props: Record<string, unknown> = { op: 'add', layer: 'build', kind: 'floor', level_m: Math.min(30, Math.max(-5, spec.level)), thick_m: Math.min(1, Math.max(0.05, spec.thick)), material: this.material(spec.material, 'wood') };
    if (spec.structure.trim()) props.structure = spec.structure.trim().slice(0, 60);
    const f: Feature = { type: 'Feature', properties: this.stamp(props), geometry: { type: 'Polygon', coordinates: [ring] } };
    this.commitBuild([f]);
    return String(f.properties.id);
  }

  /** a roof over a ring: its form, the height of its eaves, its pitch, how far it overhangs */
  addRoof(coords: [number, number][], spec: RoofSpec, ridgeDeg?: number): string | null {
    if (coords.length < 3) return null;
    const ring = coords.slice(); ring.push(ring[0]);
    const props: Record<string, unknown> = {
      op: 'add', layer: 'build', kind: 'roof', form: spec.form, eaves_m: Math.min(30, Math.max(0.5, spec.eaves)),
      pitch_deg: Math.min(60, Math.max(0, spec.pitch)), overhang_m: Math.min(3, Math.max(0, spec.overhang)), material: this.material(spec.material, 'tile')
    };
    if (ridgeDeg != null && isFinite(ridgeDeg)) props.ridge_deg = ((ridgeDeg % 360) + 360) % 360;
    if (spec.structure.trim()) props.structure = spec.structure.trim().slice(0, 60);
    const f: Feature = { type: 'Feature', properties: this.stamp(props), geometry: { type: 'Polygon', coordinates: [ring] } };
    this.commitBuild([f]);
    return String(f.properties.id);
  }

  /**
   * A room in one go — a floor, a closed wall round it with a door in the first side, and a roof —
   * so many metres by so many, so high, facing a heading, on the half-metre grid. One undo step.
   */
  addRoom(lng: number, lat: number, spec: RoomSpec, headingDeg = 0): string | null {
    const w = Math.max(1, spec.w), d = Math.max(1, spec.d), h = Math.min(12, Math.max(1, spec.h));
    const c = this.o.frame.toWorld(lng, lat);
    const cs = { x: Math.round(c.x / SNAP_M) * SNAP_M, z: Math.round(c.z / SNAP_M) * SNAP_M };
    const a = headingDeg * Math.PI / 180;
    const corners = [[-w / 2, d / 2], [w / 2, d / 2], [w / 2, -d / 2], [-w / 2, -d / 2]].map(([x, z]) =>
      new THREE.Vector3(cs.x + x * Math.cos(a) - z * Math.sin(a), 0, cs.z + x * Math.sin(a) + z * Math.cos(a)));
    const ring = this.outlineFrom(corners);            // closed: five points, the first side faces the heading
    const name = spec.name.trim().slice(0, 60) || 'room';
    const floor: Feature = { type: 'Feature', properties: this.stamp({ op: 'add', layer: 'build', kind: 'floor', level_m: 0, thick_m: 0.2, material: this.material(spec.floor, 'wood'), structure: name }), geometry: { type: 'Polygon', coordinates: [ring] } };
    const openings: Opening[] = spec.door ? [{ kind: 'door', at_m: Math.round(w) / 2, width_m: 0.9, sill_m: 0, head_m: Math.min(2.1, h - 0.2) }] : [];
    const wall: Feature = { type: 'Feature', properties: this.stamp({ op: 'add', layer: 'build', kind: 'wall', height_m: h, thick_m: 0.25, material: this.material(spec.wall, 'plaster'), base_m: 0.2, openings, structure: name }), geometry: { type: 'LineString', coordinates: ring } };
    const ridge = ((headingDeg % 360) + 360 + (w >= d ? 90 : 0)) % 360;      // the ridge runs the long way
    const roof: Feature = { type: 'Feature', properties: this.stamp({ op: 'add', layer: 'build', kind: 'roof', form: spec.roof, eaves_m: h + 0.2, pitch_deg: spec.roof === 'flat' ? 0 : 25, overhang_m: 0.5, material: this.material(spec.roofMaterial, 'tile'), ridge_deg: ridge, structure: name }), geometry: { type: 'Polygon', coordinates: [ring] } };
    this.commitBuild([floor, wall, roof], String(wall.properties.id));
    return String(wall.properties.id);
  }

  /** a room a few metres in front of where you stand, facing the way you face */
  addRoomHere(spec: RoomSpec): string | null {
    const st = this.o.player.state();
    const a = st.headingDeg * Math.PI / 180;
    const p = this.o.player.position;
    const ahead = Math.max(2, spec.d / 2 + 2);
    const ll = this.o.frame.toLngLat(p.x + Math.sin(a) * ahead, p.z - Math.cos(a) * ahead);
    return this.addRoom(ll.lng, ll.lat, spec, st.headingDeg);
  }

  /** how the editor asks a question: the host's way, or the browser's */
  ask(question: string, initial: string): string | null {
    return this.o.ask ? this.o.ask(question, initial) : window.prompt(question, initial);
  }

  /** a door or a window cut into a wall, so far along it */
  addOpening(wallId: string, at: number, spec: OpeningSpec): boolean {
    const f = this.buildFeature(wallId);
    if (!f || f.properties.kind !== 'wall') return false;
    const next: Feature = JSON.parse(JSON.stringify(f));
    const list = Array.isArray(next.properties.openings) ? next.properties.openings as Opening[] : [];
    const o: Opening = spec.kind === 'door'
      ? { kind: 'door', at_m: at, width_m: Math.min(6, Math.max(0.5, spec.width)), sill_m: 0, head_m: Math.min(Number(f.properties.height_m || 2.7) - 0.05, Math.max(1.5, spec.head)) }
      : { kind: 'window', at_m: at, width_m: Math.min(10, Math.max(0.3, spec.width)), sill_m: Math.max(0.05, spec.sill), head_m: Math.min(Number(f.properties.height_m || 2.7) - 0.05, Math.max(spec.sill + 0.3, spec.head)) };
    list.push(o);
    next.properties.openings = list;
    this.replaceBuild(next);
    return true;
  }

  removeOpening(wallId: string, index: number) {
    const f = this.buildFeature(wallId);
    if (!f || !Array.isArray(f.properties.openings)) return;
    const next: Feature = JSON.parse(JSON.stringify(f));
    (next.properties.openings as Opening[]).splice(index, 1);
    this.replaceBuild(next);
  }

  /** change a part's properties: its height, its material, whether it curves, its name */
  updateBuild(id: string, patch: Record<string, unknown>) {
    const f = this.buildFeature(id);
    if (!f) return;
    const next: Feature = JSON.parse(JSON.stringify(f));
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined || v === '' || v === null) delete next.properties[k];
      else next.properties[k] = v;
    }
    this.replaceBuild(next);
  }

  /** the middle of a set of points, a repeated closing point not counted twice */
  private centreOf(pts: { x: number; z: number }[]): { x: number; z: number } {
    const n = pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1e-6 ? pts.length - 1 : pts.length;
    let x = 0, z = 0;
    for (let i = 0; i < n; i++) { x += pts[i].x / n; z += pts[i].z / n; }
    return { x, z };
  }

  /** move a part by so many metres east and south, snapped to the half metre */
  moveBuild(id: string, dx: number, dz: number, snap = true) {
    const f = this.buildFeature(id);
    if (!f) return;
    this.replaceBuild(this.shifted(f, dx, dz, snap));
  }

  private shifted(f: Feature, dx: number, dz: number, snap: boolean): Feature {
    const next: Feature = JSON.parse(JSON.stringify(f));
    const coords = next.geometry.type === 'LineString' ? next.geometry.coordinates : next.geometry.type === 'Polygon' ? next.geometry.coordinates[0] : [next.geometry.coordinates];
    const pts = coords.map(([lng, lat]) => this.o.frame.toWorld(lng, lat));
    const c = this.centreOf(pts);
    let tx = c.x + dx, tz = c.z + dz;
    if (snap) { tx = Math.round(tx / SNAP_M) * SNAP_M; tz = Math.round(tz / SNAP_M) * SNAP_M; }
    const ox = tx - c.x, oz = tz - c.z;
    coords.forEach((q, i) => { const ll = this.o.frame.toLngLat(pts[i].x + ox, pts[i].z + oz); q[0] = ll.lng; q[1] = ll.lat; });
    return next;
  }

  /** turn a part about its middle, in steps of fifteen degrees; a roof's ridge turns with it */
  rotateBuild(id: string, deg: number) {
    const f = this.buildFeature(id);
    if (!f) return;
    const next: Feature = JSON.parse(JSON.stringify(f));
    const coords = next.geometry.type === 'LineString' ? next.geometry.coordinates : next.geometry.type === 'Polygon' ? next.geometry.coordinates[0] : [next.geometry.coordinates];
    const pts = coords.map(([lng, lat]) => this.o.frame.toWorld(lng, lat));
    const c = this.centreOf(pts);
    const a = deg * Math.PI / 180;
    coords.forEach((q, i) => {
      const x = pts[i].x - c.x, z = pts[i].z - c.z;
      const ll = this.o.frame.toLngLat(c.x + x * Math.cos(a) - z * Math.sin(a), c.z + x * Math.sin(a) + z * Math.cos(a));
      q[0] = ll.lng; q[1] = ll.lat;
    });
    if (next.properties.ridge_deg != null) next.properties.ridge_deg = ((Number(next.properties.ridge_deg) + deg) % 360 + 360) % 360;
    this.replaceBuild(next);
  }

  /** take a part down: one placed here and never saved simply vanishes; a saved one is a removal to propose */
  removeBuild(id: string) {
    const f = this.buildFeature(id);
    if (!f) return;
    const known = this.o.pack()?.edits.features.some(x => String(x.properties.id) === id) || this.proposed.edits.some(x => String(x.properties.id) === id);
    this.snapshot();
    this.edits = this.edits.filter(x => String(x.properties.id) !== id);
    if (known) {
      const where = f.geometry.type === 'Point' ? f.geometry.coordinates : f.geometry.type === 'LineString' ? f.geometry.coordinates[0] : f.geometry.coordinates[0][0];
      this.edits.push({ type: 'Feature', properties: this.stamp({ op: 'remove', layer: 'build', target: id, what: String(f.properties.kind) }), geometry: { type: 'Point', coordinates: [where[0], where[1]] } });
    }
    this.persist();
    this.redraw();
    this.select(null);
    this.setHover(null);
    this.o.onChange(this);
  }

  /** take down every part of a structure at once */
  removeStructureParts(structure: string) {
    const ids = this.buildParts(structure).map(f => String(f.properties.id));
    for (const id of ids) this.removeBuild(id);
  }

  /** several parts as one change, one undo step */
  private commitBuild(list: Feature[], select = String(list[list.length - 1].properties.id)) {
    this.snapshot();
    this.edits.push(...list);
    this.persist();
    this.redraw();
    this.selectBuild(select);
    this.o.onChange(this);
  }

  /** a changed part: a later feature with the same id replaces the earlier one, here and in the pack */
  private replaceBuild(next: Feature) {
    this.snapshot();
    next.properties.reported = new Date().toISOString().slice(0, 10);
    const at = this.edits.findIndex(x => String(x.properties.id) === String(next.properties.id) && x.properties.op === 'add');
    if (at >= 0) this.edits[at] = next; else this.edits.push(next);
    this.persist();
    this.redraw();
    this.selectBuild(String(next.properties.id));
    this.o.onChange(this);
  }

  /** after a redraw the old object is gone; find the new one for the same part */
  private selectBuild(id: string) {
    const f = this.buildFeature(id);
    const obj = f ? this.o.build.group.getObjectByName(`build:${id}`) : null;
    if (f && obj) this.select({ kind: 'build', id, feature: f, object: obj, point: this.buildCentre(f) ?? new THREE.Vector3() });
    else this.select(null);
  }

  // ---- keeping and saving ----------------------------------------------------------------------
  private persist() {
    const pack = this.o.pack();
    if (!pack) return;
    try { localStorage.setItem(KEY(pack.manifest.id), JSON.stringify({ edits: this.edits, structures: this.structures, proposed: this.proposed })); } catch { /* private mode: the edits live for the session */ }
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
   * Send the unsaved work to the atlas as a proposal.
   *
   *   The atlas holds the PIN and the token; the world only ever sends the PIN it was given and the
   *   changes. An admin's proposal is applied at once, and the changes become part of what is known
   *   here — the pack's edits layer, the registry — so nothing drawn changes. A builder's proposal
   *   waits for an admin: the changes stay drawn, marked as proposed, and the unsaved list is empty.
   */
  async save(pin: string, note = ''): Promise<{ ok: boolean; message: string }> {
    const pack = this.o.pack();
    if (!pack) return this.said(false, 'no pack loaded');
    if (!this.unsaved) return this.said(true, 'nothing to save');
    try {
      const r = await fetch(`${this.o.atlas}/api/pack/proposals`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin, pack: pack.manifest.id, note, edits: this.edits, structures: this.structures })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const why = j.error === 'bad_pin' ? 'wrong PIN' : j.error === 'not_configured' ? 'the atlas has no token for this pack yet' : j.error === 'github_error' ? `the atlas could not commit (${j.detail ? String(j.detail).slice(0, 80) : 'GitHub refused'})` : (j.error || `HTTP ${r.status}`);
        return this.said(false, `not saved: ${why}`);
      }
      const n = this.unsaved;
      if (j.applied) {
        pack.edits.features.push(...this.edits);
        const base = this.o.structuresBase();
        base.splice(0, base.length, ...mergeChanges(base, this.structures));
      } else {
        this.proposed = { edits: this.proposed.edits.concat(this.edits), structures: this.proposed.structures.concat(this.structures) };
      }
      this.edits = [];
      this.structures = [];
      this.history = [];
      this.persist();
      this.redraw();
      return this.said(true, j.applied
        ? `saved ${n} to the pack${j.commit ? ` · ${String(j.commit).slice(0, 7)}` : ''}`
        : `proposed ${n} · waiting for an admin${j.id ? ` · ${j.id}` : ''}`);
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

