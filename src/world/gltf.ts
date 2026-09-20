// One glTF loader, with the decoder the world can actually afford.
//
//   A model that meets its size budget is a compressed model, and a compressed model needs a
//   decoder on this side or it does not load at all. `EXT_meshopt_compression` goes into the
//   glTF's `extensionsRequired`, and GLTFLoader refuses outright to open a file that requires an
//   extension it has not been given — it does not fall back and it does not warn, it throws. So a
//   world without this is a world that silently shows nothing the moment anyone optimises a model.
//
//   MESHOPT, NOT DRACO, and the reason is the embed rule rather than the compression ratio.
//   Meshopt's decoder is a self-contained module inside three — JavaScript that fetches nothing.
//   Draco compresses this kind of geometry a little better, but its decoder is a separate .wasm
//   that has to be served from somewhere: a CDN, which the embed forbids, or a vendored binary
//   past the 200 kB limit. Meshopt costs one import and no network. That settles it.
//
//   Imported dynamically, like the loader was before, so a world that never loads a model pays
//   nothing for the ability to.

import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/** true once a loader has been built with the decoder attached — the suite checks this */
export let meshoptReady = false;

/**
 * A GLTFLoader that can open a compressed model.
 *
 *   Callers may still register their own plugins on the returned loader; this only guarantees the
 *   decoder is in place before anything is read.
 */
export async function makeGltfLoader(): Promise<GLTFLoader> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/libs/meshopt_decoder.module.js')
  ]);
  const loader = new GLTFLoader();
  // the decoder carries its own `ready` promise; GLTFLoader awaits it before touching a buffer
  loader.setMeshoptDecoder(MeshoptDecoder);
  meshoptReady = true;
  return loader;
}
