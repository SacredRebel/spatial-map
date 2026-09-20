// A flight over the place, built from the registry rather than written down.
//
//   The point of a tour is not to be impressive. It is to answer, in ninety seconds and without
//   anyone having to learn a control scheme, the question someone asks the first time they open
//   this: what is here, and in what order does it happen?
//
//   So the route is NOT a list of nice camera angles. It follows the registry's own `phase`, which
//   means the flight tells the phasing story on its own — everything in Phase 1 before anything in
//   Phase 2 — and it keeps telling the true story after the phasing changes, because nobody has to
//   remember to re-cut the tour. A hardcoded route is a route that is wrong by the end of the
//   month and confidently wrong, which is the worst kind.
//
//   Nothing here moves the world. The tour drives the same body a person drives, in the same fly
//   mode, through the same eye. What it shows is exactly what someone could walk to afterwards,
//   which is the only honest way to show something that is not built yet.

import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import { placeOf, type Structure } from './structures';

export interface Waypoint {
  lng: number;
  lat: number;
  /** metres above the ground beneath, never above sea level */
  altitudeM: number;
  /** what the eye is pointed at; the heading and pitch follow from it */
  lookAt: { lng: number; lat: number; heightM: number };
  /** seconds to fly here from the previous stop */
  travelS: number;
  /** seconds to linger once arrived */
  holdS: number;
  /** for the caption line, and for the suite to check the order */
  name: string;
}

/** how far out from a structure the eye sits while it looks at it, in metres */
const STANDOFF_M = 42;
/** and how high above the ground it holds — high enough to see a roof, low enough to feel near */
const EYE_M = 26;
/** the establishing shot, and the one it ends on */
const OPENING_M = 260;

export interface TourOpts {
  frame: Frame;
  field: HeightField;
  /** where the community's own way in is — the flight starts and ends looking from there */
  home: { lng: number; lat: number };
}

/**
 * Build the route.
 *
 *   Takes whatever the registry holds — including RESERVED SITES with nothing standing on them.
 *   My first instinct was to skip those, on the grounds that holding over bare ground reads as a
 *   mistake. It is the opposite: on a site where almost nothing is built, the empty ground IS the
 *   story, and "this is where the barn goes" is the sentence the whole flight exists to say. A
 *   tour that only visits finished buildings would, right now, be a tour of one house.
 *
 *   Ordered by phase, then by distance from home within a phase, so each phase plays as a walk
 *   outward rather than as a scatter.
 */
export function routeFrom(list: Structure[], opts: TourOpts): Waypoint[] {
  const { frame, field, home } = opts;
  const h = frame.toWorld(home.lng, home.lat);

  const stops = list
    .map(s => ({ s, at: placeOf(s) }))
    .filter((x): x is { s: Structure; at: [number, number] } => x.at !== null)
    .map(({ s, at }) => {
      const w = frame.toWorld(at[0], at[1]);
      return { s, at, dist: Math.hypot(w.x - h.x, w.z - h.z) };
    })
    .sort((a, b) => ((a.s.phase ?? 99) - (b.s.phase ?? 99)) || (a.dist - b.dist));

  const out: Waypoint[] = [];
  const groundAt = (lng: number, lat: number) => field.atOr(lng, lat, 0);

  // the establishing shot: high over home, looking at the first thing that happens
  const first = stops[0];
  if (!first) return out;
  out.push({
    lng: home.lng, lat: home.lat, altitudeM: OPENING_M,
    lookAt: { lng: first.at[0], lat: first.at[1], heightM: groundAt(first.at[0], first.at[1]) },
    travelS: 0, holdS: 2.5, name: 'the site'
  });

  for (const { s, at } of stops) {
    const [lng, lat] = at;
    const t = frame.toWorld(lng, lat);
    // approach from the side home is on, for the same reason a deep link does: you arrive the way
    // someone walking from the rest of the settlement would, and a building keeps its front
    const dx = h.x - t.x, dz = h.z - t.z;
    const len = Math.hypot(dx, dz) || 1;
    const eye = frame.toLngLat(t.x + (dx / len) * STANDOFF_M, t.z + (dz / len) * STANDOFF_M);
    out.push({
      lng: eye.lng, lat: eye.lat, altitudeM: EYE_M,
      lookAt: { lng, lat, heightM: groundAt(lng, lat) + 4 },
      travelS: 4.5, holdS: 2, name: s.name || s.id
    });
  }

  // and back up, so it ends where it began and can be played again without a cut
  out.push({
    lng: home.lng, lat: home.lat, altitudeM: OPENING_M,
    lookAt: { lng: first.at[0], lat: first.at[1], heightM: groundAt(first.at[0], first.at[1]) },
    travelS: 6, holdS: 1.5, name: 'the site'
  });
  return out;
}

