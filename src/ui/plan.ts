// The floor plan and the site plan: a building drawn the way an architect hands it over.
//
//   Walls cut at 1.2 m above the floor and filled black, doors with their swing, windows as the
//   three thin lines of a plan, the roof's edge dashed; every straight outside wall dimensioned,
//   the overall width and depth outside that, the square footage the way an appraiser counts it,
//   a north arrow and a scale bar. The site plan puts the same outline on the surveyed parcel and
//   dimensions the setback to the nearest property line.
//
//   It is drawn in the world's own true metres, north up, so it lays straight over any map of the
//   land. It downloads as SVG (for an architect's software) or PNG, and prints to PDF.

import { fmtLen, fmtArea, levelName, feetInches, metres, growRing, centroid, orientedBox, area, signedArea, offsetLine, type Units, type XZ, type BuildingSize } from '../edit/measure';

export interface PlanWall { centre: XZ[]; thick: number; closed: boolean; smooth: boolean; height: number; base: number; openings: { kind: 'door' | 'window'; at_m: number; width_m: number }[] }
export interface PlanFloor { ring: XZ[]; level: number; name?: string; interior: boolean }
export interface PlanSite {
  boundary: XZ[] | null;
  easements: XZ[][];
  others: { name: string; ring: XZ[] }[];
  trees: { x: number; z: number; r: number }[];
  parcel?: string;
}
export interface PlanInput {
  title: string;
  /** drawn here (walls and floors), or read off a model's floors */
  kind: 'drawn' | 'model' | 'block';
  walls: PlanWall[];
  /** a model's wall solids: rings with their base and top, metres above the building's lowest floor */
  cuts: { ring: XZ[]; base: number; top: number }[];
  floors: PlanFloor[];
  roofs: XZ[][];
  size: BuildingSize | null;
  site: PlanSite;
  setback: { d: number; from: XZ; to: XZ; inside: boolean } | null;
  centre: { lng: number; lat: number };
  survey: { lines: number; worstFt: number } | null;
  note?: string;
}

const INK = '#1d1d1b', PAPER = '#fbfaf6', FLOOR = '#efe9dc', GOLD = '#b8860b', DIM = '#2b5d8a', FAINT = '#9a968c';
const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const pts = (r: XZ[]) => r.map(p => `${p.x.toFixed(3)},${p.z.toFixed(3)}`).join(' ');

/** the part of a polyline between two distances along it */
function slice(line: XZ[], from: number, to: number): XZ[] {
  const out: XZ[] = [];
  let run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
    const s0 = run, s1 = run + l;
    if (s1 >= from && s0 <= to && l > 0) {
      const t0 = Math.max(0, (from - s0) / l), t1 = Math.min(1, (to - s0) / l);
      const p0 = { x: a.x + (b.x - a.x) * t0, z: a.z + (b.z - a.z) * t0 }, p1 = { x: a.x + (b.x - a.x) * t1, z: a.z + (b.z - a.z) * t1 };
      if (!out.length) out.push(p0);
      out.push(p1);
    }
    run = s1;
  }
  return out;
}
function lengthOf(line: XZ[]): number { let l = 0; for (let i = 0; i < line.length - 1; i++) l += Math.hypot(line[i + 1].x - line[i].x, line[i + 1].z - line[i].z); return l; }
function pointAt(line: XZ[], s: number): { p: XZ; t: XZ } {
  let run = 0;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i], b = line[i + 1], l = Math.hypot(b.x - a.x, b.z - a.z);
    if (run + l >= s || i === line.length - 2) { const k = l ? Math.min(1, Math.max(0, (s - run) / l)) : 0; return { p: { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k }, t: { x: (b.x - a.x) / (l || 1), z: (b.z - a.z) / (l || 1) } }; }
    run += l;
  }
  return { p: line[0], t: { x: 1, z: 0 } };
}

/** a scale bar length that reads well: 5, 10, 20, 50… ft or m, about a fifth of the drawing */
function niceBar(span: number, units: Units): { m: number; label: string } {
  const unit = units === 'ft' ? 0.3048 : 1;
  const want = span / 5 / unit;
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
  const n = steps.find(s => s >= want) ?? 1000;
  return { m: n * unit, label: units === 'ft' ? `${n} ft` : `${n} m` };
}

