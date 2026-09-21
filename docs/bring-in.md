# Bringing things in: models, phone scans, photos

v0.15 adds the **📥 bring in** tool (key I). Drop a file on the world, or choose it and click the
ground, and it stands on the hill there.

| brought in | files | drawn by |
|---|---|---|
| a model | `.glb`, or a `.gltf` that embeds its buffers | GLTFLoader + meshopt (no Draco, no KTX2) |
| a scan | `.spz` `.ply` `.splat` `.ksplat` `.sog` `.rad` | [Spark](https://sparkjs.dev) 2.2, loaded only when a scan is shown |
| a photo or sketch | `.jpg` `.png` `.webp` | made into a `.glb` by the atlas (Meshy), then as a model |

## Where it is kept

Everything is kept in this browser, in IndexedDB (`spatial-map-imports`): the file and its placing,
per pack. Nothing is uploaded. A scan of the property is a photograph of it, and it must not reach
a public repository by accident. A hosted copy is a separate, deliberate step. **⤓ file** hands the
file back.

## How it is set down

This is the convention anything else that places a scan or a model has to reproduce, for example
the pack's `layers.scans`.

1. **Scans only: stand it up.** A scan is turned half round its x axis, because a capture is y-down.
   **Hide strays** then makes fully transparent every splat outside its extent grown by a quarter.
   Nothing is deleted.
2. **Measure the extent.**
   - A model uses its bounding box.
   - A scan uses the 2nd to 98th percentile of its splat centres on each axis.
3. **Centre it.** The middle of that extent (x, z) goes to the item's `position` (lng, lat). Its base
   goes to the ground there: the box bottom for a model, the 2nd percentile of y for a scan.
4. **Transform it.** It is turned `turn` degrees clockwise seen from above, then scaled by `scale`.
   `lift` metres are added on top.
5. **Follow the ground.** Every half second it is set down again if the ground under it has changed,
   for example when a terrain tile arrives late.

Item fields:

| field | meaning |
|---|---|
| `position` | lng, lat of the base middle |
| `lift` | metres added on top of the ground |
| `turn` | degrees clockwise seen from above |
| `scale` | plain factor; 1 for a scan made in metres |
| `flip` | scans: stand it up (default on) |
| `tidy` | scans: hide strays (default on) |
| `native` | width, depth and height in metres before `scale` |

## Photo → 3D

1. The world shrinks the photo to 1280 px on its long side (JPEG).
2. It sends the photo to the atlas with the signed-in PIN, and polls every 5 s.
3. When the model is done, it fetches the GLB in parts of 3 MB.

The atlas side is `/api/image3d`, `/status` and `/part` in `EcoVillage-map/server-complete.js`, and
it needs `MESHY_API_KEY`.

- The provider's asset host sends no CORS headers, and a Vercel function answers with at most about
  4.5 MB. The parts get round both.
- A job costs about 30 Meshy credits. There is no job without a PIN.
- The **about N m tall** field sets the scale. Without it, Meshy's own size estimate (`auto_size`)
  stands.
