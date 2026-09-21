// What things are made of, and what that looks like.
//
//   Every wall, floor and roof used to be one flat colour — a cob wall and a plaster wall differed
//   by a hex code, and a steel roof with solar on it was a grey slab. That is the diagram look: the
//   eye reads colour-without-texture as "not built yet". So each material now carries a surface —
//   painted once, procedurally, into a small tiling canvas when it is first used — and a relief the
//   light can catch: the lumps of hand-built cob, the flecks of hemp shiv in hempcrete, the strata
//   of rammed earth, the seams of a standing-seam roof, the cells of a solar panel.
//
//   Procedural, not photographs, on purpose: nothing to download, nothing to license, the same on
//   every machine, and each one a few milliseconds to paint the first time it is asked for.
//   Everything is PBR (MeshStandardMaterial), so a sky pre-filtered into an environment map lights
//   it the way the sky lights a real wall — warm at dusk, blue in the shade.
//
//   Units: every texture covers `metres` of surface. Wall UVs are (distance along, height) in metres
//   and floor/roof UVs are plan metres, so a cob wall's lumps are the size of a hand everywhere.

import * as THREE from 'three';

export interface Surface {
  /** the base colour, also used where a texture cannot be (a list swatch, a far LOD) */
  colour: string;
  /** how many metres one repeat of the texture covers */
  metres: number;
  roughness: number;
  metalness?: number;
  /** how strongly the relief shows */
  bump?: number;
  glass?: boolean;
  /** paints albedo into `c` and height into `h`, both size×size, tiling */
  paint?: (c: Painter, h: Painter, size: number) => void;
  /** what it is, in a few words — the panel and the agent read this */
  what: string;
  /** walls, roofs, floors: where this material normally goes */
  use: ('wall' | 'roof' | 'floor' | 'ground')[];
}

// ---- a tiny painter over ImageData ---------------------------------------------------------------

export class Painter {
  data: Float32Array;          // rgb in 0..1, or a single channel repeated
  constructor(public size: number) { this.data = new Float32Array(size * size * 3); }
  fill(r: number, g: number, b: number) { for (let i = 0; i < this.data.length; i += 3) { this.data[i] = r; this.data[i + 1] = g; this.data[i + 2] = b; } }
  /** call f for every pixel with its coordinate in 0..1 and write what it returns */
  each(f: (u: number, v: number, x: number, y: number, rgb: [number, number, number]) => void) {
    const s = this.size, px: [number, number, number] = [0, 0, 0];
    for (let y = 0; y < s; y++) for (let x = 0; x < s; x++) {
      const i = (y * s + x) * 3;
      px[0] = this.data[i]; px[1] = this.data[i + 1]; px[2] = this.data[i + 2];
      f(x / s, y / s, x, y, px);
      this.data[i] = px[0]; this.data[i + 1] = px[1]; this.data[i + 2] = px[2];
    }
  }
  /** a filled rectangle in pixel space, wrapping round the edges so the texture still tiles */
  rect(x0: number, y0: number, w: number, h: number, r: number, g: number, b: number, a = 1) {
    const s = this.size;
    for (let y = Math.floor(y0); y < y0 + h; y++) for (let x = Math.floor(x0); x < x0 + w; x++) {
      const i = ((((y % s) + s) % s) * s + (((x % s) + s) % s)) * 3;
      this.data[i] += (r - this.data[i]) * a; this.data[i + 1] += (g - this.data[i + 1]) * a; this.data[i + 2] += (b - this.data[i + 2]) * a;
    }
  }
  /** a filled ellipse (a pebble), wrapping round the edges; `a` is its opacity */
  ellipse(cx: number, cy: number, rx: number, ry: number, r: number, g: number, b: number, a = 1, shade = 0) {
    const s = this.size;
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry, d = dx * dx + dy * dy;
      if (d > 1) continue;
      // lit from the top left, rounded: brighter on one shoulder, darker on the other
      const k = 1 + shade * (-(dx + dy) * 0.35 - d * 0.25);
      const i = ((((y % s) + s) % s) * s + (((x % s) + s) % s)) * 3;
      this.data[i] += (r * k - this.data[i]) * a; this.data[i + 1] += (g * k - this.data[i + 1]) * a; this.data[i + 2] += (b * k - this.data[i + 2]) * a;
    }
  }
  toCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = c.height = this.size;
    const g = c.getContext('2d')!;
    const im = g.createImageData(this.size, this.size);
    for (let i = 0, j = 0; i < this.data.length; i += 3, j += 4) {
      im.data[j] = Math.max(0, Math.min(255, this.data[i] * 255));
      im.data[j + 1] = Math.max(0, Math.min(255, this.data[i + 1] * 255));
      im.data[j + 2] = Math.max(0, Math.min(255, this.data[i + 2] * 255));
      im.data[j + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    return c;
  }
}