export class PlanView {
  private root: HTMLDivElement;
  private input: PlanInput | null = null;
  private tab: 'floor' | 'site' = 'floor';
  private level = 0;
  units: Units = 'ft';
  onUnits?: (u: Units) => void;

  constructor(container: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'plan-modal';
    this.root.hidden = true;
    container.appendChild(this.root);
    window.addEventListener('keydown', e => { if (e.key === 'Escape' && !this.root.hidden) this.close(); });
  }

  get isOpen(): boolean { return !this.root.hidden; }

  open(input: PlanInput, units: Units) {
    this.input = input;
    this.units = units;
    const lv = input.size?.levels ?? [];
    // open on the ground (or main) floor when there is one, else on the biggest level
    const main = lv.find(l => Math.abs(l.level) < 0.01) ?? lv.slice().sort((a, b) => b.grossM2 - a.grossM2)[0];
    this.level = main ? main.level : 0;
    this.tab = 'floor';
    this.root.hidden = false;
    this.render();
  }

  close() { this.root.hidden = true; }

  /** the drawing as an SVG string: the floor plan of the chosen level, or the site plan */
  svg(tab: 'floor' | 'site' = this.tab): string {
    const inp = this.input;
    if (!inp) return '';
    return tab === 'site' ? this.sitePlan(inp) : this.floorPlan(inp);
  }

  private render() {
    const inp = this.input!;
    const lv = inp.size?.levels ?? [];
    const levelButtons = lv.length > 1 ? `<div class="pl-levels">${lv.map(l => `<button class="btn${Math.abs(l.level - this.level) < 0.01 ? ' on' : ''}" data-pl-level="${l.level}">${levelName(l.level, this.units)}</button>`).join('')}</div>` : '';
    this.root.innerHTML = `<div class="pl-card">
      <div class="pl-head"><b>📐 ${esc(inp.title)}</b>
        <div class="pl-tabs"><button class="btn${this.tab === 'floor' ? ' on' : ''}" data-pl-tab="floor">floor plan</button><button class="btn${this.tab === 'site' ? ' on' : ''}" data-pl-tab="site" ${inp.site.boundary ? '' : 'disabled title="the pack has no surveyed line"'}>site plan</button></div>
        <button class="btn" data-pl-units>${this.units === 'ft' ? 'ft → m' : 'm → ft'}</button>
        <button class="ep-x" data-pl-close title="close (Esc)">×</button></div>
      ${levelButtons}
      <div class="pl-sheet">${this.svg()}</div>
      <div class="pl-foot">${this.summary(inp)}
        <div class="pl-acts"><button class="btn" data-pl-dl="svg">⤓ SVG</button><button class="btn" data-pl-dl="png">⤓ PNG</button><button class="btn" data-pl-print>🖨 print / PDF</button></div></div>
    </div>`;
    this.root.querySelector('[data-pl-close]')?.addEventListener('click', () => this.close());
    this.root.querySelectorAll<HTMLElement>('[data-pl-tab]').forEach(b => b.addEventListener('click', () => { this.tab = b.dataset.plTab as 'floor' | 'site'; this.render(); }));
    this.root.querySelectorAll<HTMLElement>('[data-pl-level]').forEach(b => b.addEventListener('click', () => { this.level = Number(b.dataset.plLevel); this.render(); }));
    this.root.querySelector('[data-pl-units]')?.addEventListener('click', () => { this.units = this.units === 'ft' ? 'm' : 'ft'; this.onUnits?.(this.units); this.render(); });
    this.root.querySelectorAll<HTMLElement>('[data-pl-dl]').forEach(b => b.addEventListener('click', () => void this.download(b.dataset.plDl as 'svg' | 'png')));
    this.root.querySelector('[data-pl-print]')?.addEventListener('click', () => this.print());
  }

