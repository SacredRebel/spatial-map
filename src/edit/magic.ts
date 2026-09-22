// The magic box: a marker you talk to.
//
//   Put a box down anywhere on the land and it is a place to create from. Say what you want —
//   typed, or spoken — and the agent on the atlas answers, and proposes: a block of such a size
//   here, a fence from here to there, a marker, trees taken down. Every proposal is shown as a
//   card and nothing happens until you take it; then it becomes an ordinary unsaved edit, made
//   through the editor's own grammar, so it can be undone, seen, and saved like anything else.
//
//   The agent lives on the atlas (POST /api/agent) and speaks only the map's grammar — it cannot
//   do anything a builder could not do by hand. Voice in is the browser's own recognition where
//   it has one; voice out is the browser's own speech. The transcript stays with the box, in this
//   browser, so a conversation can be picked up where it was left.

import type { Editor, ModifySpec } from './editor';
import type { Feature, PackData } from '../world/pack';
import type { Session } from '../world/roles';
import type { RoofForm, Opening } from '../world/build';
import { specFromWords, type OrganicSpec } from '../world/organic';
import { metresPerDegree } from '../world/geo';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** what the agent may propose — the map's grammar, in metres east and north of the box */
export type Action =
  | { type: 'block'; name: string; w: number; d: number; h: number; e?: number; n?: number; heading?: number }
  | { type: 'line'; kind: 'fence' | 'path' | 'road'; name: string; points: [number, number][]; e?: number; n?: number }
  | { type: 'marker'; name: string; e?: number; n?: number }
  | { type: 'remove_trees'; radius_m: number; e?: number; n?: number }
  | { type: 'plant_tree'; height_m: number; e?: number; n?: number }
  | { type: 'zone'; name: string; kind: string; points: [number, number][]; e?: number; n?: number }
  | { type: 'terrain'; op: 'flatten' | 'raise' | 'lower'; height_m: number; edge_m: number; points: [number, number][]; e?: number; n?: number }
  | { type: 'wall'; points: [number, number][]; height_m: number; thick_m: number; material: string; smooth?: boolean; structure?: string; door_at_m?: number; e?: number; n?: number }
  | { type: 'floor'; points: [number, number][]; level_m: number; material: string; structure?: string; e?: number; n?: number }
  | { type: 'roof'; points: [number, number][]; form: RoofForm; eaves_m: number; pitch_deg: number; material: string; structure?: string; e?: number; n?: number }
  | { type: 'room'; name: string; w: number; d: number; h: number; wall: string; roof: RoofForm; door: boolean; e?: number; n?: number; heading?: number }
  /** an organic building fitted into a perimeter: `points` (e/n of the box), or the marked ground when there are none */
  | { type: 'organic'; name: string; spec: Partial<OrganicSpec>; points?: [number, number][]; e?: number; n?: number }
  /** a change to parts that are already there — the marked ones, by id */
  | ({ type: 'modify'; ids: string[]; e?: number; n?: number } & ModifySpec);

export interface Turn { role: 'you' | 'agent'; text: string; actions?: Action[]; taken?: boolean[]; at: number }

interface SpeechRecognitionLike extends EventTarget {
  lang: string; interimResults: boolean; continuous: boolean;
  start(): void; stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
}

export interface MagicOpts {
  atlas: string;
  pack: () => PackData | null;
  session: () => Session;
  heading: () => number;
}

const KEY = (id: string) => `spatial-map:magic:${id}`;

export class Magic {
  root: HTMLElement;
  boxId: string | null = null;
  turns: Turn[] = [];
  busy = false;
  speak = false;
  listening = false;
  private rec: SpeechRecognitionLike | null = null;
  /** what the agent last said, for tests and for the readout */
  last: { reply: string; actions: Action[]; stub: boolean } | null = null;

