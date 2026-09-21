// The grass at your feet.
//
//   From a standing height the ground within thirty metres is most of what you see, and a flat
//   photograph there — however good — reads as carpet. Sulphur Mountain in summer is wild oats and
//   bunch grass gone to straw, knee high, moving in the wind off the valley; in spring it is green.
//   So around wherever you stand a field of blades grows out of the ground, coloured by the aerial
//   under each clump where there is one (so a green swale stays green and a straw slope stays gold),
//   and kept off what is not grass: floors, walls, roads, paths, the gravel the photograph shows as
//   grey, and the leaf litter under an oak.
//
//   Instanced clumps, rebuilt as you walk, fading out towards the edge of the patch so the edge is
//   never a line. The same wind as the trees moves it, a little more, because grass moves more.

import * as THREE from 'three';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';

export interface GrassOpts {
  radius: number;
  /** blades per square metre, roughly; 0 grows nothing */
  density: number;
  /** anything inside these stays bare */
  keepOut: { ring: { x: number; z: number }[]; pad: number }[];
  /** lines on the ground that are not grass (roads, paths), with a half width */
  bare?: { pts: { x: number; z: number }[]; half: number }[];
  /** the ground's own colour under a point, sRGB 0..1, or null where nothing is known */
  groundColour?: (x: number, z: number) => [number, number, number] | null;
}

