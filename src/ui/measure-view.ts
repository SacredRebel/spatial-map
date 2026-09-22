// The tape measure you see: dimension labels pinned to points in the world, and the tapes.
//
//   The editor works out WHAT to say (world/geo.ts makes the metres true, edit/measure.ts reads them
//   out); this only puts the words where they belong on the screen, every frame, and draws the tapes
//   as lines in the world. Labels are plain HTML over the canvas: they stay sharp at any distance
//   and cost nothing to change while the cursor moves.

import * as THREE from 'three';

export type LabelKind = 'seg' | 'live' | 'area' | 'tape' | 'typed' | 'sel';
export interface Label { at: THREE.Vector3; text: string; kind: LabelKind }
export interface TapeLine { a: THREE.Vector3; b: THREE.Vector3 }

export class MeasureView {
  readonly layer: HTMLDivElement;
  readonly group = new THREE.Group();
  private sets = new Map<string, Label[]>();
  private pool: HTMLDivElement[] = [];
  private lines: THREE.LineSegments;
  private v = new THREE.Vector3();

  constructor(container: HTMLElement, scene: THREE.Scene) {
    this.layer = document.createElement('div');
    this.layer.className = 'measure-layer';
    container.appendChild(this.layer);
    this.lines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#ffd23f', depthTest: false, transparent: true, opacity: 0.95 }));
    this.lines.renderOrder = 14;
    this.lines.frustumCulled = false;
    this.group.name = 'measure';
    this.group.add(this.lines);
    scene.add(this.group);
  }

  /** replace one named set of labels ('draft', 'sel', 'tape'); an empty list clears it */
  set(key: string, labels: Label[]) {
    if (labels.length) this.sets.set(key, labels); else this.sets.delete(key);
  }

  /** the tapes as lines in the world, with a short tick across each end */
  setTapes(tapes: TapeLine[]) {
    const pts: THREE.Vector3[] = [];
    for (const t of tapes) {
      pts.push(t.a, t.b);
      const d = new THREE.Vector3().subVectors(t.b, t.a);
      const across = new THREE.Vector3(-d.z, 0, d.x).normalize().multiplyScalar(0.35);
      if (across.lengthSq() > 0) for (const p of [t.a, t.b]) pts.push(p.clone().add(across), p.clone().sub(across));
      // a plumb line when the ends are at different heights
      if (Math.abs(t.b.y - t.a.y) > 0.05) { const low = t.a.y < t.b.y ? t.a : t.b, high = low === t.a ? t.b : t.a; pts.push(new THREE.Vector3(high.x, low.y, high.z), high); pts.push(low, new THREE.Vector3(high.x, low.y, high.z)); }
    }
    this.lines.geometry.dispose();
    this.lines.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.lines.visible = pts.length > 0;
  }

  /** what is on screen now, for tests and for the plan */
  texts(key?: string): string[] {
    const out: string[] = [];
    for (const [k, list] of this.sets) if (!key || k === key) for (const l of list) out.push(l.text);
    return out;
  }

  /** every frame: pin each label over its point, hide the ones behind the eye */
  render(camera: THREE.Camera, w: number, h: number) {
    let n = 0;
    for (const list of this.sets.values()) {
      for (const l of list) {
        this.v.copy(l.at).project(camera);
        if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.2 || Math.abs(this.v.y) > 1.2) continue;
        const el = this.pool[n] ?? this.make();
        const x = (this.v.x + 1) / 2 * w, y = (1 - this.v.y) / 2 * h;
        if (el.textContent !== l.text) el.textContent = l.text;
        const cls = `ml ml-${l.kind}`;
        if (el.className !== cls) el.className = cls;
        el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
        el.style.display = '';
        n++;
      }
    }
    for (let i = n; i < this.pool.length; i++) this.pool[i].style.display = 'none';
  }

  private make(): HTMLDivElement {
    const el = document.createElement('div');
    this.layer.appendChild(el);
    this.pool.push(el);
    return el;
  }
}
