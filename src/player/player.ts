// The body you move through the world with.
//
//   A character controller, not a flying camera: it has a position on the ground, a heading, a
//   weight, and a camera that follows it. Third person by default, because the point of a world is
//   to be somebody in it; first person on a key, because that is how you judge a doorway.
//
//   Collision against the hillside is a height query rather than a physics engine — the ground is
//   a function, so standing on it is one lookup per frame instead of a broadphase. Buildings are
//   prisms over their footprint and are resolved in the same step (see world/collide).
//
//   Movement arrives as an AXIS, not as keys. Keys set the axis, a thumbstick sets the axis, and a
//   test sets the axis, so all three go through exactly the same arithmetic and a phone walks at
//   the same speed as a keyboard.

import * as THREE from 'three';
import type { Frame } from '../world/geo';
import type { HeightField } from '../world/heightfield';
import type { Solid } from '../world/collide';
import { resolve } from '../world/collide';
import type { AvatarRig } from './avatar';
import { CapsuleRig } from './avatar';

const WALK = 1.6, RUN = 5.2, GRAVITY = -18, JUMP = 5.4;
const EYE = 1.68, BODY = 1.8, SHOULDER = 0.34;
const LOOK = 0.0022, TOUCH_LOOK = 0.006;
const PITCH_MIN = -1.15, PITCH_MAX = 0.9;
const SUBSTEP = 1 / 20;            // the physics runs at 20 Hz however fast the page draws

export type View = 'third' | 'first';

export interface PlayerState {
  lng: number; lat: number; groundM: number; headingDeg: number;
  speed: number; view: View; grounded: boolean;
  /** the id of the building being leaned on, if any */
  touching: string | null;
}

export class Player {
  readonly object = new THREE.Group();
  rig: AvatarRig = new CapsuleRig();
  view: View = 'third';
  camDist = 6.4;
  /** buildings that stop you; set by main once the registry has loaded */
  solids: Solid[] = [];
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.26;
  private keys = new Set<string>();
  private axis = { fwd: 0, side: 0, run: false };
  private grounded = true;
  private ground = 0;
  private locked = false;
  private dragging = false;
  private lastTouch: { x: number; y: number } | null = null;
  private travelled = 0;
  private lastTravelled = 0;
  private touching: string | null = null;
  onChange: (s: PlayerState) => void = () => {};

  constructor(
    private frame: Frame,
    private field: HeightField,
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement
  ) {
    this.object.add(this.rig.object);
    this.wire();
  }

  /** swap the built-in body for a loaded character without losing where you are standing */
  setRig(rig: AvatarRig) {
    this.object.remove(this.rig.object);
    this.rig.dispose();
    this.rig = rig;
    rig.object.visible = this.view === 'third';
    this.object.add(rig.object);
  }

  /** the body other people see — kept as `avatar` because that is what it is */
  get avatar(): THREE.Object3D { return this.rig.object; }

  /** drop the player onto the ground at a longitude and latitude */
  placeAt(lng: number, lat: number, headingDeg = 0) {
    const w = this.frame.toWorld(lng, lat);
    this.ground = this.field.atOr(lng, lat, 0);
    this.pos.set(w.x, this.ground, w.z);
    this.yaw = -headingDeg * Math.PI / 180;
    this.vel.set(0, 0, 0);
    this.sync();
  }

  get position(): THREE.Vector3 { return this.pos; }
  get headingDeg(): number { return ((-this.yaw * 180 / Math.PI) % 360 + 360) % 360; }
  /** total ground covered, in metres — the gait is paced by this, not by the clock */
  get distance(): number { return this.travelled; }

  state(): PlayerState {
    const ll = this.frame.toLngLat(this.pos.x, this.pos.z);
    return {
      lng: ll.lng, lat: ll.lat, groundM: this.ground, headingDeg: this.headingDeg,
      speed: Math.hypot(this.vel.x, this.vel.z), view: this.view, grounded: this.grounded,
      touching: this.touching
    };
  }

  setView(v: View) { this.view = v; this.rig.object.visible = v === 'third'; this.sync(); }
  toggleView() { this.setView(this.view === 'third' ? 'first' : 'third'); }

  // ---- input ---------------------------------------------------------------------------------
  private wire() {
    const down = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
      const k = e.key.toLowerCase();
      if (k === 'c') { this.toggleView(); return; }
      if (!MOVE.has(k)) return;
      e.preventDefault();
      this.keys.add(k);
    };
    const up = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', () => this.keys.clear());