// ---- tileable noise ---------------------------------------------------------------------------------

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const fade = (t: number) => t * t * (3 - 2 * t);
/** value noise that wraps every `period` cells, so a texture made of it tiles */
export function vnoise(u: number, v: number, period: number, seed = 0): number {
  const x = u * period, y = v * period;
  const xi = Math.floor(x), yi = Math.floor(y);
  const fx = fade(x - xi), fy = fade(y - yi);
  const w = (a: number) => ((a % period) + period) % period;
  const a = hash(w(xi), w(yi), seed), b = hash(w(xi + 1), w(yi), seed);
  const c = hash(w(xi), w(yi + 1), seed), d = hash(w(xi + 1), w(yi + 1), seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(u: number, v: number, period: number, octaves = 4, seed = 0): number {
  let s = 0, amp = 0.5, p = period, norm = 0;
  for (let o = 0; o < octaves; o++) { s += amp * vnoise(u, v, p, seed + o * 17); norm += amp; amp *= 0.5; p *= 2; }
  return s / norm;
}
/** a #rrggbb colour as sRGB numbers in 0..1 — the canvas holds sRGB, so no conversion to linear here */
const hex = (h: string): [number, number, number] => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const lerp3 = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** the basic earthen surface: a colour mottled at two scales, with a relief of lumps */
function mottled(base: string, dark: string, light: string, lumpPeriod: number, amount: number, seed: number) {
  const B = hex(base), D = hex(dark), L = hex(light);
  return (c: Painter, h: Painter) => {
    c.each((u, v, _x, _y, px) => {
      const m = fbm(u, v, 3, 4, seed), f = fbm(u, v, 24, 3, seed + 5);
      let col = m < 0.5 ? lerp3(D, B, m * 2) : lerp3(B, L, (m - 0.5) * 2);
      col = lerp3(B, col, amount);
      const k = 0.92 + 0.16 * f;
      px[0] = col[0] * k; px[1] = col[1] * k; px[2] = col[2] * k;
    });
    h.each((u, v, _x, _y, px) => { const t = 0.6 * fbm(u, v, lumpPeriod, 4, seed + 9) + 0.4 * fbm(u, v, lumpPeriod * 6, 2, seed + 11); px[0] = px[1] = px[2] = t; });
  };
}

/** short fibres scattered over a surface — straw in cob, shiv in hempcrete */
function fibres(c: Painter, h: Painter, n: number, colour: string, len: number, seed: number, alpha = 0.7) {
  const [r, g, b] = hex(colour);
  const s = c.size;
  for (let i = 0; i < n; i++) {
    const x = hash(i, 1, seed) * s, y = hash(i, 2, seed) * s, a = hash(i, 3, seed) * Math.PI;
    const l = len * (0.5 + hash(i, 4, seed));
    for (let t = 0; t < l; t += 0.7) {
      const px = x + Math.cos(a) * t, py = y + Math.sin(a) * t;
      c.rect(px, py, 1, 1, r, g, b, alpha);
      h.rect(px, py, 1, 1, 0.9, 0.9, 0.9, 0.5);
    }
  }
}

function courses(c: Painter, h: Painter, rows: number, cols: number, mortar: string, joint: number, seed: number, jitter: [string, string]) {
  const s = c.size, rh = s / rows, cw = s / cols;
  const [mr, mg, mb] = hex(mortar);
  const A = hex(jitter[0]), B = hex(jitter[1]);
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * cw / 2;
    for (let k = 0; k < cols + 1; k++) {
      const t = hash(r, k, seed);
      const [cr, cg, cb] = lerp3(A, B, t);
      c.rect(off + k * cw + joint, r * rh + joint, cw - 2 * joint, rh - 2 * joint, cr, cg, cb, 0.55);
      h.rect(off + k * cw + joint, r * rh + joint, cw - 2 * joint, rh - 2 * joint, 0.75 + 0.2 * t, 0, 0, 1);
    }
    c.rect(0, r * rh, s, joint, mr, mg, mb, 1); h.rect(0, r * rh, s, joint, 0.1, 0, 0, 1);
  }
  // the height painter wrote only red; make it grey
  h.each((_u, _v, _x, _y, px) => { px[1] = px[2] = px[0]; });
  // mortar verticals
  for (let r = 0; r < rows; r++) {
    const off = (r % 2) * cw / 2;
    for (let k = 0; k < cols + 1; k++) { c.rect(off + k * cw, r * rh, joint, rh, mr, mg, mb, 1); h.rect(off + k * cw, r * rh, joint, rh, 0.1, 0.1, 0.1, 1); }
  }
}

// ---- the library ----------------------------------------------------------------------------------

export const SURFACES: Record<string, Surface> = {
  plaster: { colour: '#e8e2d4', metres: 2, roughness: 0.9, bump: 0.6, what: 'lime or clay plaster, smooth', use: ['wall'],
    paint: mottled('#e8e2d4', '#d9d1c0', '#f3eee4', 5, 0.8, 1) },
  lime: { colour: '#f1ece1', metres: 2, roughness: 0.88, bump: 0.5, what: 'lime wash, soft white', use: ['wall'],
    paint: mottled('#f1ece1', '#e2dccd', '#faf7f0', 4, 0.7, 2) },
  cob: { colour: '#b98d62', metres: 1.6, roughness: 0.96, bump: 2.2, what: 'cob — clay, sand and straw, hand-built, sculpted', use: ['wall'],
    paint: (c, h, s) => { mottled('#b98d62', '#9d7450', '#cfa77b', 3, 1, 3)(c, h); fibres(c, h, Math.round(s * 1.2), '#dcc690', s / 40, 3, 0.55); } },
  hempcrete: { colour: '#cbbd9a', metres: 1, roughness: 0.95, bump: 1.2, what: 'hempcrete — hemp shiv and lime, insulating infill', use: ['wall'],
    paint: (c, h, s) => { mottled('#cbbd9a', '#b8a882', '#ddd1b2', 8, 0.8, 4)(c, h); fibres(c, h, s * 3, '#8f7d58', s / 60, 4, 0.45); fibres(c, h, s * 2, '#e8dcbc', s / 70, 5, 0.5); } },
  strawbale: { colour: '#c8a878', metres: 2.4, roughness: 0.95, bump: 1.8, what: 'straw bale, earth-plastered', use: ['wall'],
    paint: (c, h) => {
      mottled('#c8a878', '#b0905f', '#dcc095', 2, 1, 6)(c, h);
      // the bales show through the plaster as soft courses
      h.each((_u, v, _x, _y, px) => { const b = 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 5); px[0] = px[1] = px[2] = px[0] * 0.7 + 0.3 * b; });
    } },
  rammed_earth: { colour: '#b88a5e', metres: 2.4, roughness: 0.92, bump: 1, what: 'rammed earth, in strata', use: ['wall'],
    paint: (c, h) => {
      const bands = ['#b07a52', '#c49a6c', '#a86f48', '#caa274', '#9c6b47', '#bf8d61'].map(hex);
      c.each((u, v, _x, _y, px) => {
        const w = v * 14 + 0.35 * fbm(u, v, 3, 3, 7);
        const i = Math.floor(w), t = w - i;
        const col = lerp3(bands[((i % 6) + 6) % 6], bands[(((i + 1) % 6) + 6) % 6], Math.pow(t, 6));
        const k = 0.9 + 0.2 * fbm(u, v, 30, 2, 8);
        px[0] = col[0] * k; px[1] = col[1] * k; px[2] = col[2] * k;
      });
      h.each((u, v, _x, _y, px) => { const w = v * 14; px[0] = px[1] = px[2] = 0.5 + 0.3 * Math.pow(Math.abs(Math.sin(w * Math.PI)), 0.3) + 0.2 * fbm(u, v, 40, 2, 9); });
    } },
  adobe: { colour: '#c9a27a', metres: 2.4, roughness: 0.93, bump: 1.4, what: 'adobe block', use: ['wall'],
    paint: (c, h) => { mottled('#c9a27a', '#b38c65', '#d8b58f', 6, 0.8, 10)(c, h); courses(c, h, 24, 6, '#b99670', 1.5, 10, ['#c29a70', '#d3ae86']); } },
  earth: { colour: '#b08a63', metres: 2, roughness: 0.95, bump: 1, what: 'earthen plaster or floor', use: ['wall', 'floor'],
    paint: mottled('#b08a63', '#957250', '#c49f78', 4, 1, 11) },
  wood: { colour: '#a67c52', metres: 1.2, roughness: 0.75, bump: 0.8, what: 'wood boards', use: ['wall', 'floor'],
    paint: (c, h, s) => {
      const A = hex('#a67c52'), B = hex('#8a6440');
      c.each((u, v, _x, _y, px) => {
        const board = Math.floor(v * 8), shade = hash(board, 1, 12);
        const grain = 0.5 + 0.5 * Math.sin((u * 40 + fbm(u, v, 4, 3, 12 + board) * 6) * Math.PI);
        const col = lerp3(A, B, 0.35 * grain + 0.4 * shade);
        px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
      });
      h.each((_u, v, _x, y, px) => { const edge = (y % (s / 8)) < 2 ? 0.1 : 0.7; px[0] = px[1] = px[2] = edge + 0.1 * Math.sin(v * 300); });
    } },
  timber: { colour: '#8b6a45', metres: 1.6, roughness: 0.8, bump: 1, what: 'heavy timber', use: ['wall', 'floor'],
    paint: (c, h, s) => {
      const A = hex('#8b6a45'), B = hex('#6d5234');
      c.each((u, v, _x, _y, px) => {
        const board = Math.floor(v * 5);
        const grain = 0.5 + 0.5 * Math.sin((u * 26 + fbm(u, v, 3, 3, 13 + board) * 8) * Math.PI);
        const col = lerp3(A, B, 0.4 * grain + 0.4 * hash(board, 2, 13));
        px[0] = col[0]; px[1] = col[1]; px[2] = col[2];
      });
      h.each((_u, _v, _x, y, px) => { px[0] = px[1] = px[2] = (y % (s / 5)) < 3 ? 0.05 : 0.7; });
    } },
  bamboo: { colour: '#b9a45f', metres: 1.2, roughness: 0.55, bump: 1.4, what: 'bamboo culms', use: ['wall', 'roof'],
    paint: (c, h, s) => {
      const A = hex('#c2ad66'), B = hex('#8f7b3e');
      c.each((u, v, x, _y, px) => {
        const n = 10, col = Math.floor(u * n), f = (u * n) % 1;
        const round = Math.sin(f * Math.PI);
        const node = Math.abs(((v * 3 + hash(col, 1, 14)) % 1) - 0.5) < 0.012 ? 0.55 : 1;
        const cc = lerp3(B, A, round * 0.8 + 0.2 * hash(col, 2, 14));
        px[0] = cc[0] * node; px[1] = cc[1] * node; px[2] = cc[2] * node;
        void x; void s;
      });
      h.each((u, _v, _x, _y, px) => { const f = (u * 10) % 1; px[0] = px[1] = px[2] = Math.sin(f * Math.PI); });
    } },
  stone: { colour: '#9a948a', metres: 2.4, roughness: 0.9, bump: 2, what: 'fieldstone, laid dry or in lime', use: ['wall', 'floor'],
    paint: (c, h) => {
      // Voronoi stones with mortar between
      const pts: [number, number, number][] = [];
      for (let i = 0; i < 40; i++) pts.push([hash(i, 1, 15), hash(i, 2, 15), hash(i, 3, 15)]);
      const cols = ['#a39c90', '#8e887e', '#b0a898', '#9a8f80', '#857f76'].map(hex);
      const M = hex('#c9c1b0');
      c.each((u, v, _x, _y, px) => {
        let d1 = 9, d2 = 9, id = 0;
        for (let i = 0; i < pts.length; i++) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const dx = u - pts[i][0] - ox, dy = (v - pts[i][1] - oy) * 1.6;
          const d = dx * dx + dy * dy;
          if (d < d1) { d2 = d1; d1 = d; id = i; } else if (d < d2) d2 = d;
        }
        const edge = Math.sqrt(d2) - Math.sqrt(d1);
        const k = 0.88 + 0.24 * fbm(u, v, 20, 2, 16);
        const col = edge < 0.012 ? M : cols[Math.floor(pts[id][2] * cols.length)];
        px[0] = col[0] * k; px[1] = col[1] * k; px[2] = col[2] * k;
      });
      // the relief follows the stones: high in the middle, down at the joints
      h.each((u, v, _x, _y, px) => {
        let d1 = 9, d2 = 9;
        for (let i = 0; i < pts.length; i++) for (let ox = -1; ox <= 1; ox++) for (let oy = -1; oy <= 1; oy++) {
          const dx = u - pts[i][0] - ox, dy = (v - pts[i][1] - oy) * 1.6;
          const d = dx * dx + dy * dy;
          if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
        }
        const t = Math.min(1, (Math.sqrt(d2) - Math.sqrt(d1)) * 12);
        px[0] = px[1] = px[2] = Math.sqrt(t) * 0.8 + 0.2 * fbm(u, v, 30, 2, 17);
      });
    } },
  concrete: { colour: '#b9b5ae', metres: 2.4, roughness: 0.85, bump: 0.6, what: 'board-formed concrete', use: ['wall', 'floor'],
    paint: (c, h, s) => {
      mottled('#b9b5ae', '#a7a39c', '#c9c5be', 12, 0.6, 18)(c, h);
      for (let i = 1; i < 12; i++) { c.rect(0, i * s / 12, s, 1, 0.64, 0.62, 0.59, 0.35); h.rect(0, i * s / 12, s, 1, 0.2, 0.2, 0.2, 0.8); }
    } },
  glass: { colour: '#bcd8e6', metres: 2, roughness: 0.04, metalness: 0, glass: true, what: 'glass', use: ['wall'] },
  metal: { colour: '#9aa0a3', metres: 2.7, roughness: 0.38, metalness: 0.75, bump: 1.4, what: 'standing-seam metal', use: ['roof', 'wall'],
    paint: (c, h, s) => {
      mottled('#9aa0a3', '#8e9497', '#a8aeb1', 6, 0.4, 19)(c, h);
      const n = 6;
      h.fill(0.5, 0.5, 0.5);
      for (let i = 0; i < n; i++) { const x = (i / n) * s; c.rect(x, 0, 2, s, 0.75, 0.77, 0.78, 0.8); h.rect(x - 1, 0, 4, s, 1, 1, 1, 1); }
    } },
  steel: { colour: '#5b6064', metres: 2, roughness: 0.45, metalness: 0.85, bump: 0.3, what: 'structural steel', use: ['wall', 'roof'],
    paint: mottled('#5b6064', '#50555a', '#666b70', 10, 0.5, 20) },
  tile: { colour: '#a3563b', metres: 2, roughness: 0.7, bump: 1.6, what: 'clay tile', use: ['roof'],
    paint: (c, h, s) => {
      const A = hex('#a3563b'), B = hex('#b8694a');
      const rows = 10, cols = 8;
      c.each((u, v, x, y, px) => {
        const r = Math.floor(v * rows), k = Math.floor(u * cols + (r % 2) * 0.5);
        const f = (u * cols + (r % 2) * 0.5) % 1, g = (v * rows) % 1;
        const col = lerp3(A, B, hash(r, k, 21));
        const sh = 0.75 + 0.35 * Math.sin(f * Math.PI) - 0.25 * g;
        px[0] = col[0] * sh; px[1] = col[1] * sh; px[2] = col[2] * sh;
        void x; void y; void s;
      });
      h.each((u, v, _x, _y, px) => { const r = Math.floor(v * rows); const f = (u * cols + (r % 2) * 0.5) % 1; px[0] = px[1] = px[2] = Math.sin(f * Math.PI) * (1 - 0.6 * ((v * rows) % 1)); });
    } },
  thatch: { colour: '#c2a35a', metres: 1.6, roughness: 0.95, bump: 2, what: 'thatch', use: ['roof'],
    paint: (c, h, s) => {
      mottled('#c2a35a', '#a78845', '#d4b870', 3, 0.8, 22)(c, h);
      fibres(c, h, s * 6, '#8d7238', s / 10, 22, 0.35);
      fibres(c, h, s * 4, '#dcc27a', s / 12, 23, 0.35);
    } },
  shingle: { colour: '#6b625a', metres: 2, roughness: 0.85, bump: 1.4, what: 'wood or slate shingle', use: ['roof'],
    paint: (c, h) => courses(c, h, 12, 7, '#4e4640', 1.2, 24, ['#6b625a', '#7d746a']) },
  living: { colour: '#7da65a', metres: 2, roughness: 0.95, bump: 2, what: 'living roof — sedum and grasses', use: ['roof'],
    paint: (c, h, s) => {
      const G = hex('#6f8f4a'), Y = hex('#a2ad5c'), R = hex('#a8574a');
      c.each((u, v, _x, _y, px) => {
        const m = fbm(u, v, 6, 4, 25), f = fbm(u, v, 40, 2, 26);
        let col = lerp3(G, Y, m);
        if (f > 0.72) col = lerp3(col, R, (f - 0.72) * 3);
        const k = 0.8 + 0.4 * fbm(u, v, 80, 2, 27);
        px[0] = col[0] * k; px[1] = col[1] * k; px[2] = col[2] * k;
      });
      h.each((u, v, _x, _y, px) => { px[0] = px[1] = px[2] = fbm(u, v, 50, 3, 28); });
      void s;
    } },
  solar: { colour: '#1d2b44', metres: 1.7, roughness: 0.18, metalness: 0.35, bump: 0.4, what: 'solar panels', use: ['roof'],
    paint: (c, h, s) => {
      // one panel: 6 × 10 cells, silver bus bars, an aluminium frame
      c.fill(0.08, 0.13, 0.24); h.fill(0.5, 0.5, 0.5);
      const cw = s / 6, ch = s / 10;
      for (let i = 0; i < 6; i++) for (let j = 0; j < 10; j++) {
        const t = hash(i, j, 29) * 0.04;
        c.rect(i * cw + 1.5, j * ch + 1.5, cw - 3, ch - 3, 0.07 + t, 0.11 + t, 0.22 + t, 1);
        for (let b = 1; b < 4; b++) c.rect(i * cw + b * cw / 4, j * ch + 1.5, 0.7, ch - 3, 0.55, 0.58, 0.62, 0.6);
      }
      c.rect(0, 0, s, 3, 0.72, 0.74, 0.76, 1); c.rect(0, s - 3, s, 3, 0.72, 0.74, 0.76, 1);
      c.rect(0, 0, 3, s, 0.72, 0.74, 0.76, 1); c.rect(s - 3, 0, 3, s, 0.72, 0.74, 0.76, 1);
      h.rect(0, 0, s, 3, 1, 1, 1, 1); h.rect(0, s - 3, s, 3, 1, 1, 1, 1); h.rect(0, 0, 3, s, 1, 1, 1, 1); h.rect(s - 3, 0, 3, s, 1, 1, 1, 1);
    } }
};