  constructor(container: HTMLElement, private editor: Editor, private o: MagicOpts) {
    this.root = document.createElement('section');
    this.root.className = 'magic';
    this.root.hidden = true;
    container.appendChild(this.root);
    const W = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Rec = W.SpeechRecognition || W.webkitSpeechRecognition;
    if (Rec) {
      this.rec = new Rec();
      this.rec.lang = 'en-US';
      this.rec.interimResults = true;
      this.rec.continuous = false;
      this.rec.onresult = e => {
        const r = e.results[e.results.length - 1];
        const text = r[0].transcript;
        const input = this.root.querySelector<HTMLInputElement>('[data-say]');
        if (input) input.value = text;
        if (r.isFinal) void this.send(text);
      };
      this.rec.onend = () => { this.listening = false; this.render(); };
      this.rec.onerror = () => { this.listening = false; this.render(); };
    }
  }

  /** the box the panel shows, or none */
  open(id: string | null) {
    if (id === this.boxId) { this.render(); return; }
    this.boxId = id;
    this.turns = [];
    if (id) {
      try { const raw = localStorage.getItem(KEY(id)); if (raw) this.turns = JSON.parse(raw); } catch { this.turns = []; }
      if (!this.turns.length) this.turns.push({ role: 'agent', text: id === 'mark'
        ? this.markGreeting()
        : 'I am here. Tell me what you want at this spot — a room of some size, a wall, a floor, a roof, a block, a fence, a marker, a territory, the ground flattened or raised, trees taken down, or a whole organic building — and I will lay it out for you to take or leave.', at: Date.now() });
    }
    this.render();
  }

  close() { if (this.boxId === 'mark') this.editor.clearMark(); else this.editor.openMagic(null); }

  private markGreeting(): string {
    const parts = this.editor.markedParts();
    const walls = parts.filter(f => f.properties.kind === 'wall').length;
    return parts.length
      ? `Marked: ${Math.round(this.editor.mark?.areaM2 ?? 0)} m² with ${parts.length} part${parts.length === 1 ? '' : 's'} in it${walls ? ` (${walls} wall${walls === 1 ? '' : 's'})` : ''}. Tell me how to change them — higher, curved, thicker, another material, windows, a door — or ask for something new here.`
      : `Marked: ${Math.round(this.editor.mark?.areaM2 ?? 0)} m² of ground. Tell me what to grow here — "an organic house with a steel frame, cob walls, hemp insulation and a solar roof", say — and I will fit it inside the line, eave and all.`;
  }

  /** the viewer's right, on the ground: what "to the right" means to the person saying it */
  private right(): { x: number; z: number } {
    const a = (this.o.heading() * Math.PI) / 180;
    return { x: Math.cos(a), z: Math.sin(a) };
  }

  private persist() {
    if (!this.boxId) return;
    try { localStorage.setItem(KEY(this.boxId), JSON.stringify(this.turns.slice(-60))); } catch { /* fine */ }
  }