function rand(x: number, z: number, s: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263) + Math.imul(s, 2246822519)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x: number, z: number, s: number): number {
  const xi = Math.floor(x), zi = Math.floor(z), fx = x - xi, fz = z - zi;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = rand(xi, zi, s), b = rand(xi + 1, zi, s), c = rand(xi, zi + 1, s), d = rand(xi + 1, zi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** one clump: a few curved, tapering blades leaning out from a point */
function clumpGeometry(): THREE.BufferGeometry {
  const pos: number[] = [], col: number[] = [], nor: number[] = [], idx: number[] = [];
  const blades = 6, segs = 3;
  for (let b = 0; b < blades; b++) {
    const a = (b / blades) * Math.PI * 2 + b * 0.7;
    const lean = 0.18 + 0.12 * ((b * 37) % 5) / 5;
    const h = 0.34 + 0.22 * ((b * 53) % 7) / 7;
    const ox = Math.cos(a) * 0.05, oz = Math.sin(a) * 0.05;
    const dx = Math.cos(a), dz = Math.sin(a);
    const sx = -dz, sz = dx;                                   // across the blade
    const base = pos.length / 3;
    for (let i = 0; i <= segs; i++) {
      const t = i / segs;
      const w = 0.018 * (1 - t * 0.9);
      const bend = lean * t * t;
      const x = ox + dx * bend * h, y = h * t, z = oz + dz * bend * h;
      pos.push(x - sx * w, y, z - sz * w, x + sx * w, y, z + sz * w);
      // dark at the root, pale at the tip: the shade in a stand of grass, painted in
      const k = 0.72 + 0.4 * t;
      col.push(k, k, k, k, k, k);
      // lit as the ground is lit — straight up — so a field of blades reads as the ground, grown
      nor.push(0, 1, 0, 0, 1, 0);
    }
    for (let i = 0; i < segs; i++) {
      const q = base + i * 2;
      idx.push(q, q + 1, q + 2, q + 1, q + 3, q + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

function inRing(x: number, z: number, ring: { x: number; z: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}
function segDist(x: number, z: number, a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const t = l2 ? Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / l2)) : 0;
  return Math.hypot(x - a.x - t * dx, z - a.z - t * dz);
}

const STRAW: [number, number, number] = [0.78, 0.68, 0.45];
const GREEN: [number, number, number] = [0.52, 0.6, 0.33];

export class Grass {
  group = new THREE.Group();
  count = 0;
  private mesh: THREE.InstancedMesh | null = null;
  private geo = clumpGeometry();
  private mat: THREE.MeshStandardMaterial;
  private centre = new THREE.Vector2(NaN, NaN);

  constructor(private frame: Frame, private field: HeightField, wind: { value: number }) {
    this.group.name = 'grass';
    this.mat = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: 1, metalness: 0, envMapIntensity: 0.35 });
    this.mat.onBeforeCompile = shader => {
      shader.uniforms.uWind = wind;
      // both faces of a blade are lit as its normal says (up), not flipped dark on the back
      shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize(vNormal);');
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uWind;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
  float h = position.y * position.y * 6.0;
  float gust = 0.5 + 0.5 * sin(uWind * 0.6 + ip.x * 0.05 + ip.y * 0.04);
  float ph = uWind * 2.1 + ip.x * 0.9 + ip.y * 0.7;
  transformed.x += (sin(ph) * 0.05 + 0.06 * gust) * h;
  transformed.z += (cos(ph * 0.8) * 0.04 + 0.03 * gust) * h;
}`);
    };
    this.mat.customProgramCacheKey = () => 'grass';
  }

  /** grow (or regrow) the patch around a point */
  build(cx: number, cz: number, o: GrassOpts) {
    this.dispose();
    this.centre.set(cx, cz);
    if (o.density <= 0) return;
    const step = 1 / Math.sqrt(o.density);
    const r = o.radius;
    const g0x = Math.floor((cx - r) / step), g0z = Math.floor((cz - r) / step), n = Math.ceil((2 * r) / step);
    const mats: number[] = [], cols: number[] = [];
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), v = new THREE.Vector3(), s = new THREE.Vector3();
    // only the rings near this patch matter
    const near = o.keepOut.filter(k => k.ring.some(p => Math.abs(p.x - cx) < r + 20 && Math.abs(p.z - cz) < r + 20));
    const bare = (o.bare ?? []).filter(b => b.pts.some(p => Math.abs(p.x - cx) < r + 20 && Math.abs(p.z - cz) < r + 20));
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
      const gx = g0x + i, gz = g0z + j;
      const x = (gx + rand(gx, gz, 1)) * step, z = (gz + rand(gx, gz, 2)) * step;
      const d = Math.hypot(x - cx, z - cz);
      if (d > r) continue;
      // bunches and gaps, the way wild grass grows, and thinner towards the edge of the patch
      const clump = vnoise(x * 0.35, z * 0.35, 3) * 0.7 + vnoise(x * 1.7, z * 1.7, 4) * 0.3;
      const fade = d < r * 0.6 ? 1 : 1 - (d - r * 0.6) / (r * 0.4);
      if (rand(gx, gz, 5) > (clump * 1.4 - 0.15) * fade) continue;
      if (near.some(k => inRing(x, z, k.ring))) continue;
      if (bare.some(b => { for (let k = 0; k < b.pts.length - 1; k++) if (segDist(x, z, b.pts[k], b.pts[k + 1]) < b.half) return true; return false; })) continue;
      let colour: [number, number, number];
      const gc = o.groundColour?.(x, z) ?? null;
      if (gc) {
        const mx = Math.max(...gc), mn = Math.min(...gc), sat = (mx - mn) / Math.max(mx, 1e-3), lum = 0.2126 * gc[0] + 0.7152 * gc[1] + 0.0722 * gc[2];
        const canopy = gc[1] > Math.max(gc[0], gc[2]) * 1.02 && lum < 0.33;
        // grey and bright is gravel or a road; dark green is the shade of a crown and the litter under it
        if ((sat < 0.12 && lum > 0.35) || canopy || lum < 0.12) continue;
        // the blade takes the photograph's colour, lifted: seen from the side a blade is paler than from above
        colour = [Math.min(1, gc[0] * 1.15 + 0.04), Math.min(1, gc[1] * 1.15 + 0.04), Math.min(1, gc[2] * 1.05 + 0.02)];
      } else {
        const t = vnoise(x * 0.08, z * 0.08, 6);
        colour = [STRAW[0] + (GREEN[0] - STRAW[0]) * t * 0.6, STRAW[1] + (GREEN[1] - STRAW[1]) * t * 0.6, STRAW[2] + (GREEN[2] - STRAW[2]) * t * 0.6];
      }
      const ll = this.frame.toLngLat(x, z);
      const h = this.field.atOr(ll.lng, ll.lat, NaN);
      if (!isFinite(h)) continue;
      e.set((rand(gx, gz, 7) - 0.5) * 0.25, rand(gx, gz, 8) * Math.PI * 2, (rand(gx, gz, 9) - 0.5) * 0.25);
      q.setFromEuler(e);
      const sc = (0.6 + 0.9 * clump) * (0.55 + 0.45 * fade);
      v.set(x, h - 0.02, z);
      s.set(sc, sc * (0.8 + 0.5 * rand(gx, gz, 10)), sc);
      m.compose(v, q, s);
      mats.push(...m.elements);
      const k = 0.85 + 0.3 * rand(gx, gz, 11);
      cols.push(colour[0] * k, colour[1] * k, colour[2] * k);
    }
    const count = mats.length / 16;
    this.count = count;
    if (!count) return;
    const mesh = new THREE.InstancedMesh(this.geo, this.mat, count);
    mesh.instanceMatrix = new THREE.InstancedBufferAttribute(new Float32Array(mats), 16);
    // the colours arrive in sRGB from the photograph; the renderer wants linear
    const lin = cols.map(c => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(lin), 3);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.name = 'grass-blades';
    this.mesh = mesh;
    this.group.add(mesh);
  }

  /** regrow once you have walked a third of the way to the patch's edge; the full options are only worked out then */
  update(x: number, z: number, o: GrassOpts, full?: () => GrassOpts) {
    if (!isFinite(this.centre.x) || Math.hypot(x - this.centre.x, z - this.centre.y) > o.radius * 0.3) this.build(x, z, full ? full() : o);
  }

  dispose() {
    if (this.mesh) { this.group.remove(this.mesh); this.mesh.dispose(); this.mesh = null; }
    this.count = 0;
  }
}
