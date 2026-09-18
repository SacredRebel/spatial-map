# spatial-map — the walkable world

The open world a member walks into. One world per community; Sulphur Mountain is the blueprint.

This is not a map. The [Ojai Atlas](https://github.com/SacredRebel/EcoVillage-map) is the map — the
strategy layer, where parcels, the county record, the planning and the siting live. This is the
place itself: real ground at a metre, what stands on it and what is proposed for it, every tree
the lidar saw, the sun where it actually is, and a body to walk it with.

**Live data, one source of truth.** Nothing here has its own opinion about where anything is. The
ground comes from the atlas's baked USGS 3DEP tiles and what is *proposed* from its
`data/structures.json`; what is *there* comes from the property's own **data pack** — one small
repository per property, loaded by URL, holding the surveyed boundary, the roofs the lidar
measured, every tree it saw, the road and the placed zones. Move a building in the atlas and it
moves here; correct a tree in the pack and it is corrected here. One engine, one pack per property,
like one game and many maps.

```
    playground-cosmos-view      EcoVillage-map            <property>-world          spatial-map
    identity · wallet · globe → the strategy layer    +   the property's record  →  the world you walk
    "enter portal"              parcels · siting          survey · lidar · zones     ground · trees · buildings · sun
```

The first pack is [sulphur-mountain-world](https://github.com/SacredRebel/sulphur-mountain-world).

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
| `pack` | the data pack's URL (a folder, or its `pack.json`); `0` for none. Sulphur Mountain has a default |
| `far` | a coarse `{z}/{x}/{y}` terrarium template for the ground beyond the property (default: the global Mapzen/AWS set); `0` for none |
| `t` | the hour to start at, community wall time — `?t=8` is a winter morning's light |
| `avatar` | a `.vrm` or `.glb` to walk in; anything that fails to load leaves you in the built-in body |
| `stick` | `1` shows the thumbstick on a desktop |
| `plants` | 0–2, multiplies the vegetation rule's density; the record's trees are never scaled |

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
cannot disagree, and there are no seams between tiles. Below the atlas's pyramid a second, global
terrarium set answers, so the ridges across the valley are real ridges 24 km out.

**`world/terrain.ts`** — three rings. A fine one you are standing in (640 m across, a vertex every
2.5 m) that is rebuilt as you leave it, a coarse one for the middle distance, and a far one out to
the ridges 24 km away that dissolves into the sky's own haze; the last two are built once. Vertex
colours come from slope and height, so the first frame costs one fetch of elevation and nothing
else. When a pack names an aerial, the fine ring is draped with it: the tiles over the ring go into
one canvas, every vertex gets the UV of its own longitude and latitude, and the texture updates tile
by tile as they land. If no tile lands the ring keeps its slope colours.

**`world/pack.ts`** and **`world/today.ts`** — the property's record, and what it puts on the
ground. `pack.json` names the layers; nothing in a pack is required and a missing file is an empty
layer, never an error. `today` raises the county's footprints to the heights the lidar measured
over them (and lays a "footprint" the lidar says is concrete flat), stands the roofs the county
does not map, draws the surveyed line and the found monuments, the easement, the county ring faintly
beside it so the drift is visible, the road as a strip on the ground (with the pack's asphalt on
it), and a post with a label at every placed zone — gold where something already stands, violet
where it is planned. The record is never rewritten: what the owner says has changed goes in the
pack's `edits` layer and is applied on top at load — fourteen trees are gone from around the house
that way.

**`world/grain.ts`** — the ground from a metre away. The aerial carries the colour of every square
metre and, under your feet, none of the grain. The pack's `materials` name four tiles — straw,
dirt, gravel, leaf litter — each a CC0 material recoloured to the owner's photographs of the land.
The shader reads the aerial's own colour under each point to choose the tile (gold is straw, pale
grey is gravel, green is canopy, and under a canopy the litter replaces the photograph outright),
normalises the tile to its mean so it adds texture and not colour, and fades it out between 25 and
90 m where the aerial takes over on its own.

**`world/sky.ts`** — a dome calibrated to photographs of the place rather than to a scattering
model. Three colours (zenith, the horizon away from the sun, the horizon towards it) keyed to the
sun's altitude, a tight forward-scatter glow, and the disc; each key colour is a photographed sRGB
value run backwards through the renderer's ACES curve, so noon straight up is the #5d8fd9 of the
owner's July photograph. Sunlight itself keeps a physical part — the atmosphere's extinction at
that altitude — which is what reddens the last hour. The same function gives the fog its colour and
the sky light its tint, so the three always agree; and the exposure opens as the sun drops, the way
an eye does.

**`world/vegetation.ts`** — a rule and a record. The rule is the Ojai rule: coast live oak on the
gentler, cooler, north-facing ground, chamise and ceanothus on the steep dry south faces, seeded by
position so nothing moves between visits. Where a pack has the lidar's trees, each is placed at its
own position with its own height and crown, and the rule stays out of that ground. Everything is
instanced: a wooded hillside costs about what an empty one does.

**`world/collide.ts`** — walls. Buildings are prisms over their footprint; a body that is inside one
with its head below the roof is pushed to the nearest edge. Reserved ground is deliberately not solid:
you are meant to stand in the footprint of a house that does not exist yet.

**`player/avatar.ts`** — the body. A built-in capsule at human proportions that always works, and a
loaded VRM or glTF when one is given. The walk cycle lives outside both and is paced by distance
covered, not by the clock, so the feet stay planted when the speed changes.

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

## Looking at a pack

`PACK_DIR=../sulphur-mountain-world node tests/serve.mjs` serves a pack from disk at
`/realpack/`, and `node scripts/shot.mjs "<url>" out.png [lng,lat,heading]` boots the built world
against it headless and writes a screenshot.

## What is next

- **Bark and leaves.** The pack already carries an oak-bark tile; the trees want a real silhouette,
  bark on the trunk and leaf cards for the crown, for all 3,649 of them.
- **Buildings.** Stucco, metal and shingle instead of flat colour; doors and windows from the
  owner's photographs of each building.
- **The ground's own photographs.** The tiles are CC0 materials matched to the property's colours;
  straight-down photographs of the straw, the drive and the litter would replace them with the
  land's own grain.
- **The house.** The new build as a `.glb`, sited from the surveyed line and never from the county
  ring, in the atlas's registry so it appears here the moment it is placed there.
- **Reconciliation.** The lidar is 2018. A way to stand at a tree and say *this one is gone*, and
  have the pack remember.
- **Real collision.** three-mesh-bvh against the models once there are models.
- **Presence.** Seeing each other: position, heading and animation state at about 10 Hz.

## Licence

MIT. Deliberately: the stack is three.js, three-mesh-bvh, BVHEcctrl and three-vrm, all MIT or
Apache, and nothing copyleft, so the community, token and member layers stay ours to licence.
