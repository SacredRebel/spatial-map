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
  /** fly / walk (G) */
  onFly: () => void;
  /** edit mode on / off (B) */
  onEdit: () => void;
  /** open the design studio overlay */
  onStudio: () => void;
  /** the role button: sign in with a PIN, or sign out */
  onRole: () => void;
  /** the character panel: pick a body by URL (null = the built-in capsule); resolves to what loaded */
  onAvatar: (url: string | null) => Promise<'capsule' | 'vrm' | 'gltf'>;
  /** look sensitivity, 0.4–2, and how far back the third-person camera sits */
  onLook: (scale: number) => void;
  onCamDist: (d: number) => void;
  /** where those two start (remembered from last time) */
  look: number;
  camDist: number;
  avatarUrl: string | null;
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
        <div class="brand"><span class="mark">◈</span><b>${esc(o.community)}</b><span class="sub">walkable world · v0.12.0</span></div>
        <div class="acts">
          <button class="btn" data-act="char" data-el="char" title="the character: body, camera, controls">🧍 character</button>
          <button class="btn" data-act="view" title="first / third person (C)">👤 view</button>
          <button class="btn" data-act="fly" data-el="fly" title="fly / walk (G)">🕊 fly</button>
          <button class="btn" data-act="edit" data-el="edit" title="edit the world (B)">✎ edit</button>
          <button class="btn" data-act="studio" data-el="studio" title="design the house in the studio" hidden>🏗 studio</button>
          <button class="btn" data-act="role" data-el="role" title="who you are here">◌ member</button>
          <button class="btn" data-act="recentre" title="back to the start">⌖ recentre</button>
        </div>
      </header>
      <aside class="char" data-el="charpanel" hidden>
        <div class="c-head"><b>The character</b><button class="btn c-close" data-act="charclose" title="close">✕</button></div>
        <div class="c-sec">
          <div class="c-title">the body</div>
          <div class="c-row"><span>walking as</span><b data-el="c-kind">built-in body</b></div>
          <label class="c-row c-url"><span>avatar file</span>
            <input type="url" data-el="c-avatar" placeholder="https://… .vrm or .glb" spellcheck="false">
          </label>
          <div class="c-btns">
            <button class="btn" data-act="charapply">use this body</button>
            <button class="btn" data-act="charreset">built-in body</button>
          </div>
          <div class="c-note" data-el="c-note" hidden></div>
        </div>
        <div class="c-sec">
          <div class="c-title">the camera</div>
          <button class="btn c-wide" data-act="charview">👤 first / third person <b>C</b></button>
          <label class="c-slider"><span>camera distance <b data-el="c-distv"></b></span>
            <input type="range" min="1.6" max="14" step="0.2" data-el="c-dist"></label>
          <label class="c-slider"><span>look sensitivity <b data-el="c-lookv"></b></span>
            <input type="range" min="0.4" max="2" step="0.1" data-el="c-look"></label>
        </div>
        <div class="c-sec">
          <div class="c-title">the controls</div>
          <div class="c-keys">
            <div><i>on foot</i> <b>W A S D</b> move · <b>Shift</b> run · <b>Space</b> jump · <b>Q E</b> turn · <b>C</b> view · drag or click to look · wheel zooms</div>
            <div><i>flying (G)</i> <b>Space</b> up · <b>X</b> down · <b>Shift</b> fast · wheel sets speed · <b>G</b> lands</div>
            <div><i>editing (B)</i> click to place · <b>1–9, 0</b> tools · <b>L F R O</b> wall floor roof opening · <b>Ctrl Z</b> undo</div>
            <div><i>touch</i> left thumbstick walks · a finger looks · buttons jump and fly</div>
          </div>
        </div>
        <div class="c-sec">
          <div class="c-title">the manners</div>
          <div class="c-keys"><div>walks 1.6 m/s, runs 5.2 · leans into the stride · steps to 0.55 m in stride · a bank past ~50° wants its stairs · downhill the feet keep the ground · the jump forgives the edge (0.12 s) and keeps a press before landing (0.14 s)</div></div>
        </div>
      </aside>
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
      <div class="keys" data-el="keys">W A S D move · <b>Shift</b> run · <b>Space</b> jump · <b>C</b> first person · <b>G</b> fly · <b>B</b> edit · drag or click to look · wheel to zoom out</div>
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
    this.q('[data-act="fly"]').addEventListener('click', () => o.onFly());
    this.q('[data-act="edit"]').addEventListener('click', () => o.onEdit());
    this.q('[data-act="studio"]').addEventListener('click', () => o.onStudio());
    this.q('[data-act="role"]').addEventListener('click', () => o.onRole());

    // the character panel — the body, the camera and every control, where the character lives
    const panel = this.q('[data-el="charpanel"]');
    const note = this.q('[data-el="c-note"]');
    const avatarIn = this.q('[data-el="c-avatar"]') as HTMLInputElement;
    avatarIn.value = o.avatarUrl ?? '';
    this.q('[data-act="char"]').addEventListener('click', () => { panel.hidden = !panel.hidden; });
    this.q('[data-act="charclose"]').addEventListener('click', () => { panel.hidden = true; });
    this.q('[data-act="charview"]').addEventListener('click', () => o.onView());
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) panel.hidden = true; });
    const say = (t: string | null) => { note.hidden = !t; note.textContent = t ?? ''; };
    const apply = async (url: string | null) => {
      say(url ? 'loading the body…' : null);
      const kind = await o.onAvatar(url);
      if (url && kind === 'capsule') say('that file would not load — the built-in body walks instead');
      else say(null);
    };
    this.q('[data-act="charapply"]').addEventListener('click', () => { const v = avatarIn.value.trim(); void apply(v || null); });
    this.q('[data-act="charreset"]').addEventListener('click', () => { avatarIn.value = ''; void apply(null); });
    const dist = this.q('[data-el="c-dist"]') as HTMLInputElement;
    const distV = this.q('[data-el="c-distv"]');
    dist.value = String(o.camDist);
    distV.textContent = `${o.camDist.toFixed(1)} m`;
    dist.addEventListener('input', () => { distV.textContent = `${Number(dist.value).toFixed(1)} m`; o.onCamDist(Number(dist.value)); });
    const look = this.q('[data-el="c-look"]') as HTMLInputElement;
    const lookV = this.q('[data-el="c-lookv"]');
    look.value = String(o.look);
    lookV.textContent = `${o.look.toFixed(1)}×`;
    look.addEventListener('input', () => { lookV.textContent = `${Number(look.value).toFixed(1)}×`; o.onLook(Number(look.value)); });
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

  /** a line that stays: something the world had to do without, and what that means */
  setNotice(text: string | null) {
    let el = this.root.querySelector<HTMLElement>('[data-el="notice"]');
    if (!el) { el = document.createElement('div'); el.className = 'notice'; el.dataset.el = 'notice'; this.root.appendChild(el); }
    el.hidden = !text;
    el.textContent = text ?? '';
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
    this.q('[data-el="c-kind"]').textContent = kind === 'vrm' ? 'a VRM avatar' : kind === 'gltf' ? 'a glTF avatar' : 'the built-in body';
  }

  /** say who is here: a member, a builder, an admin */
  setRole(role: 'member' | 'builder' | 'admin', canEdit: boolean) {
    const b = this.q('[data-el="role"]');
    b.textContent = role === 'admin' ? '◆ admin' : role === 'builder' ? '◇ builder' : '◌ member';
    b.classList.toggle('on', role !== 'member');
    b.title = role === 'member' ? 'enter a PIN to build or administer' : `${role} · click to sign out`;
    this.q('[data-el="edit"]').hidden = !canEdit;
    this.q('[data-el="studio"]').hidden = !canEdit;
  }

  /** light up the fly and edit buttons when they are on, and say what the keys do now */
  setMode(flying: boolean, editing: boolean) {
    this.q('[data-el="fly"]').classList.toggle('on', flying);
    this.q('[data-el="edit"]').classList.toggle('on', editing);
    this.q('[data-el="keys"]').innerHTML = editing
      ? 'click to select or place · drag a block to move it · <b>[ ]</b> turn · <b>1–9, 0</b> tools · <b>L F R O</b> wall, floor, roof, opening · <b>V</b> grid · <b>Enter</b> finish a line · <b>Esc</b> cancel · <b>Ctrl Z</b> undo · right-drag to look · <b>B</b> leave edit'
      : flying
        ? 'W A S D fly · <b>Space</b> up · <b>X</b> down · <b>Shift</b> fast · <b>Q E</b> turn · wheel speed · <b>G</b> land · <b>B</b> edit'
        : 'W A S D move · <b>Shift</b> run · <b>Space</b> jump · <b>C</b> first person · <b>G</b> fly · <b>B</b> edit · drag or click to look · wheel to zoom out';
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
    const fly = s.mode === 'fly' ? `<span class="fly">flying · <b>${s.heightM.toFixed(0)} m</b> up · ${s.flySpeed.toFixed(0)} m/s</span>` : '';
    this.readout.innerHTML =
      fly +
      `<span><b>${s.groundM.toFixed(1)} m</b> <i>${ft} ft</i></span>` +
      `<span>${s.lat.toFixed(6)}, ${s.lng.toFixed(6)}</span>` +
      `<span>heading <b>${s.headingDeg.toFixed(0)}°</b> · ${s.speed.toFixed(1)} m/s</span>` +
      `<span>${tiles} tiles · ${this.fps} fps</span>`;
  }
}
