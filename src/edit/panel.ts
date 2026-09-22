// The editor's panel: the tools down one side, what is selected and what can be done to it.
//
//   It is a view of the Editor and nothing more — every button calls a method the tests can call
//   too, and it redraws itself from the editor's state whenever the editor says something changed.

import type { Editor, Pick, Tool } from './editor';
import type { Caps, Role } from '../world/roles';
import { MATERIAL_NAMES, ROOF_FORMS, STRUCTURES, INFILLS, INSULATIONS, ROOF_FINISHES, type Opening } from '../world/build';
import { ORGANIC_FORMS, type OrganicSpec, type Quantities } from '../world/organic';
import { ACCEPT, megabytes, type ImportItem } from '../world/imports';
import { fmtLen, fmtArea, parseArea, levelName, type BuildingSize } from './measure';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const FT = 0.3048;

const TOOLS: { id: Tool; key: string; label: string; hint: string; needs?: keyof Caps; group?: string }[] = [
  { id: 'select', key: '1', label: '↖ select', hint: 'click a tree, a post, a marker, a line, a block, a wall · drag a block or a wall to move it' },
  { id: 'tape', key: 'T', label: '📏 tape', hint: 'click where the tape starts, then where it ends — on the ground, a wall, a roof · it reads the level distance, the rise and the slope' },
  { id: 'marker', key: '2', label: '📍 marker', hint: 'click the ground to pin a name there' },
  { id: 'tree', key: '3', label: '🌳 tree', hint: 'click the ground to plant a tree that is there' },
  { id: 'fence', key: '4', label: '⌇ fence', hint: 'click along the line · Enter to finish' },
  { id: 'path', key: '5', label: '⋯ path', hint: 'click along the path · Enter to finish' },
  { id: 'road', key: '6', label: '═ road', hint: 'click along the road · Enter to finish' },
  { id: 'block', key: '7', label: '▢ block', hint: 'set the size, then click the ground to put it down facing the way you face', needs: 'place' },
  { id: 'magic', key: '8', label: '✦ magic box', hint: 'click the ground to put down a box you can talk to', needs: 'magic' },
  { id: 'zone', key: '9', label: '⬠ territory', hint: 'click the corners of an area on the ground · Enter to close it' },
  { id: 'terrain', key: '0', label: '⛰ ground', hint: 'click the corners of the ground to shape · Enter to shape it', needs: 'place' },
  { id: 'wall', key: 'L', label: '▬ wall', hint: 'click along the wall on the grid · click the start again to close a room · Enter to finish', needs: 'place', group: 'build' },
  { id: 'floor', key: 'F', label: '▱ floor', hint: 'click the corners of the floor · Enter to lay it', needs: 'place', group: 'build' },
  { id: 'roof', key: 'R', label: '⌂ roof', hint: 'click the corners the roof covers · Enter to raise it', needs: 'place', group: 'build' },
  { id: 'opening', key: 'O', label: '▯ door / window', hint: 'click a wall where the opening goes', needs: 'place', group: 'build' },
  { id: 'organic', key: 'K', label: '🌿 organic', hint: 'click round the ground it may use · Enter grows a building that fits inside, eave and all', needs: 'place', group: 'build' },
  { id: 'bring', key: 'I', label: '📥 bring in', hint: 'a model (.glb), a phone scan (.spz .ply .splat .sog) or a photo — choose it, then click the ground where it goes · or drop the file on the world', needs: 'place' },
  { id: 'mark', key: 'M', label: '✦ mark for AI', hint: 'press and draw round ground or walls (or click corners, Enter) · then tell the agent what to do there', group: 'build' }
];

const opts = (list: readonly string[], chosen: string) => list.map(m => `<option value="${m}" ${m === chosen ? 'selected' : ''}>${m.replace('_', ' ')}</option>`).join('');
const compass = (deg: number) => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