  private summary(inp: PlanInput): string {
    const s = inp.size, u = this.units;
    if (!s || !s.levels.length) return `<div class="muted">nothing to measure yet</div>`;
    const rows = s.levels.map(l => `<tr><td>${levelName(l.level, u)}</td><td>${fmtArea(l.grossM2, u, false)}</td><td>${l.from === 'walls' ? fmtArea(l.netM2, u, false) : '—'}</td><td>${l.ceilingM != null ? fmtLen(l.ceilingM, u, false) : '—'}${l.counted ? '' : ' <small>(under 7 ft: not counted)</small>'}</td></tr>`).join('');
    const setback = !inp.setback ? '' : inp.setback.inside ? `<div>nearest property line: <b>${fmtLen(inp.setback.d, u)}</b></div>`
      : `<div class="pl-warn">⚠ not inside the property line — ${fmtLen(inp.setback.d, u, false)} from the nearest part of it</div>`;
    const survey = inp.survey ? `<div class="pl-true">✓ true to the ground: ${inp.survey.lines} surveyed boundary lines measure within ${inp.survey.worstFt.toFixed(2)} ft of the surveyor's figures</div>` : '';
    return `<div class="pl-sum"><div><b>${fmtArea(s.grossM2, u)}</b> gross${s.levels.some(l => l.from === 'walls') ? ` · <b>${fmtArea(s.netM2, u, false)}</b> inside the walls` : ''}</div>
      <div>${inp.kind === 'model' ? 'ground it clears' : 'footprint'} ${fmtArea(s.footprintM2, u, false)} · ${fmtLen(s.width, u, false)} × ${fmtLen(s.depth, u, false)}${inp.kind === 'model' ? '' : ' outside to outside'}</div>
      ${setback}
      ${s.levels.length > 1 || s.levels[0].ceilingM != null ? `<table class="pl-levels-t"><tr><th>level</th><th>gross</th><th>inside</th><th>ceiling</th></tr>${rows}</table>` : ''}
      <small>measured to ${esc(s.basis)}${inp.note ? ` · ${esc(inp.note)}` : ''}</small>${survey}</div>`;
  }

