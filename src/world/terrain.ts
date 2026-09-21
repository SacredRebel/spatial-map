// The hillside you can see and walk on.
//
//   One mesh, not one per tile. The height field answers anywhere, so the geometry is a plain grid
//   over a square of ground with the heights sampled into it — which means no seams, no cracks
//   between levels of detail, and no bookkeeping about which tile owns which vertex.
//
//   Three rings: a fine one you are standing in, a coarse one for the middle distance, and a far one
//   out to the ridges across the valley. The fine ring is rebuilt as you leave it; the other two are
//   built once, because at that distance a metre does not read. Vertex colours come from slope and
//   height rather than a texture, so the first frame costs one fetch of elevation and nothing else.
//
//   When a pack names an aerial, the fine ring is draped with it: the tiles covering the ring are
//   drawn into one canvas, the canvas becomes the ring's texture, and every vertex gets the UV of
//   its own longitude and latitude in that canvas. Tiles arrive one by one and the texture updates
//   as they do, so the ground is walkable before the photograph has finished loading. The coarse
//   ring keeps its vertex colours: at a kilometre, colour is what reads, not pixels.

import * as THREE from 'three';
import { tileBounds, tilesCovering, type Frame } from './geo';
import type { HeightField } from './heightfield';
import { applyGrain, type GrainTiles } from './grain';

export interface Imagery {
  /** {z}/{x}/{y} template — the county's caches put {y} before {x}, so the template spells the order */
  template: string;
  maxzoom: number;
}

/** a tile source addressed by function rather than template — Bing numbers its tiles by quadkey */
export interface TileSource {
  url: (z: number, x: number, y: number) => string;
  maxzoom: number;
}

type Distant = 'coarse' | 'far';
const blankDrape = () => ({ z: 0, tiles: 0, loaded: 0, failed: 0, active: false });

export interface TerrainOpts {
  /** half-width of the square, in metres */
  radius: number;
  /** vertices along one edge; 129 over 512 m is a vertex every 4 m */
  segments: number;
}

const ROCK = new THREE.Color('#a2988a');
const GRASS = new THREE.Color('#93a065');
const DRY = new THREE.Color('#bfae76');
const SHADE = new THREE.Color('#71805a');

/** colour by slope and height: steep reads as rock, gentle as grass, high and dry as chaparral */
function shade(slope: number, h: number, lo: number, hi: number, out: THREE.Color) {
  const steep = THREE.MathUtils.smoothstep(slope, 0.35, 0.85);
  const high = hi > lo ? THREE.MathUtils.smoothstep((h - lo) / (hi - lo), 0.35, 0.9) : 0;
  out.copy(GRASS).lerp(DRY, high).lerp(ROCK, steep);
  out.lerp(SHADE, 0.12 * (1 - steep));
}

export class Terrain {
  group = new THREE.Group();
  private fine: THREE.Mesh | null = null;
  private coarse: THREE.Mesh | null = null;
  private far: THREE.Mesh | null = null;
  private fineCentre = new THREE.Vector2(NaN, NaN);
  private fineOpts: TerrainOpts | null = null;
  private imagery: Imagery | null = null;
  private grain: GrainTiles | null = null;
  /** whether the fine ring currently carries the close-up grain — the tests read this */
  grainActive = false;
  private tileCache = new Map<string, Promise<HTMLImageElement | null>>();
  private drapeGen = 0;
  /** what the current drape is doing — the tests and the HUD read this */
  imageryState = { z: 0, tiles: 0, loaded: 0, failed: 0, active: false };
  /** resolves when every tile of the current drape has arrived or failed */
  imageryReady: Promise<void> = Promise.resolve();

  // the imagery beyond the parcel: the middle distance and the far ridges, from a wider source
  private distant: TileSource | null = null;
  private distantGen: Record<Distant, number> = { coarse: 0, far: 0 };
  private distantDone: Record<Distant, Promise<void>> = { coarse: Promise.resolve(), far: Promise.resolve() };
  /** what each distant drape is doing — the tests read this */
  distantState: Record<Distant, ReturnType<typeof blankDrape>> = { coarse: blankDrape(), far: blankDrape() };
  /** resolves when both distant drapes have every tile they asked for, or have given up */
  get distantReady(): Promise<void> { return Promise.all([this.distantDone.coarse, this.distantDone.far]).then(() => undefined); }

  constructor(private frame: Frame, private field: HeightField) {
    this.group.name = 'terrain';
  }

