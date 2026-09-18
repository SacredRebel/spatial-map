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

import type { Editor } from './editor';
import type { PackData } from '../world/pack';
import type { Session } from '../world/roles';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

/** what the agent may propose — the map's grammar, in metres east and north of the box */
export type Action =
  | { type: 'block'; name: string; w: number; d: number; h: number; e?: number; n?: number; heading?: number }
  | { type: 'line'; kind: 'fence' | 'path' | 'road'; name: string; points: [number, number][]; e?: number; n?: number }
  | { type: 'marker'; name: string; e?: number; n?: number }
  | { type: 'remove_trees'; radius_m: number; e?: number; n?: number }
  | { type: 'plant_tree'; height_m: number; e?: number; n?: number }
  | { type: 'zone'; name: string; kind: string; points: [number, number][]; e?: number; n?: number }
  | { type: 'terrain'; op: 'flatten' | 'raise' | 'lower'; height_m: number; edge_m: number; points: [number, number][]; e?: number; n?: number };

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
      if (!this.turns.length) this.turns.push({ role: 'agent', text: 'I am here. Tell me what you want at this spot — a block of some size, a fence, a marker, a territory, the ground flattened or raised, trees taken down — and I will lay it out for you to take or leave.', at: Date.now() });
    }
    this.render();
  }

  close() { this.editor.openMagic(null); }

  private persist() {
    if (!this.boxId) return;
    try { localStorage.setItem(KEY(this.boxId), JSON.stringify(this.turns.slice(-60))); } catch { /* fine */ }
  }

  /** where the box stands, in lng/lat and as a name */
  private box(): { id: string; name: string; lng: number; lat: number } | null {
    if (!this.boxId) return null;
    const f = this.editor.note(this.boxId);
    if (!f || f.geometry.type !== 'Point') return null;
    return { id: this.boxId, name: String(f.properties.name || 'magic box'), lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
  }

  /** metres east and north of the box → lng/lat */
  private at(e = 0, n = 0): [number, number] {
    const b = this.box()!;
    const MX = 111320 * Math.cos(b.lat * Math.PI / 180), MY = 110574;
    return [b.lng + e / MX, b.lat + n / MY];
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
          pin: this.o.session().pin, pack: pack?.manifest.id, box, heading: this.o.heading(),
          messages: this.turns.slice(-12).map(x => ({ role: x.role === 'you' ? 'user' : 'assistant', content: x.text }))
        })
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) {
        const why = j.error === 'bad_pin' ? 'the atlas does not know your PIN — sign in again' : j.error === 'not_configured' ? 'the atlas has no PIN set up' : (j.detail || j.error || `HTTP ${r.status}`);
        turn = { role: 'agent', text: `I could not reach the atlas: ${why}.`, at: Date.now() };
      } else {
        const actions = (Array.isArray(j.actions) ? j.actions : []) as Action[];
        this.last = { reply: String(j.reply || ''), actions, stub: !!j.stub };
        turn = { role: 'agent', text: String(j.reply || '…'), actions, taken: actions.map(() => false), at: Date.now() };
        if (this.speak && 'speechSynthesis' in window) { try { speechSynthesis.cancel(); speechSynthesis.speak(new SpeechSynthesisUtterance(turn.text)); } catch { /* no voice */ } }
      }
    } catch (e) {
      turn = { role: 'agent', text: `I could not reach the atlas: ${(e as Error).message}.`, at: Date.now() };
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
      }
    };
    const turns = this.turns.map((t, i) => `<div class="mg-turn ${t.role}">
        <div class="mg-text">${esc(t.text)}</div>
        ${t.actions && t.actions.length ? `<div class="mg-actions">${t.actions.map((a, j) => `<div class="mg-action${t.taken?.[j] ? ' taken' : ''}"><span>${describe(a)}</span>${t.taken?.[j] ? '<em>taken</em>' : `<button class="btn" data-take="${i}:${j}">take</button>`}</div>`).join('')}
          ${t.actions.length > 1 && !t.taken?.every(Boolean) ? `<button class="btn gold" data-take-all="${i}">take all</button>` : ''}</div>` : ''}
      </div>`).join('');
    this.root.innerHTML = `
      <div class="mg-head"><b>✦ ${esc(box.name)}</b><span>${box.lat.toFixed(5)}, ${box.lng.toFixed(5)}</span>
        <label class="mg-toggle" title="read the replies aloud"><input type="checkbox" data-speak ${this.speak ? 'checked' : ''}> voice</label>
        <button class="ep-x" data-close title="close">×</button></div>
      <div class="mg-log" data-log>${turns}${this.busy ? '<div class="mg-turn agent"><div class="mg-text muted">…</div></div>' : ''}</div>
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
    const log = this.root.querySelector<HTMLElement>('[data-log]');
    if (log) log.scrollTop = log.scrollHeight;
  }
}
