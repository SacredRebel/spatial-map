// The ground from a metre away.
//
//   The aerial carries the colour of every square metre of the property, and at ten metres out it
//   reads as a photograph; under your feet it is a blur, because 12 cm per pixel is all the county
//   flew. These tiles carry what the aerial cannot — the grain: the stalks of the mowed straw, the
//   stones in the drive, the leaves under the oaks. Each tile is normalised to its own mean, so it
//   adds texture without changing the colour; the colour stays the aerial's, which is real.
//
//   Which tile goes where is decided by the aerial's own colour under that point: bright and gold is
//   straw, pale and grey is gravel, green is canopy — and under a canopy the aerial shows leaves,
//   not ground, so there the leaf-litter tile replaces the photograph outright — and the rest is
//   dirt. The grain fades out between 25 and 90 m, where the aerial takes over on its own.
//
//   This is a shader patch on the ordinary material of the fine ring: two lines in the
//   vertex shader for a world-space UV, and one block after the map is sampled. Nothing else about
//   the terrain changes.

import * as THREE from 'three';
import type { PackMaterials } from './pack';

export interface GrainTiles {
  straw: THREE.Texture; dirt: THREE.Texture; gravel: THREE.Texture; litter: THREE.Texture;
  metres: { straw: number; dirt: number; gravel: number; litter: number };
  /** each tile's mean colour in linear light — the grain is the tile divided by this */
  means: { straw: THREE.Color; dirt: THREE.Color; gravel: THREE.Color; litter: THREE.Color };
}

/** the mean colour of a loaded image, in linear light */
function meanOf(t: THREE.Texture): THREE.Color {
  const img = t.image as HTMLImageElement | undefined;
  const c = document.createElement('canvas');
  c.width = c.height = 32;
  const g = c.getContext('2d', { willReadFrequently: true });
  if (!g || !img) return new THREE.Color(0.5, 0.5, 0.5);
  g.drawImage(img, 0, 0, 32, 32);
  const px = g.getImageData(0, 0, 32, 32).data;
  const lin = (v: number) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  let r = 0, gg = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += lin(px[i]); gg += lin(px[i + 1]); b += lin(px[i + 2]); }
  const n = px.length / 4;
  return new THREE.Color().setRGB(Math.max(r / n, 1e-3), Math.max(gg / n, 1e-3), Math.max(b / n, 1e-3), THREE.LinearSRGBColorSpace);
}

const NAMES = ['straw', 'dirt', 'gravel', 'litter'] as const;

/** fetch the four ground tiles a pack names; resolves to null if any of the four is missing */
export function loadGrain(materials: PackMaterials | null, small = false): Promise<GrainTiles | null> {
  if (!materials || !NAMES.every(n => materials[n])) return Promise.resolve(null);
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  const one = (url: string) => new Promise<THREE.Texture | null>(resolve => {
    loader.load(url, t => {
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 4;
      resolve(t);
    }, undefined, () => resolve(null));
  });
  return Promise.all(NAMES.map(n => one((small && materials[n].albedo_512) || materials[n].albedo))).then(ts => {
    if (ts.some(t => !t)) { ts.forEach(t => t?.dispose()); return null; }
    const [straw, dirt, gravel, litter] = ts as THREE.Texture[];
    return {
      straw, dirt, gravel, litter,
      metres: { straw: materials.straw.metres, dirt: materials.dirt.metres, gravel: materials.gravel.metres, litter: materials.litter.metres },
      means: { straw: meanOf(straw), dirt: meanOf(dirt), gravel: meanOf(gravel), litter: meanOf(litter) }
    };
  });
}

export const GRAIN_NEAR = 25, GRAIN_FAR = 90;

/** one repeating, colour-managed tile from a URL, or null if it cannot be fetched */
export function loadTile(url: string | undefined): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const loader = new THREE.TextureLoader();
  loader.setCrossOrigin('anonymous');
  return new Promise(resolve => loader.load(url, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    resolve(t);
  }, undefined, () => resolve(null)));
}

