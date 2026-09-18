// The editor's panel: the tools down one side, what is selected and what can be done to it.
//
//   It is a view of the Editor and nothing more — every button calls a method the tests can call
//   too, and it redraws itself from the editor's state whenever the editor says something changed.

import type { Editor, Pick, Tool } from './editor';
import type { Caps, Role } from '../world/roles';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const FT = 0.3048;

const TOOLS: { id: Tool; key: string; label: string; hint: string; needs?: keyof Caps }[] = [
  { id: 'select', key: '1', label: '↖ select', hint: 'click a tree, a post, a marker, a line, a block · drag a block to move it' },
  { id: 'marker', key: '2', label: '📍 marker', hint: 'click the ground to pin a name there' },
  { id: 'tree', key: '3', label: '🌳 tree', hint: 'click the ground to plant a tree that is there' },
  { id: 'fence', key: '4', label: '⌇ fence', hint: 'click along the line · Enter to finish' },
  { id: 'path', key: '5', label: '⋯ path', hint: 'click along the path · Enter to finish' },
  { id: 'road', key: '6', label: '═ road', hint: 'click along the road · Enter to finish' },
  { id: 'block', key: '7', label: '▢ block', hint: 'set the size, then click the ground to put it down facing the way you face', needs: 'place' },
  { id: 'magic', key: '8', label: '✦ magic box', hint: 'click the ground to put down a box you can talk to', needs: 'magic' },
  { id: 'zone', key: '9', label: '⬠ territory', hint: 'click the corners of an area on the ground · Enter to close it' },
  { id: 'terrain', key: '0', label: '⛰ ground', hint: 'click the corners of the ground to shape · Enter to shape it', needs: 'place' }
];

const ZONE_KINDS = ['zone', 'garden', 'orchard', 'pasture', 'site', 'camp', 'water', 'keep', 'forest'];

export interface PanelOpts {
  askPin: () => string | null;
  role: () => Role;
  caps: () => Caps;
}

export class Panel {
  root: HTMLElement;

  constructor(container: HTMLElement, private editor: Editor, private o: PanelOpts) {
    this.root = document.createElement('aside');
    this.root.className = 'edit-panel';
    this.root.hidden = true;
    container.appendChild(this.root);
    this.render();
  }