  // ---- the floor plan -------------------------------------------------------------------------------
  private floorPlan(inp: PlanInput): string {
    const u = this.units;
    const L = this.level;
    const cut = L + 1.2;
    const lv = inp.size?.levels.find(l => Math.abs(l.level - L) < 0.01) ?? inp.size?.levels[0] ?? null;
    const floors = inp.floors.filter(f => Math.abs(f.level - L) < 0.6 || inp.kind !== 'model');
    const walls = inp.walls.filter(w => w.base <= cut && w.base + w.height >= cut);
    const cuts = inp.cuts.filter(c => c.base <= cut && c.top >= cut);
    // the extent of everything drawn
    const all: XZ[] = [];
    for (const f of floors) all.push(...f.ring);
    for (const w of walls) all.push(...w.centre);
    for (const c of cuts) all.push(...c.ring);
    for (const r of inp.roofs) all.push(...r);
    if (lv) all.push(...lv.outline);
    if (!all.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4"><text x="5" y="2" font-size="0.5" text-anchor="middle">nothing to draw on this level</text></svg>`;
    let x0 = Math.min(...all.map(p => p.x)), x1 = Math.max(...all.map(p => p.x)), z0 = Math.min(...all.map(p => p.z)), z1 = Math.max(...all.map(p => p.z));
    const span = Math.max(x1 - x0, z1 - z0, 4);
    const fs = Math.max(0.3, span / 22);                   // text size in metres, so a figure reads at any size
    const pad = fs * 6.5;
    x0 -= pad; x1 += pad; z0 -= pad; z1 += pad + fs * 5.5;
    const W = x1 - x0, H = z1 - z0;
    const parts: string[] = [];
    // floors
    for (const f of floors) parts.push(`<polygon points="${pts(f.ring)}" fill="${f.interior ? FLOOR : '#f6f3ec'}" stroke="${FAINT}" stroke-width="${(fs * 0.06).toFixed(3)}"/>`);
    // roof edges, dashed
    for (const r of inp.roofs) parts.push(`<polygon points="${pts(r)}" fill="none" stroke="${FAINT}" stroke-width="${(fs * 0.07).toFixed(3)}" stroke-dasharray="${(fs * 0.6).toFixed(2)} ${(fs * 0.35).toFixed(2)}"/>`);
    // a model's walls, cut
    for (const c of cuts) parts.push(`<polygon points="${pts(c.ring)}" fill="${INK}"/>`);
    // drawn walls: solid between the openings, the openings drawn as a plan draws them
    for (const w of walls) parts.push(this.wallSvg(w, fs, lv?.outline ?? null));
    // dimensions round the outside
    if (lv && lv.outline.length >= 3) parts.push(this.dims(lv.outline, fs, u));
    // the area in the middle
    if (lv) {
      const c = centroid(lv.inner ?? lv.outline);
      parts.push(`<g font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="${INK}"><text x="${c.x.toFixed(2)}" y="${(c.z - fs * 0.3).toFixed(2)}" font-size="${(fs * 1.25).toFixed(2)}" font-weight="700">${esc(fmtArea(lv.grossM2, u, false).toUpperCase())}</text>
        <text x="${c.x.toFixed(2)}" y="${(c.z + fs * 1.1).toFixed(2)}" font-size="${(fs * 0.8).toFixed(2)}">${lv.from === 'walls' ? `GROSS · ${esc(fmtArea(lv.netM2, u, false).toUpperCase())} INSIDE` : lv.from === 'model' ? 'FLOOR AREA' : 'FLOOR'}</text></g>`);
    }
    parts.push(this.north(x1 - fs * 3.2, z0 + fs * 3.4, fs));
    parts.push(this.bar(x0 + fs * 1.5, z1 - fs * 4.4, W, fs, u));
    parts.push(this.titleBlock(inp, x0, x1, z1, fs, lv ? (lv.level === 0 ? (inp.kind === 'model' ? 'MAIN FLOOR' : 'GROUND FLOOR') : `LEVEL ${levelName(lv.level, this.units).toUpperCase()}`) : ''));
    return this.wrap(parts.join(''), x0, z0, W, H);
  }

  private wallSvg(w: PlanWall, fs: number, outer: XZ[] | null): string {
    const line = w.closed ? w.centre.concat([w.centre[0]]) : w.centre;
    const total = lengthOf(line);
    const gaps = w.openings.map(o => ({ ...o, a: o.at_m - o.width_m / 2, b: o.at_m + o.width_m / 2 })).filter(o => o.a >= 0 && o.b <= total + 1e-6).sort((p, q) => p.a - q.a);
    const out: string[] = [];
    let from = 0;
    const strip = (a: number, b: number) => {
      if (b - a < 0.01) return;
      const seg = slice(line, a, b);
      if (seg.length < 2) return;
      const L = offsetLine(seg, w.thick / 2, false), R = offsetLine(seg, -w.thick / 2, false);
      out.push(`<polygon points="${pts(L.concat(R.reverse()))}" fill="${INK}"/>`);
    };
    for (const g of gaps) { strip(from, g.a); from = g.b; }
    strip(from, total);
    const sw = (fs * 0.05).toFixed(3);
    const c = outer ? centroid(outer) : null;
    for (const g of gaps) {
      const a = pointAt(line, g.a), b = pointAt(line, g.b);
      const n = { x: a.t.z, z: -a.t.x };                         // the wall's left
      const h = w.thick / 2;
      if (g.kind === 'window') {
        for (const k of [-h, 0, h]) out.push(`<line x1="${(a.p.x + n.x * k).toFixed(3)}" y1="${(a.p.z + n.z * k).toFixed(3)}" x2="${(b.p.x + n.x * k).toFixed(3)}" y2="${(b.p.z + n.z * k).toFixed(3)}" stroke="${INK}" stroke-width="${sw}"/>`);
        for (const p of [a.p, b.p]) out.push(`<line x1="${(p.x - n.x * h).toFixed(3)}" y1="${(p.z - n.z * h).toFixed(3)}" x2="${(p.x + n.x * h).toFixed(3)}" y2="${(p.z + n.z * h).toFixed(3)}" stroke="${INK}" stroke-width="${sw}"/>`);
      } else {
        // the door swings into the room: toward the middle of the building when there is one
        let s = 1;
        if (c) { const mid = { x: (a.p.x + b.p.x) / 2, z: (a.p.z + b.p.z) / 2 }; s = (c.x - mid.x) * n.x + (c.z - mid.z) * n.z >= 0 ? 1 : -1; }
        const r = g.width_m;
        const hinge = { x: a.p.x + n.x * h * s, z: a.p.z + n.z * h * s };
        const leaf = { x: hinge.x + n.x * r * s, z: hinge.z + n.z * r * s };
        const shut = { x: b.p.x + n.x * h * s, z: b.p.z + n.z * h * s };
        const sweep = (a.t.x * (n.z * s) - a.t.z * (n.x * s)) > 0 ? 1 : 0;
        out.push(`<line x1="${hinge.x.toFixed(3)}" y1="${hinge.z.toFixed(3)}" x2="${leaf.x.toFixed(3)}" y2="${leaf.z.toFixed(3)}" stroke="${INK}" stroke-width="${(fs * 0.08).toFixed(3)}"/>`);
        out.push(`<path d="M${leaf.x.toFixed(3)} ${leaf.z.toFixed(3)} A${r.toFixed(3)} ${r.toFixed(3)} 0 0 ${1 - sweep} ${shut.x.toFixed(3)} ${shut.z.toFixed(3)}" fill="none" stroke="${INK}" stroke-width="${sw}" stroke-dasharray="${(fs * 0.25).toFixed(2)} ${(fs * 0.15).toFixed(2)}"/>`);
      }
    }
    return out.join('');
  }

  /** a dimension: extension lines, the line itself with slashes at the ends, the figure over it */
  private dim(a: XZ, b: XZ, out: XZ, off: number, text: string, fs: number): string {
    const A = { x: a.x + out.x * off, z: a.z + out.z * off }, B = { x: b.x + out.x * off, z: b.z + out.z * off };
    const gap = fs * 0.3, over = fs * 0.35;
    const sw = (fs * 0.045).toFixed(3);
    const ext = (p: XZ, q: XZ) => `<line x1="${(p.x + out.x * gap).toFixed(3)}" y1="${(p.z + out.z * gap).toFixed(3)}" x2="${(q.x + out.x * over).toFixed(3)}" y2="${(q.z + out.z * over).toFixed(3)}" stroke="${DIM}" stroke-width="${sw}"/>`;
    const d = { x: B.x - A.x, z: B.z - A.z }, l = Math.hypot(d.x, d.z) || 1;
    const t = { x: d.x / l, z: d.z / l };
    const tick = (p: XZ) => { const k = fs * 0.35; return `<line x1="${(p.x - (t.x + out.x) * k).toFixed(3)}" y1="${(p.z - (t.z + out.z) * k).toFixed(3)}" x2="${(p.x + (t.x + out.x) * k).toFixed(3)}" y2="${(p.z + (t.z + out.z) * k).toFixed(3)}" stroke="${DIM}" stroke-width="${(fs * 0.08).toFixed(3)}"/>`; };
    let ang = Math.atan2(d.z, d.x) * 180 / Math.PI;
    if (ang > 90.01) ang -= 180; else if (ang < -89.99) ang += 180;
    const mid = { x: (A.x + B.x) / 2 + out.x * fs * 0.45, z: (A.z + B.z) / 2 + out.z * fs * 0.45 };
    return `${ext(a, A)}${ext(b, B)}<line x1="${A.x.toFixed(3)}" y1="${A.z.toFixed(3)}" x2="${B.x.toFixed(3)}" y2="${B.z.toFixed(3)}" stroke="${DIM}" stroke-width="${sw}"/>${tick(A)}${tick(B)}
      <text x="${mid.x.toFixed(3)}" y="${mid.z.toFixed(3)}" font-size="${(fs * 0.78).toFixed(3)}" font-family="Helvetica, Arial, sans-serif" fill="${DIM}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${ang.toFixed(2)} ${mid.x.toFixed(3)} ${mid.z.toFixed(3)})">${esc(text)}</text>`;
  }

  /** every straight outside edge, then the overall width and depth outside those */
  private dims(outline: XZ[], fs: number, u: Units): string {
    const out: string[] = [];
    const ring = outline;
    const sgn = signedArea(ring) > 0 ? 1 : -1;
    const straight = ring.length <= 48;
    if (straight) {
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        const l = Math.hypot(b.x - a.x, b.z - a.z);
        if (l < Math.max(0.6, fs * 1.6)) continue;
        const n = { x: sgn * (b.z - a.z) / l, z: sgn * -(b.x - a.x) / l };
        out.push(this.dim(a, b, n, fs * 2.2, fmtLen(l, u, false), fs));
      }
    }
    // overall, turned to the building
    const box = orientedBox(ring);
    const P = (a: number, b: number) => ({ x: box.u.x * a + box.v.x * b, z: box.u.z * a + box.v.z * b });
    const [a0, b0] = box.min, [a1, b1] = box.max;
    const off = fs * (straight ? 4.6 : 2.4);
    // width along u, drawn beyond the v-min side; depth along v, beyond the u-max side
    out.push(this.dim(P(a0, b0), P(a1, b0), { x: -box.v.x, z: -box.v.z }, off, `${fmtLen(box.w, u, false)} overall`, fs));
    out.push(this.dim(P(a1, b0), P(a1, b1), { x: box.u.x, z: box.u.z }, off, `${fmtLen(box.d, u, false)} overall`, fs));
    return out.join('');
  }

