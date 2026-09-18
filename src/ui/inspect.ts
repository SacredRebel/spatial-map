// What a member does with a click: reads.
//
//   Walk up to a post and click it, and a card says what is planned there; click a building and
//   it says what the record knows; click a marker, a fence, a block. No tool, no mode — it is the
//   world answering the question "what is this?", which is the whole of interaction until there
//   is more to do here than look.

import type { Editor, Pick } from '../edit/editor';
import type { PackData } from '../world/pack';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const FT = 0.3048;

export class Inspect {
  root: HTMLElement;
  private downAt: { x: number; y: number; t: number } | null = null;

  constructor(container: HTMLElement, dom: HTMLElement, private editor: Editor, private pack: () => PackData | null) {
    this.root = document.createElement('div');
    this.root.className = 'inspect';
    this.root.hidden = true;
    container.appendChild(this.root);
    // a click that did not drag: the look-around uses the same button
    dom.addEventListener('pointerdown', e => { if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    dom.addEventListener('pointerup', e => {
      const d = this.downAt; this.downAt = null;
      if (!d || e.button !== 0 || editor.active) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 6 || performance.now() - d.t > 400) return;
      this.show(editor.pick(e.clientX, e.clientY));
    });
    window.addEventListener('keydown', e => { if (e.key === 'Escape') this.hide(); });
  }

  hide() { this.root.hidden = true; }

  show(p: Pick | null) {
    if (!p || p.kind === 'ground') { this.hide(); return; }
    this.root.innerHTML = `<button class="ep-x" data-close title="close (Esc)">×</button>${this.card(p)}`;
    this.root.querySelector('[data-close]')?.addEventListener('click', () => this.hide());
    this.root.hidden = false;
  }

  private card(p: Pick): string {
    const pack = this.pack();
    switch (p.kind) {
      case 'vision': {
        const f = pack?.visionNow.features.find(x => String(x.properties.id) === p.id);
        const pr = f?.properties ?? {};
        const mode = pr.mode === 'both' ? 'standing today, and part of the vision' : pr.mode === 'current' ? 'standing today' : 'planned';
        return `<b>${esc(p.name)}</b><span class="in-kind">${esc(pr.type ?? 'project')} · ${mode}${pr.moved ? ' · moved by the owner' : ''}</span>${pr.note ? `<p>${esc(pr.note)}</p>` : ''}${pr.placeholder ? `<small>a post stands in for the building until its model arrives</small>` : ''}`;
      }
      case 'building': {
        // the mesh is named by the lidar's kind; find the footprint or roof that carries it
        const slug = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const foot = pack?.county.features.find(x => x.properties.layer === 'footprint' && slug((x.properties.lidar_2018 as { kind?: string } | undefined)?.kind || 'building') === p.name);
        const roof = foot ? null : pack?.roofs.features.find(x => slug(x.properties.kind || 'building') === p.name);
        const lidar = (foot?.properties.lidar_2018 as { roof_p50_m?: number; roof_m?: number; area_m2?: number } | undefined) ?? (roof ? { roof_m: Number(roof.properties.roof_m), area_m2: Number(roof.properties.area_m2) } : undefined);
        const h = lidar?.roof_p50_m ?? lidar?.roof_m;
        const name = p.name.replace(/-/g, ' ');
        return `<b>${esc(name)}</b><span class="in-kind">standing · ${foot ? 'county footprint' : 'lidar roof, no county footprint'}${h ? ` · roof ${Number(h).toFixed(1)} m` : ''}${lidar?.area_m2 ? ` · ${Math.round(Number(lidar.area_m2))} m²` : ''}</span>`;
      }
      case 'structure': {
        const s = p.structure;
        const d = this.editor.dimensions(s);
        const what = s.status === 'massing' ? 'a block, to judge the size' : s.status === 'model' ? 'a designed building' : 'ground reserved';
        return `<b>${esc(s.name)}</b><span class="in-kind">${what} · ${esc(s.mode)}</span>${d.w ? `<p>${d.w.toFixed(1)} × ${d.d.toFixed(1)} m (${Math.round(d.w / FT)} × ${Math.round(d.d / FT)} ft)${d.h ? `, ${d.h.toFixed(1)} m high` : ''}</p>` : ''}${s.note ? `<p>${esc(s.note)}</p>` : ''}`;
      }
      case 'note': return `<b>${esc(p.name)}</b><span class="in-kind">${p.magic ? 'magic box · a place to create from — builders and admins talk to it' : 'marker'}</span>`;
      case 'line': {
        const f = pack?.lines.features.find(x => String(x.properties.id) === p.id);
        return `<b>${esc(f?.properties.name ?? p.id)}</b><span class="in-kind">${esc(f?.properties.kind ?? 'line')}</span>`;
      }
      case 'tree': return `<b>oak</b><span class="in-kind">${p.tree.height.toFixed(1)} m tall · crown ${p.tree.crown.toFixed(1)} m · from the 2018 lidar</span>`;
      case 'build': {
        const pr = p.feature.properties;
        const parts = pr.structure ? this.editor.buildParts(String(pr.structure)).length : 0;
        return `<b>${esc(pr.structure ? `${pr.structure} · ${pr.kind}` : pr.kind)}</b><span class="in-kind">${esc(this.editor.describeBuild(p.feature))}${parts > 1 ? ` · one of ${parts} parts` : ''} · built by the owner${pr.reported ? `, ${esc(pr.reported)}` : ''}</span>`;
      }
      case 'zone': return `<b>${esc(p.name)}</b><span class="in-kind">territory</span>`;
      default: return '';
    }
  }
}