/** ease in and out, so no leg starts or stops with a jerk */
const smooth = (t: number) => t * t * (3 - 2 * t);

/**
 * Fly the route.
 *
 *   Holds the eye's own state rather than reading it back from the player, because the player is
 *   free to be driven by a person at any moment and a tour that fights the mouse is worse than no
 *   tour. `stop()` simply stops writing; whatever the person does next, they do from here.
 */
export class Tour {
  route: Waypoint[] = [];
  leg = 0;
  t = 0;
  running = false;
  /** told the name of each stop as it is reached, for a caption */
  onStop: ((name: string, index: number, total: number) => void) | null = null;

  constructor(private frame: Frame, private field: HeightField) {}

  start(route: Waypoint[]) {
    this.route = route;
    this.leg = 0;
    this.t = 0;
    this.running = route.length > 1;
  }

  stop() { this.running = false; }

  /** total seconds the route takes, so a caller can say how long this is going to be */
  get durationS(): number {
    return this.route.reduce((s, w) => s + w.travelS + w.holdS, 0);
  }

  /**
   * Advance and return where the eye should be, or null when there is nothing to fly.
   *
   *   Returns a position rather than moving the player itself: the tour does not own the body, and
   *   a module that reaches into the player to move it is a module that has to be trusted not to
   *   do it at the wrong moment.
   */
  update(dt: number): { lng: number; lat: number; altitudeM: number; headingDeg: number; pitchDeg: number } | null {
    if (!this.running || this.route.length < 2) return null;
    this.t += dt;

    const to = this.route[this.leg + 1];
    if (!to) { this.running = false; return null; }
    const from = this.route[this.leg];

    const span = to.travelS + to.holdS;
    if (this.t >= span) {
      this.t -= span;
      this.leg++;
      if (this.leg + 1 >= this.route.length) { this.running = false; }
      else this.onStop?.(this.route[this.leg].name, this.leg, this.route.length - 1);
    }

    const w = this.route[this.leg + 1] ?? this.route[this.route.length - 1];
    const prev = this.route[this.leg] ?? from;
    // during the hold the leg is finished, so k pins to 1 and the eye sits still at the stop
    const k = w.travelS <= 0 ? 1 : smooth(Math.min(1, this.t / w.travelS));

    const lng = prev.lng + (w.lng - prev.lng) * k;
    const lat = prev.lat + (w.lat - prev.lat) * k;
    const altitudeM = prev.altitudeM + (w.altitudeM - prev.altitudeM) * k;

    // the target eases too, so the eye swings between subjects rather than snapping
    const tl = { lng: prev.lookAt.lng + (w.lookAt.lng - prev.lookAt.lng) * k,
                 lat: prev.lookAt.lat + (w.lookAt.lat - prev.lookAt.lat) * k,
                 heightM: prev.lookAt.heightM + (w.lookAt.heightM - prev.lookAt.heightM) * k };

    const a = this.frame.toWorld(lng, lat);
    const b = this.frame.toWorld(tl.lng, tl.lat);
    const eyeY = this.field.atOr(lng, lat, 0) + altitudeM;
    const dx = b.x - a.x, dz = b.z - a.z;
    const flat = Math.hypot(dx, dz);
    const headingDeg = ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
    const pitchDeg = (Math.atan2(tl.heightM - eyeY, flat) * 180) / Math.PI;
    return { lng, lat, altitudeM, headingDeg, pitchDeg };
  }
}