  // ---- the site plan ----------------------------------------------------------------------------------
  private sitePlan(inp: PlanInput): string {
    const u = this.units;
    const site = inp.site;
    const b = site.boundary;
    const lv = inp.size?.levels[0] ?? null;
    const all: XZ[] = [...(b ?? []), ...(lv?.outline ?? [])];
    if (!all.length) return '';
    let x0 = Math.min(...all.map(p => p.x)), x1 = Math.max(...all.map(p => p.x)), z0 = Math.min(...all.map(p => p.z)), z1 = Math.max(...all.map(p => p.z));
    const span = Math.max(x1 - x0, z1 - z0, 10);
    const fs = span / 42;
    const pad = fs * 5;
    x0 -= pad; x1 += pad; z0 -= pad; z1 += pad + fs * 5.5;
    const W = x1 - x0, H = z1 - z0;
    const parts: string[] = [];
    const clip = (p: XZ) => p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1;
    for (const t of site.trees) if (clip(t)) parts.push(`<circle cx="${t.x.toFixed(2)}" cy="${t.z.toFixed(2)}" r="${Math.max(0.8, t.r).toFixed(2)}" fill="#9fbf8a" fill-opacity="0.3" stroke="#6f8f5a" stroke-width="${(fs * 0.04).toFixed(3)}"/>`);
    for (const e of site.easements) parts.push(`<polygon points="${pts(e)}" fill="#d9cfb8" fill-opacity="0.35" stroke="${FAINT}" stroke-width="${(fs * 0.06).toFixed(3)}" stroke-dasharray="${(fs * 0.5).toFixed(2)} ${(fs * 0.3).toFixed(2)}"/>`);
    for (const o of site.others) {
      if (o.ring.length < 3 || !o.ring.some(clip)) continue;
      // grounds and paths that cover half the parcel are an outline, not a building
      const big = area(o.ring) > 2000;
      parts.push(`<polygon points="${pts(o.ring)}" fill="${big ? 'none' : '#d8d4ca'}" stroke="${FAINT}" stroke-width="${(fs * (big ? 0.03 : 0.05)).toFixed(3)}"${big ? ` stroke-dasharray="${(fs * 0.3).toFixed(2)} ${(fs * 0.3).toFixed(2)}"` : ''}/>`);
      const c = centroid(o.ring);
      if (area(o.ring) > span * span / 4000) parts.push(`<text x="${c.x.toFixed(2)}" y="${c.z.toFixed(2)}" font-size="${(fs * 0.6).toFixed(2)}" font-family="Helvetica, Arial, sans-serif" fill="#77736a" text-anchor="middle">${esc(o.name)}</text>`);
    }
    if (b) {
      parts.push(`<polygon points="${pts(b)}" fill="none" stroke="${INK}" stroke-width="${(fs * 0.14).toFixed(3)}" stroke-dasharray="${(fs * 1.4).toFixed(2)} ${(fs * 0.35).toFixed(2)} ${(fs * 0.2).toFixed(2)} ${(fs * 0.35).toFixed(2)}"/>`);
      const sgn = signedArea(b) > 0 ? 1 : -1;
      for (let i = 0; i < b.length; i++) {
        const p = b[i], q = b[(i + 1) % b.length], l = Math.hypot(q.x - p.x, q.z - p.z);
        if (l < span / 25) continue;
        const n = { x: sgn * (q.z - p.z) / l, z: sgn * -(q.x - p.x) / l };
        const m = { x: (p.x + q.x) / 2 + n.x * fs * 0.9, z: (p.z + q.z) / 2 + n.z * fs * 0.9 };
        let ang = Math.atan2(q.z - p.z, q.x - p.x) * 180 / Math.PI;
        if (ang > 90.01) ang -= 180; else if (ang < -89.99) ang += 180;
        parts.push(`<text x="${m.x.toFixed(2)}" y="${m.z.toFixed(2)}" font-size="${(fs * 0.62).toFixed(2)}" font-family="Helvetica, Arial, sans-serif" fill="${INK}" text-anchor="middle" dominant-baseline="middle" transform="rotate(${ang.toFixed(2)} ${m.x.toFixed(2)} ${m.z.toFixed(2)})">${esc(fmtLen(l, u, false))}</text>`);
      }
    }
    if (lv) {
      parts.push(`<polygon points="${pts(lv.outline)}" fill="${GOLD}" fill-opacity="0.85" stroke="${INK}" stroke-width="${(fs * 0.08).toFixed(3)}"/>`);
      const c = centroid(lv.outline);
      parts.push(`<text x="${c.x.toFixed(2)}" y="${(c.z - Math.sqrt(area(lv.outline)) / 2 - fs * 0.8).toFixed(2)}" font-size="${(fs * 0.9).toFixed(2)}" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="${INK}" text-anchor="middle">${esc(inp.title)} · ${esc(fmtArea(inp.size!.footprintM2, u, false))} footprint</text>`);
    }
    if (inp.setback) {
      const s = inp.setback;
      const d = { x: s.to.x - s.from.x, z: s.to.z - s.from.z }, l = Math.hypot(d.x, d.z) || 1;
      const n = { x: d.z / l, z: -d.x / l };
      parts.push(this.dim(s.from, s.to, n, 0, '', fs));
      const m = { x: (s.from.x + s.to.x) / 2 + n.x * fs * 0.9, z: (s.from.z + s.to.z) / 2 + n.z * fs * 0.9 };
      parts.push(`<text x="${m.x.toFixed(2)}" y="${m.z.toFixed(2)}" font-size="${(fs * 0.8).toFixed(2)}" font-weight="700" font-family="Helvetica, Arial, sans-serif" fill="${s.inside ? DIM : '#b3261e'}" text-anchor="middle" dominant-baseline="middle">${s.inside ? 'setback' : 'OUTSIDE THE LINE by'} ${esc(fmtLen(s.d, u, false))}</text>`);
    }
    parts.push(this.north(x1 - fs * 3.2, z0 + fs * 3.4, fs));
    parts.push(this.bar(x0 + fs * 1.5, z1 - fs * 4.4, W, fs, u));
    parts.push(this.titleBlock(inp, x0, x1, z1, fs, `SITE PLAN${site.parcel ? ` · ${site.parcel}` : ''}`));
    return this.wrap(parts.join(''), x0, z0, W, H);
  }

