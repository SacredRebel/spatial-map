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
import { organicPlan, cleanSpec, ORGANIC_DEFAULT, roofMaterialFor, type OrganicSpec, type Quantities } from '../world/organic';
import { sortOf, megabytes, type Imports, type ImportItem } from '../world/imports';
import { photoToJpeg, type Photo3D, type Photo3DKind } from './photo3d';

export type Tool = 'select' | 'marker' | 'tree' | 'fence' | 'path' | 'road' | 'block' | 'magic' | 'zone' | 'terrain' | 'wall' | 'floor' | 'roof' | 'opening' | 'organic' | 'mark' | 'bring';

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
  | { kind: 'import'; id: string; item: ImportItem; object: THREE.Object3D; point: THREE.Vector3 }
  | { kind: 'ground'; point: THREE.Vector3; lng: number; lat: number };

export interface BlockSpec { name: string; w: number; d: number; h: number }

/**
 * A change asked of existing parts — what the agent proposes for "make these walls higher, curve
 * them to the right and add a window". Every field is optional; each applies to the parts it fits.
 */
export interface ModifySpec {
  height_m?: number; height_delta_m?: number;
  thick_m?: number; material?: string; smooth?: boolean;
  /** bow a wall this many metres at its middle; which way: the viewer's left or right, out of or into its building */
  bulge_m?: number; bulge_dir?: 'left' | 'right' | 'out' | 'in';
  add_windows?: number; window_width_m?: number; window_sill_m?: number; window_head_m?: number;
  add_door?: boolean;
  /** roofs: raise the crown (shell) or the eaves, change the finish */
  rise_delta_m?: number; eaves_delta_m?: number; roof_finish?: string;
}