// ---- the ground's own surfaces: streets, tracks, the creek bed -----------------------------------------
Object.assign(SURFACES, {
  asphalt: { colour: '#56585a', metres: 4, roughness: 0.92, bump: 0.5, what: 'asphalt', use: ['ground'],
    paint: (c: Painter, h: Painter, s: number) => {
      mottled('#58595b', '#4a4b4d', '#66676a', 30, 0.7, 40)(c, h);
      // aggregate: pale flecks, and the odd dark patch where it was mended
      fibres(c, h, s * 10, '#8a8a88', 1.2, 41, 0.5);
      c.each((u, v, _x, _y, px) => { const p = fbm(u, v, 2, 3, 42); if (p > 0.68) { px[0] *= 0.82; px[1] *= 0.82; px[2] *= 0.82; } });
    } },
  gravel: { colour: '#a39a88', metres: 2, roughness: 0.95, bump: 1.6, what: 'gravel drive', use: ['ground'],
    paint: (c: Painter, h: Painter, s: number) => {
      mottled('#a39a88', '#8c8474', '#b8b09e', 40, 0.9, 43)(c, h);
      const cols = ['#c9c2b3', '#7f786b', '#a89f8c', '#bdb4a2'];
      for (let i = 0; i < s * 6; i++) { const col = hex(cols[i % cols.length]); const x = hash(i, 1, 44) * s, y = hash(i, 2, 44) * s, r = 1 + hash(i, 3, 44) * 2.2; c.rect(x, y, r, r, col[0], col[1], col[2], 0.9); h.rect(x, y, r, r, 0.9, 0.9, 0.9, 0.8); }
    } },
  dirt: { colour: '#a88b64', metres: 3, roughness: 0.97, bump: 1.2, what: 'dirt track', use: ['ground'],
    paint: (c: Painter, h: Painter) => {
      mottled('#a88b64', '#8f7453', '#bca07a', 6, 1, 45)(c, h);
      // two ruts worn along the track
      c.each((u, _v, _x, _y, px) => { const r = Math.exp(-Math.pow((u - 0.3) * 14, 2)) + Math.exp(-Math.pow((u - 0.7) * 14, 2)); px[0] *= 1 - 0.12 * r; px[1] *= 1 - 0.12 * r; px[2] *= 1 - 0.1 * r; });
    } },
  creekbed: { colour: '#b0a58e', metres: 2.5, roughness: 0.9, bump: 1.6, what: 'creek bed — sand and cobbles', use: ['ground'],
    paint: (c: Painter, h: Painter, s: number) => {
      mottled('#b8ad95', '#a39781', '#c9bfa8', 8, 0.8, 46)(c, h);
      // rounded cobbles of the local sandstone and shale, small and many, washed pale
      const cols = ['#9d9788', '#b3ac9c', '#8b857a', '#c2bba9', '#a59b88', '#7f7a70'];
      for (let i = 0; i < s * 2.2; i++) {
        const col = hex(cols[i % cols.length]);
        const x = hash(i, 1, 47) * s, y = hash(i, 2, 47) * s, r = 2 + Math.pow(hash(i, 3, 47), 2) * 7;
        const ry = r * (0.55 + 0.4 * hash(i, 4, 47));
        c.ellipse(x, y, r, ry, col[0], col[1], col[2], 0.92, 1);
        h.ellipse(x, y, r, ry, 0.85, 0.85, 0.85, 0.8, 0.6);
      }
    } },
  paint: { colour: '#e8c24a', metres: 1, roughness: 0.6, what: 'road paint', use: ['ground'] },
  paint_white: { colour: '#ecebe6', metres: 1, roughness: 0.6, what: 'road paint', use: ['ground'] }
} as Record<string, Surface>);

