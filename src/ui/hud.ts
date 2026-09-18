// The thin layer of glass over the world.
//
//   A world should mostly be the world, so this stays out of the way: where you are, where the sun
//   is, and the two or three things you can change. The time-of-day slider is here rather than in a
//   menu because it is the control people actually reach for — the light is half of what a place
//   feels like, and it is the thing a siting decision turns on.

import type { PlayerState } from '../player/player';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const pad = (n: number) => String(Math.floor(n)).padStart(2, '0');

export interface HudOpts {
  community: string;
  /** where the time-of-day slider starts, in hours */
  hours: number;
  onTime: (hours: number) => void;
  onView: () => void;
  onRecentre: () => void;
}

export class Hud {
  root: HTMLElement;
  private readout: HTMLElement;
  private sunLine: HTMLElement;
  private clock: HTMLElement;
  private loading: HTMLElement;
  private avatarLine: HTMLElement;
  private packLine: HTMLElement;
  private frames = 0;
  private fps = 0;
  private last = performance.now();

  constructor(container: HTMLElement, o: HudOpts) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <header class="hud-top">
        <div class="brand"><span class="mark">◈</span><b>${esc(o.community)}</b><span class="sub">walkable world · v0.3.1</span></div>
        <div class="acts">
          <button class="btn" data-act="view" title="first / third person (C)">👤 view</button>
          <button class="btn" data-act="recentre" title="back to the start">⌖ recentre</button>
        </div>
      </header>
      <div class="time">
        <label>
          <span class="t-label">time of day <b data-el="clock">12:00</b></span>
          <input type="range" min="0" max="1439" step="5" value="${Math.round(o.hours * 60)}" data-el="time" aria-label="time of day">
        </label>
        <div class="sun" data-el="sun">sun —</div>
        <div class="pack" data-el="pack" hidden></div>
        <div class="who" data-el="avatar" hidden></div>
      </div>
      <div class="readout" data-el="readout"></div>
      <div class="keys">W A S D move · <b>Shift</b> run · <b>Space</b> jump · <b>C</b> first person · drag or click to look · wheel to zoom out</div>
      <div class="loading" data-el="loading"><div class="spin"></div><span data-el="loadmsg">reading the ground…</span></div>`;
    container.appendChild(this.root);

    this.readout = this.q('[data-el="readout"]');
    this.sunLine = this.q('[data-el="sun"]');
    this.clock = this.q('[data-el="clock"]');
    this.loading = this.q('[data-el="loading"]');
    this.avatarLine = this.q('[data-el="avatar"]');
    this.packLine = this.q('[data-el="pack"]');

    this.q('[data-act="view"]').addEventListener('click', () => o.onView());
    this.q('[data-act="recentre"]').addEventListener('click', () => o.onRecentre());
    const time = this.q('[data-el="time"]') as HTMLInputElement;
    this.clock.textContent = `${pad(o.hours)}:${pad((o.hours % 1) * 60)}`;
    time.addEventListener('input', () => {
      const m = Number(time.value);
      this.clock.textContent = `${pad(m / 60)}:${pad(m % 60)}`;
      o.onTime(m / 60);
    });
  }

  private q(sel: string): HTMLElement { return this.root.querySelector(sel) as HTMLElement; }

  setLoading(msg: string | null) {
    this.loading.hidden = msg == null;
    if (msg != null) (this.q('[data-el="loadmsg"]')).textContent = msg;
  }

  /** say what the pack brought — the survey's date, the trees, the aerial — or nothing */
  setPack(text: string | null) {
    this.packLine.hidden = !text;
    this.packLine.textContent = text ?? '';
  }

  /** say which body is walking, once a real character has loaded */
  setAvatar(kind: 'capsule' | 'vrm' | 'gltf') {
    this.avatarLine.hidden = kind === 'capsule';
    this.avatarLine.textContent = kind === 'vrm' ? 'VRM avatar' : kind === 'gltf' ? 'glTF avatar' : '';
  }

  setSun(altitude: number, azimuth: number) {
    const dir = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(azimuth / 45) % 8];
    this.sunLine.textContent = altitude < -0.5
      ? `sun below the horizon · ${dir}`
      : `sun ${altitude.toFixed(0)}° up · ${dir} ${azimuth.toFixed(0)}°`;
  }

  frame(s: PlayerState, tiles: number) {
    this.frames++;
    const now = performance.now();
    if (now - this.last >= 500) {
      this.fps = Math.round((this.frames * 1000) / (now - this.last));
      this.frames = 0; this.last = now;
    }
    const ft = Math.round(s.groundM * 3.28084);
    this.readout.innerHTML =
      `<span><b>${s.groundM.toFixed(1)} m</b> <i>${ft} ft</i></span>` +
      `<span>${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</span>` +
      `<span>heading <b>${s.headingDeg.toFixed(0)}°</b> · ${s.speed.toFixed(1)} m/s</span>` +
      `<span>${tiles} tiles · ${this.fps} fps</span>`;
  }
}