/** a marked piece of ground: the ring, and the parts it takes in */
export interface Mark { ring: [number, number][]; selected: string[]; areaM2: number }
/** a file waiting for a ground click to say where it goes */
export interface Bringing { file: Blob; name: string; sort: 'model' | 'splat' | 'photo' }
/** a photo on its way to being a model */
export interface PhotoJob { id: string; name: string; at: [number, number]; stage: 'shrinking' | 'sending' | 'making' | 'fetching' | 'placing' | 'done' | 'failed'; progress: number; message?: string; thumb?: string | null }

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
  /** what was brought in from outside: models and scans, kept in this browser */
  imports: Imports;
  /** the atlas's photo → model service; absent in tests that do not need it */
  photo3d?: Photo3D;
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
  /**
   * Asked when someone reaches for the tools without the role for them. Resolves true if they now
   * have it. Without this the editor can only refuse, and a refusal with no way forward is how the
   * tools came to look as if they did not exist.
   */
  onNeedRole?: () => Promise<boolean>;
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
  /** the next organic building: its form, its make-up, and what it is called */
  organic: OrganicSpec = { ...ORGANIC_DEFAULT };
  organicName = '';
  /** the ground marked for the agent, and the parts inside it */
  mark: Mark | null = null;
  /** what the last organic building would take — the panel shows it */
  lastQuantities: Quantities | null = null;
  /** why the last organic building could not be made, when it could not */
  lastOrganicWhy: string | null = null;
  /** what the last save said, for the panel */
  lastSave: { ok: boolean; message: string; at: number } | null = null;
  private history: Snapshot[] = [];
  private ray = new THREE.Raycaster();
  private halo: THREE.Mesh;
  private box: THREE.BoxHelper;
  private preview: THREE.Line;
  private dims: THREE.Sprite;
  private markLine: THREE.Line;
  private markFill: THREE.Mesh;
  private lasso: { points: [number, number][]; last: THREE.Vector3 | null } | null = null;
  private group = new THREE.Group();
  private counter = 0;
  private lastHover = 0;
  private swallowClick = false;
  private drag: { id: string; kind: 'structure' | 'build' | 'import'; start: Structure | Feature | ImportItem; from: THREE.Vector3; moved: boolean } | null = null;
  /** the file the next ground click puts down (the bring-in tool) */
  bringing: Bringing | null = null;
  /** what a photo is of, and roughly how tall, before it becomes a model */
  photo: { kind: Photo3DKind; height: number } = { kind: 'object', height: 0 };
  /** photos being made into models */
  jobs: PhotoJob[] = [];
  /** the 3D services the atlas has a key for; null until asked */
  photoProviders: string[] | null = null;

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
    this.markLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#f5c542', depthTest: false, transparent: true, opacity: 0.95 }));
    this.markLine.visible = false;
    this.markLine.renderOrder = 12;
    this.markFill = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ color: '#f5c542', transparent: true, opacity: 0.16, depthWrite: false, side: THREE.DoubleSide }));
    this.markFill.visible = false;
    this.markFill.renderOrder = 11;
    this.group.add(this.halo, this.box, this.preview, this.dims, this.markLine, this.markFill);
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
    if (on && !this.o.caps().edit) {
      if (this.o.onNeedRole) { void this.o.onNeedRole().then(ok => { if (ok) this.setActive(true); }); return; }
      this.said(false, 'editing needs a builder or admin PIN');
      return;
    }
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
    if (this.tool !== 'bring') this.bringing = null;
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
    const targets: THREE.Object3D[] = [...this.o.vegetation.recordMeshes, this.o.today.group, this.o.structures.group, this.o.build.group, this.o.imports.group];
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
      // something brought in: its meshes carry their own names, so look for the import above them
      let up: THREE.Object3D | null = obj;
      while (up && !up.name.startsWith('import:') && up.parent) up = up.parent;
      if (up && up.name.startsWith('import:')) {
        const id = up.name.slice(7);
        const item = this.o.imports.item(id);
        if (item) return { kind: 'import', id, item, object: this.o.imports.bounds(id) ?? up, point: hit.point };
        continue;
      }
      if (obj.name.startsWith('pending:')) continue;
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
      if (shown.kind === 'import') {
        const b = new THREE.Box3().setFromObject(shown.object);
        const c = b.getCenter(new THREE.Vector3());
        this.showLabel(this.describeImport(shown.item), c.x, b.max.y + 1.2, c.z);
      }
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
      if (this.lasso) { this.lassoTo(e.clientX, e.clientY); return; }
      const now = performance.now();
      if (now - this.lastHover < 60) return;         // the pick is not free; fifteen a second is plenty
      this.lastHover = now;
      if (this.drawing.length) { const g = this.ground(this.rayAt(e.clientX, e.clientY).ray); this.previewLine(g); }
      this.setHover(this.pick(e.clientX, e.clientY));
    });
    d.addEventListener('pointerdown', e => {
      // the mark tool: press and draw round the ground to lasso it
      if (this.active && e.button === 0 && this.tool === 'mark' && !this.drawing.length) {
        const g = this.ground(this.rayAt(e.clientX, e.clientY).ray);
        if (g) { const ll = this.o.frame.toLngLat(g.x, g.z); this.lasso = { points: [[ll.lng, ll.lat]], last: g }; d.setPointerCapture?.(e.pointerId); }
        return;
      }
      if (!this.active || e.button !== 0 || this.tool !== 'select' || this.moving || !this.o.caps().place) return;
      const p = this.pick(e.clientX, e.clientY);
      if (p && p.kind === 'import') {
        const g = this.ground(this.rayAt(e.clientX, e.clientY).ray);
        if (g) { this.drag = { id: p.id, kind: 'import', start: JSON.parse(JSON.stringify(p.item)), from: g, moved: false }; d.setPointerCapture?.(e.pointerId); }
        return;
      }
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
      if (this.lasso) {
        const pts = this.lasso.points;
        this.lasso = null;
        this.preview.visible = false;
        // a real lasso closes the mark; a press that barely moved is a click, and the click adds a corner
        if (pts.length >= 6) { this.swallowClick = true; this.setMark(pts); }
        return;
      }
      if (!this.drag) return;
      const was = this.drag;
      this.drag = null;
      if (was.kind === 'import') { if (was.moved) { this.o.imports.save(was.id); this.selectImport(was.id); } return; }
      if (!was.moved) { this.history.pop(); return; }
      if (was.kind === 'structure') this.selectStructure(was.id); else this.selectBuild(was.id);
      this.persist();
      this.o.onChange(this);
    });
    d.addEventListener('click', e => {
      if (!this.active || e.button !== 0) return;
      if (this.swallowClick) { this.swallowClick = false; return; }
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
      else if (k === 'k') this.setTool('organic');
      else if (k === 'm') this.setTool('mark');
      else if (k === 'i') this.setTool('bring');
      else if (k === '[' && this.selection?.kind === 'import') this.turnImport(this.selection.id, -SNAP_DEG);
      else if (k === ']' && this.selection?.kind === 'import') this.turnImport(this.selection.id, SNAP_DEG);
      else if ((k === '+' || k === '=') && this.selection?.kind === 'import') this.liftImport(this.selection.id, 0.25);
      else if ((k === '-' || k === '_') && this.selection?.kind === 'import') this.liftImport(this.selection.id, -0.25);
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
      case 'bring':
        if (this.bringing && p.kind === 'ground') { void this.bringAt([p.lng, p.lat]); break; }
        if (!this.bringing) this.select(p);
        break;
      case 'marker': if (p.kind === 'ground') this.promptNote(p.lng, p.lat); break;
      case 'tree': if (p.kind === 'ground') this.promptTree(p.lng, p.lat); break;
      case 'block': if (p.kind === 'ground' && this.o.caps().place) this.addBlock(p.lng, p.lat, this.block, this.o.player.state().headingDeg); break;
      case 'magic': if (p.kind === 'ground' && this.o.caps().magic) this.promptMagic(p.lng, p.lat); break;
      case 'fence': case 'path': case 'road': case 'zone': case 'terrain': case 'mark':
        if (p.kind === 'ground') { this.drawing.push([p.lng, p.lat]); this.previewLine(null); this.o.onChange(this); }
        break;
      case 'organic':
        if (!this.o.caps().place) break;
        if (p.kind === 'ground' || p.kind === 'build' || p.kind === 'structure' || p.kind === 'building') {
          const ll = this.o.frame.toLngLat(p.point.x, p.point.z);
          this.drawing.push([ll.lng, ll.lat]); this.previewLine(null); this.o.onChange(this);
        }
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
    else if (p.kind === 'import') { void this.o.imports.remove(p.id); this.select(null); this.setHover(null); }
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
  private get polygonal(): boolean { return this.tool === 'zone' || this.tool === 'terrain' || this.tool === 'floor' || this.tool === 'roof' || this.tool === 'organic' || this.tool === 'mark'; }

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
      } else if (this.tool === 'organic') this.addOrganic(coords, this.organic, this.organicName);
      else if (this.tool === 'mark') this.setMark(coords);
      else if (this.tool === 'floor') this.addFloor(coords, this.floor);
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
    if (this.drag.kind === 'import') {
      // from where it started, on the half-metre, drawn live and kept once on release
      const start = this.drag.start as ImportItem;
      const w0 = this.o.frame.toWorld(start.position[0], start.position[1]);
      const ll = this.o.frame.toLngLat(Math.round((w0.x + dx) / SNAP_M) * SNAP_M, Math.round((w0.z + dz) / SNAP_M) * SNAP_M);
      this.o.imports.update(this.drag.id, { position: [ll.lng, ll.lat] }, false);
      this.selectImport(this.drag.id);
      return;
    }
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

  // ---- marking ground for the agent -----------------------------------------------------------------
  /** the lasso follows the pointer across the ground, a point every three quarters of a metre */
  private lassoTo(clientX: number, clientY: number) {
    if (!this.lasso) return;
    const g = this.ground(this.rayAt(clientX, clientY).ray);
    if (!g) return;
    if (this.lasso.last && Math.hypot(g.x - this.lasso.last.x, g.z - this.lasso.last.z) < 0.75) return;
    const ll = this.o.frame.toLngLat(g.x, g.z);
    this.lasso.points.push([ll.lng, ll.lat]);
    this.lasso.last = g;
    const keep = this.drawing;
    this.drawing = this.lasso.points;
    this.previewLine(null);
    this.drawing = keep;
  }

  /**
   * Mark a piece of ground: the ring is kept, drawn in gold, and every part of a building that has
   * any of itself inside it is taken in — a wall, a floor, a roof, and the rest of the building
   * each belongs to. The agent's panel opens on it.
   */
  setMark(coords: [number, number][]) {
    const ring = coords.slice();
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) return;
    const xz = ring.map(([lng, lat]) => this.o.frame.toWorld(lng, lat));
    let area = 0;
    for (let i = 0, j = xz.length - 1; i < xz.length; j = i++) area += xz[j].x * xz[i].z - xz[i].x * xz[j].z;
    const inside = (x: number, z: number) => {
      let r = false;
      for (let i = 0, j = xz.length - 1; i < xz.length; j = i++) { const a = xz[i], b = xz[j]; if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) r = !r; }
      return r;
    };
    const picked = new Set<string>();
    const structures = new Set<string>();
    for (const f of this.o.pack()?.build.features ?? []) {
      const coords2 = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.type === 'Polygon' ? (f.geometry.coordinates[0] || []) : [];
      // a part is in if any vertex, or any point along its edges, is inside the mark
      let hit = false;
      for (let i = 0; i < coords2.length && !hit; i++) {
        const a = this.o.frame.toWorld(coords2[i][0], coords2[i][1]);
        if (inside(a.x, a.z)) hit = true;
        const nb = coords2[i + 1];
        if (!hit && nb) { const b = this.o.frame.toWorld(nb[0], nb[1]); for (let t = 0.25; t < 1 && !hit; t += 0.25) if (inside(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) hit = true; }
      }
      if (hit) { picked.add(String(f.properties.id)); if (f.properties.structure) structures.add(String(f.properties.structure)); }
    }
    for (const name of structures) for (const f of this.buildParts(name)) picked.add(String(f.properties.id));
    this.mark = { ring, selected: [...picked], areaM2: Math.abs(area / 2) };
    this.drawing = [];
    this.preview.visible = false;
    this.drawMark();
    this.openMagic('mark');
  }

  /** after a building is grown on the mark, the mark takes in that building, so "higher" means it */
  setMarkSelected(structure: string) {
    if (!this.mark) return;
    this.mark.selected = this.buildParts(structure).map(f => String(f.properties.id));
    this.o.onChange(this);
  }

  clearMark() {
    this.mark = null;
    this.markLine.visible = false;
    this.markFill.visible = false;
    if (this.magicOpen === 'mark') this.magicOpen = null;
    this.o.onChange(this);
  }

  /** the parts the mark took in, as they now stand */
  markedParts(): Feature[] {
    if (!this.mark) return [];
    return this.mark.selected.map(id => this.buildFeature(id)).filter((f): f is Feature => !!f);
  }

  private drawMark() {
    if (!this.mark) { this.markLine.visible = this.markFill.visible = false; return; }
    const pts = this.mark.ring.map(([lng, lat]) => { const w = this.o.frame.toWorld(lng, lat); return new THREE.Vector3(w.x, this.o.field.atOr(lng, lat, 0) + 0.35, w.z); });
    this.markLine.geometry.dispose();
    this.markLine.geometry = new THREE.BufferGeometry().setFromPoints(pts.concat([pts[0].clone()]));
    this.markLine.visible = true;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.z)));
    const geo = new THREE.ShapeGeometry(shape);
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getY(i);
      const ll = this.o.frame.toLngLat(x, z);
      pos.setXYZ(i, x, this.o.field.atOr(ll.lng, ll.lat, 0) + 0.3, z);
    }
    geo.computeVertexNormals();
    this.markFill.geometry.dispose();
    this.markFill.geometry = geo;
    this.markFill.visible = true;
  }

  // ---- organic buildings ------------------------------------------------------------------------------
  /**
   * An organic building fitted inside a perimeter (lng/lat): a smooth plan, walls with a door and
   * glass, a floor, a shell roof, and a level pad under it — one undo step. Returns the name it was
   * given, or null when nothing fitted (and `lastOrganicWhy` says why).
   */
  addOrganic(coords: [number, number][], specIn: Partial<OrganicSpec>, name = ''): string | null {
    const ring = coords.slice();
    if (ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]) ring.pop();
    if (ring.length < 3) return null;
    const spec = cleanSpec(specIn);
    const title = (name || '').trim().slice(0, 60) || this.nextOrganicName();
    const parts = this.organicParts(ring, spec, title, null);
    if (!parts) return null;
    this.commitBuild(parts, String(parts.find(f => f.properties.kind === 'wall')?.properties.id ?? parts[0].properties.id));
    return title;
  }

  private nextOrganicName(): string {
    const have = new Set((this.o.pack()?.build.features ?? []).map(f => String(f.properties.structure ?? '')));
    for (let i = 1; ; i++) { const n = `bio form ${i}`; if (!have.has(n)) return n; }
  }

  /** the spec an organic building was made from, and its floor, by the building's name */
  organicOf(structure: string): { spec: OrganicSpec; perimeter: [number, number][]; floor: Feature } | null {
    const floor = this.buildParts(structure).find(f => f.properties.kind === 'floor' && f.properties.organic && typeof f.properties.organic === 'object');
    if (!floor) return null;
    const o = floor.properties.organic as Record<string, unknown>;
    const per = Array.isArray(o.perimeter) ? (o.perimeter as [number, number][]).filter(c => Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])) : [];
    if (per.length < 3) return null;
    return { spec: cleanSpec(o), perimeter: per, floor };
  }

  /** how many recorded trees stand inside a building's floor — oaks are protected here, so this is a warning, never an automatic clearing */
  treesInside(structure: string): number {
    const floor = this.buildParts(structure).find(f => f.properties.kind === 'floor');
    const pack = this.o.pack();
    if (!floor || floor.geometry.type !== 'Polygon' || !pack) return 0;
    const ring = (floor.geometry.coordinates[0] || []).map(([lng, lat]) => this.o.frame.toWorld(lng, lat));
    const inside = (x: number, z: number) => { let r = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) r = !r; } return r; };
    return pack.trees.filter(t => { const w = this.o.frame.toWorld(t.lng, t.lat); return inside(w.x, w.z); }).length;
  }

  /** what an organic building takes, worked out again from its own spec (so it is always this building's) */
  organicQuantities(structure: string): Quantities | null {
    const o = this.organicOf(structure);
    if (!o) return null;
    const plan = organicPlan(o.perimeter.map(([lng, lat]) => this.o.frame.toWorld(lng, lat)), o.spec);
    return plan.ok ? plan.quantities : null;
  }

  /**
   * Grow an organic building again with some of its numbers changed — the sliders. The parts keep
   * their ids, so this is a change to the same building, one undo step, not a new one beside it.
   */
  regenerateOrganic(structure: string, patch: Partial<OrganicSpec>): boolean {
    const was = this.organicOf(structure);
    if (!was) return false;
    const spec = cleanSpec({ ...was.spec, ...patch });
    const old = this.buildParts(structure);
    const ids = {
      floor: String(was.floor.properties.id),
      wall: String(old.find(f => f.properties.kind === 'wall')?.properties.id ?? ''),
      roof: String(old.find(f => f.properties.kind === 'roof')?.properties.id ?? ''),
      pad: String((was.floor.properties.organic as Record<string, unknown>).pad_id ?? '')
    };
    const parts = this.organicParts(was.perimeter, spec, structure, ids);
    if (!parts) return false;
    this.snapshot();
    const keepIds = new Set(parts.map(f => String(f.properties.id)));
    // anything of the building the new version no longer has (a pad switched off) is dropped
    const dropped = new Set([ids.floor, ids.wall, ids.roof, ids.pad].filter(id => id && !keepIds.has(id)));
    this.edits = this.edits.filter(x => !dropped.has(String(x.properties.id)));
    for (const next of parts) {
      next.properties.reported = new Date().toISOString().slice(0, 10);
      const at = this.edits.findIndex(x => String(x.properties.id) === String(next.properties.id) && x.properties.op === 'add');
      if (at >= 0) this.edits[at] = next; else this.edits.push(next);
    }
    this.persist();
    this.redraw();
    this.selectBuild(ids.wall || String(parts[0].properties.id));
    this.o.onChange(this);
    return true;
  }

  /** the features of an organic building, with fresh ids or the ones given */
  private organicParts(ring: [number, number][], spec: OrganicSpec, name: string, ids: { floor: string; wall: string; roof: string; pad: string } | null): Feature[] | null {
    const xz = ring.map(([lng, lat]) => this.o.frame.toWorld(lng, lat));
    const plan = organicPlan(xz, spec);
    this.lastQuantities = plan.ok ? plan.quantities : null;
    this.lastOrganicWhy = plan.ok ? null : plan.why ?? 'it did not fit';
    if (!plan.ok) { this.said(false, `no building: ${this.lastOrganicWhy}`); return null; }
    const ll = (pts: { x: number; z: number }[]) => pts.map(p => { const q = this.o.frame.toLngLat(p.x, p.z); return [q.lng, q.lat] as [number, number]; });
    const withId = (props: Record<string, unknown>, id: string | undefined) => { const st = this.stamp(props); if (id) st.id = id; return st; };
    const assembly = { structure: spec.structure, infill: spec.infill, insulation: spec.insulation };
    const out: Feature[] = [];
    let padId = '';
    if (spec.pad) {
      const pad: Feature = { type: 'Feature', properties: withId({ op: 'add', layer: 'terrain', terrain_op: 'flatten', edge_m: 3, structure: name }, ids?.pad || undefined), geometry: { type: 'Polygon', coordinates: [ll(plan.pad)] } };
      padId = String(pad.properties.id);
      out.push(pad);
    }
    const perimeter = ring.concat([ring[0]]).map(c => [+c[0].toFixed(7), +c[1].toFixed(7)]);
    const floor: Feature = { type: 'Feature', properties: withId({ op: 'add', layer: 'build', kind: 'floor', level_m: 0, thick_m: 0.3, material: this.material(spec.floor, 'earth'), structure: name,
      organic: { ...spec, perimeter, pad_id: padId || undefined } }, ids?.floor || undefined), geometry: { type: 'Polygon', coordinates: [ll(plan.floor)] } };
    const wall: Feature = { type: 'Feature', properties: withId({ op: 'add', layer: 'build', kind: 'wall', height_m: spec.height, thick_m: spec.thick, material: this.material(spec.infill, 'cob'), smooth: true,
      openings: plan.openings, structure: name, assembly }, ids?.wall || undefined), geometry: { type: 'LineString', coordinates: ll(plan.wall) } };
    const roof: Feature = { type: 'Feature', properties: withId({ op: 'add', layer: 'build', kind: 'roof', form: 'shell', eaves_m: spec.height, pitch_deg: 20, rise_m: spec.rise, overhang_m: spec.overhang,
      material: roofMaterialFor(spec.roof), finish: spec.roof, solar_ratio: spec.solar, solar_facing_deg: 180, structure: name,
      assembly: { roof_structure: spec.structure, insulation: spec.insulation } }, ids?.roof || undefined), geometry: { type: 'Polygon', coordinates: [ll(plan.roof)] } };
    out.push(floor, wall, roof);
    return out;
  }

  // ---- changing parts that are already there ------------------------------------------------------------
  /**
   * Apply one change to several parts at once — the agent's "make these walls higher, curve them to
   * the right and add a window". `right` is the viewer's right on the ground (x, z), so "right" means
   * what the person looking at it means by right. One undo step for the lot.
   */
  modifyParts(ids: string[], m: ModifySpec, right: { x: number; z: number } = { x: 1, z: 0 }): number {
    const list = ids.map(id => this.buildFeature(id)).filter((f): f is Feature => !!f);
    if (!list.length) return 0;
    const nexts: Feature[] = [];
    for (const f of list) {
      const next: Feature = JSON.parse(JSON.stringify(f));
      const p = next.properties;
      const kind = String(p.kind);
      if (kind === 'wall' && next.geometry.type === 'LineString') {
        let h = Number(p.height_m || 2.7);
        if (m.height_m != null && isFinite(m.height_m)) h = m.height_m;
        if (m.height_delta_m != null && isFinite(m.height_delta_m)) h += m.height_delta_m;
        h = Math.min(12, Math.max(0.3, h));
        p.height_m = +h.toFixed(2);
        if (m.thick_m != null && isFinite(m.thick_m)) p.thick_m = Math.min(1.5, Math.max(0.05, m.thick_m));
        if (m.material && MATERIALS[m.material]) p.material = m.material;
        if (m.smooth != null) { if (m.smooth) p.smooth = true; else delete p.smooth; }
        if (m.bulge_m && isFinite(m.bulge_m)) this.bulgeWall(next, m.bulge_m, m.bulge_dir ?? 'out', right);
        // openings keep inside the wall's new height
        const ops = (Array.isArray(p.openings) ? p.openings : []) as Opening[];
        for (const o of ops) { o.head_m = Math.min(o.head_m, +(h - 0.1).toFixed(2)); if (o.kind === 'window' && o.sill_m > o.head_m - 0.3) o.sill_m = Math.max(0.05, +(o.head_m - 0.6).toFixed(2)); }
        p.openings = ops.filter(o => o.head_m > o.sill_m + 0.25);
        const L = this.wallAlong(next)?.total ?? 0;
        if (m.add_windows && m.add_windows > 0 && L > 1) {
          const w = Math.min(4, Math.max(0.5, m.window_width_m ?? 1.2));
          const sill = Math.max(0.05, m.window_sill_m ?? 0.8), head = Math.min(h - 0.2, Math.max(sill + 0.4, m.window_head_m ?? Math.min(2.2, h - 0.3)));
          const n = Math.min(12, Math.round(m.add_windows));
          const opsNow = p.openings as Opening[];
          // spread evenly, then nudge each clear of what is already there
          for (let k = 0; k < n; k++) {
            let at = (L * (k + 1)) / (n + 1);
            for (let tries = 0; tries < 20 && opsNow.some(o => Math.abs(o.at_m - at) < (o.width_m + w) / 2 + 0.2); tries++) at += (tries % 2 ? -1 : 1) * (tries + 1) * 0.3;
            if (at < w / 2 + 0.1 || at > L - w / 2 - 0.1 || opsNow.some(o => Math.abs(o.at_m - at) < (o.width_m + w) / 2 + 0.1)) continue;
            opsNow.push({ kind: 'window', at_m: +at.toFixed(2), width_m: w, sill_m: +sill.toFixed(2), head_m: +head.toFixed(2) });
          }
          opsNow.sort((a, b) => a.at_m - b.at_m);
        }
        if (m.add_door && L > 1.2) {
          const opsNow = p.openings as Opening[];
          let at = L / 2;
          for (let tries = 0; tries < 20 && opsNow.some(o => Math.abs(o.at_m - at) < (o.width_m + 1) / 2 + 0.2); tries++) at += (tries % 2 ? -1 : 1) * (tries + 1) * 0.3;
          if (!opsNow.some(o => Math.abs(o.at_m - at) < (o.width_m + 1) / 2 + 0.1)) opsNow.push({ kind: 'door', at_m: +at.toFixed(2), width_m: 1, sill_m: 0, head_m: +Math.min(2.2, h - 0.1).toFixed(2) });
          opsNow.sort((a, b) => a.at_m - b.at_m);
        }
      } else if (kind === 'roof') {
        if (m.rise_delta_m && isFinite(m.rise_delta_m)) {
          if (p.form === 'shell') p.rise_m = +Math.min(12, Math.max(0.2, Number(p.rise_m ?? 2.2) + m.rise_delta_m)).toFixed(2);
          else p.pitch_deg = Math.min(60, Math.max(0, Number(p.pitch_deg ?? 25) + m.rise_delta_m * 8));
        }
        const eavesD = m.eaves_delta_m ?? m.height_delta_m;
        if (eavesD && isFinite(eavesD)) p.eaves_m = +Math.min(30, Math.max(0.5, Number(p.eaves_m ?? 3) + eavesD)).toFixed(2);
        if (m.height_m != null && isFinite(m.height_m)) p.eaves_m = Math.min(30, Math.max(0.5, m.height_m));
        if (m.roof_finish) { p.finish = m.roof_finish; p.material = roofMaterialFor(m.roof_finish); }
      } else if (kind === 'floor') {
        if (m.material && MATERIALS[m.material] && !m.roof_finish) { /* a wall material is not a floor's */ }
      }
      nexts.push(next);
    }
    this.snapshot();
    const today = new Date().toISOString().slice(0, 10);
    for (const next of nexts) {
      next.properties.reported = today;
      const at = this.edits.findIndex(x => String(x.properties.id) === String(next.properties.id) && x.properties.op === 'add');
      if (at >= 0) this.edits[at] = next; else this.edits.push(next);
    }
    this.persist();
    this.redraw();
    this.selectBuild(String(nexts[0].properties.id));
    if (this.mark) this.drawMark();
    this.o.onChange(this);
    return nexts.length;
  }

  /**
   * Bow a wall: its middle moves `by` metres to one side and the ends stay put, along a smooth arc.
   * A closed wall (a room) bows on the side facing the way asked; an open one along its length.
   */
  private bulgeWall(f: Feature, by: number, dir: 'left' | 'right' | 'out' | 'in', right: { x: number; z: number }) {
    if (f.geometry.type !== 'LineString') return;
    const coords = f.geometry.coordinates;
    const pts = coords.map(([lng, lat]) => this.o.frame.toWorld(lng, lat));
    const closed = pts.length > 3 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].z - pts[pts.length - 1].z) < 1e-3;
    // the building's middle, for out and in
    let cx = 0, cz = 0;
    const st = f.properties.structure ? this.buildParts(String(f.properties.structure)) : [f];
    let n = 0;
    for (const g of st) {
      const cs = g.geometry.type === 'LineString' ? g.geometry.coordinates : g.geometry.type === 'Polygon' ? g.geometry.coordinates[0] : [];
      for (const c of cs) { const w = this.o.frame.toWorld(c[0], c[1]); cx += w.x; cz += w.z; n++; }
    }
    if (n) { cx /= n; cz /= n; }
    if (closed) {
      // push the side of the ring that faces the chosen way out along it, fading to nothing at the sides
      const ring = pts.slice(0, -1);
      let mx = 0, mz = 0; for (const q of ring) { mx += q.x / ring.length; mz += q.z / ring.length; }
      const d = dir === 'right' ? right : dir === 'left' ? { x: -right.x, z: -right.z } : { x: 0, z: 0 };
      const moved = ring.map(q => {
        const rx = q.x - mx, rz = q.z - mz, rl = Math.hypot(rx, rz) || 1;
        if (dir === 'out' || dir === 'in') { const k = (dir === 'out' ? 1 : -1) * by / rl; return { x: q.x + rx * k, z: q.z + rz * k }; }
        const facing = Math.max(0, (rx * d.x + rz * d.z) / rl);
        const k = by * facing * facing;
        return { x: q.x + d.x * k, z: q.z + d.z * k };
      });
      moved.push({ ...moved[0] });
      f.geometry.coordinates = moved.map(q => { const ll = this.o.frame.toLngLat(q.x, q.z); return [ll.lng, ll.lat]; });
      f.properties.smooth = true;
      return;
    }
    // an open wall: resample to nine points so a straight wall has somewhere to bend, then bow it
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    const L = cum[cum.length - 1];
    if (L < 0.5) return;
    const at = (s: number) => { let i = 0; while (i < cum.length - 2 && cum[i + 1] < s) i++; const t = (s - cum[i]) / ((cum[i + 1] - cum[i]) || 1); return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * t, z: pts[i].z + (pts[i + 1].z - pts[i].z) * t }; };
    const K = pts.length >= 9 ? pts.length - 1 : 8;
    const a = pts[0], b = pts[pts.length - 1];
    let nx = -(b.z - a.z), nz = b.x - a.x;
    const nl = Math.hypot(nx, nz) || 1; nx /= nl; nz /= nl;
    const mid = at(L / 2);
    const want = dir === 'right' ? right : dir === 'left' ? { x: -right.x, z: -right.z } : { x: (mid.x - cx) * (dir === 'out' ? 1 : -1), z: (mid.z - cz) * (dir === 'out' ? 1 : -1) };
    if (nx * want.x + nz * want.z < 0) { nx = -nx; nz = -nz; }
    const out: [number, number][] = [];
    for (let k = 0; k <= K; k++) {
      const s = (k / K) * L, q = at(s), off = by * Math.sin((Math.PI * s) / L);
      const ll = this.o.frame.toLngLat(q.x + nx * off, q.z + nz * off);
      out.push([ll.lng, ll.lat]);
    }
    f.geometry.coordinates = out;
    f.properties.smooth = true;
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

  // ---- brought in: models, scans, photos ------------------------------------------------------------------
  /**
   * A file to bring in. With a place it goes straight there; without one the tool waits for a ground
   * click. A photo becomes a model first (through the atlas), and stands where the click was.
   */
  bring(file: Blob, name: string, at?: [number, number]): boolean {
    const sort = sortOf(name);
    if (!sort) { this.said(false, `${name}: not a model (.glb), a scan (.spz .ply .splat .ksplat .sog .rad) or a photo (.jpg .png .webp)`); return false; }
    this.bringing = { file, name, sort };
    if (this.tool !== 'bring') { this.tool = 'bring'; this.drawing = []; this.moving = null; }
    if (at) { void this.bringAt(at); return true; }
    this.o.onChange(this);
    return true;
  }

  /** put down what is waiting, here */
  async bringAt(at: [number, number]): Promise<ImportItem | null> {
    const b = this.bringing;
    if (!b) return null;
    this.bringing = null;
    this.o.onChange(this);
    if (b.sort === 'photo') { void this.photoAt(b.file, b.name, at); return null; }
    try {
      const item = await this.o.imports.add(b.file, b.name, at);
      this.said(true, `${item.name} brought in · ${megabytes(item.bytes)} · kept in this browser`);
      this.selectImport(item.id);
      return item;
    } catch (e) {
      this.said(false, String((e as Error)?.message || e));
      return null;
    }
  }

  /** a photo made into a model where it will stand; the ring turns there while it is being made */
  private async photoAt(file: Blob, name: string, at: [number, number]) {
    const svc = this.o.photo3d;
    const base = name.replace(/\.[a-z0-9]+$/i, '');
    const job: PhotoJob = { id: `job-${Date.now().toString(36)}`, name: base, at, stage: 'shrinking', progress: 0 };
    this.jobs.push(job);
    const step = (stage: PhotoJob['stage'], progress: number, message?: string) => { job.stage = stage; job.progress = progress; if (message !== undefined) job.message = message; this.o.onChange(this); };
    this.o.imports.showPending(job.id, at);
    try {
      if (!svc) throw new Error('photo → model is not wired in this world');
      const jpeg = await photoToJpeg(file);
      step('sending', 0);
      const { provider, task } = await svc.start(jpeg, this.photo.kind, base);
      step('making', 0, `${provider} is making it — a minute or three`);
      let st = await svc.status(provider, task);
      const t0 = Date.now();
      while (st.status === 'pending' || st.status === 'running') {
        if (Date.now() - t0 > 15 * 60_000) throw new Error('the service took more than fifteen minutes — try again later');
        await new Promise(r => setTimeout(r, 5000));
        st = await svc.status(provider, task);
        job.thumb = st.thumb ?? job.thumb;
        step('making', st.progress);
      }
      if (st.status === 'failed' || !st.bytes) throw new Error(st.error || 'the service could not make a model from this photo');
      step('fetching', 0, megabytes(st.bytes));
      const blob = await svc.download(provider, task, st.bytes, share => step('fetching', Math.round(share * 100)));
      step('placing', 100);
      const item = await this.o.imports.add(blob, `${base}.glb`, at, { source: provider, note: `made from a photo (${this.photo.kind})` });
      // a height asked for is a height given; otherwise the service's own guess at real size stands
      if (this.photo.height > 0 && item.native && item.native[2] > 0.01) this.o.imports.update(item.id, { scale: Math.round(this.photo.height / item.native[2] * 1000) / 1000 });
      step('done', 100, `${item.name} is standing where you clicked`);
      this.selectImport(item.id);
    } catch (e) {
      step('failed', 0, String((e as Error)?.message || e));
    } finally {
      this.o.imports.hidePending(job.id);
      this.o.onChange(this);
    }
  }

  /** everything brought in to this pack */
  importItems(): ImportItem[] { return this.o.imports.items; }

  selectImport(id: string) {
    const item = this.o.imports.item(id);
    const obj = this.o.imports.bounds(id);
    if (!item || !obj) return;
    const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    this.select({ kind: 'import', id, item, object: obj, point: c });
  }

  turnImport(id: string, deg: number) {
    const item = this.o.imports.item(id);
    if (!item) return;
    this.o.imports.update(id, { turn: ((Math.round((item.turn + deg) * 10) / 10 + 540) % 360) - 180 });
    this.selectImport(id);
  }

  liftImport(id: string, dm: number) {
    const item = this.o.imports.item(id);
    if (!item) return;
    this.o.imports.update(id, { lift: Math.round((item.lift + dm) * 100) / 100 });
    this.selectImport(id);
  }

  /** set how it stands from the panel: any of turn, lift, scale, flip, name */
  setImport(id: string, patch: { lift?: number; turn?: number; scale?: number; flip?: boolean; tidy?: boolean; name?: string }) {
    this.o.imports.update(id, patch);
    this.selectImport(id);
  }

  /** its height as drawn, in metres */
  importHeight(item: ImportItem): number { return (item.native?.[2] ?? 0) * item.scale; }

  describeImport(item: ImportItem): string {
    const h = this.importHeight(item);
    const w = (item.native?.[0] ?? 0) * item.scale, d = (item.native?.[1] ?? 0) * item.scale;
    return `${item.name} · ${item.kind === 'splat' ? 'scan' : 'model'} · ${w.toFixed(1)} × ${d.toFixed(1)} m, ${h.toFixed(1)} m high`;
  }

  /** hand the file back (a download), so what is only in this browser can be kept elsewhere too */
  async downloadImport(id: string) {
    const item = this.o.imports.item(id);
    const blob = await this.o.imports.file(id);
    if (!item || !blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${item.name}.${item.ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  private said(ok: boolean, message: string) {
    this.lastSave = { ok, message, at: Date.now() };
    this.o.onChange(this);
    return { ok, message };
  }
}