  // ---- the furniture of a sheet -------------------------------------------------------------------------
  private north(x: number, z: number, fs: number): string {
    const r = fs * 1.8;
    return `<g><circle cx="${x.toFixed(2)}" cy="${z.toFixed(2)}" r="${r.toFixed(2)}" fill="none" stroke="${INK}" stroke-width="${(fs * 0.06).toFixed(3)}"/>
      <path d="M${x.toFixed(2)} ${(z - r * 0.85).toFixed(2)} L${(x + r * 0.35).toFixed(2)} ${(z + r * 0.5).toFixed(2)} L${x.toFixed(2)} ${(z + r * 0.2).toFixed(2)} Z" fill="${INK}"/>
      <text x="${x.toFixed(2)}" y="${(z - r * 1.15).toFixed(2)}" font-size="${(fs * 0.8).toFixed(2)}" font-weight="700" font-family="Helvetica, Arial, sans-serif" text-anchor="middle" fill="${INK}">N</text></g>`;
  }

  private bar(x: number, z: number, span: number, fs: number, u: Units): string {
    const b = niceBar(span, u);
    const h = fs * 0.35;
    const half = b.m / 2;
    return `<g font-family="Helvetica, Arial, sans-serif" fill="${INK}"><rect x="${x.toFixed(2)}" y="${z.toFixed(2)}" width="${half.toFixed(3)}" height="${h.toFixed(3)}" fill="${INK}"/>
      <rect x="${(x + half).toFixed(2)}" y="${z.toFixed(2)}" width="${half.toFixed(3)}" height="${h.toFixed(3)}" fill="none" stroke="${INK}" stroke-width="${(fs * 0.04).toFixed(3)}"/>
      <text x="${x.toFixed(2)}" y="${(z - fs * 0.35).toFixed(2)}" font-size="${(fs * 0.6).toFixed(2)}">0</text>
      <text x="${(x + b.m).toFixed(2)}" y="${(z - fs * 0.35).toFixed(2)}" font-size="${(fs * 0.6).toFixed(2)}" text-anchor="middle">${b.label}</text></g>`;
  }

