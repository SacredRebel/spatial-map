# the ring of world beyond the property

Someone standing on the Oak Leaf knoll should see the Ojai valley behind the
site, not a procedural nothing that stops at the parcel line. This is the note
about where that far distance comes from, and it exists because my first
recommendation was wrong and I would otherwise have quietly acted on it.

## what I recommended first, and why it was wrong

I said: pull **Cesium World Terrain** and **Cesium OSM Buildings** through
`3d-tiles-renderer`. Two of those three parts do not survive contact with the
formats.

## Cesium World Terrain (ion asset 1) — wrong format, and not needed anyway

World Terrain is **quantized-mesh**, not 3D Tiles. `3d-tiles-renderer` does not
load it and never will; using it would mean writing a quantized-mesh decoder.

That alone would be a reason to check whether it is worth it, and it is not.
The engine already samples real elevation, and that elevation has been checked
against the ground rather than assumed:

| point                | engine  | independent figure | apart  |
| -------------------- | ------- | ------------------ | ------ |
| Oak Leaf knoll       | 425.62 m| 425.90 m (registry)| 0.28 m |
| parcel low point     | 418.38 m| 418.41 m (measured)| 0.03 m |

A second elevation source that agrees with the first to within a third of a
metre buys nothing, and introduces a seam wherever the two disagree. Declined.

## Cesium OSM Buildings (ion asset 96188) — right format, empty of what we need

This one genuinely is 3D Tiles, so it would load. The question is what it would
draw. Cesium OSM Buildings is built from OpenStreetMap, so OSM answers that
directly. Counted around the property (lat 34.4331, lng −119.1554):

| radius   | buildings in OSM | with a stated height or storey count |
| -------- | ---------------- | ------------------------------------ |
| 500 m    | 44               | **0**                                |
| 1,500 m  | 232              | **0**                                |

Zero of 232. Every one of those arrives as a footprint with no height, so every
one is extruded to a default guess. On a site whose eleven survey monuments are
drawn to 0.00 m against a county-approved survey closing 0.007 ft over 2,999 ft,
putting 232 invented volumes in the middle distance is worse than drawing
nothing. It is confident and wrong, and anyone who knows this valley will see it
immediately. The price of that would be 3.5 MB of renderer. Declined.

## Bing Maps Aerial (ion asset 2) — the one worth having now

Imagery, not geometry: tiles draped over terrain the engine already has. No new
renderer, no second elevation source to seam against, and nothing invented — it
shows what is actually there. This is what would make the far ring read as Ojai.

It is unbuilt only because of the token problem below.

## Google Photorealistic 3D Tiles (ion asset 2275) — the real answer, later

Genuine 3D Tiles, and actually captured geometry rather than extruded
footprints. It returns **404 for this account**: the asset has to be added from
the ion Asset Depot before the token can see it. This is the one worth spending
`3d-tiles-renderer` on, and having it makes OSM Buildings redundant rather than
merely unattractive.

## the token, which is the actual blocker

A Cesium ion token scoped to `assets:read` is **designed to be public**. Cesium's
own integration puts it in client code, because the map is drawn in the browser
and the browser has to be able to ask for tiles. The protection is not secrecy —
it is the narrow scope plus a domain allowlist on the token itself.

So a token stored as a private variable cannot be read by this app at all. Vite
only exposes variables prefixed `VITE_`, which means the token has to be
`VITE_CESIUM_ION_TOKEN`, and the hosting platform will warn that this exposes it
to the browser. For a scoped, domain-locked `assets:read` token that warning is
expected and correct to accept. For any token with write scopes it is not — such
a token must never reach the client, and the fix there is a different token, not
a different prefix.

## the decision

| source                          | format         | verdict                                   |
| ------------------------------- | -------------- | ----------------------------------------- |
| Cesium World Terrain (1)        | quantized-mesh | no — unloadable here, and redundant       |
| Cesium OSM Buildings (96188)    | 3D Tiles       | no — 0 of 232 nearby buildings have heights |
| Bing Maps Aerial (2)            | imagery        | **yes** — once the token is client-visible |
| Google Photorealistic 3D (2275) | 3D Tiles       | **yes** — once added from the Asset Depot  |

Until then the far ring stays as it is: the engine's own terrain, which is the
only thing here that has been checked against the actual ground.
