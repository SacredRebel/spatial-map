// A metre grid laid on the hillside.
//
//   The raster under a placement: lines every metre, a heavier one every ten, each line sampled
//   along the height function so it lies on the ground rather than cutting through a slope. It
//   is what lets a footprint be read at real size — twelve squares is twelve metres, whatever
//   the camera is doing — and it moves with whoever is looking.

import * as THREE from 'three';
import type { Frame } from '../world/geo';
import type { HeightField } from '../world/heightfield';

const SPAN = 60;        // metres across
const STEP = 1;         // metres between lines
const LIFT = 0.06;      // above the ground, so it never z-fights the hill

export class GroundGrid {
  readonly group = new THREE.Group();
  private minor: THREE.LineSegments;
  private major: THREE.LineSegments;
  private centre = new THREE.Vector2(NaN, NaN);
  private _visible = false;

  constructor(private frame: Frame, private field: HeightField) {
    this.group.name = 'grid';
    this.minor = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.22, depthWrite: false }));
    this.major = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: '#4fd1c5', transparent: true, opacity: 0.6, depthWrite: false }));
    this.minor.renderOrder = 5; this.major.renderOrder = 6;
    this.group.add(this.minor, this.major);
    this.group.visible = false;
  }

  get visible() { return this._visible; }
  set visible(v: boolean) { this._visible = v; this.group.visible = v; if (v) this.centre.set(NaN, NaN); }

  /** keep the grid under a point; rebuilt when that point has moved a third of the way to the edge */
  update(x: number, z: number) {
    if (!this._visible) return;
    const cx = Math.round(x / 10) * 10, cz = Math.round(z / 10) * 10;
    if (Math.abs(cx - this.centre.x) < SPAN / 3 && Math.abs(cz - this.centre.y) < SPAN / 3) return;
    this.centre.set(cx, cz);
    this.rebuild(cx, cz);
  }

  private rebuild(cx: number, cz: number) {
    const minor: number[] = [], major: number[] = [];
    const half = SPAN / 2;
    const h = (x: number, z: number) => { const ll = this.frame.toLngLat(x, z); return this.field.atOr(ll.lng, ll.lat, NaN); };
    const line = (ax: number, az: number, bx: number, bz: number, into: number[]) => {
      const ya = h(ax, az), yb = h(bx, bz);
      if (!isFinite(ya) || !isFinite(yb)) return;
      into.push(ax, ya + LIFT, az, bx, yb + LIFT, bz);
    };
    for (let i = -half; i <= half; i += STEP) {
      const heavy = ((cx + i) % 10 === 0);
      const heavyZ = ((cz + i) % 10 === 0);
      for (let j = -half; j < half; j += STEP) {
        line(cx + i, cz + j, cx + i, cz + j + STEP, heavy ? major : minor);      // north-south line at x = cx+i
        line(cx + j, cz + i, cx + j + STEP, cz + i, heavyZ ? major : minor);     // east-west line at z = cz+i
      }
    }
    this.minor.geometry.dispose();
    this.minor.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(minor, 3));
    this.major.geometry.dispose();
    this.major.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(major, 3));
  }
}
