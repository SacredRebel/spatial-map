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

/**
 * A ring does not draw where a finer ring already is.
 *
 *   The coarse ring is sampled every 25 m and the ground between its vertices is a straight line; in
 *   every hollow of a real hillside that line runs above the 1 m ground, and a coarse ring only
 *   dropped fifteen centimetres pokes up through the fine one in broad dark sheets — over the
 *   photograph, over the grain, over everything that makes the ground near you look real. So each
 *   outer ring throws away its own fragments inside the square the next ring in covers, less a
 *   margin that keeps the two overlapping at the seam so no sky shows between them.
 */
function clipInside(mat: THREE.Material, clip: { centre: { value: THREE.Vector2 }; half: { value: number } }) {
  mat.onBeforeCompile = shader => {
    shader.uniforms.uClipCentre = clip.centre;
    shader.uniforms.uClipHalf = clip.half;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vClipXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvClipXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vClipXZ;\nuniform vec2 uClipCentre; uniform float uClipHalf;')
      .replace('void main() {', 'void main() {\n  if (uClipHalf > 0.0 && abs(vClipXZ.x - uClipCentre.x) < uClipHalf && abs(vClipXZ.y - uClipCentre.y) < uClipHalf) discard;');
  };
  mat.customProgramCacheKey = () => 'clip-inside';
}

