// The hillside you can see and walk on.
//
//   One mesh, not one per tile. The height field answers anywhere, so the geometry is a plain grid
//   over a square of ground with the heights sampled into it — which means no seams, no cracks
//   between levels of detail, and no bookkeeping about which tile owns which vertex.
//
//   Two rings: a fine one you are standing in and a coarse one out to the horizon. The fine ring is
//   rebuilt as you leave it; the coarse one is built once, because at that distance a metre does
//   not read. Vertex colours come from slope and height rather than a texture, so the first frame
//   costs one fetch of elevation and nothing else — a photographic drape comes later, from NAIP.

import * as THREE from 'three';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';

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
  private fineCentre = new THREE.Vector2(NaN, NaN);

  constructor(private frame: Frame, private field: HeightField) {
    this.group.name = 'terrain';
  }

  /** build (or rebuild) the patch the player is standing in */
  buildFine(centreX: number, centreZ: number, o: TerrainOpts) {
    if (this.fine) { this.group.remove(this.fine); this.fine.geometry.dispose(); }
    this.fine = this.build(centreX, centreZ, o, 0);
    this.fine.name = 'terrain-fine';
    this.group.add(this.fine);
    this.fineCentre.set(centreX, centreZ);
  }

  /** the horizon, built once and left alone */
  buildCoarse(centreX: number, centreZ: number, o: TerrainOpts) {
    if (this.coarse) { this.group.remove(this.coarse); this.coarse.geometry.dispose(); }
    this.coarse = this.build(centreX, centreZ, o, -0.15);
    this.coarse.name = 'terrain-coarse';
    this.coarse.renderOrder = -1;
    this.group.add(this.coarse);
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
    for (const m of [this.fine, this.coarse]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.fine = this.coarse = null;
  }
}