  /** where the box stands, in lng/lat and as a name */
  private box(): { id: string; name: string; lng: number; lat: number } | null {
    if (!this.boxId) return null;
    if (this.boxId === 'mark') {
      const m = this.editor.mark;
      if (!m || !m.ring.length) return null;
      const lng = m.ring.reduce((s, c) => s + c[0], 0) / m.ring.length, lat = m.ring.reduce((s, c) => s + c[1], 0) / m.ring.length;
      return { id: 'mark', name: 'marked ground', lng, lat };
    }
    const f = this.editor.note(this.boxId);
    if (!f || f.geometry.type !== 'Point') return null;
    return { id: this.boxId, name: String(f.properties.name || 'magic box'), lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  }

  /** metres east and north of the box → lng/lat */
  private at(e = 0, n = 0): [number, number] {
    const b = this.box()!;
    const { mx: MX, my: MY } = metresPerDegree(b.lat);
    return [b.lng + e / MX, b.lat + n / MY];
  }

  /** lng/lat → metres east and north of the box */
  private en(lng: number, lat: number): [number, number] {
    const b = this.box()!;
    const { mx: MX, my: MY } = metresPerDegree(b.lat);
    return [+((lng - b.lng) * MX).toFixed(2), +((lat - b.lat) * MY).toFixed(2)];
  }

  /** what the agent is told about the marked ground: its outline, and each part inside it */
  private markContext(): Record<string, unknown> | undefined {
    const m = this.editor.mark;
    if (this.boxId !== 'mark' || !m) return undefined;
    const part = (f: Feature) => {
      const p = f.properties;
      const coords = f.geometry.type === 'LineString' ? f.geometry.coordinates : f.geometry.type === 'Polygon' ? f.geometry.coordinates[0] : [];
      const out: Record<string, unknown> = { id: p.id, kind: p.kind, structure: p.structure, material: p.material, points_en: coords.slice(0, 60).map(c => this.en(c[0], c[1])) };
      if (p.kind === 'wall') { out.height_m = p.height_m; out.thick_m = p.thick_m; out.smooth = !!p.smooth; out.openings = ((p.openings ?? []) as Opening[]).map(o => ({ kind: o.kind, at_m: o.at_m, width_m: o.width_m })); }
      if (p.kind === 'roof') { out.form = p.form; out.eaves_m = p.eaves_m; out.rise_m = p.rise_m; out.finish = p.finish; }
      if (p.kind === 'floor') { out.level_m = p.level_m; }
      return out;
    };
    return { ring_en: m.ring.map(c => this.en(c[0], c[1])), area_m2: Math.round(m.areaM2), selected: this.editor.markedParts().slice(0, 24).map(part) };
  }

  /**
   * When the atlas cannot answer — no PIN in this browser, no key on the atlas, no network — the box
   * still understands the plain words, so marking ground and saying what you want does something
   * on day one. It says plainly that it is the plain-words reading.
   */
  localAgent(text: string): { reply: string; actions: Action[] } {
    const t = text.toLowerCase();
    const parts = this.boxId === 'mark' ? this.editor.markedParts() : [];
    const walls = parts.filter(f => f.properties.kind === 'wall').map(f => String(f.properties.id));
    const roofs = parts.filter(f => f.properties.kind === 'roof').map(f => String(f.properties.id));
    const changeWords = /\b(higher|taller|lower|shorter|raise|curv|bend|bow|round(er)?|window|door|thick|thin|make (it|them|these|this)|change|redesign)/.test(t);
    const makeWords = /\b(bio|organic|biomorph|shape|transform|build|house|home|cabin|dwelling|dome|nautilus|leaf|lobe|flower|grow)/.test(t);
    const actions: Action[] = [];
    const by = /by\s+(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)/.exec(t);
    if (parts.length && changeWords && !(makeWords && !walls.length)) {
      const m: ModifySpec = {};
      if (/\b(higher|taller|raise)\b/.test(t)) m.height_delta_m = by ? Number(by[1]) : 0.6;
      if (/\b(lower|shorter)\b/.test(t) && !/\blower (the )?roof\b/.test(t)) m.height_delta_m = -(by ? Number(by[1]) : 0.5);
      const hi = /(\d+(?:\.\d+)?)\s*(?:m|metres?|meters?)\s*(?:high|tall)/.exec(t);
      if (hi) m.height_m = Number(hi[1]);
      if (/\b(curv|bend|bow|round)/.test(t)) {
        m.bulge_m = /\bmore\b|\bvery\b|\bstrong/.test(t) ? 1.8 : 1.1;
        m.bulge_dir = /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : /\b(in|inward|inwards)\b/.test(t) ? 'in' : 'out';
      }
      const nw = /(?:add|put|cut|with)\s+(a|an|one|two|three|four|\d+)?\s*(?:more\s+)?(?:big\s+|large\s+|tall\s+)?windows?/.exec(t);
      if (nw) { const w: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 }; m.add_windows = Number(nw[1]) || w[nw[1] ?? 'a'] || 1; if (/\b(big|large|tall)\b/.test(t)) { m.window_width_m = 2; m.window_sill_m = 0.4; } }
      if (/\b(add|put|cut)\s+(a|another)\s+door\b/.test(t)) m.add_door = true;
      const mat = /\b(cob|hempcrete|strawbale|straw bale|rammed earth|adobe|stone|plaster|lime|wood|timber|glass|concrete|bamboo)\b/.exec(t);
      if (mat && /\b(make|change|turn|in|to)\b/.test(t)) m.material = mat[1].replace(' ', '_').replace('straw_bale', 'strawbale');
      if (/\bthicker\b/.test(t)) m.thick_m = 0.6; if (/\bthinner\b/.test(t)) m.thick_m = 0.25;
      if (/\broof\b/.test(t) && /\b(higher|taller|raise|steeper)\b/.test(t)) { m.rise_delta_m = by ? Number(by[1]) : 0.8; delete m.height_delta_m; }
      const ids = /\broof\b/.test(t) && !walls.length ? roofs : m.rise_delta_m ? roofs : walls.length ? walls : parts.map(f => String(f.properties.id));
      if (Object.keys(m).length && ids.length) actions.push({ type: 'modify', ids, ...m });
    } else if (makeWords || this.boxId === 'mark') {
      const spec = specFromWords(t);
      const name = (/(?:called|named)\s+["“]?([^"”.,]+)/.exec(text)?.[1] ?? '').trim();
      actions.push({ type: 'organic', name: name || '', spec });
    }
    const reply = actions.length
      ? `I read that in plain words (the full agent needs a PIN and the atlas's key) — here is what I would do. Take it, then tune it with the sliders.`
      : `I only understand plain words right now. Mark ground and say "an organic house with a steel frame, cob walls and a solar roof", or mark walls and say "make them higher, curve them to the right and add a window".`;
    return { reply, actions };
  }

  /** send a line to the agent; the reply and its proposals join the transcript */
  async send(text: string): Promise<Turn | null> {
    const box = this.box();
    const t = text.trim();
    if (!box || !t || this.busy) return null;
    this.turns.push({ role: 'you', text: t, at: Date.now() });
    this.busy = true;
    this.render();
    let turn: Turn;
    try {
      const pack = this.o.pack();
      const r = await fetch(`${this.o.atlas}/api/agent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pin: this.o.session().pin, pack: pack?.manifest.id, box, heading: this.o.heading(), mark: this.markContext(),
          messages: this.turns.slice(-12).map(x => ({ role: x.role === 'you' ? 'user' : 'assistant', content: x.text }))
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const why = j.error === 'bad_pin' ? 'the atlas does not know your PIN' : j.error === 'not_configured' ? 'the atlas has no PIN set up' : (j.detail || j.error || `HTTP ${r.status}`);
        const local = this.localAgent(t);
        if (local.actions.length) {
          this.last = { reply: local.reply, actions: local.actions, stub: true };
          turn = { role: 'agent', text: `(${why}) ${local.reply}`, actions: local.actions, taken: local.actions.map(() => false), at: Date.now() };
        } else turn = { role: 'agent', text: `I could not reach the atlas: ${why}. ${local.reply}`, at: Date.now() };
      } else {
        const actions = (Array.isArray(j.actions) ? j.actions : []) as Action[];
        this.last = { reply: String(j.reply || ''), actions, stub: !!j.stub };
        turn = { role: 'agent', text: String(j.reply || '…'), actions, taken: actions.map(() => false), at: Date.now() };
        if (this.speak && 'speechSynthesis' in window) { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(turn.text)); } catch { /* no voice */ } }
      }
    } catch (e) {
      const local = this.localAgent(t);
      turn = local.actions.length
        ? { role: 'agent', text: `(offline) ${local.reply}`, actions: local.actions, taken: local.actions.map(() => false), at: Date.now() }
        : { role: 'agent', text: `I could not reach the atlas: ${(e as Error).message}.`, at: Date.now() };
    }
    this.turns.push(turn);
    this.busy = false;
    this.persist();
    this.render();
    return turn;
  }

  /** take one of the agent's proposals: it becomes an ordinary unsaved edit */
  take(turnIndex: number, actionIndex: number): boolean {
    const turn = this.turns[turnIndex];
    const a = turn?.actions?.[actionIndex];
    if (!turn || !a || turn.taken?.[actionIndex] || !this.box()) return false;
    const ed = this.editor;
    const [lng, lat] = this.at(a.e ?? 0, a.n ?? 0);
    switch (a.type) {
      case 'block': ed.addBlock(lng, lat, { name: a.name || 'block', w: a.w, d: a.d, h: a.h }, a.heading ?? this.o.heading()); break;
      case 'line': ed.addLine(a.kind, a.points.map(([e, n]) => this.at(e, n)), a.name || a.kind); break;
      case 'marker': ed.addNote(lng, lat, a.name || 'marker'); break;
      case 'remove_trees': ed.removeTreesAround(lng, lat, a.radius_m); break;
      case 'plant_tree': ed.addTree(lng, lat, a.height_m); break;
      case 'zone': ed.addZone(a.points.map(([e, n]) => this.at(e, n)), a.name || a.kind, a.kind); break;
      case 'terrain': ed.addShaping(a.points.map(([e, n]) => this.at(e, n)), a.op, a.height_m, a.edge_m); break;
      case 'wall': {
        const id = ed.addWall(a.points.map(([e, n]) => this.at(e, n)), { height: a.height_m, thick: a.thick_m, material: a.material, smooth: !!a.smooth, base: 0, structure: a.structure ?? '' });
        if (id && a.door_at_m != null) ed.addOpening(id, a.door_at_m, { kind: 'door', width: 0.9, sill: 0, head: Math.min(2.1, a.height_m - 0.2) });
        break;
      }
      case 'floor': ed.addFloor(a.points.map(([e, n]) => this.at(e, n)), { level: a.level_m, thick: 0.2, material: a.material, structure: a.structure ?? '' }); break;
      case 'roof': ed.addRoof(a.points.map(([e, n]) => this.at(e, n)), { form: a.form, eaves: a.eaves_m, pitch: a.pitch_deg, overhang: 0.5, material: a.material, structure: a.structure ?? '' }); break;
      case 'room': ed.addRoom(lng, lat, { name: a.name || 'room', w: a.w, d: a.d, h: a.h, wall: a.wall, floor: 'wood', roof: a.roof, roofMaterial: 'tile', door: a.door !== false }, a.heading ?? this.o.heading()); break;
      case 'organic': {
        const ring = a.points && a.points.length >= 3 ? a.points.map(([e, n]) => this.at(e, n)) : this.editor.mark?.ring;
        if (!ring || ring.length < 3) return false;
        const made = ed.addOrganic(ring, { ...ed.organic, ...a.spec }, a.name);
        if (!made) { turn.text += ` — ${ed.lastOrganicWhy ?? 'it did not fit'}`; this.render(); return false; }
        if (this.boxId === 'mark') this.editor.setMarkSelected(made);
        break;
      }
      case 'modify': {
        const { type: _t, ids, e: _e, n: _n, ...m } = a;
        if (!ed.modifyParts(ids, m, this.right())) return false;
        break;
      }
      default: return false;
    }
    turn.taken![actionIndex] = true;
    this.persist();
    this.render();
    return true;
  }

  takeAll(turnIndex: number) {
    const turn = this.turns[turnIndex];
    (turn?.actions ?? []).forEach((_, i) => this.take(turnIndex, i));
  }

  listen() {
    if (!this.rec || this.listening) return;
    try { this.rec.start(); this.listening = true; this.render(); } catch { this.listening = false; }
  }

  // ---- the view ------------------------------------------------------------------------------------
  render() {
    const box = this.box();
    this.root.hidden = !box;
    if (!box) return;
    const describe = (a: Action): string => {
      const where = (a.e || a.n) ? ` ${Math.abs(a.e ?? 0).toFixed(0)} m ${(a.e ?? 0) >= 0 ? 'east' : 'west'}, ${Math.abs(a.n ?? 0).toFixed(0)} m ${(a.n ?? 0) >= 0 ? 'north' : 'south'} of the box` : ' at the box';
      switch (a.type) {
        case 'block': return `▢ block “${esc(a.name)}” ${a.w} × ${a.d} m, ${a.h} m high${where}`;
        case 'line': return `⌇ ${esc(a.kind)} “${esc(a.name)}”, ${a.points.length} points`;
        case 'marker': return `📍 marker “${esc(a.name)}”${where}`;
        case 'remove_trees': return `🌳 take down the trees within ${a.radius_m} m${where}`;
        case 'plant_tree': return `🌳 plant a ${a.height_m} m tree${where}`;
        case 'zone': return `⬠ ${esc(a.kind)} “${esc(a.name)}”, ${a.points.length} corners`;
        case 'terrain': return `⛰ ${a.op} the ground${a.op === 'flatten' ? '' : ` by ${a.height_m} m`} inside ${a.points.length} corners, bank ${a.edge_m} m`;
        case 'wall': return `▬ ${a.smooth ? 'curved ' : ''}${esc(a.material)} wall, ${a.points.length} points, ${a.height_m} m high${a.door_at_m != null ? ', with a door' : ''}${a.structure ? ` (${esc(a.structure)})` : ''}`;
        case 'floor': return `▱ ${esc(a.material)} floor, ${a.points.length} corners${a.level_m ? `, ${a.level_m} m up` : ''}${a.structure ? ` (${esc(a.structure)})` : ''}`;
        case 'roof': return `⌂ ${esc(a.form)} ${esc(a.material)} roof, eaves ${a.eaves_m} m, ${a.pitch_deg}°${a.structure ? ` (${esc(a.structure)})` : ''}`;
        case 'room': return `⌂ room “${esc(a.name)}” ${a.w} × ${a.d} m, ${a.h} m high, ${esc(a.wall)} walls, ${esc(a.roof)} roof${a.door === false ? '' : ', a door'}${where}`;
        case 'organic': {
          const sp = { ...this.editor.organic, ...a.spec };
          return `🌿 organic building${a.name ? ` “${esc(a.name)}”` : ''} — ${esc(sp.form)} plan${sp.form === 'lobed' ? ` of ${sp.lobes} lobes` : ''}, ${esc(sp.structure)} frame, ${esc(sp.infill.replace('_', ' '))} walls ${sp.height} m, ${esc(sp.insulation)} insulation, ${esc(sp.roof)} shell roof · fitted ${a.points ? `to ${a.points.length} points` : 'inside the mark'}`;
        }
        case 'modify': {
          const bits: string[] = [];
          if (a.height_m != null) bits.push(`${a.height_m} m high`);
          if (a.height_delta_m) bits.push(`${a.height_delta_m > 0 ? 'higher' : 'lower'} by ${Math.abs(a.height_delta_m)} m`);
          if (a.bulge_m) bits.push(`curved ${a.bulge_m} m ${a.bulge_dir ?? 'out'}`);
          if (a.add_windows) bits.push(`${a.add_windows} window${a.add_windows === 1 ? '' : 's'} added`);
          if (a.add_door) bits.push('a door added');
          if (a.material) bits.push(`in ${esc(a.material)}`);
          if (a.thick_m) bits.push(`${a.thick_m} m thick`);
          if (a.rise_delta_m) bits.push(`roof crown ${a.rise_delta_m > 0 ? 'up' : 'down'} ${Math.abs(a.rise_delta_m)} m`);
          if (a.roof_finish) bits.push(`${esc(a.roof_finish)} roof`);
          return `✎ change ${a.ids.length} part${a.ids.length === 1 ? '' : 's'}: ${bits.join(', ') || 'as asked'}`;
        }
      }
    };
    const turns = this.turns.map((t, i) => `<div class="mg-turn ${t.role}">
        <div class="mg-text">${esc(t.text)}</div>
        ${t.actions && t.actions.length ? `<div class="mg-actions">${t.actions.map((a, j) => `<div class="mg-action${t.taken?.[j] ? ' taken' : ''}"><span>${describe(a)}</span>${t.taken?.[j] ? '<em>taken</em>' : `<button class="btn" data-take="${i}:${j}">take</button>`}</div>`).join('')}
          ${t.actions.length > 1 && !t.taken?.every(Boolean) ? `<button class="btn gold" data-take-all="${i}">take all</button>` : ''}</div>` : ''}
      </div>`).join('');
    const mark = this.boxId === 'mark' ? this.editor.mark : null;
    const marked = mark ? this.editor.markedParts() : [];
    const chips = mark ? (marked.length
      ? ['make these walls higher', 'curve them to the right', 'add two big windows', 'make them cob', 'raise the roof']
      : ['an organic house here: steel frame, cob walls, hemp insulation, solar roof', 'a leaf-shaped studio in hempcrete with a living roof', 'a five-lobed home in rammed earth, glass to the south'])
      : [];
    this.root.innerHTML = `
      <div class="mg-head"><b>✦ ${esc(box.name)}</b><span>${mark ? `${Math.round(mark.areaM2)} m² · ${marked.length} part${marked.length === 1 ? '' : 's'}` : `${box.lat.toFixed(5)}, ${box.lng.toFixed(5)}`}</span>
        <label class="mg-toggle" title="read the replies aloud"><input type="checkbox" data-speak ${this.speak ? 'checked' : ''}> voice</label>
        <button class="ep-x" data-close title="close">×</button></div>
      <div class="mg-log" data-log>${turns}${this.busy ? '<div class="mg-turn agent"><div class="mg-text muted">…</div></div>' : ''}</div>
      ${chips.length ? `<div class="mg-chips">${chips.map(c => `<button class="mg-chip" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
      <form class="mg-say" data-form>
        ${this.rec ? `<button type="button" class="btn${this.listening ? ' on' : ''}" data-mic title="speak">${this.listening ? '● listening' : '🎤'}</button>` : ''}
        <input data-say placeholder="say what you want here…" autocomplete="off" ${this.busy ? 'disabled' : ''}>
        <button class="btn gold" type="submit" ${this.busy ? 'disabled' : ''}>send</button>
      </form>`;
    this.root.querySelector('[data-close]')?.addEventListener('click', () => this.close());
    this.root.querySelector<HTMLInputElement>('[data-speak]')?.addEventListener('change', e => { this.speak = (e.target as HTMLInputElement).checked; });
    this.root.querySelector('[data-mic]')?.addEventListener('click', () => this.listen());
    this.root.querySelector<HTMLFormElement>('[data-form]')?.addEventListener('submit', e => {
      e.preventDefault();
      const input = this.root.querySelector<HTMLInputElement>('[data-say]')!;
      const text = input.value; input.value = '';
      void this.send(text);
    });
    this.root.querySelectorAll<HTMLElement>('[data-take]').forEach(b => b.addEventListener('click', () => { const [i, j] = b.dataset.take!.split(':').map(Number); this.take(i, j); }));
    this.root.querySelectorAll<HTMLElement>('[data-take-all]').forEach(b => b.addEventListener('click', () => this.takeAll(Number(b.dataset.takeAll))));
    this.root.querySelectorAll<HTMLElement>('[data-chip]').forEach(b => b.addEventListener('click', () => void this.send(b.dataset.chip!)));
    const log = this.root.querySelector<HTMLElement>('[data-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }
}