export class Terrain {
  group = new THREE.Group();
  /** where the coarse ring stops drawing (the fine ring's square) and where the far ring does (the coarse ring's) */
  readonly clips = {
    coarse: { centre: { value: new THREE.Vector2() }, half: { value: 0 } },
    far: { centre: { value: new THREE.Vector2() }, half: { value: 0 } }
  };
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
  /** the near drape's pixels, kept once it has arrived, so things on the ground can take its colour */
  private drapeSample: { data: Uint8ClampedArray; W: number; H: number; west: number; east: number; mS: number; mN: number } | null = null;
  /** bumped each time the near drape's pixels change — the grass regrows when it does */
  drapeVersion = 0;

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
      const m = this.fine.material as THREE.MeshStandardMaterial;
      m.map?.dispose();
      m.dispose();
    }
    this.fine = this.build(centreX, centreZ, o, 0);
    this.fine.name = 'terrain-fine';
    this.group.add(this.fine);
    this.fineCentre.set(centreX, centreZ);
    this.fineOpts = o;
    // the coarse ring now stands back from this square, keeping 3 % of it as overlap at the seam
    this.clips.coarse.centre.value.set(centreX, centreZ);
    this.clips.coarse.half.value = o.radius * 0.97;
    this.fineVersion++;
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
    const mat = mesh.material as THREE.MeshStandardMaterial;
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
      if (gen === this.drapeGen && this.imageryState.loaded === 0) { this.undrape(mesh); return; }
      if (gen !== this.drapeGen) return;
      try {
        this.drapeSample = { data: g.getImageData(0, 0, W, H).data, W, H, west, east, mS, mN };
        this.drapeVersion++;
      } catch { this.drapeSample = null; /* a tile without CORS taints the canvas: no colours to read, and that is fine */ }
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
    const mat = mesh.material as THREE.MeshStandardMaterial;
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
    const mat = mesh.material as THREE.MeshStandardMaterial;
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
    this.drapeSample = null;
    this.drapeVersion++;
    const mat = mesh.material as THREE.MeshStandardMaterial;
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

  /** bumped each time the near ring is rebuilt — things laid on the rings (streets, creeks) are laid again */
  fineVersion = 0;

  /**
   * The height of the ground AS DRAWN under a world point — not the field, but the triangles of
   * whichever ring is showing there, worked out exactly the way the mesh was built. A street laid on
   * the 1 m field would sink under the coarse ring's straight 25 m spans in every hollow; laid on
   * this, it lies on what you see.
   */
  surfaceAt(x: number, z: number): number | null {
    const on = (c: THREE.Vector2, o: TerrainOpts | null, drop: number): number | null => {
      if (!o) return null;
      const n = o.segments, step = (o.radius * 2) / (n - 1);
      const gx = (x - (c.x - o.radius)) / step, gz = (z - (c.y - o.radius)) / step;
      if (gx < 0 || gz < 0 || gx >= n - 1 || gz >= n - 1) return null;
      const i = Math.floor(gx), j = Math.floor(gz), fx = gx - i, fz = gz - j;
      const h = (ii: number, jj: number) => {
        const ll = this.frame.toLngLat(c.x - o.radius + ii * step, c.y - o.radius + jj * step);
        return this.field.atOr(ll.lng, ll.lat, 0) + drop;
      };
      // the mesh's two triangles per cell: (a, d, b) below the diagonal and (b, d, e) above it
      if (fx + fz <= 1) { const a = h(i, j), b = h(i + 1, j), d = h(i, j + 1); return a + fx * (b - a) + fz * (d - a); }
      const b = h(i + 1, j), d = h(i, j + 1), e = h(i + 1, j + 1);
      return e + (1 - fx) * (d - e) + (1 - fz) * (b - e);
    };
    const inside = (c: THREE.Vector2, half: number) => Math.abs(x - c.x) < half && Math.abs(z - c.y) < half;
    const fine = this.fine && this.fineOpts ? on(this.fineCentre, this.fineOpts, 0) : null;
    const coarseShown = this.coarse && this.coarseOpts && !inside(this.clips.coarse.centre.value, this.clips.coarse.half.value);
    const coarse = coarseShown ? on(this.coarseCentre, this.coarseOpts, -0.15) : null;
    if (fine != null && coarse != null) return Math.max(fine, coarse);
    if (fine != null) return fine;
    if (coarse != null) return coarse;
    const farShown = this.far && this.farOpts && !inside(this.clips.far.centre.value, this.clips.far.half.value);
    return farShown ? on(this.farCentre, this.farOpts, -0.6) : null;
  }

  /** the photograph's colour of the ground under a world point, sRGB 0..1, or null where there is none */
  groundColour(x: number, z: number): [number, number, number] | null {
    const d = this.drapeSample;
    if (!d) return null;
    const ll = this.frame.toLngLat(x, z);
    const u = (ll.lng - d.west) / (d.east - d.west);
    const v = (Math.log(Math.tan(Math.PI / 4 + (ll.lat * Math.PI) / 360)) - d.mS) / (d.mN - d.mS);
    if (u < 0 || u >= 1 || v <= 0 || v > 1) return null;
    const px = Math.min(d.W - 1, Math.floor(u * d.W)), py = Math.min(d.H - 1, Math.floor((1 - v) * d.H));
    const i = (py * d.W + px) * 4;
    return [d.data[i] / 255, d.data[i + 1] / 255, d.data[i + 2] / 255];
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
    if (this.coarse) { this.group.remove(this.coarse); this.coarse.geometry.dispose(); (this.coarse.material as THREE.MeshStandardMaterial).map?.dispose(); }
    this.coarseCentre.set(centreX, centreZ);
    this.coarseOpts = o;
    this.coarse = this.build(centreX, centreZ, o, -0.15);
    this.coarse.name = 'terrain-coarse';
    clipInside(this.coarse.material as THREE.Material, this.clips.coarse);
    this.clips.far.centre.value.set(centreX, centreZ);
    this.clips.far.half.value = o.radius * 0.97;
    this.coarse.renderOrder = -1;
    this.group.add(this.coarse);
    if (this.distant) this.drapeDistant('coarse');
  }

  private farCentre = new THREE.Vector2();
  private farOpts: TerrainOpts | null = null;

  /** the horizon: the ridges across the valley, from the coarse global ground, dissolving into the haze */
  buildFar(centreX: number, centreZ: number, o: TerrainOpts) {
    if (this.far) { this.group.remove(this.far); this.far.geometry.dispose(); (this.far.material as THREE.MeshStandardMaterial).map?.dispose(); }
    this.farCentre.set(centreX, centreZ);
    this.farOpts = o;
    this.far = this.build(centreX, centreZ, o, -0.6);
    this.far.name = 'terrain-far';
    clipInside(this.far.material as THREE.Material, this.clips.far);
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
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.FrontSide, roughness: 1, metalness: 0 });
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
