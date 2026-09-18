// The editor's panel: the tools down one side, what is selected and what can be done to it.
//
//   It is a view of the Editor and nothing more — every button calls a method the tests can call
//   too, and it redraws itself from the editor's state whenever the editor says something changed.

import type { Editor, Pick, Tool } from './editor';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const TOOLS: { id: Tool; key: string; label: string; hint: string }[] = [
  { id: 'select', key: '1', label: '↖ select', hint: 'click a tree, a post, a marker, a line' },
  { id: 'marker', key: '2', label: '📍 marker', hint: 'click the ground to pin a name there' },
  { id: 'tree', key: '3', label: '🌳 tree', hint: 'click the ground to plant a tree that is there' },
  { id: 'fence', key: '4', label: '⌇ fence', hint: 'click along the line · Enter to finish' },
  { id: 'path', key: '5', label: '⋯ path', hint: 'click along the path · Enter to finish' },
  { id: 'road', key: '6', label: '═ road', hint: 'click along the road · Enter to finish' }
];

export class Panel {
  root: HTMLElement;

  constructor(container: HTMLElement, private editor: Editor, private askPin: () => string | null) {
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
    const busy = e.moving ? `<div class="ep-note">put <b>${esc(e.moving.name)}</b> down: click the ground · Esc cancels</div>`
      : e.drawing.length ? `<div class="ep-note">${e.drawing.length} point${e.drawing.length === 1 ? '' : 's'} · <b>Enter</b> finish · <b>Backspace</b> undo point · <b>Esc</b> cancel</div>`
      : '';
    const save = e.lastSave ? `<div class="ep-save ${e.lastSave.ok ? 'ok' : 'bad'}">${esc(e.lastSave.message)}</div>` : '';
    this.root.innerHTML = `
      <div class="ep-head"><b>edit</b><span>${e.edits.length} unsaved</span><button class="ep-x" data-act="close" title="leave edit mode (B)">×</button></div>
      <div class="ep-tools">${TOOLS.map(t => `<button class="ep-tool${t.id === e.tool ? ' on' : ''}" data-tool="${t.id}" title="${esc(t.hint)} (${t.key})">${t.label}</button>`).join('')}</div>
      <div class="ep-hint">${esc(TOOLS.find(t => t.id === e.tool)?.hint ?? '')}</div>
      ${busy}
      ${this.selection(e.selection)}
      <div class="ep-list">${this.list()}</div>
      <div class="ep-actions">
        <button class="btn" data-act="undo" ${e.edits.length ? '' : 'disabled'}>↶ undo</button>
        <button class="btn" data-act="download" ${e.edits.length ? '' : 'disabled'}>⤓ edits.geojson</button>
        <button class="btn gold" data-act="save" ${e.edits.length ? '' : 'disabled'}>save to pack…</button>
      </div>
      ${save}`;
    this.root.querySelectorAll<HTMLElement>('[data-tool]').forEach(b => b.addEventListener('click', () => e.setTool(b.dataset.tool as Tool)));
    this.root.querySelectorAll<HTMLElement>('[data-act]').forEach(b => b.addEventListener('click', () => this.act(b.dataset.act!)));
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
        return `<div class="ep-sel"><b>${esc(p.name)}</b> <small>marker</small>
          <div class="ep-row"><button class="btn" data-act="remove">✕ remove</button></div></div>`;
      case 'line':
        return `<div class="ep-sel"><b>${esc(this.lineName(p.id))}</b> <small>drawn</small>
          <div class="ep-row"><button class="btn" data-act="remove">✕ remove</button></div></div>`;
      case 'building':
        return `<div class="ep-sel"><b>${esc(p.name)}</b> <small>standing — from the county record; it cannot be edited here</small></div>`;
      case 'ground':
        return `<div class="ep-sel muted">ground · ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>`;
    }
  }

  private lineName(id: string): string {
    const f = this.editor.edits.find(x => String(x.properties.id) === id);
    return String(f?.properties.name || f?.properties.kind || id);
  }

  private list(): string {
    const e = this.editor;
    if (!e.edits.length) return `<div class="muted">no unsaved edits — they are kept in this browser until you save them to the pack</div>`;
    return e.edits.slice(-8).reverse().map(f => {
      const p = f.properties;
      const what = p.op === 'remove' && p.layer === 'trees' ? `tree marked gone`
        : p.op === 'remove' ? `${esc(p.target ?? p.id)} taken off the map`
        : p.op === 'move' ? `${esc(p.target ?? p.id)} moved`
        : p.op === 'add' && p.layer === 'trees' ? `tree ${Number(p.height_m).toFixed(1)} m planted`
        : p.op === 'add' && p.layer === 'notes' ? `marker “${esc(p.name)}”`
        : p.op === 'add' && p.layer === 'lines' ? `${esc(p.kind)} “${esc(p.name)}”`
        : `${esc(p.op)} ${esc(p.layer)}`;
      return `<div class="ep-item">${what}</div>`;
    }).join('') + (e.edits.length > 8 ? `<div class="muted">… and ${e.edits.length - 8} more</div>` : '');
  }

  private act(a: string) {
    const e = this.editor;
    const s = e.selection;
    switch (a) {
      case 'close': e.setActive(false); break;
      case 'undo': e.undo(); break;
      case 'download': e.download(); break;
      case 'gone': if (s?.kind === 'tree') e.markGone(s.tree); break;
      case 'move': if (s?.kind === 'vision') e.beginMove(s.id, s.name); break;
      case 'remove': if (s) e.remove(s); break;
      case 'save': {
        const pin = this.askPin();
        if (pin) void e.save(pin);
        break;
      }
    }
  }
}
