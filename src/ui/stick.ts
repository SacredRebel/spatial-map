// Thumbs.
//
//   A world you can only walk with a keyboard is a world half the people who will see it cannot
//   walk at all. The stick is analog — where your thumb sits is how fast you go — and it feeds the
//   same movement axis the keys do, so there is no second movement code path to keep in step.
//
//   It appears on touch devices, or on demand with ?stick=1 so it can be looked at on a desktop.

export interface StickOpts {
  onAxis: (fwd: number, side: number, run: boolean) => void;
  onJump: () => void;
  onView: () => void;
}

const RADIUS = 52;          // px from the centre of the pad to full deflection
const RUN_AT = 0.86;        // push past this and you run

export function touchCapable(): boolean {
  return typeof window !== 'undefined' &&
    ('ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0);
}

export class Stick {
  readonly root: HTMLElement;
  private knob: HTMLElement;
  private pad: HTMLElement;
  private id: number | null = null;
  private origin = { x: 0, y: 0 };
  /** the last axis sent — the tests read this rather than faking touch events */
  axis = { fwd: 0, side: 0, run: false };

  constructor(container: HTMLElement, private o: StickOpts) {
    this.root = document.createElement('div');
    this.root.className = 'stick-layer';
    this.root.innerHTML = `
      <div class="stick-pad" data-el="pad" aria-label="move">
        <div class="stick-knob" data-el="knob"></div>
      </div>
      <div class="stick-btns">
        <button class="stick-btn" data-act="view" aria-label="first or third person">👤</button>
        <button class="stick-btn stick-jump" data-act="jump" aria-label="jump">⤒</button>
      </div>`;
    container.appendChild(this.root);
    this.pad = this.root.querySelector('[data-el="pad"]') as HTMLElement;
    this.knob = this.root.querySelector('[data-el="knob"]') as HTMLElement;

    this.pad.addEventListener('touchstart', e => this.start(e), { passive: false });
    this.pad.addEventListener('touchmove', e => this.move(e), { passive: false });
    this.pad.addEventListener('touchend', e => this.end(e), { passive: false });
    this.pad.addEventListener('touchcancel', e => this.end(e), { passive: false });
    // the same pad works with a mouse, so the layout can be checked without a phone
    this.pad.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch') return;
      this.origin = this.centre();
      this.pad.setPointerCapture(e.pointerId);
      this.to(e.clientX, e.clientY);
    });
    this.pad.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch' || !this.pad.hasPointerCapture(e.pointerId)) return;
      this.to(e.clientX, e.clientY);
    });
    this.pad.addEventListener('pointerup', e => {
      if (e.pointerType === 'touch') return;
      this.pad.releasePointerCapture(e.pointerId);
      this.release();
    });

    (this.root.querySelector('[data-act="jump"]') as HTMLElement)
      .addEventListener('click', e => { e.preventDefault(); o.onJump(); });
    (this.root.querySelector('[data-act="view"]') as HTMLElement)
      .addEventListener('click', e => { e.preventDefault(); o.onView(); });
  }

  private centre() {
    const r = this.pad.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  private start(e: TouchEvent) {
    e.preventDefault();
    const t = e.changedTouches[0];
    this.id = t.identifier;
    this.origin = this.centre();
    this.to(t.clientX, t.clientY);
  }

  private move(e: TouchEvent) {
    if (this.id == null) return;
    e.preventDefault();
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.id) this.to(t.clientX, t.clientY);
    }
  }

  private end(e: TouchEvent) {
    if (this.id == null) return;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.id) { this.id = null; this.release(); }
    }
  }

  /** move the knob to a screen point and publish the axis it implies */
  private to(clientX: number, clientY: number) {
    let dx = clientX - this.origin.x;
    let dy = clientY - this.origin.y;
    const len = Math.hypot(dx, dy);
    if (len > RADIUS) { dx = (dx / len) * RADIUS; dy = (dy / len) * RADIUS; }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const side = dx / RADIUS;
    const fwd = -dy / RADIUS;                       // up the screen is forward
    const run = Math.hypot(side, fwd) > RUN_AT;
    this.set(fwd, side, run);
  }

  private release() {
    this.knob.style.transform = 'translate(0px, 0px)';
    this.set(0, 0, false);
  }

  /** set the axis directly — used by the release path and by the tests */
  set(fwd: number, side: number, run: boolean) {
    this.axis = { fwd, side, run };
    this.o.onAxis(fwd, side, run);
  }

  show(on: boolean) { this.root.hidden = !on; }
}
