# spatial-map — the walkable world

The open world a member walks into. One world per community; Sulphur Mountain is the blueprint.

This is not a map. The [Ojai Atlas](https://github.com/SacredRebel/EcoVillage-map) is the map — the
strategy layer, where parcels, the county record, the planning and the siting live. This is the
place itself: real ground at a metre, the buildings that are proposed for it, the sun where it
actually is, and a body to walk it with.

**Live data, one source of truth.** Nothing here has its own opinion about where anything is. The
ground comes from the atlas's baked USGS 3DEP tiles, the buildings from its `data/structures.json`,
the models from its `public/models`. Move a building in the atlas's placement studio and it moves
here. The atlas serves those three things with permissive CORS precisely so this can be a separate
app on a separate host.

```
    playground-cosmos-view          EcoVillage-map              spatial-map
    identity · wallet · globe  →    the strategy layer     →    the world you walk
    "enter portal"                  parcels · data · siting     ground · buildings · sun
```

## Run it

```bash
npm install
npm run dev        # http://localhost:5180
npm run build      # typecheck, then build to dist/
npm test           # the world, driven in a real browser against a known hillside
```

By default it reads the live atlas. Point it somewhere else with `?atlas=`:

```
/?community=sulphur-mountain
/?community=howard&at=-119.3197,34.4242,180
/?atlas=http://localhost:5001
```

| Parameter | Means |
| --- | --- |
| `community` | which world: `sulphur-mountain`, `howard`, `keris-property`, `chers-property` |
| `at` | `lng,lat,heading` — where to stand, and which way to face |
| `atlas` | the origin to read the ground and the structures from |

## Controls

**W A S D** move · **Shift** run · **Space** jump · **C** first person · **Q E** turn · drag or click
to look around · wheel to pull the camera back. Touch: one finger looks.

## How it is put together

**`world/geo.ts`** — the local frame. Each community has an origin, and everything inside the world
is metres east, metres north and metres up from it. Over a few hundred metres the flat-earth error
is millimetres, and in exchange the physics, the camera and the models all speak the same unit as a
tape measure.

**`world/heightfield.ts`** — the ground as a function. Terrarium tiles are decoded once into height
arrays and exposed as `at(lng, lat)`, bilinearly interpolated. The terrain mesh is that function
sampled on a grid, and the walker stands on the same function — so what you see and what you walk on
cannot disagree, and there are no seams between tiles.

**`world/terrain.ts`** — two rings. A fine one you are standing in (640 m across, a vertex every
2.5 m) that is rebuilt as you leave it, and a coarse one out to the horizon built once. Vertex
colours come from slope and height rather than a texture, so the first frame costs one fetch of
elevation and nothing else.

**`world/sun.ts`** — the NOAA solar position algorithm, and the instant that is a given wall-clock
time *at the community* rather than wherever the viewer happens to be. Getting that wrong would move
every shadow by hours.

**`player/player.ts`** — a character controller, not a flying camera. Third person by default,
because the point of a world is to be somebody in it. Collision against the hillside is a height
query rather than a physics broadphase; the physics runs at a fixed 20 Hz however fast the page
draws, so a laptop at four frames a second walks at the same speed as a workstation.

**`world/structures.ts`** — what is proposed to stand here, in the same three states the atlas
draws: reserved ground, a massing block, or a real `.glb`. The glTF loader is imported only when
there is a model to load.

## Testing

`npm test` serves a **synthetic hillside** — a tilted plane, base 500 m, rising 5 % east and falling
3 % north, encoded exactly the way the atlas encodes 3DEP — and drives the real built app against
it in Chromium. Every assertion is checked against a number worked out from that surface rather than
against whatever the renderer produced: the height under the player, the relief carried by the mesh,
the distance a second of walking covers, where the camera sits, where the sun is. The tiles are
generated on the spot by `tests/fixture.mjs` — no binaries in the repo, nothing to regenerate.

## What is next

- **Avatars.** VRM (`@pixiv/three-vrm`), so a Playground avatar drops in without conversion. The
  placeholder body is deliberately crude and deliberately the right size.
- **Vegetation.** Oaks and chaparral scattered by rule — slope, aspect, and the canopy visible in
  NAIP — then GPU-instanced. Ten thousand trees should cost about what ten cost.
- **A photographic ground.** NAIP orthophoto baked per property, blended over the slope shading.
  Public domain, unlike map-service imagery.
- **Real collision.** three-mesh-bvh against the buildings, and a proper character controller
  (pmndrs `BVHEcctrl`) once there is something to bump into.
- **Presence.** Seeing each other: position, heading and animation state at about 10 Hz. The shape
  is being designed now and wired later, ahead of the move to Rust and Holochain.

## Licence

MIT. Deliberately: the stack is three.js, three-mesh-bvh, BVHEcctrl and three-vrm, all MIT or
Apache, and nothing copyleft, so the community, token and member layers stay ours to licence.
