# Organic buildings, marked ground, and the agent

This page is the contract for three things that arrived together in v0.14:

- the organic generator, which grows a whole building inside a drawn line
- marking ground or parts for the agent
- the two proposals the agent can now make: `organic` and `modify`

It is written so that anything else that designs buildings for this world (a studio, a script, a
model) can produce the same data and have the world draw it.

## The spec

An organic building is grown from an `OrganicSpec` and a perimeter. The perimeter is a ring of
`[lng, lat]` points, and the whole building, eave included, fits inside it. The spec sets the shape
and the make-up, and `world/organic.ts` (`cleanSpec`) clamps every field to the range below.

| field | range / values | meaning |
|---|---|---|
| `form` | `fit` `lobed` `oval` `leaf` `shell` | the shape of the plan: `fit` follows the drawn edge, `lobed` is a flower of lobes, `shell` is a nautilus curl |
| `lobes` | 2–12 | lobed only |
| `depth` | 0–0.6 | how deep the valleys between lobes are; for `shell`, how tight the curl is |
| `turn` | −360–360° | turns the form about its centre |
| `inset` | 0–10 m | how far the walls keep in from the perimeter, beyond the eave |
| `height` | 2.2–9 m | wall height, from the ground to the eaves |
| `rise` | 0.3–8 m | how far the shell roof's crown rises above the eaves |
| `overhang` | 0–3 m | how far the eave reaches past the walls |
| `thick` | 0.12–1 m | wall thickness (cob about 0.45) |
| `structure` | `steel` `timber` `bamboo` `none` | the frame |
| `infill` | `cob` `hempcrete` `strawbale` `rammed_earth` `adobe` `stone` `plaster` `wood` `timber` `glass` | what fills the walls; this is also the wall's material |
| `insulation` | `hemp` `wool` `cork` `strawbale` `none` | roof insulation |
| `roof` | `solar` `living` `metal` `thatch` `tile` `shingle` | the roof finish |
| `solar` | 0–1 | the share of the sun-facing roof that carries panels |
| `glazing` | 0–1 | the share of the view-facing wall that is glass |
| `facing` | 0–360° | the compass bearing the glass faces (180 is south) |
| `door` | 0–360° | the compass bearing of the door, measured from the middle of the plan |
| `floor` | `earth` `stone` `wood` `concrete` `timber` | the floor finish |
| `pad` | boolean | whether to level a pad under the building first |

## What gets drawn

The building is stored as ordinary pack features: parts that are walked on, moved, cut, undone and
saved like anything else drawn by hand. All of them share one `structure` name.

- **pad.** A `terrain` feature with `terrain_op: flatten` and `edge_m: 3`, over the floor ring pushed
  out 1 m.
- **floor.** A `build` feature with `kind: floor`, `level_m: 0` and `thick_m: 0.3`. It also carries
  **`organic`**: the full spec, plus `perimeter` (the ring it was fitted inside) and `pad_id`. That
  record is what lets the building be grown again.
- **wall.** A `build` feature with `kind: wall` on a closed ring of about 40 points and
  `smooth: true` (a closed Catmull–Rom curve). It has the `openings` (one door plus windows across
  the view-facing arc) and an `assembly` of `{ structure, infill, insulation }`.
- **roof.** A `build` feature with `kind: roof` and `form: shell`. Its settings are `eaves_m`,
  `rise_m`, `overhang_m`, `finish`, `solar_ratio`, `solar_facing_deg` and an `assembly` of
  `{ roof_structure, insulation }`.

`world/shell.ts` makes the shell. It lofts from the plan's pole, the point furthest from any wall.
The height at a point is `eaves + rise·(1 − ρ^2.2)`, where ρ is how far along its spoke from the pole
to the wall the point sits. Past the wall the same curve droops into the eave. `solarSpots()` lays
the panels on that same surface, where it faces the sun and is shallower than 42°. The model, the
panel count and the quantities all come from this one function.

The quantities, from `organicPlan().quantities`, are:

- floor m² and sq ft
- wall length, gross and net area, and infill m³
- glazing m²
- roof plan and surface area, and insulation m³
- frame kg
- panels, kWp, and a rough kWh per year at 1,650 kWh per kWp

## Marking ground

The **✦ mark for AI** tool (M) takes ground in one of two ways: press and drag a lasso round it, or
click its corners and press Enter. Every build part with any of itself inside the mark is taken in,
together with the rest of the structure it belongs to. The agent's panel then opens on the mark.

With the mark, the agent receives:

```json
{ "ring_en": [[e, n], ...], "area_m2": 700,
  "selected": [{ "id": "e-…", "kind": "wall", "structure": "…", "material": "cob", "height_m": 3.2,
                 "thick_m": 0.45, "smooth": true, "openings": [...], "points_en": [[e, n], ...] }] }
```

All distances are metres east and north of the mark's centre.

## The proposals

```ts
{ type: 'organic', name, spec: Partial<OrganicSpec>, points?: [e, n][] }   // no points → fit the mark
{ type: 'modify', ids: string[],
  height_m?, height_delta_m?, thick_m?, material?, smooth?,
  bulge_m?, bulge_dir?: 'left'|'right'|'out'|'in',       // left/right as the viewer sees it
  add_windows?, window_width_m?, window_sill_m?, window_head_m?, add_door?,
  rise_delta_m?, eaves_delta_m?, roof_finish? }
```

The atlas agent (`POST /api/agent`) proposes these through its `build_organic` and `modify_parts`
tools. It may only modify ids that were marked; any other id is dropped. With no model key, the atlas
reads the plain words instead.

When the atlas cannot be reached at all (no PIN, no network), the world's own `Magic.localAgent()`
does the same plain-words reading. So this works without the atlas:

- mark walls and say "make these walls higher, curve them to the right and add a window"
- mark empty ground and say "an organic house with a steel frame, cob walls, hemp insulation and a
  solar roof"

Nothing is applied until the person takes the card. Once taken, it is an ordinary unsaved edit, and
one undo reverses it.