  /** name the aerial to drape the fine ring with, or null to go back to colour by slope */
  setImagery(im: Imagery | null) {
    this.imagery = im;
    if (this.fine && this.fineOpts) this.buildFine(this.fineCentre.x, this.fineCentre.y, this.fineOpts);
  }

  /**
   * Drape the middle distance and the far ridges with a wider source, or null to go back to colour
   * by slope. The near ring keeps the pack's own aerial either way: close up, the county's photograph
   * of this property is better than any global set, and it is the property's own.
   */
  setDistantImagery(src: TileSource | null) {
    this.distant = src;
    for (const k of ['coarse', 'far'] as Distant[]) {
      if (src) this.drapeDistant(k);
      else this.undrapeDistant(k);
    }
  }

  /** give the fine ring its close-up tiles (they only show where an aerial is draped), or take them away */
  setGrain(tiles: GrainTiles | null) {
    this.grain = tiles;
    if (this.fine && this.fineOpts) this.buildFine(this.fineCentre.x, this.fineCentre.y, this.fineOpts);
  }

  /** build (or rebuild) the patch the player is standing in */
  buildFine(centreX: number, centreZ: number, o: TerrainOpts) {
    if (this.fine) {
      this.group.remove(this.fine);
      this.fine.geometry.dispose();
      const m = this.fine.material as THREE.MeshLambertMaterial;
      m.map?.dispose();
      m.dispose();
    }
    this.fine = this.build(centreX, centreZ, o, 0);
    this.fine.name = 'terrain-fine';
    this.group.add(this.fine);
    this.fineCentre.set(centreX, centreZ);
    this.fineOpts = o;
    this.grainActive = false;
    if (this.imagery) this.drape(this.fine, centreX, centreZ, o);
    else this.imageryState = { z: 0, tiles: 0, loaded: 0, failed: 0, active: false };
  }

  // ---- the photograph -------------------------------------------------------------------------------
  private drape(mesh: THREE.Mesh, cx: number, cz: number, o: TerrainOpts) {
    const im = this.imagery!;
    const gen = ++this.drapeGen;
    const sw = this.frame.toLngLat(cx - o.radius, cz + o.radius);
    const ne = this.frame.toLngLat(cx + o.radius, cz - o.radius);
    const box: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat];

    // the deepest zoom whose tile grid over the ring still fits one sane canvas
    let z = Math.min(im.maxzoom, 19);
    let tiles = tilesCovering(box, z);
    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    for (;;) {
      x0 = Math.min(...tiles.map(t => t.x)); x1 = Math.max(...tiles.map(t => t.x));
      y0 = Math.min(...tiles.map(t => t.y)); y1 = Math.max(...tiles.map(t => t.y));
      if ((x1 - x0 + 1) * (y1 - y0 + 1) <= 100 || z <= 12) break;
      z--; tiles = tilesCovering(box, z);
    }
    const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#8f9a6a';                    // the hillside's own colour until the photograph lands
    g.fillRect(0, 0, W, H);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;

    // UVs: each vertex at its own place in the tile grid, mercator in y because the tiles are
    const west = tileBounds({ z, x: x0, y: y0 })[0], east = tileBounds({ z, x: x1, y: y1 })[2];
    const north = tileBounds({ z, x: x0, y: y0 })[3], south = tileBounds({ z, x: x1, y: y1 })[1];
    const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const mS = mercY(south), mN = mercY(north);
    const pos = mesh.geometry.getAttribute('position');
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const ll = this.frame.toLngLat(pos.getX(i), pos.getZ(i));
      uv[i * 2] = (ll.lng - west) / (east - west);
      uv[i * 2 + 1] = (mercY(ll.lat) - mS) / (mN - mS);
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mat = mesh.material as THREE.MeshLambertMaterial;
    mat.map = tex;
    mat.vertexColors = false;
    mat.color.set('#ffffff');
    if (this.grain) { applyGrain(mat, this.grain); this.grainActive = true; }
    mat.needsUpdate = true;