  private titleBlock(inp: PlanInput, x0: number, x1: number, z1: number, fs: number, sheet: string): string {
    const truth = inp.survey ? `true to the ground: ${inp.survey.lines} survey lines within ${inp.survey.worstFt.toFixed(2)} ft` : 'true metres, WGS84';
    const y1 = z1 - fs * 2.1, y2 = z1 - fs * 1.0;
    return `<g font-family="Helvetica, Arial, sans-serif" fill="${INK}"><line x1="${x0.toFixed(2)}" y1="${(y1 - fs * 1.1).toFixed(2)}" x2="${x1.toFixed(2)}" y2="${(y1 - fs * 1.1).toFixed(2)}" stroke="${FAINT}" stroke-width="${(fs * 0.03).toFixed(3)}"/>
      <text x="${(x0 + fs * 1.5).toFixed(2)}" y="${y1.toFixed(2)}" font-size="${(fs * 0.72).toFixed(2)}" font-weight="700">${esc(inp.title.toUpperCase())} — ${esc(sheet)}</text>
      <text x="${(x0 + fs * 1.5).toFixed(2)}" y="${y2.toFixed(2)}" font-size="${(fs * 0.5).toFixed(2)}" fill="#5f5b52">${inp.centre.lat.toFixed(6)}, ${inp.centre.lng.toFixed(6)} · north up · ${esc(truth)} · ${new Date().toISOString().slice(0, 10)}</text></g>`;
  }