export const SURFACE_NAMES = Object.keys(SURFACES);

/**
 * Moving water: a dark, glossy surface whose ripples drift downstream. The ripples are a normal map
 * painted once from noise; `flowWater(t)` scrolls it, so a creek visibly runs.
 */
let waterMat: THREE.MeshStandardMaterial | null = null;
export function waterMaterial(): THREE.MeshStandardMaterial {
  if (waterMat) return waterMat;
  let normalMap: THREE.Texture | null = null;
  if (typeof document !== 'undefined') {
    const S = 128, hgt = new Float32Array(S * S);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) hgt[y * S + x] = fbm(x / S, y / S, 4, 4, 60) * 0.7 + fbm(x / S, y / S, 12, 2, 61) * 0.3;
    const p = new Painter(S);
    p.each((_u, _v, x, y, px) => {
      const hx = hgt[y * S + ((x + 1) % S)] - hgt[y * S + ((x - 1 + S) % S)];
      const hy = hgt[((y + 1) % S) * S + x] - hgt[((y - 1 + S) % S) * S + x];
      const k = 3;
      const nx = -hx * k, ny = -hy * k, nz = 1, l = Math.hypot(nx, ny, nz);
      px[0] = 0.5 + 0.5 * nx / l; px[1] = 0.5 + 0.5 * ny / l; px[2] = 0.5 + 0.5 * nz / l;
    });
    normalMap = new THREE.CanvasTexture(p.toCanvas());
    normalMap.wrapS = normalMap.wrapT = THREE.RepeatWrapping;
    normalMap.repeat.set(1 / 3, 1 / 3);
  }
  waterMat = new THREE.MeshStandardMaterial({
    color: '#27433f', roughness: 0.05, metalness: 0.1, transparent: true, opacity: 0.86, normalMap, normalScale: new THREE.Vector2(0.35, 0.35),
    envMapIntensity: 2.2, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
  });
  waterMat.name = 'surface:water';
  return waterMat;
}
/** the water's ripples move on; the loop calls this with seconds */
export function flowWater(seconds: number) {
  const m = waterMat?.normalMap;
  if (m) m.offset.set(seconds * 0.013, seconds * 0.05);
}

