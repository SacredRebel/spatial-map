# The lighting contract

How light works in the world, so a design lit in the editor looks the same when it is walked.

A design that looks right where it was drawn and wrong where it is stood in is a bug in one of the
two, and it is this side that moves. So these are not suggestions — they are the numbers the world
actually uses, read out of the source rather than remembered.

Everything here lives in `src/world/sky.ts`, `src/world/sun.ts`, `src/world/looks.ts` and the
renderer setup in `src/main.ts`. If this document and that code disagree, the code is right and
this document is a bug.

---

## 1. The renderer

```
outputColorSpace      THREE.SRGBColorSpace
toneMapping           THREE.ACESFilmicToneMapping
toneMappingExposure   0.75 × sky.exposure          (see §2)
shadowMap.enabled     true
shadowMap.type        THREE.PCFSoftShadowMap
```

ACES is the single most consequential line. A material authored under linear or Reinhard tone
mapping and then shown under ACES will read darker and less saturated in the shoulder — pale
stucco goes grey, and glass loses its lift. **Match the tone mapping before tuning a single
material**, or every value tuned before that point has to be tuned again.

## 2. Exposure opens at dusk

```
sky.exposure = 1 + 0.9 × (1 − smoothstep(sunAltitude°, −2, 30))
```

Sun above 30°  → ×1.0, so the renderer sits at 0.75.
Sun below −2°  → ×1.9, so the renderer sits at 1.425.
Between        → smooth.

This is the eye adapting, not the sky getting brighter. Without it, dusk is a black screen; with a
constant exposure instead, midday blows out. If the editor shows a time of day at all, it needs
this curve, or a design checked at six in the evening will be judged on the wrong picture.

## 3. Where the sun is

NOAA solar position — real latitude, longitude and instant, with atmospheric refraction near the
horizon. `sunPosition(date, lat, lng)` returns:

```
altitude   degrees above the horizon, negative below
azimuth    degrees clockwise from NORTH
```

For this site: **lat 34.4331, lng −119.1554, timezone `America/Los_Angeles`.**

Do not approximate this with an angle slider mapped to a circle. The reason the real algorithm is
worth forty lines is that it answers the question a designer actually has — which way the light
comes in December, and how long the ridge keeps it — and an approximation gets December wrong by
enough to move a window.

## 4. The sun light

```
new THREE.DirectionalLight(0xffffff, 3)

intensity   = 0.02 + 3.6 × up × (0.35 + 0.65 × min(1, peak × 1.25))
colour      = white, lerped 0.35 toward the horizon colour as the sun nears the horizon
castShadow  = true
mapSize     = 4096 × 4096
bias        = −0.0004
normalBias  = 0.6
```

The 0.02 floor is moonlight-ish ambience so nothing is ever absolutely black. The colour lerp is
what makes six o'clock orange without tinting the whole scene.

`normalBias 0.6` is large on purpose: it is what stops shadow acne on the terrain at grazing sun.
A smaller value looks fine on a box and crawls with artefacts on a hillside.

## 5. Skylight

```
ambient.intensity = (0.1 + 1.5 × day) × skylightScale
```

## 6. The sky lights the scene — this is the important one

The sky dome is pre-filtered through `THREE.PMREMGenerator` into `scene.environment`, so surfaces
are lit by the actual colour of the sky above them.

**The dome is sampled at the ORIGIN, not riding the camera.** A hemisphere light cannot do this: it
gives one colour above and one below, so a west-facing wall at six in the evening gets the same
light as an east-facing one. The whole point is that it does not.

If the editor uses a hemisphere light as a stand-in, materials will be tuned to compensate for
light that is wrong in a way the world does not share, and every one of them will need redoing.
Use a PMREM'd sky, or accept that the editor's lighting is provisional and say so on screen.

## 7. Atmosphere

```
turbidity        4
rayleigh         1.0
mieCoefficient   0.005
```

Clear, dry, a little haze. A California valley in the dry season.

## 8. Ambient occlusion

```
near   0.25
far    400
fov    58          (the camera's own fov)
```

The camera sees 60 km so the far ridge is in frame; an occlusion buffer stretched that far reads
noise, so the occlusion keeps the picture's lens and drops its horizon to where occlusion resolves.

## 9. The rule the whole file keeps

Three quality tiers — `off`, `plain`, `full`. **The plain render is never taken away.** The
composer is an addition: tried once, dropped the moment it is unavailable or too slow, and the
world goes on drawing. A device that cannot afford the chain gets the world at speed, not a black
screen.

The editor should hold the same rule. A design tool that will not open on a laptop is a design tool
nobody uses on site.

---

## What this means for an editor

**Match, in this order:**

1. `SRGBColorSpace` + `ACESFilmicToneMapping` + exposure `0.75 × skyExposure`. Before anything else.
2. The sky as a PMREM environment, sampled at the origin.
3. The NOAA sun, at the site's real latitude and longitude.
4. The sun intensity and colour-lerp curve.
5. Shadow bias and normalBias, if the editor casts shadows on terrain.

**Do not:**

- bake lighting into materials — the world relights everything and baked light fights it
- substitute a hemisphere light for the sky IBL
- choose a different exposure because the editor looks nicer that way; the world is the reference
  and "nicer in the editor" means "wrong on site"
- tune materials before item 1 is done

**Presentation view** should use this same light at a stated time of day, and say which time. A
render with no time on it is a render that cannot be argued with.