  private wrap(body: string, x0: number, z0: number, W: number, H: number): string {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x0.toFixed(3)} ${z0.toFixed(3)} ${W.toFixed(3)} ${H.toFixed(3)}" preserveAspectRatio="xMidYMid meet"><rect x="${x0.toFixed(3)}" y="${z0.toFixed(3)}" width="${W.toFixed(3)}" height="${H.toFixed(3)}" fill="${PAPER}"/>${body}</svg>`;
  }

  // ---- out of the world ---------------------------------------------------------------------------------
  private fileName(ext: string): string {
    const n = (this.input?.title || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
    return `${n}-${this.tab === 'site' ? 'site-plan' : 'floor-plan'}.${ext}`;
  }

  async download(kind: 'svg' | 'png') {
    const svg = this.svg();
    let blob: Blob = new Blob([svg], { type: 'image/svg+xml' });
    if (kind === 'png') {
      const url = URL.createObjectURL(blob);
      try {
        const img = new Image();
        await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(new Error('the plan could not be drawn')); img.src = url; });
        const vb = /viewBox="([^"]+)"/.exec(svg)![1].split(' ').map(Number);
        const w = 2400, h = Math.round(w * vb[3] / vb[2]);
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        const g = c.getContext('2d')!;
        g.fillStyle = PAPER; g.fillRect(0, 0, w, h);
        g.drawImage(img, 0, 0, w, h);
        blob = await new Promise<Blob>((res) => c.toBlob(b => res(b!), 'image/png'));
      } finally { URL.revokeObjectURL(url); }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = this.fileName(kind);
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  print() {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0';
    document.body.appendChild(f);
    const d = f.contentDocument!;
    d.open();
    d.write(`<!doctype html><title>${esc(this.fileName('pdf'))}</title><style>@page{size:landscape;margin:12mm}html,body{margin:0}svg{width:100%;height:auto}</style>${this.svg()}`);
    d.close();
    setTimeout(() => { try { f.contentWindow?.focus(); f.contentWindow?.print(); } finally { setTimeout(() => f.remove(), 2000); } }, 250);
  }
}

/** a length both ways, for places that must show both */
export const bothWays = (m: number) => `${feetInches(m)} (${metres(m)})`;
/** grow or shrink an outline, re-exported for the editor */
export { growRing };