/** the biomimetic controls: every number that shapes an organic building, as sliders */
function organicControls(sp: OrganicSpec, attr: string, dis = ''): string {
  const range = (k: keyof OrganicSpec, label: string, lo: number, hi: number, step: number, unit = '', show?: (v: number) => string) =>
    `<label class="ep-range">${label} <input ${attr}="${k}" type="range" min="${lo}" max="${hi}" step="${step}" value="${sp[k] as number}" ${dis}><output>${show ? show(sp[k] as number) : `${sp[k]}${unit}`}</output></label>`;
  return `<div class="ep-organic">
    <label class="ep-inline">form <select ${attr}="form" ${dis}>${opts(ORGANIC_FORMS, sp.form)}</select></label>
    ${sp.form === 'lobed' ? range('lobes', 'lobes', 2, 12, 1) : ''}
    ${sp.form === 'lobed' || sp.form === 'shell' ? range('depth', sp.form === 'shell' ? 'curl' : 'lobe depth', 0, 0.6, 0.05) : ''}
    ${range('turn', 'turn', -180, 180, 5, '°')}
    ${range('height', 'wall height', 2.4, 7, 0.1, ' m')}
    ${range('rise', 'roof rise', 0.4, 6, 0.1, ' m')}
    ${range('overhang', 'eave', 0, 2.5, 0.1, ' m')}
    ${range('thick', 'wall thickness', 0.15, 0.9, 0.05, ' m')}
    ${range('glazing', 'glass', 0, 1, 0.05, '', v => `${Math.round(v * 100)}%`)}
    ${range('facing', 'glass faces', 0, 355, 5, '', v => `${v}° ${compass(v)}`)}
    ${sp.form === 'shell' ? '' : range('door', 'door at', 0, 355, 5, '', v => `${v}° ${compass(v)}`)}
    <label class="ep-inline">frame <select ${attr}="structure" ${dis}>${opts(STRUCTURES, sp.structure)}</select></label>
    <label class="ep-inline">walls <select ${attr}="infill" ${dis}>${opts(INFILLS, sp.infill)}</select></label>
    <label class="ep-inline">insulation <select ${attr}="insulation" ${dis}>${opts(INSULATIONS, sp.insulation)}</select></label>
    <label class="ep-inline">roof <select ${attr}="roof" ${dis}>${opts(ROOF_FINISHES, sp.roof)}</select></label>
    ${sp.roof === 'solar' ? range('solar', 'panels', 0, 1, 0.05, '', v => `${Math.round(v * 100)}% of the sunny side`) : ''}
    <label class="ep-inline">floor <select ${attr}="floor" ${dis}>${opts(['earth', 'stone', 'wood', 'concrete', 'timber'], sp.floor)}</select></label>
    <label class="ep-check"><input ${attr}="pad" type="checkbox" ${sp.pad ? 'checked' : ''} ${dis}> level a pad under it first</label>
  </div>`;
}

function quantities(q: Quantities | null): string {
  if (!q) return '';
  return `<div class="ep-qty"><b>what it takes</b> <small>(rough, from the model)</small>
    <div>floor ${q.floorM2} m² · ${q.floorSqft.toLocaleString()} sq ft</div>
    <div>walls ${q.wallLengthM} m round × ${q.wallHeightM} m · ${q.wallNetM2} m² net · infill ${q.infillM3} m³</div>
    <div>${q.doors} door${q.doors === 1 ? '' : 's'} · ${q.windows} window${q.windows === 1 ? '' : 's'} · ${q.glazingM2} m² of glass</div>
    <div>roof ${q.roofSurfaceM2} m² (covers ${q.roofPlanM2} m²)${q.insulationM3 ? ` · insulation ${q.insulationM3} m³` : ''}</div>
    ${q.frameKg ? `<div>frame ≈ ${q.frameKg.toLocaleString()} kg</div>` : ''}
    ${q.panels ? `<div>solar ${q.panels} panels · ${q.solarKwp} kWp · ≈ ${q.solarKwhYear.toLocaleString()} kWh a year</div>` : ''}
  </div>`;
}

const ZONE_KINDS = ['zone', 'garden', 'orchard', 'pasture', 'site', 'camp', 'water', 'keep', 'forest'];
const materialOptions = (chosen: string) => MATERIAL_NAMES.map(m => `<option value="${m}" ${m === chosen ? 'selected' : ''}>${m}</option>`).join('');

