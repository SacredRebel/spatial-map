// The body you move through the world with.
//
//   A character controller, not a flying camera: it has a position on the ground, a heading, a
//   weight, and a camera that follows it. Third person by default, because the point of a world is
//   to be somebody in it; first person on a key, because that is how you judge a doorway.
//
//   Collision against the hillside is a height query rather than a physics engine — the ground is
//   a function, so standing on it is one lookup per frame instead of a broadphase. Buildings get
//   real collision when they arrive; until then the ground is the world.

import * as THREE from 'three';
import type { Frame } from '../world/geo';
import type { HeightField } from '../world/heightfield';

const WALK = 1.6, RUN = 5.2, GRAVITY = -18, JUMP = 5.4;
const EYE = 1.68, BODY = 1.8;
const LOOK = 0.0022, TOUCH_LOOK = 0.006;
const PITCH_MIN = -1.15, PITCH_MAX = 0.9;
const SUBSTEP = 1 / 20;            // the physics runs at 20 Hz however fast the page draws

export type View = 'third' | 'first';

export interface PlayerState {
  lng: number; lat: number; groundM: number; headingDeg: number;
  speed: number; view: View; grounded: boolean;
}

/** a stand-in body: a capsule and a head, sized like a person, until a VRM avatar replaces it */
function placeholderAvatar(): THREE.Group {
  const g = new THREE.Group();
  const skin = new THREE.MeshLambertMaterial({ color: '#d9b08c' });
  const cloth = new THREE.MeshLambertMaterial({ color: '#3d6b52' });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.9, 6, 12), cloth);
  body.position.y = 0.86;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 16, 12), skin);
  head.position.y = 1.58;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.12, 8), skin);
  nose.position.set(0, 1.56, -0.16);
  nose.rotation.x = -Math.PI / 2;
  for (const m of [body, head, nose]) { m.castShadow = true; g.add(m); }
  g.name = 'avatar';
  return g;
}

export class Player {
  readonly object = new THREE.Group();
  readonly avatar = placeholderAvatar();
  view: View = 'third';
  camDist = 6.4;
  private pos = new THREE.Vector3();
  private vel = new THREE.Vector3();
  private yaw = 0;
  private pitch = -0.26;
  private keys = new Set<string>();
  private grounded = true;
  private ground = 0;
  private locked = false;
  private dragging = false;
  private lastTouch: { x: number; y: number } | null = null;
  onChange: (s: PlayerState) => void = () => {};

  constructor(
    private frame: Frame,
    private field: HeightField,
    private camera: THREE.PerspectiveCamera,
    private dom: HTMLElement
  ) {
    this.object.add(this.avatar);
    this.wire();
  }

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

  state(): PlayerState {
    const ll = this.frame.toLngLat(this.pos.x, this.pos.z);
    return {
      lng: ll.lng, lat: ll.lat, groundM: this.ground, headingDeg: this.headingDeg,
      speed: Math.hypot(this.vel.x, this.vel.z), view: this.view, grounded: this.grounded
    };
  }

  setView(v: View) { this.view = v; this.avatar.visible = v === 'third'; this.sync(); }
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
    // touch: one finger looks around
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
  }

  private step(d: number) {
    let fwd = 0, side = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) fwd += 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) fwd -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) side += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) side -= 1;
    if (this.keys.has('q')) this.yaw += 1.6 * d;
    if (this.keys.has('e')) this.yaw -= 1.6 * d;

    const speed = this.keys.has('shift') ? RUN : WALK;
    if (fwd || side) {
      const len = Math.hypot(fwd, side);
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      // a body with rotation.y = yaw faces (-sin, 0, -cos) and its right hand is (cos, 0, -sin),
      // so at yaw 0 forward is -z, which is north in this frame
      const dx = (fwd * -sin + side * cos) / len * speed;
      const dz = (fwd * -cos + side * -sin) / len * speed;
      this.pos.x += dx * d;
      this.pos.z += dz * d;
      this.vel.x = dx; this.vel.z = dz;
    } else { this.vel.x = this.vel.z = 0; }

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