    this.imageryState = { z, tiles: tiles.length, loaded: 0, failed: 0, active: true };
    this.imageryReady = Promise.all(tiles.map(t => this.tile(im.template, t.z, t.x, t.y).then(img => {
      if (gen !== this.drapeGen) return;          // the ring moved on; this photograph is for the old one
      if (img) {
        g.drawImage(img, (t.x - x0) * 256, (t.y - y0) * 256, 256, 256);
        tex.needsUpdate = true;
        this.imageryState.loaded++;
      } else this.imageryState.failed++;
    }))).then(() => {
      // a photograph that never arrived is not a photograph: give the ring its slope colours back
      if (gen === this.drapeGen && this.imageryState.loaded === 0) this.undrape(mesh);
    });
  }

  /**
   * The same photograph-in-a-canvas as the near ring, for a ring a few kilometres across. Fewer tiles
   * and a shallower zoom: at a kilometre away a pixel of three metres is already finer than the eye.
   */
  private drapeDistant(k: Distant) {
    const mesh = k === 'coarse' ? this.coarse : this.far;
    const o = k === 'coarse' ? this.coarseOpts : this.farOpts;
    const c = k === 'coarse' ? this.coarseCentre : this.farCentre;
    const src = this.distant;
    if (!mesh || !o || !src) return;
    const gen = ++this.distantGen[k];
    const sw = this.frame.toLngLat(c.x - o.radius, c.y + o.radius);
    const ne = this.frame.toLngLat(c.x + o.radius, c.y - o.radius);
    const box: [number, number, number, number] = [sw.lng, sw.lat, ne.lng, ne.lat];

    const CAP = 49;                            // seven tiles a side: a 1792-pixel canvas, kind to a phone
    let z = Math.min(src.maxzoom, 19);
    let tiles = tilesCovering(box, z);
    while (tiles.length > CAP && z > 3) { z--; tiles = tilesCovering(box, z); }
    const x0 = Math.min(...tiles.map(t => t.x)), x1 = Math.max(...tiles.map(t => t.x));
    const y0 = Math.min(...tiles.map(t => t.y)), y1 = Math.max(...tiles.map(t => t.y));
    const W = (x1 - x0 + 1) * 256, H = (y1 - y0 + 1) * 256;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#8a9366';
    g.fillRect(0, 0, W, H);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;

    const west = tileBounds({ z, x: x0, y: y0 })[0], east = tileBounds({ z, x: x1, y: y1 })[2];
    const north = tileBounds({ z, x: x0, y: y0 })[3], south = tileBounds({ z, x: x1, y: y1 })[1];
    const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const mS = mercY(south), mN = mercY(north);
    const pos = mesh.geometry.getAttribute('position');
    const uv = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) {
      const ll = this.frame.toLngLat(pos.getX(i), pos.getZ(i));
      uv[i * 2] = (ll.lng - west) / (east - west);
      uv[i * 2 + 1] = (mercY(ll.lat) - mS) / (mN - mS);
    }
    mesh.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    const mat = mesh.material as THREE.MeshLambertMaterial;
    mat.map?.dispose();
    mat.map = tex;
    mat.vertexColors = false;
    mat.color.set('#ffffff');
    mat.needsUpdate = true;

    const st = this.distantState[k] = { z, tiles: tiles.length, loaded: 0, failed: 0, active: true };
    this.distantDone[k] = Promise.all(tiles.map(t => this.fetchTile(src.url(t.z, t.x, t.y)).then(img => {
      if (gen !== this.distantGen[k]) return;
      if (img) { g.drawImage(img, (t.x - x0) * 256, (t.y - y0) * 256, 256, 256); tex.needsUpdate = true; st.loaded++; }
      else st.failed++;
    }))).then(() => {
      // nothing arrived: this is not a photograph, so the ring goes back to its slope colours
      if (gen === this.distantGen[k] && st.loaded === 0) this.undrapeDistant(k);
    });
  }

  private undrapeDistant(k: Distant) {
    this.distantGen[k]++;
    const mesh = k === 'coarse' ? this.coarse : this.far;
    this.distantState[k] = blankDrape();
    this.distantDone[k] = Promise.resolve();
    if (!mesh) return;
    const mat = mesh.material as THREE.MeshLambertMaterial;
    mat.map?.dispose();
    mat.map = null;
    mat.vertexColors = true;
    mat.needsUpdate = true;
  }

  /** the ground the distant drape covers and at what zoom — Google's copyright is asked for exactly this */
  distantView(k: Distant): { box: [number, number, number, number]; z: number } | null {
    const o = k === 'coarse' ? this.coarseOpts : this.farOpts;
    const c = k === 'coarse' ? this.coarseCentre : this.farCentre;
    if (!o || !this.distantState[k].active) return null;
    const sw = this.frame.toLngLat(c.x - o.radius, c.y + o.radius);
    const ne = this.frame.toLngLat(c.x + o.radius, c.y - o.radius);
    return { box: [sw.lng, sw.lat, ne.lng, ne.lat], z: this.distantState[k].z };
  }

  private undrape(mesh: THREE.Mesh) {
    const mat = mesh.material as THREE.MeshLambertMaterial;
    mat.map?.dispose();
    mat.map = null;
    mat.vertexColors = true;
    mat.needsUpdate = true;
    this.imageryState.active = false;
    this.grainActive = false;
  }

  /** one tile, fetched once and remembered, so a ring rebuilt a few metres on costs almost nothing */
  private tile(template: string, z: number, x: number, y: number): Promise<HTMLImageElement | null> {
    return this.fetchTile(template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  }

  private fetchTile(url: string): Promise<HTMLImageElement | null> {
    const have = this.tileCache.get(url);
    if (have) return have;
    const p = new Promise<HTMLImageElement | null>(resolve => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    this.tileCache.set(url, p);
    return p;
  }

  /** the ground has been reshaped: the near rings are sampled again where they stand */
  reshape() {
    if (this.coarse && this.coarseOpts) this.buildCoarse(this.coarseCentre.x, this.coarseCentre.y, this.coarseOpts);
    if (this.fine && this.fineOpts) this.buildFine(this.fineCentre.x, this.fineCentre.y, this.fineOpts);
  }

  private coarseCentre = new THREE.Vector2();
  private coarseOpts: TerrainOpts | null = null;

  /** the middle distance, built once and left alone */
  buildCoarse(centreX: number, centreZ: number, o: TerrainOpts) {
    if (this.coarse) { this.group.remove(this.coarse); this.coarse.geometry.dispose(); (this.coarse.material as THREE.MeshLambertMaterial).map?.dispose(); }
    this.coarseCentre.set(centreX, centreZ);
    this.coarseOpts = o;
    this.coarse = this.build(centreX, centreZ, o, -0.15);
    this.coarse.name = 'terrain-coarse';
    this.coarse.renderOrder = -1;
    this.group.add(this.coarse);
    if (this.distant) this.drapeDistant('coarse');
  }

  private farCentre = new THREE.Vector2();
  private farOpts: TerrainOpts | null = null;

  /** the horizon: the ridges across the valley, from the coarse global ground, dissolving into the haze */
  buildFar(centreX: number, centreZ: number, o: TerrainOpts) {
    if (this.far) { this.group.remove(this.far); this.far.geometry.dispose(); (this.far.material as THREE.MeshLambertMaterial).map?.dispose(); }
    this.farCentre.set(centreX, centreZ);
    this.farOpts = o;
    this.far = this.build(centreX, centreZ, o, -0.6);
    this.far.name = 'terrain-far';
    this.far.renderOrder = -2;
    this.far.receiveShadow = false;
    this.group.add(this.far);
    if (this.distant) this.drapeDistant('far');
  }

  /** the fine patch follows you, and is only rebuilt once you are well into its outer third */
  update(x: number, z: number, o: TerrainOpts) {
    if (!this.fine) { this.buildFine(x, z, o); return; }
    const d = Math.hypot(x - this.fineCentre.x, z - this.fineCentre.y);
    if (d > o.radius * 0.45) this.buildFine(x, z, o);
  }

  private build(cx: number, cz: number, o: TerrainOpts, drop: number): THREE.Mesh {
    const n = o.segments, span = o.radius * 2, step = span / (n - 1);
    const pos = new Float32Array(n * n * 3);
    const col = new Float32Array(n * n * 3);
    const hs = new Float32Array(n * n);
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = cx - o.radius + i * step;
        const z = cz - o.radius + j * step;
        const ll = this.frame.toLngLat(x, z);
        const h = this.field.atOr(ll.lng, ll.lat, 0) + drop;
        hs[j * n + i] = h;
        if (h < lo) lo = h;
        if (h > hi) hi = h;
        const k = (j * n + i) * 3;
        pos[k] = x; pos[k + 1] = h; pos[k + 2] = z;
      }
    }
    const c = new THREE.Color();
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const h = hs[j * n + i];
        const hx = hs[j * n + Math.min(n - 1, i + 1)] - hs[j * n + Math.max(0, i - 1)];
        const hz = hs[Math.min(n - 1, j + 1) * n + i] - hs[Math.max(0, j - 1) * n + i];
        const slope = Math.hypot(hx, hz) / (2 * step);
        shade(slope, h, lo, hi, c);
        const k = (j * n + i) * 3;
        col[k] = c.r; col[k + 1] = c.g; col[k + 2] = c.b;
      }
    }
    const idx: number[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, d2 = a + n, e = d2 + 1;
        idx.push(a, d2, b, b, d2, e);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const m = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.FrontSide });
    const mesh = new THREE.Mesh(g, m);
    mesh.receiveShadow = true;
    return mesh;
  }

  dispose() {
    for (const m of [this.fine, this.coarse, this.far]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.fine = this.coarse = this.far = null;
  }
}