// ---- textures and materials, made once and shared -----------------------------------------------

const textures = new Map<string, { map: THREE.Texture; bump: THREE.Texture } | null>();
const materials = new Map<string, THREE.Material>();
/** the size each texture is painted at; tests may lower it, a phone does */
let SIZE = 256;
export function setSurfaceResolution(px: number) { SIZE = px; }

function texturesFor(name: string) {
  if (textures.has(name)) return textures.get(name)!;
  const s = SURFACES[name];
  if (!s?.paint || typeof document === 'undefined') { textures.set(name, null); return null; }
  try {
    const c = new Painter(SIZE), h = new Painter(SIZE);
    c.fill(...hex(s.colour));
    h.fill(0.5, 0.5, 0.5);
    s.paint(c, h, SIZE);
    const map = new THREE.CanvasTexture(c.toCanvas());
    map.colorSpace = THREE.SRGBColorSpace;
    const bump = new THREE.CanvasTexture(h.toCanvas());
    for (const t of [map, bump]) {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.repeat.set(1 / s.metres, 1 / s.metres);
      t.anisotropy = 4;
      t.generateMipmaps = true;
    }
    const out = { map, bump };
    textures.set(name, out);
    return out;
  } catch {
    textures.set(name, null);
    return null;
  }
}

/**
 * The shared material for a surface. Shared on purpose: two hundred cob walls are one material and
 * one texture on the GPU. The caller must never dispose it — `Build` keeps these out of its own list.
 */
export function surfaceMaterial(name: string, fallback = 'plaster'): THREE.Material {
  const key = SURFACES[name] ? name : SURFACES[fallback] ? fallback : 'plaster';
  const have = materials.get(key);
  if (have) return have;
  const s = SURFACES[key];
  let m: THREE.Material;
  if (s.glass) {
    m = new THREE.MeshPhysicalMaterial({
      color: s.colour, roughness: s.roughness, metalness: 0, transparent: true, opacity: 0.32,
      side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1.4, clearcoat: 1, clearcoatRoughness: 0.05,
      reflectivity: 0.6
    });
  } else {
    const t = texturesFor(key);
    m = new THREE.MeshStandardMaterial({
      color: t ? '#ffffff' : s.colour, map: t?.map ?? null, bumpMap: t?.bump ?? null, bumpScale: s.bump ?? 1,
      roughness: s.roughness, metalness: s.metalness ?? 0, side: THREE.DoubleSide
    });
  }
  m.name = `surface:${key}`;
  materials.set(key, m);
  return m;
}

/** a flat swatch of a surface for a list: the base colour */
export function surfaceColour(name: string): string { return SURFACES[name]?.colour ?? '#cccccc'; }
