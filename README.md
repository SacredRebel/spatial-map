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

## The link

**https://spatial-map.vercel.app** — the production address, public, no login. The other addresses
Vercel shows (`spatial-map-git-main-…`, `spatial-…-pauls-projects-…`) are preview deployments
behind Vercel's own sign-in; they are for checking a build, not for sharing.

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

**G** flies — god mode. Anywhere, any height, no ground: **W A S D** along the look, **Space** up,
**X** down, **Shift** fast, wheel for speed, **G** again to land where you are.

**B** edits. The world becomes something you can correct: click a tree and mark it gone; pick up a
project's post and put it where it really goes; pin a marker with a name (the gate, the well, the
place a photograph was taken); draw a fence, a path, a road. Tools on **1–6**, **Enter** finishes a
line, **Esc** cancels, **Ctrl Z** undoes. In edit mode the left button selects and places and the
right button looks around. Construction is on **L F R O** (wall, floor, roof, opening).

**Blocks, at real size.** Tool **7** puts down a block — so many metres by so many, so high — facing
the way you face, on a metre grid that lies on the hillside (**V** shows it anywhere). Drag it to
move it (it snaps to the half metre), **[ ]** turn it in fifteen-degree steps, set its height, read
its footprint in metres and feet off the label over it. The atlas's designed structures (its
reserved sites, massing blocks and `.glb` models) are picked and moved the same way. A block is a
row of the atlas's `data/structures.json`, so what is placed here is what the atlas plans.

**The magic box.** Tool **8** puts down a box you can talk to. Say what you want there — typed, or
spoken, with the reply read back if you like — and the agent on the atlas answers and *proposes*, in
the map's own grammar: a block of such a size so many metres east of the box, a fence from here to
there, a marker, trees taken down, a tree planted. Each proposal is a card; nothing happens until
you take it, and a taken one is an ordinary unsaved edit — undo it, see it, save it like anything
else. The agent can do nothing a builder could not do by hand. With `ANTHROPIC_API_KEY` on the
atlas the agent is Claude with eleven tools and nothing else; without it, a small parser
answers plain commands and says so. The transcript stays with the box, in your browser.

**Territories and the ground.** Tool **9** draws a territory — click the corners, Enter closes the
ring — a translucent fill that lies on the hillside with a name and a kind (garden, orchard, pasture,
site, camp, water, keep, forest). Tool **0** shapes the ground inside a ring: *flatten* it to a pad at
the mean level of its outline, *raise* or *lower* it by so many metres, with a bank of a few metres
that eases back into the hill. The record's tiles are never rewritten: a shaping is one edit feature
the height field applies after the tiles, and because the terrain mesh, every tree, every building,
the walker and the grid all ask that one function, they follow without knowing.

**Construction.** A building here is *parts*: a wall is a line with a height and a thickness, a
floor is a polygon with a level, a roof is a polygon with a form. Tool **L** draws a wall along the
grid — every point snaps to the half metre and to the end of any wall near it; click the start again
and it closes into a room — with a height, a thickness, a material and, ticked, *curved*, which bends
a smooth curve through the points for organic, bio-mimetic forms. **F** lays a floor you stand on
(a slab, a deck, an upper storey at any level); **R** raises a roof — flat, shed, gable, hip or a
vault — with its eaves height, pitch and overhang, the ridge along the longest side; **O** cuts a
door or a window into a wall where you click. **room…** puts down a whole room where you stand: a
floor, a closed wall with a door in the side facing you, a roof. Select a part and every number is
changed in place on its card; drag it to move it, **[ ]** turn it, take it down alone or with every
part of its structure. Walls stop the walker except at the doors; floors are the ground once you are
on them. Each part is one feature of the pack's `build` layer, so the house is a dozen small files
of coordinates and not a model, and a later feature with the same id replaces the earlier one —
that is how a wall is changed. The magic box builds too: "a cabin 6 by 4 in adobe with a vault
roof", "a curved stone wall 10 m east with a door".

**Three roles.** A *member* walks, flies and reads — click a post, a building, a block, and a card
says what it is. A *builder* has every tool, and what a builder saves is a **proposal** that waits
for an admin. An *admin* saves at once and decides the proposals. The role comes from a PIN the
atlas checks (`POST /api/pack/role`); the table of who-may-what is `world/roles.ts`, one place,
so a wallet or a Holochain agent key can replace the PIN later without touching a gate.

Every edit is one feature of the pack's own `edits.geojson` grammar (`op` × `layer`: remove or add
trees, move or remove a project, add a marker, a line, a territory, a shaping, a part of a building),
applied on top of the record the moment
it is made, kept in the browser until it is saved, and downloadable as `edits.geojson`. **Save to
pack…** (or **propose…**) sends the edits and the structure changes with the PIN to the atlas's
`POST /api/pack/proposals`, which validates each one, records the proposal in git, and — for an
admin, or once an admin approves — commits the merged edits layer to the pack's repository and the
merged registry to the atlas's. The record itself is never rewritten: the lidar's 3,663 trees stay
in `trees.csv`; the edit is what takes one down.