    this.dom.addEventListener('click', () => { if (!this.locked) void this.dom.requestPointerLock?.(); });
    document.addEventListener('pointerlockchange', () => { this.locked = document.pointerLockElement === this.dom; });
    this.dom.addEventListener('mousedown', () => { this.dragging = true; });
    window.addEventListener('mouseup', () => { this.dragging = false; });
    window.addEventListener('mousemove', e => {
      if (!this.locked && !this.dragging) return;
      this.look(e.movementX * LOOK, e.movementY * LOOK);
    });
    // touch: one finger anywhere but the thumbstick looks around
    this.dom.addEventListener('touchstart', e => {
      const t = e.touches[0]; if (t) this.lastTouch = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    this.dom.addEventListener('touchmove', e => {
      const t = e.touches[0]; if (!t || !this.lastTouch) return;
      this.look((t.clientX - this.lastTouch.x) * TOUCH_LOOK, (t.clientY - this.lastTouch.y) * TOUCH_LOOK);
      this.lastTouch = { x: t.clientX, y: t.clientY };
    }, { passive: true });
    this.dom.addEventListener('touchend', () => { this.lastTouch = null; }, { passive: true });
    this.dom.addEventListener('wheel', e => {
      if (this.view !== 'third') return;
      e.preventDefault();
      this.camDist = THREE.MathUtils.clamp(this.camDist + Math.sign(e.deltaY) * 0.6, 1.6, 14);
    }, { passive: false });
  }

  private look(dx: number, dy: number) {
    this.yaw -= dx;
    this.pitch = THREE.MathUtils.clamp(this.pitch - dy, PITCH_MIN, PITCH_MAX);
  }

  /** press or release a movement key without an event — for on-screen controls and for tests */
  key(k: string, down: boolean) {
    const s = k.toLowerCase();
    if (!MOVE.has(s)) return;
    if (down) this.keys.add(s); else this.keys.delete(s);
  }

  /**
   * Set the movement axis directly: forward in [-1,1], right in [-1,1].
   *
   *   This is what the thumbstick drives. It is analog — half a stick is half a walk — and it is
   *   the same path the keys take, so there is one movement implementation rather than two.
   */
  setAxis(fwd: number, side: number, run = false) {
    this.axis.fwd = THREE.MathUtils.clamp(fwd, -1, 1);
    this.axis.side = THREE.MathUtils.clamp(side, -1, 1);
    this.axis.run = run;
  }

  /** jump from a button rather than the space bar */
  jump() { if (this.grounded) { this.vel.y = JUMP; this.grounded = false; } }

  // ---- the step ------------------------------------------------------------------------------
  /**
   * Advance the body by dt seconds.
   *
   *   Integrated in small fixed substeps rather than one big one. A browser tab that drops to two
   *   frames a second would otherwise move the walker in half-metre jumps — past a wall, through a
   *   crest, or simply at the wrong speed once anything clamps — and the whole point of a world is
   *   that it behaves the same on a laptop as on a workstation.
   */
  update(dt: number) {
    const total = Math.min(Math.max(dt, 0), 1);
    const steps = Math.max(1, Math.ceil(total / SUBSTEP));
    const d = total / steps;
    for (let i = 0; i < steps; i++) this.step(d);
    this.sync();
    const moved = this.travelled - this.lastTravelled;
    this.lastTravelled = this.travelled;
    this.rig.update({
      dt: total, distance: moved,
      speed: Math.hypot(this.vel.x, this.vel.z), grounded: this.grounded
    });
  }

  private step(d: number) {
    let fwd = this.axis.fwd, side = this.axis.side;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) side += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) side -= 1;
    if (this.keys.has('q')) this.yaw += 1.6 * d;
    if (this.keys.has('e')) this.yaw -= 1.6 * d;
    fwd = THREE.MathUtils.clamp(fwd, -1, 1);
    side = THREE.MathUtils.clamp(side, -1, 1);

    const speed = (this.keys.has('shift') || this.axis.run) ? RUN : WALK;
    const before = { x: this.pos.x, z: this.pos.z };
    if (fwd || side) {
      const len = Math.max(1, Math.hypot(fwd, side));   // analog: half a stick is half a walk
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // a body with rotation.y = yaw faces (-sin, 0, -cos) and its right hand is (cos, 0, -sin),
      // so at yaw 0 forward is -z, which is north in this frame
      const dx = (fwd * -sin + side * cos) / len * speed;
      const dz = (fwd * -cos + side * -sin) / len * speed;
      this.pos.x += dx * d;
      this.pos.z += dz * d;
      this.vel.x = dx; this.vel.z = dz;
    } else { this.vel.x = this.vel.z = 0; }

    const hit = this.solids.length ? resolve(this.pos, SHOULDER, this.solids) : null;
    this.touching = hit ? hit.id : null;
    this.travelled += Math.hypot(this.pos.x - before.x, this.pos.z - before.z);

    const ll = this.frame.toLngLat(this.pos.x, this.pos.z);
    this.ground = this.field.atOr(ll.lng, ll.lat, this.ground);

    if (this.keys.has(' ') && this.grounded) { this.vel.y = JUMP; this.grounded = false; }
    this.vel.y += GRAVITY * d;
    this.pos.y += this.vel.y * d;
    if (this.pos.y <= this.ground) { this.pos.y = this.ground; this.vel.y = 0; this.grounded = true; }
  }

  /** put the body and the camera where the state says they are */
  private sync() {
    this.object.position.copy(this.pos);
    this.object.rotation.y = this.yaw;
    const eye = this.pos.y + EYE;
    if (this.view === 'first') {
      this.camera.position.set(this.pos.x, eye, this.pos.z);
      const dir = new THREE.Vector3(-Math.sin(this.yaw), Math.tan(this.pitch), -Math.cos(this.yaw));
      this.camera.lookAt(this.camera.position.clone().add(dir));
    } else {
      const back = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.camDist * Math.cos(this.pitch));
      const lift = this.camDist * Math.sin(-this.pitch) + 1.55;
      const cam = new THREE.Vector3(this.pos.x + back.x, this.pos.y + lift, this.pos.z + back.z);
      const cll = this.frame.toLngLat(cam.x, cam.z);
      const floor = this.field.atOr(cll.lng, cll.lat, this.ground) + 0.6;
      cam.y = Math.max(cam.y, floor);
      this.camera.position.copy(cam);
      this.camera.lookAt(this.pos.x, this.pos.y + BODY * 0.72, this.pos.z);
    }
    this.onChange(this.state());
  }
}

const MOVE = new Set(['w', 'a', 's', 'd', 'q', 'e', 'shift', ' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