  render() {
    const e = this.editor;
    this.root.hidden = !e.active;
    if (!e.active) return;
    const caps = this.o.caps();
    const busy = e.moving ? `<div class="ep-note">put <b>${esc(e.moving.name)}</b> down: click the ground · Esc cancels</div>`
      : e.drawing.length ? `<div class="ep-note">${e.drawing.length} point${e.drawing.length === 1 ? '' : 's'} · <b>Enter</b> ${e.tool === 'zone' || e.tool === 'terrain' ? 'close the ring' : 'finish'} · <b>Backspace</b> undo point · <b>Esc</b> cancel</div>`
      : '';
    const save = e.lastSave ? `<div class="ep-save ${e.lastSave.ok ? 'ok' : 'bad'}">${esc(e.lastSave.message)}</div>` : '';
    const proposed = e.proposed.edits.length + e.proposed.structures.length;
    const tools = TOOLS.filter(t => !t.needs || caps[t.needs]);
    this.root.innerHTML = `
      <div class="ep-head"><b>edit</b><span>${e.unsaved} unsaved${proposed ? ` · ${proposed} proposed` : ''}</span><em class="ep-role">${esc(this.o.role())}</em><button class="ep-x" data-act="close" title="leave edit mode (B)">×</button></div>
      <div class="ep-tools">${tools.map(t => `<button class="ep-tool${t.id === e.tool ? ' on' : ''}" data-tool="${t.id}" title="${esc(t.hint)} (${t.key})">${t.label}</button>`).join('')}</div>
      <div class="ep-hint">${esc(TOOLS.find(t => t.id === e.tool)?.hint ?? '')}</div>
      ${e.tool === 'block' ? this.blockForm() : e.tool === 'terrain' ? this.shapeForm() : e.tool === 'zone' ? this.zoneForm() : ''}
      ${busy}
      ${this.selection(e.selection)}
      <div class="ep-list">${this.list()}</div>
      <div class="ep-actions">
        <button class="btn" data-act="undo" ${e.unsaved ? '' : 'disabled'}>↶ undo</button>
        <button class="btn" data-act="grid">▦ grid (V)</button>
        <button class="btn" data-act="download" ${e.edits.length ? '' : 'disabled'}>⤓ edits.geojson</button>
        <button class="btn gold" data-act="save" ${e.unsaved ? '' : 'disabled'}>${caps.commit ? 'save to pack…' : 'propose…'}</button>
      </div>
      ${save}`;
    this.root.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => b.addEventListener('click', () => e.setTool(b.dataset.tool as Tool)));
    this.root.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', () => this.act(b.dataset.act!)));
    this.root.querySelectorAll<HTMLInputElement>('[data-block]').forEach(i => i.addEventListener('change', () => {
      const k = i.dataset.block as 'name' | 'w' | 'd' | 'h';
      if (k === 'name') e.block.name = i.value.trim() || 'block';
      else { const v = Number(i.value); if (isFinite(v) && v > 0) e.block[k] = v; }
    }));
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-shape]').forEach(i => i.addEventListener('change', () => {
      const k = i.dataset.shape as 'op' | 'height' | 'edge';
      if (k === 'op') e.shape.op = (i.value === 'raise' || i.value === 'lower') ? i.value : 'flatten';
      else { const v = Number(i.value); if (isFinite(v) && v >= 0) e.shape[k] = v; }
      this.render();
    }));
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-zone]').forEach(i => i.addEventListener('change', () => {
      const k = i.dataset.zone as 'name' | 'kind';
      e.zone[k] = i.value.trim();
    }));
    const height = this.root.querySelector<HTMLInputElement>('[data-height]');
    height?.addEventListener('change', () => { const s = e.selection; if (s?.kind === 'structure') e.setHeight(s.id, Number(height.value)); });
    const name = this.root.querySelector<HTMLInputElement>('[data-name]');
    name?.addEventListener('change', () => { const s = e.selection; if (s?.kind === 'structure') e.rename(s.id, name.value); });
  }

  private blockForm(): string {
    const b = this.editor.block;
    return `<div class="ep-form">
      <label>name <input data-block="name" value="${esc(b.name)}"></label>
      <label>width <input data-block="w" type="number" step="0.5" min="0.5" value="${b.w}"> m</label>
      <label>depth <input data-block="d" type="number" step="0.5" min="0.5" value="${b.d}"> m</label>
      <label>height <input data-block="h" type="number" step="0.5" min="0.5" value="${b.h}"> m</label>
      <small>${(b.w / FT).toFixed(0)} × ${(b.d / FT).toFixed(0)} ft · ${(b.w * b.d).toFixed(0)} m² · ${(b.w * b.d / (FT * FT)).toFixed(0)} sq ft</small>
    </div>`;
  }

  private shapeForm(): string {
    const sh = this.editor.shape;
    return `<div class="ep-form">
      <label>do <select data-shape="op">${['flatten', 'raise', 'lower'].map(o => `<option value="${o}" ${o === sh.op ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
      ${sh.op === 'flatten' ? `<small>to the mean level of its outline</small>` : `<label>by <input data-shape="height" type="number" step="0.25" min="0.1" max="20" value="${sh.height}"> m</label>`}
      <label>bank <input data-shape="edge" type="number" step="0.5" min="0" max="40" value="${sh.edge}"> m</label>
      <small>a pad flattened for a house, a bank raised, a hollow cut · the ground eases back into the hill across the bank</small>
    </div>`;
  }

  private zoneForm(): string {
    const z = this.editor.zone;
    return `<div class="ep-form">
      <label>name <input data-zone="name" value="${esc(z.name)}" placeholder="the orchard"></label>
      <label>kind <select data-zone="kind">${ZONE_KINDS.map(k => `<option value="${k}" ${k === z.kind ? 'selected' : ''}>${k}</option>`).join('')}</select></label>
    </div>`;
  }

  private selection(p: Pick | null): string {
    if (!p) return `<div class="ep-sel muted">nothing selected</div>`;
    switch (p.kind) {
      case 'tree':
        return `<div class="ep-sel"><b>tree</b> ${p.tree.height.toFixed(1)} m tall, crown ${p.tree.crown.toFixed(1)} m<br><small>${p.tree.lat.toFixed(6)}, ${p.tree.lng.toFixed(6)}</small>
          <div class="ep-row"><button class="btn" data-act="gone">✕ mark gone</button></div></div>`;
      case 'vision':
        return `<div class="ep-sel"><b>${esc(p.name)}</b> <small>project</small>
          <div class="ep-row"><button class="btn" data-act="move">⤒ move here…</button><button class="btn" data-act="remove">✕ take off the map</button></div></div>`;
      case 'note':
        return `<div class="ep-sel"><b>${esc(p.name)}</b> <small>${p.magic ? 'magic box' : 'marker'}</small>
          <div class="ep-row">${p.magic ? `<button class="btn gold" data-act="talk">✦ talk</button>` : ''}<button class="btn" data-act="remove">✕ remove</button></div></div>`;
      case 'line':
        return `<div class="ep-sel"><b>${esc(this.lineName(p.id))}</b> <small>drawn</small>
          <div class="ep-row"><button class="btn" data-act="remove">✕ remove</button></div></div>`;
      case 'zone':
        return `<div class="ep-sel"><b>${esc(p.name)}</b> <small>territory</small>
          <div class="ep-row"><button class="btn" data-act="remove">✕ remove</button></div></div>`;
      case 'building':
        return `<div class="ep-sel"><b>${esc(p.name)}</b> <small>standing — from the county record; it cannot be edited here</small></div>`;
      case 'structure': {
        const s = p.structure;
        const d = this.editor.dimensions(s);
        const can = this.o.caps().place;
        const what = s.status === 'massing' ? 'block' : s.status === 'model' ? 'model' : 'reserved site';
        const size = s.status === 'model' ? '' : `${d.w.toFixed(1)} × ${d.d.toFixed(1)} m · ${Math.round(d.w / FT)} × ${Math.round(d.d / FT)} ft`;
        return `<div class="ep-sel"><label class="ep-inline">name <input data-name value="${esc(s.name)}" ${can ? '' : 'disabled'}></label> <small>${what} · ${esc(s.mode)}</small>
          ${size ? `<div class="ep-dim">${size}</div>` : ''}
          ${s.status === 'massing' ? `<label class="ep-inline">height <input data-height type="number" step="0.5" min="0.5" max="90" value="${d.h.toFixed(1)}" ${can ? '' : 'disabled'}> m</label>` : ''}
          ${can ? `<div class="ep-row"><button class="btn" data-act="rot-" title="turn 15° left ([)">↺ 15°</button><button class="btn" data-act="rot+" title="turn 15° right (])">↻ 15°</button>${s.status === 'model' ? `<button class="btn" data-act="up" title="raise 0.25 m (+)">▲</button><button class="btn" data-act="down" title="lower 0.25 m (−)">▼</button>` : ''}<button class="btn" data-act="remove">✕ remove</button></div>
          <div class="muted">drag it across the ground to move it · it snaps to the half metre</div>` : ''}</div>`;
      }
      case 'ground':
        return `<div class="ep-sel muted">ground · ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>`;
    }
  }

  private lineName(id: string): string {
    const f = this.editor.edits.find(x => String(x.properties.id) === id) ?? this.editor.proposed.edits.find(x => String(x.properties.id) === id);
    return String(f?.properties.name || f?.properties.kind || id);
  }

  private list(): string {
    const e = this.editor;
    if (!e.unsaved) return `<div class="muted">no unsaved changes — they are kept in this browser until you ${this.o.caps().commit ? 'save them to the pack' : 'propose them'}</div>`;
    const items: string[] = [];
    for (const s of e.structures.slice(-6).reverse()) items.push(`<div class="ep-item">${s.remove ? `${esc(s.id)} taken off the registry` : `${esc(s.name)} · ${s.status === 'massing' ? 'block' : s.status}${s.note === 'placed in the world' ? ' placed' : ' changed'}`}</div>`);
    for (const f of e.edits.slice(-8).reverse()) {
      const p = f.properties;
      const what = p.op === 'remove' && p.layer === 'trees' ? `tree marked gone`
        : p.op === 'remove' ? `${esc(p.target ?? p.id)} taken off the map`
        : p.op === 'move' ? `${esc(p.target ?? p.id)} moved`
        : p.op === 'add' && p.layer === 'trees' ? `tree ${Number(p.height_m).toFixed(1)} m planted`
        : p.op === 'add' && p.layer === 'notes' ? `marker “${esc(p.name)}”`
        : p.op === 'add' && p.layer === 'lines' ? `${esc(p.kind)} “${esc(p.name)}”`
        : p.op === 'add' && p.layer === 'zones' ? `territory “${esc(p.name)}” (${esc(p.kind)})`
        : p.op === 'add' && p.layer === 'terrain' ? `ground ${esc(p.terrain_op)}${p.height_m != null ? ` ${Number(p.height_m)} m` : ''}`
        : `${esc(p.op)} ${esc(p.layer)}`;
      items.push(`<div class="ep-item">${what}</div>`);
    }
    const more = e.unsaved - items.length;
    return items.join('') + (more > 0 ? `<div class="muted">… and ${more} more</div>` : '');
  }

  private act(a: string) {
    const e = this.editor;
    const s = e.selection;
    switch (a) {
      case 'close': e.setActive(false); break;
      case 'undo': e.undo(); break;
      case 'grid': e.toggleGrid(); break;
      case 'download': e.download(); break;
      case 'gone': if (s?.kind === 'tree') e.markGone(s.tree); break;
      case 'talk': if (s?.kind === 'note' && s.magic) e.openMagic(s.id); break;
      case 'move': if (s?.kind === 'vision') e.beginMove(s.id, s.name); break;
      case 'remove': if (s) e.remove(s); break;
      case 'rot-': if (s?.kind === 'structure') e.rotateStructure(s.id, -15); break;
      case 'rot+': if (s?.kind === 'structure') e.rotateStructure(s.id, 15); break;
      case 'up': if (s?.kind === 'structure') e.raiseStructure(s.id, 0.25); break;
      case 'down': if (s?.kind === 'structure') e.raiseStructure(s.id, -0.25); break;
      case 'save': {
        const pin = this.o.askPin();
        if (pin) void e.save(pin);
        break;
      }
    }
  }
}