**The ground comes with the pack.** A pack may carry its own 1 m pyramid (`layers.terrain` with
`kind: terrarium`, an `index` and a `template`, relative to the pack or absolute), and when it does
the world reads the ground from there — Sulphur Mountain's thirteen tiles live in its own
repository — and asks the atlas only for what is proposed. Without one, the atlas's pyramid is
used. Either is asked three times before the world gives up on it, and if neither answers the
world **still opens**, on the coarse global set (about 10 m between samples), with a notice at the
top saying so; it never stops at a message when there is ground to stand on.

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
there is a model to load. A model you can go into says so in its row (`enter: true`) and carries
its own floors and walls in the file — `extras.walk` on the scene, plan rings in model metres with
a top for each floor and a base and top for each wall — and the world stands on those and stops at
those instead of treating the outline as one solid block. A row may also say what standing thing
it replaces (`clears: ['house']`, by the kind the record draws it as), so a proposal is never drawn
through the building it is meant to succeed; and the record's trees inside a model's outline are
not drawn either, since nothing grows through a floor.

**Models are not built here.** A property's structures belong to that property's pack, together with
the scripts that generate them — one engine, one pack per property, and the engine carries no
property's content. The Oak Leaf and its generators live in
[sulphur-mountain-world](https://github.com/SacredRebel/sulphur-mountain-world): `scripts/glb.py`
writes the glTF, `scripts/oak-leaf.py` is the house, `scripts/plan.py` draws a measured plan from the
same walk floors and solids the world stands on, and `scripts/preview.mjs` renders a `.glb` on its own
before it goes anywhere near the ground. `node scripts/build-models.mjs` in that repository rebuilds
`models/`, which is committed and served with the rest of the pack. A change to a design is a change
to its script, never a hand edit of a mesh.

This repository needs no python to deploy and produces no `.glb`. It reads them.

**`world/looks.ts`** — how the light lands: ground-truth ambient occlusion over the frame, and the sky
dome pre-filtered into an environment map so a wall is lit by the sky it stands under rather than by
a guess. **Off unless asked for** — `?looks=auto|plain|full` — and the passes are fetched only when
someone asks, so a world with the chain off pays nothing for it. The plain render is never taken
away: anything that throws, and any machine that runs the chain slower than it is worth, falls back
to exactly the renderer the world had before the file existed.

**`edit/editor.ts`** — the pencil. Picking is a raycast against the record's instanced trees (the
instance id maps back to the row of the record), the standing things and the structures, and for the
ground a march along the ray against the height function, which is exact and needs no mesh. Every
action is one edit feature with its own id, `by: owner`, and the date, or one structure change (a
whole row, or an id to remove); undo steps back through snapshots; the unsaved work lives in
`localStorage` per pack and comes back on reload, minus anything the pack has since taken in.
**`edit/panel.ts`** is the view of it; **`edit/grid.ts`** the metre raster on the ground;
**`edit/magic.ts`** the box's chat — voice in through the browser's own recognition where it has
one, voice out through its speech, the agent's proposals taken through the editor's own methods;
**`ui/inspect.ts`** the member's card; **`world/roles.ts`** the table of who may do what;
**`world/shaping.ts`** the ground's shapings — a Polygon with an op, a target, an edge — applied
inside `HeightField.at()` after the tiles, with a smoothstep bank.

## Testing

**Taking the pencil.** `?role=builder` (or `admin`) grants the tools for this browser — draw, place,
shape, undo, all kept locally. Saving to the atlas still wants a PIN, which is where the gate always
belonged; drawing on your own screen was never the thing that needed protecting.

`npm test` serves a **synthetic hillside** — a tilted plane, base 500 m, rising 5 % east and falling
3 % north, encoded exactly the way the atlas encodes 3DEP — and drives the real built app against
it in Chromium. Every assertion is checked against a number worked out from that surface rather than
against whatever the renderer produced: the height under the player, the relief carried by the mesh,
the distance a second of walking covers, where the camera sits, where the sun is. The tiles are
generated on the spot by `tests/fixture.mjs` — no binaries in the repo, nothing to regenerate.

## Looking at a pack

`PACK_DIR=../sulphur-mountain-world node tests/serve.mjs` serves a pack from disk at
`/realpack/`, and `node scripts/shot.mjs "<url>" out.png [lng,lat,heading] [first|third|fly|edit|place]`
boots the built world against it headless and writes a screenshot — `fly` from 50 m up, `edit` with
the editor open and a marker, a fence and a path already drawn, `place` with a block on the grid,
`magic` at a box with a conversation and its proposals, `ground` with a pad flattened, a bank raised,
two territories and a block on the pad, `build` with a house put up part by part on a flattened pad —
a room, a curved adobe wing under a vault, a deck — and `inside` standing in its doorway.

## What is next

- **Bark and leaves.** The pack already carries an oak-bark tile; the trees want a real silhouette,
  bark on the trunk and leaf cards for the crown, for all 3,649 of them.
- **Buildings.** Stucco, metal and shingle instead of flat colour; doors and windows from the
  owner's photographs of each building.
- **The ground's own photographs.** The tiles are CC0 materials matched to the property's colours;
  straight-down photographs of the straw, the drive and the litter would replace them with the
  land's own grain.
- **The house, further.** The Oak Leaf is a massing — the shape at the right size on the right
  ground. What it wants next: the leaf shells from a real structural sketch (rib spacing, spans),
  the interior partitions, textures from the pack's materials on the stone and the timber, and the
  design itself settled against the sun study before any of that.
- **Construction, further.** Stairs between floors; walls that meet cleanly when drawn as separate
  lines; textures on the parts from the pack's materials; a model broken into parts (a `.glb` from
  meshy.ai split into walls, floor and roof so it is edited like the rest).
- **Real collision.** three-mesh-bvh against the models once there are models.
- **Presence.** Seeing each other: position, heading and animation state at about 10 Hz.

## Licence

MIT. Deliberately: the stack is three.js, three-mesh-bvh, BVHEcctrl and three-vrm, all MIT or
Apache, and nothing copyleft, so the community, token and member layers stay ours to licence.