/**
 * Patch a Lambert material so its map gets the grain up close.
 *
 *   Returns the uniforms so the caller can change the fade distances. The material must have a
 *   map (the aerial); without one the patch is a no-op, because there is nothing to add grain to.
 */
export function applyGrain(mat: THREE.MeshLambertMaterial | THREE.MeshStandardMaterial, tiles: GrainTiles): Record<string, THREE.IUniform> {
  const uniforms: Record<string, THREE.IUniform> = {
    uStraw: { value: tiles.straw }, uDirt: { value: tiles.dirt }, uGravel: { value: tiles.gravel }, uLitter: { value: tiles.litter },
    uMetres: { value: new THREE.Vector4(tiles.metres.straw, tiles.metres.dirt, tiles.metres.gravel, tiles.metres.litter) },
    uMeanStraw: { value: tiles.means.straw }, uMeanDirt: { value: tiles.means.dirt }, uMeanGravel: { value: tiles.means.gravel },
    uGrainNear: { value: GRAIN_NEAR }, uGrainFar: { value: GRAIN_FAR }
  };
  mat.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vGrainXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrainXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vGrainXZ;
uniform sampler2D uStraw; uniform sampler2D uDirt; uniform sampler2D uGravel; uniform sampler2D uLitter;
uniform vec4 uMetres; uniform float uGrainNear; uniform float uGrainFar;
uniform vec3 uMeanStraw; uniform vec3 uMeanDirt; uniform vec3 uMeanGravel;
// two reads of one tile at different scales, so the repeat never shows
vec3 grainTile(sampler2D t, vec2 xz, float metres) {
  vec3 a = texture2D(t, xz / metres).rgb;
  vec3 b = texture2D(t, xz / (metres * 2.7) + vec2(0.37, 0.11)).rgb;
  return mix(a, b, 0.35);
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
#ifdef USE_MAP
{
  float near = smoothstep(uGrainFar, uGrainNear, length(vViewPosition));
  if (near > 0.002) {
    vec3 a = diffuseColor.rgb;                                    // the aerial, in linear light
    float lum = dot(a, vec3(0.2126, 0.7152, 0.0722));
    float mx = max(a.r, max(a.g, a.b)), mn = min(a.r, min(a.g, a.b));
    float sat = (mx - mn) / max(mx, 1e-4);
    float green = clamp((a.g - max(a.r, a.b)) / max(mx, 1e-4) * 5.0, 0.0, 1.0);   // canopy in the photograph
    float bright = smoothstep(0.10, 0.30, lum);
    float wStraw = (1.0 - green) * bright * smoothstep(0.10, 0.26, sat);
    float wGravel = (1.0 - green) * bright * (1.0 - smoothstep(0.10, 0.26, sat));
    float wDirt = max(0.0, 1.0 - green - wStraw - wGravel);
    vec3 straw = grainTile(uStraw, vGrainXZ, uMetres.x);
    vec3 dirt = grainTile(uDirt, vGrainXZ, uMetres.y);
    vec3 gravel = grainTile(uGravel, vGrainXZ, uMetres.z);
    vec3 litter = grainTile(uLitter, vGrainXZ, uMetres.w);
    // each tile as grain only: divided by its own mean, so it carries texture and not colour
    float wsum = wStraw + wDirt + wGravel;
    vec3 grain = wsum > 1e-3 ? (straw / uMeanStraw * wStraw + dirt / uMeanDirt * wDirt + gravel / uMeanGravel * wGravel) / wsum : vec3(1.0);
    vec3 coloured = a * mix(vec3(1.0), grain, near);
    diffuseColor.rgb = mix(coloured, litter, green * near);        // under the canopy, the litter is the ground
  }
}
#endif`);
  };
  mat.customProgramCacheKey = () => 'grain';
  mat.needsUpdate = true;
  return uniforms;
}