export interface PanelOpts {
  askPin: () => string | null;
  /** the floor plan of what is selected */
  openPlan?: () => void;
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
      : e.drawing.length ? `<div class="ep-note">${e.drawing.length} point${e.drawing.length === 1 ? '' : 's'} · <b>Enter</b> ${e.tool === 'zone' || e.tool === 'terrain' ? 'close the ring' : 'finish'} · <b>Backspace</b> undo point · <b>Esc</b> cancel
          <div class="ep-typed">${e.typed ? `length <b>${esc(e.typed)}</b> — <b>Enter</b> puts the next point exactly that far` : `type a length (<b>32'6"</b>, <b>9.9m</b>) + <b>Enter</b> for an exact side · hold <b>Shift</b> for square corners and round lengths`}</div></div>`
      : '';
    const save = e.lastSave ? `<div class="ep-save ${e.lastSave.ok ? 'ok' : 'bad'}">${esc(e.lastSave.message)}</div>` : '';
    const proposed = e.proposed.edits.length + e.proposed.structures.length;
    const tools = TOOLS.filter(t => !t.needs || caps[t.needs]);
    const button = (t: typeof TOOLS[number]) => `<button class="ep-tool${t.id === e.tool ? ' on' : ''}" data-tool="${t.id}" title="${esc(t.hint)} (${t.key})">${t.label}</button>`;
    const building = tools.filter(t => t.group === 'build');
    this.root.innerHTML = `
      <div class="ep-head"><b>edit</b><span>${e.unsaved} unsaved${proposed ? ` · ${proposed} proposed` : ''}</span><button class="ep-units" data-act="units" title="read lengths in feet or in metres first">${e.units === 'ft' ? 'ft·in' : 'm'}</button><em class="ep-role">${esc(this.o.role())}</em><button class="ep-x" data-act="close" title="leave edit mode (B)">×</button></div>
      <div class="ep-tools">${tools.filter(t => !t.group).map(button).join('')}</div>
      ${building.length ? `<div class="ep-tools ep-build"><span class="ep-group">build</span>${building.map(button).join('')}<button class="ep-tool" data-act="room" title="a floor, a closed wall with a door, and a roof, put down in one go where you stand">⌂ room…</button></div>` : ''}
      <div class="ep-hint">${esc(TOOLS.find(t => t.id === e.tool)?.hint ?? '')}</div>
      ${e.tool === 'tape' ? this.tapeForm() : e.tool === 'block' ? this.blockForm() : e.tool === 'terrain' ? this.shapeForm() : e.tool === 'zone' ? this.zoneForm() : e.tool === 'wall' ? this.wallForm() : e.tool === 'floor' ? this.floorForm() : e.tool === 'roof' ? this.roofForm() : e.tool === 'opening' ? this.openingForm() : e.tool === 'organic' ? this.organicForm() : e.tool === 'mark' ? this.markForm() : e.tool === 'bring' ? this.bringForm() : ''}
      ${busy}
      ${this.selection(e.selection)}
      <div class="ep-list">${this.list()}</div>
      <div class="ep-actions">
        <button class="btn" data-act="undo" ${e.unsaved ? '' : 'disabled'}>↶ undo</button>
        <button class="btn" data-act="grid">▦ grid (V)</button>
        <button class="btn" data-act="download" ${e.edits.length ? '' : 'disabled'}>⤓ edits.geojson</button>
        <button class="btn gold" data-act="save" ${e.unsaved ? '' : 'disabled'}>${caps.commit ? 'save to pack…' : 'propose…'}</button>
      </div>
      ${save}
      ${(() => { const t = e.surveyCheck(); return t ? `<div class="ep-true" title="each boundary line of the licensed survey, measured here from its two ends, against the distance the surveyor wrote down">✓ true to the ground: ${t.lines} survey lines within ${t.worstFt.toFixed(2)} ft</div>` : ''; })()}`;
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
    // the construction forms: every field writes straight into the editor's spec for the next part
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-spec]').forEach(i => i.addEventListener('change', () => {
      const [which, k] = i.dataset.spec!.split('.');
      const spec = (e as unknown as Record<string, Record<string, unknown>>)[which];
      if (!spec) return;
      const input = i as HTMLInputElement;
      if (input.type === 'checkbox') spec[k] = input.checked;
      else if (input.type === 'number') { const v = Number(input.value); if (isFinite(v)) spec[k] = v; }
      else spec[k] = input.value.trim();
      if (k === 'kind' || k === 'form') this.render();
    }));
    // the selected part: a change to a field changes the part in place
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-part]').forEach(i => i.addEventListener('change', () => {
      const s = e.selection;
      if (s?.kind !== 'build') return;
      const k = i.dataset.part!;
      const input = i as HTMLInputElement;
      const v: unknown = input.type === 'checkbox' ? (input.checked ? true : undefined) : input.type === 'number' ? Number(input.value) : input.value.trim();
      if (input.type === 'number' && !isFinite(v as number)) return;
      e.updateBuild(s.id, { [k]: v });
    }));
    // the organic tool's spec for the next building, and the sliders on a selected one (which grow it again)
    const readOrg = (i: HTMLInputElement | HTMLSelectElement): [keyof OrganicSpec, unknown] => {
      const input = i as HTMLInputElement;
      const k = (i.dataset.org ?? i.dataset.orgNext) as keyof OrganicSpec;
      return [k, input.type === 'checkbox' ? input.checked : input.type === 'range' || input.type === 'number' ? Number(input.value) : input.value];
    };
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-org-next]').forEach(i => {
      i.addEventListener('input', () => { const o = i.parentElement?.querySelector('output'); if (o && i instanceof HTMLInputElement && i.type === 'range') o.textContent = i.value; });
      i.addEventListener('change', () => { const [k, v] = readOrg(i); (e.organic as unknown as Record<string, unknown>)[k] = v; this.render(); });
    });
    this.root.querySelector<HTMLInputElement>('[data-org-name]')?.addEventListener('change', ev => { e.organicName = (ev.target as HTMLInputElement).value.trim(); });
    this.root.querySelector<HTMLInputElement>('[data-org-target]')?.addEventListener('change', ev => { const v = (ev.target as HTMLInputElement).value; e.organicTarget = v.trim() ? parseArea(v, e.units) ?? 0 : 0; this.render(); });
    const sizeIn = this.root.querySelector<HTMLInputElement>('[data-size-target]');
    sizeIn?.addEventListener('keydown', ev => { if (ev.key === 'Enter') this.act('resize'); });
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-org]').forEach(i => {
      i.addEventListener('input', () => { const o = i.parentElement?.querySelector('output'); if (o && i instanceof HTMLInputElement && i.type === 'range') o.textContent = i.value; });
      i.addEventListener('change', () => {
        const sel = e.selection;
        const name = sel?.kind === 'build' ? String(sel.feature.properties.structure ?? '') : '';
        if (!name) return;
        const [k, v] = readOrg(i);
        e.regenerateOrganic(name, { [k]: v } as Partial<OrganicSpec>);
      });
    });
    this.root.querySelectorAll<HTMLElement>('[data-opening]').forEach(b => b.addEventListener('click', () => {
      const s = e.selection;
      if (s?.kind === 'build') e.removeOpening(s.id, Number(b.dataset.opening));
    }));
    const height = this.root.querySelector<HTMLInputElement>('[data-height]');
    height?.addEventListener('change', () => { const s = e.selection; if (s?.kind === 'structure') e.setHeight(s.id, Number(height.value)); });
    const name = this.root.querySelector<HTMLInputElement>('[data-name]');
    name?.addEventListener('change', () => { const s = e.selection; if (s?.kind === 'structure') e.rename(s.id, name.value); });
    // brought in: the file picker, what a photo is of, and the sliders on a selected one
    const file = this.root.querySelector<HTMLInputElement>('[data-bring-file]');
    file?.addEventListener('change', () => { const f = file.files?.[0]; if (f) e.bring(f, f.name); });
    this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-photo]').forEach(i => i.addEventListener('change', () => {
      if (i.dataset.photo === 'kind') e.photo.kind = i.value === 'building' ? 'building' : 'object';
      else { const v = Number(i.value); e.photo.height = isFinite(v) && v > 0 ? v : 0; }
    }));
    this.root.querySelectorAll<HTMLElement>('[data-imp-sel]').forEach(b => b.addEventListener('click', () => e.selectImport(b.dataset.impSel!)));
    this.root.querySelectorAll<HTMLInputElement>('[data-imp]').forEach(i => {
      i.addEventListener('input', () => { const o = i.parentElement?.querySelector('output'); if (o && i.type === 'range') o.textContent = i.dataset.imp === 'turn' ? `${i.value}°` : `${Number(i.value).toFixed(2)} m`; });
      i.addEventListener('change', () => {
        const s = e.selection;
        if (s?.kind !== 'import') return;
        const k = i.dataset.imp!;
        if (k === 'flip') e.setImport(s.id, { flip: i.checked });
        else if (k === 'tidy') e.setImport(s.id, { tidy: i.checked });
        else if (k === 'name') e.setImport(s.id, { name: i.value.trim() || s.item.name });
        else if (k === 'height') { const h = Number(i.value); const nat = s.item.native?.[2] ?? 0; if (h > 0 && nat > 0.001) e.setImport(s.id, { scale: Math.round(h / nat * 1000) / 1000 }); }
        else { const v = Number(i.value); if (isFinite(v)) e.setImport(s.id, { [k]: v }); }
      });
    });
  }

  /** the bring-in tool: choose a file, then click where it goes */
  private bringForm(): string {
    const e = this.editor;
    const b = e.bringing;
    const svc = e.photoProviders;
    const waiting = b ? `<div class="ep-note">now click the ground where <b>${esc(b.name)}</b> goes${b.sort === 'photo' ? ' — the AI makes the model there' : ''} · Esc cancels</div>` : '';
    const photo = b?.sort === 'photo' || !b ? `<div class="ep-photo"><b>photo → 3D</b> ${svc === null ? '<small>asking the atlas…</small>' : svc.length ? `<small>by ${esc(svc.join(', '))} · about 30 credits each</small>` : '<small class="bad">the atlas has no 3D key yet — add MESHY_API_KEY to its settings</small>'}
        <label class="ep-inline">it is <select data-photo="kind"><option value="object" ${e.photo.kind === 'object' ? 'selected' : ''}>a thing</option><option value="building" ${e.photo.kind === 'building' ? 'selected' : ''}>a building</option></select></label>
        <label class="ep-inline">about <input data-photo="height" type="number" min="0" max="60" step="0.1" value="${e.photo.height || ''}" placeholder="auto"> m tall</label>
        <small>one clear photo of one thing, against a plain background if you can</small></div>` : '';
    const jobs = e.jobs.slice(-4).reverse().map(j => `<div class="ep-item ${j.stage === 'failed' ? 'bad' : ''}">${j.thumb ? `<img class="ep-thumb" src="${esc(j.thumb)}" alt="">` : ''}${esc(j.name)} · ${j.stage === 'making' ? `making ${j.progress}%` : j.stage === 'fetching' ? `fetching ${j.progress}%` : j.stage}${j.message ? ` — ${esc(j.message)}` : ''}</div>`).join('');
    const items = e.importItems();
    const list = items.length ? `<div class="ep-imports"><b>brought in</b> <small>kept in this browser</small>${items.slice(-8).reverse().map(i => `<button class="ep-item ep-link" data-imp-sel="${esc(i.id)}">${i.kind === 'splat' ? '🌀' : '🧊'} ${esc(i.name)} · ${megabytes(i.bytes)}</button>`).join('')}</div>` : '';
    return `<div class="ep-form">
      <label class="btn ep-file">📂 choose a file…<input data-bring-file type="file" accept="${ACCEPT}" hidden></label>
      <small>or drop it anywhere on the world · models .glb · scans .spz .ply .splat .ksplat .sog · photos .jpg .png</small>
      ${waiting}${photo}${jobs ? `<div class="ep-jobs">${jobs}</div>` : ''}${list}
    </div>`;
  }

  /** a model or a scan that was brought in: where and how it stands */
  private importCard(item: ImportItem): string {
    const e = this.editor;
    const can = this.o.caps().place;
    const dis = can ? '' : 'disabled';
    const h = e.importHeight(item);
    const scan = item.kind === 'splat';
    return `<div class="ep-sel"><label class="ep-inline">name <input data-imp="name" value="${esc(item.name)}" ${dis}></label> <small>${scan ? 'scan' : 'model'} · .${esc(item.ext)} · ${megabytes(item.bytes)}${item.source !== 'file' ? ` · by ${esc(item.source)}` : ''}</small>
      <div class="ep-dim">${esc(e.describeImport(item).split(' · ').slice(2).join(' · '))}</div>
      ${scan
        ? `<label class="ep-range">scale <input data-imp="scale" type="range" min="0.1" max="4" step="0.01" value="${item.scale}" ${dis}><output>${item.scale.toFixed(2)}</output></label>`
        : `<label class="ep-inline">height <input data-imp="height" type="number" min="0.05" max="200" step="0.1" value="${h.toFixed(2)}" ${dis}> m</label>`}
      <label class="ep-range">turn <input data-imp="turn" type="range" min="-180" max="180" step="1" value="${item.turn}" ${dis}><output>${item.turn}°</output></label>
      <label class="ep-range">lift <input data-imp="lift" type="range" min="-8" max="12" step="0.05" value="${item.lift}" ${dis}><output>${item.lift.toFixed(2)} m</output></label>
      ${scan ? `<label class="ep-check"><input data-imp="flip" type="checkbox" ${item.flip ? 'checked' : ''} ${dis}> stand it upright (most scans need this)</label>
      <label class="ep-check"><input data-imp="tidy" type="checkbox" ${item.tidy !== false ? 'checked' : ''} ${dis}> hide stray splats (sky, noise)</label>` : ''}
      ${can ? `<div class="ep-row"><button class="btn" data-act="imp-dl" title="save the file itself">⤓ file</button><button class="btn" data-act="remove">✕ remove</button></div>
      <div class="muted">drag it across the ground to move it · [ ] turn · + − lift${scan ? ' · a scan is picked by the ring at its middle' : ''}</div>` : ''}
    </div>`;
  }

  private tapeForm(): string {
    const e = this.editor;
    const list = e.tapes.map((t, i) => `<div class="ep-item">${i + 1}. ${esc(e.tapeText(t.a, t.b))}</div>`).join('');
    return `<div class="ep-form">
      ${e.tapeStart ? '<div class="ep-note">now click the other end · Esc drops it</div>' : ''}
      ${list || '<div class="muted">no tapes yet</div>'}
      ${e.tapes.length ? '<button class="btn" data-act="clear-tapes">clear tapes</button>' : ''}
      <small>ends pull onto the corners of walls and floors within 30 cm · the metres are true (WGS84), checked against the survey</small>
    </div>`;
  }

  /** a building's size: square footage the way an appraiser counts it, where it stands, and a way to make it a given size */
  private sizeCard(name: string, s: BuildingSize | null): string {
    const e = this.editor, u = e.units;
    if (!s) return '';
    const setback = e.setback(s.footprint);
    const can = this.o.caps().place;
    const lv = s.levels.length > 1 ? `<div class="ep-levels">${s.levels.map(l => `<div>${levelName(l.level, u)}: ${fmtArea(l.grossM2, u, false)}${l.counted ? '' : ' <small>(ceiling under 7 ft — not counted)</small>'}</div>`).join('')}</div>` : '';
    return `<div class="ep-size"><div class="ep-size-h">📐 <b>${esc(name)}</b></div>
      <div class="ep-big">${fmtArea(s.grossM2, u)}</div>
      <div>gross, to the outside of the walls${s.levels.some(l => l.from === 'walls') ? ` · ${fmtArea(s.netM2, u, false)} inside` : ''}</div>
      <div>${s.levels.length} level${s.levels.length === 1 ? '' : 's'} · footprint ${fmtArea(s.footprintM2, u, false)} · ${fmtLen(s.width, u, false)} × ${fmtLen(s.depth, u, false)}</div>
      ${lv}
      ${!setback ? '' : setback.inside ? `<div>${fmtLen(setback.d, u, false)} to the nearest property line</div>` : `<div class="ep-save bad">⚠ not inside the property line — ${fmtLen(setback.d, u, false)} from it</div>`}
      ${can ? `<label class="ep-inline">make it <input data-size-target placeholder="${Math.round(u === 'ft' ? s.grossM2 / (FT * FT) : s.grossM2)}"> ${u === 'ft' ? 'sq ft' : 'm²'} <button class="btn" data-act="resize">resize</button></label>` : ''}
      <div class="ep-row"><button class="btn gold" data-act="plan" title="the floor plan and the site plan, dimensioned (P)">📐 floor plan</button></div></div>`;
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

  private wallForm(): string {
    const w = this.editor.wall;
    return `<div class="ep-form">
      <label>height <input data-spec="wall.height" type="number" step="0.1" min="0.3" max="12" value="${w.height}"> m</label>
      <label>thick <input data-spec="wall.thick" type="number" step="0.05" min="0.05" max="1.5" value="${w.thick}"> m</label>
      <label>material <select data-spec="wall.material">${materialOptions(w.material)}</select></label>
      <label class="ep-check"><input data-spec="wall.smooth" type="checkbox" ${w.smooth ? 'checked' : ''}> curved — a smooth curve through the points</label>
      <label>base <input data-spec="wall.base" type="number" step="0.1" min="-5" max="30" value="${w.base}"> m above the ground</label>
      <label>part of <input data-spec="wall.structure" value="${esc(w.structure)}" placeholder="the main house"></label>
      <small>${(w.height / FT).toFixed(1)} ft high · points snap to the half metre and to the ends of other walls</small>
    </div>`;
  }

  private floorForm(): string {
    const f = this.editor.floor;
    return `<div class="ep-form">
      <label>level <input data-spec="floor.level" type="number" step="0.1" min="-5" max="30" value="${f.level}"> m above the ground</label>
      <label>thick <input data-spec="floor.thick" type="number" step="0.05" min="0.05" max="1" value="${f.thick}"> m</label>
      <label>material <select data-spec="floor.material">${materialOptions(f.material)}</select></label>
      <label>part of <input data-spec="floor.structure" value="${esc(f.structure)}" placeholder="the main house"></label>
      <small>you stand on it; a step of half a metre is taken in stride, more wants stairs</small>
    </div>`;
  }

  private roofForm(): string {
    const r = this.editor.roof;
    return `<div class="ep-form">
      <label>form <select data-spec="roof.form">${ROOF_FORMS.map(f => `<option value="${f}" ${f === r.form ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>eaves <input data-spec="roof.eaves" type="number" step="0.1" min="0.5" max="30" value="${r.eaves}"> m above the ground</label>
      ${r.form === 'flat' ? '' : `<label>pitch <input data-spec="roof.pitch" type="number" step="1" min="0" max="60" value="${r.pitch}">°</label>`}
      <label>overhang <input data-spec="roof.overhang" type="number" step="0.1" min="0" max="3" value="${r.overhang}"> m</label>
      <label>material <select data-spec="roof.material">${materialOptions(r.material)}</select></label>
      <label>part of <input data-spec="roof.structure" value="${esc(r.structure)}" placeholder="the main house"></label>
      <small>the ridge runs along the longest side; [ ] turns it once it is up</small>
    </div>`;
  }

  private openingForm(): string {
    const o = this.editor.opening;
    return `<div class="ep-form">
      <label>cut a <select data-spec="opening.kind"><option value="door" ${o.kind === 'door' ? 'selected' : ''}>door</option><option value="window" ${o.kind === 'window' ? 'selected' : ''}>window</option></select></label>
      <label>width <input data-spec="opening.width" type="number" step="0.1" min="0.3" max="10" value="${o.width}"> m</label>
      ${o.kind === 'window' ? `<label>sill <input data-spec="opening.sill" type="number" step="0.1" min="0.05" max="10" value="${o.sill}"> m</label>` : ''}
      <label>head <input data-spec="opening.head" type="number" step="0.1" min="0.5" max="12" value="${o.head}"> m</label>
      <small>click a wall where it goes · a door is walked through; a window is not</small>
    </div>`;
  }

  private organicForm(): string {
    const e = this.editor;
    return `<div class="ep-form">
      <label>name <input data-org-name value="${esc(e.organicName)}" placeholder="the oak leaf house"></label>
      <label>size <input data-org-target value="${e.organicTarget ? Math.round(e.units === 'ft' ? e.organicTarget / (FT * FT) : e.organicTarget) : ''}" placeholder="as drawn"> ${e.units === 'ft' ? 'sq ft' : 'm²'} gross</label>
      ${organicControls(e.organic, 'data-org-next')}
      ${e.lastOrganicWhy ? `<div class="ep-save bad">${esc(e.lastOrganicWhy)}</div>` : ''}
      <small>the whole building, eave included, stays inside the line you draw · select any part afterwards to reshape it with these same sliders</small>
    </div>`;
  }

  private markForm(): string {
    const m = this.editor.mark;
    return `<div class="ep-form">
      ${m ? `<div>marked ${Math.round(m.areaM2)} m² · ${m.selected.length} part${m.selected.length === 1 ? '' : 's'} inside <button class="btn" data-act="clear-mark">clear</button> <button class="btn gold" data-act="talk-mark">✦ talk</button></div>` : '<div class="muted">nothing marked yet</div>'}
      <small>mark empty ground and ask for a building, or mark walls and ask to change them</small>
    </div>`;
  }

  /** the card for a wall, a floor or a roof: its numbers, changed in place */
  private partCard(p: Pick & { kind: 'build' }): string {
    const f = p.feature, pr = f.properties;
    const kind = String(pr.kind);
    const can = this.o.caps().place;
    const dis = can ? '' : 'disabled';
    const head = `<div class="ep-sel"><b>${esc(this.editor.describeBuild(f))}</b>
      <label class="ep-inline">part of <input data-part="structure" value="${esc(pr.structure ?? '')}" placeholder="a name" ${dis}></label>`;
    let body = '';
    if (kind === 'wall') {
      const openings = (Array.isArray(pr.openings) ? pr.openings : []) as Opening[];
      body = `<label class="ep-inline">height <input data-part="height_m" type="number" step="0.1" min="0.3" max="12" value="${Number(pr.height_m || 2.7)}" ${dis}> m</label>
        <label class="ep-inline">thick <input data-part="thick_m" type="number" step="0.05" min="0.05" max="1.5" value="${Number(pr.thick_m || 0.25)}" ${dis}> m</label>
        <label class="ep-inline">base <input data-part="base_m" type="number" step="0.1" min="-5" max="30" value="${Number(pr.base_m || 0)}" ${dis}> m</label>
        <label class="ep-inline">material <select data-part="material" ${dis}>${materialOptions(String(pr.material || 'plaster'))}</select></label>
        <label class="ep-check"><input data-part="smooth" type="checkbox" ${pr.smooth ? 'checked' : ''} ${dis}> curved</label>
        ${openings.length ? `<div class="ep-openings">${openings.map((o, i) => `<div class="ep-item">${o.kind} at ${o.at_m} m · ${o.width_m} m wide${o.kind === 'window' ? ` · sill ${o.sill_m} m` : ''} · head ${o.head_m} m ${can ? `<button class="ep-x" data-opening="${i}" title="remove">×</button>` : ''}</div>`).join('')}</div>` : ''}
        <div class="muted">the door / window tool (O) cuts an opening where you click</div>`;
    } else if (kind === 'floor') {
      body = `<label class="ep-inline">level <input data-part="level_m" type="number" step="0.1" min="-5" max="30" value="${Number(pr.level_m || 0)}" ${dis}> m</label>
        <label class="ep-inline">thick <input data-part="thick_m" type="number" step="0.05" min="0.05" max="1" value="${Number(pr.thick_m || 0.2)}" ${dis}> m</label>
        <label class="ep-inline">material <select data-part="material" ${dis}>${materialOptions(String(pr.material || 'wood'))}</select></label>`;
    } else if (kind === 'roof') {
      body = `<label class="ep-inline">form <select data-part="form" ${dis}>${ROOF_FORMS.map(x => `<option value="${x}" ${x === String(pr.form || 'gable') ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
        <label class="ep-inline">eaves <input data-part="eaves_m" type="number" step="0.1" min="0.5" max="30" value="${Number(pr.eaves_m || 3)}" ${dis}> m</label>
        <label class="ep-inline">pitch <input data-part="pitch_deg" type="number" step="1" min="0" max="60" value="${Number(pr.pitch_deg ?? 25)}" ${dis}>°</label>
        <label class="ep-inline">overhang <input data-part="overhang_m" type="number" step="0.1" min="0" max="3" value="${Number(pr.overhang_m ?? 0.5)}" ${dis}> m</label>
        <label class="ep-inline">material <select data-part="material" ${dis}>${materialOptions(String(pr.material || 'tile'))}</select></label>`;
    }
    const org = pr.structure ? this.editor.organicOf(String(pr.structure)) : null;
    if (org) body += `<div class="ep-orghead">🌿 <b>${esc(pr.structure)}</b> — organic · reshape it:</div>${organicControls(org.spec, 'data-org', dis)}${quantities(this.editor.organicQuantities(String(pr.structure)))}${(() => { const n = this.editor.treesInside(String(pr.structure)); return n ? `<div class="ep-save bad">⚠ ${n} recorded tree${n === 1 ? '' : 's'} stand${n === 1 ? 's' : ''} inside this footprint. Coast live oaks are protected in Ventura County — move the building, or mark a tree gone only if it really can go.</div>` : ''; })()}`;
    const structure = pr.structure ? this.editor.buildParts(String(pr.structure)).length : 0;
    if (pr.structure) body += this.sizeCard(String(pr.structure), this.editor.buildingSize(String(pr.structure)));
    else if (kind === 'floor' || kind === 'wall') body += `<div class="ep-row"><button class="btn" data-act="plan" title="the plan of this part (P)">📐 plan</button></div><div class="muted">give it a name in "part of" to measure the whole building</div>`;
    const acts = can ? `<div class="ep-row"><button class="btn" data-act="rot-" title="turn 15° left ([)">↺ 15°</button><button class="btn" data-act="rot+" title="turn 15° right (])">↻ 15°</button><button class="btn" data-act="remove">✕ take down</button>${structure > 1 ? `<button class="btn" data-act="remove-structure" title="every part of ${esc(pr.structure)}">✕ all ${structure} parts</button>` : ''}</div>
      <div class="muted">drag it across the ground to move it · it snaps to the half metre</div>` : '';
    return `${head}${body}${acts}</div>`;
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
      case 'build':
        return this.partCard(p);
      case 'structure': {
        const s = p.structure;
        const d = this.editor.dimensions(s);
        const can = this.o.caps().place;
        const what = s.status === 'massing' ? 'block' : s.status === 'model' ? 'model' : 'reserved site';
        const size = s.status === 'model' ? '' : `${fmtLen(d.w, this.editor.units, false)} × ${fmtLen(d.d, this.editor.units, false)} · ${fmtArea(d.w * d.d, this.editor.units)}`;
        const pi = s.status === 'model' ? this.editor.planInput() : null;
        const rooms = pi?.size ? `<div class="ep-dim">≈ ${fmtArea(pi.size.grossM2, this.editor.units)} of rooms over ${pi.size.levels.length} level${pi.size.levels.length === 1 ? '' : 's'}</div>` : '';
        return `<div class="ep-sel"><label class="ep-inline">name <input data-name value="${esc(s.name)}" ${can ? '' : 'disabled'}></label> <small>${what} · ${esc(s.mode)}</small>
          ${size ? `<div class="ep-dim">${size}</div>` : ''}${rooms}
          <div class="ep-row"><button class="btn gold" data-act="plan" title="the floor plan and the site plan (P)">📐 plan</button></div>
          ${s.status === 'massing' ? `<label class="ep-inline">height <input data-height type="number" step="0.5" min="0.5" max="90" value="${d.h.toFixed(1)}" ${can ? '' : 'disabled'}> m</label>` : ''}
          ${can ? `<div class="ep-row"><button class="btn" data-act="rot-" title="turn 15° left ([)">↺ 15°</button><button class="btn" data-act="rot+" title="turn 15° right (])">↻ 15°</button>${s.status === 'model' ? `<button class="btn" data-act="up" title="raise 0.25 m (+)">▲</button><button class="btn" data-act="down" title="lower 0.25 m (−)">▼</button>` : ''}<button class="btn" data-act="remove">✕ remove</button></div>
          <div class="muted">drag it across the ground to move it · it snaps to the half metre</div>` : ''}</div>`;
      }
      case 'ground':
        return `<div class="ep-sel muted">ground · ${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}</div>`;
      case 'import':
        return this.importCard(p.item);
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
        : p.op === 'add' && p.layer === 'build' ? `${esc(p.kind)}${p.structure ? ` of ${esc(p.structure)}` : ''}${p.kind === 'wall' ? ` ${Number(p.height_m).toFixed(1)} m high` : ''}`
        : p.op === 'remove' && p.layer === 'build' ? `${esc(p.what ?? 'part')} taken down`
        : `${esc(p.op)} ${esc(p.layer)}`;
      items.push(`<div class="ep-item">${what}</div>`);
    }
    const more = e.unsaved - items.length;
    return items.join('') + (more > 0 ? `<div class="muted">… and ${more} more</div>` : '');
  }

  /** a room where you stand: one line of numbers, then it is there */
  private roomPrompt() {
    const e = this.editor;
    const r = e.room;
    const v = e.ask('A room where you stand — width × depth × height in metres, and a name:', `${r.w} x ${r.d} x ${r.h} ${r.name}`);
    if (!v) return;
    const m = /^\s*(\d+(?:\.\d+)?)\s*[x×by ]+\s*(\d+(?:\.\d+)?)\s*(?:[x×by ]+\s*(\d+(?:\.\d+)?))?\s*(.*)$/i.exec(v);
    if (!m) return;
    r.w = Number(m[1]); r.d = Number(m[2]); if (m[3]) r.h = Number(m[3]); if (m[4].trim()) r.name = m[4].trim();
    e.addRoomHere(r);
  }

  private act(a: string) {
    const e = this.editor;
    const s = e.selection;
    switch (a) {
      case 'close': e.setActive(false); break;
      case 'units': e.setUnits(e.units === 'ft' ? 'm' : 'ft'); break;
      case 'plan': this.o.openPlan?.(); break;
      case 'clear-tapes': e.clearTapes(); break;
      case 'resize': {
        const v = this.root.querySelector<HTMLInputElement>('[data-size-target]')?.value ?? '';
        const m2 = parseArea(v, e.units);
        const name = s?.kind === 'build' ? String(s.feature.properties.structure ?? '') : '';
        if (m2 && name) e.resizeBuilding(name, m2);
        break;
      }
      case 'undo': e.undo(); break;
      case 'grid': e.toggleGrid(); break;
      case 'download': e.download(); break;
      case 'gone': if (s?.kind === 'tree') e.markGone(s.tree); break;
      case 'talk': if (s?.kind === 'note' && s.magic) e.openMagic(s.id); break;
      case 'move': if (s?.kind === 'vision') e.beginMove(s.id, s.name); break;
      case 'remove': if (s) e.remove(s); break;
      case 'imp-dl': if (s?.kind === 'import') void e.downloadImport(s.id); break;
      case 'rot-': if (s?.kind === 'structure') e.rotateStructure(s.id, -15); else if (s?.kind === 'build') e.rotateBuild(s.id, -15); break;
      case 'rot+': if (s?.kind === 'structure') e.rotateStructure(s.id, 15); else if (s?.kind === 'build') e.rotateBuild(s.id, 15); break;
      case 'remove-structure': if (s?.kind === 'build' && s.feature.properties.structure) e.removeStructureParts(String(s.feature.properties.structure)); break;
      case 'room': this.roomPrompt(); break;
      case 'clear-mark': e.clearMark(); break;
      case 'talk-mark': e.openMagic('mark'); break;
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
