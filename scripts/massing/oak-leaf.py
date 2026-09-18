"""
The Oak Leaf — a massing model of the house proposed for Sulphur Mountain, at real size.

  Three leaves on the knoll: a tall central leaf for the great room, its tip to the south over the
  drive and its base opening north to the pool; two lower leaves splayed east (kitchen and dining,
  by the outdoor fire) and west (the private lounge, toward the oaks). The heart is the river-stone
  chimney of the house that stands here now — the great room is built around it, so the model's
  origin IS that chimney, and everything is measured from it.

  Levels, in metres above the main floor (which sits at 425.9 m, the top of the knoll):
    -3.3  the lower floor: three suites cut into the south bank, each with a door onto the court
    -3.5  the parking court, dug from the bank down to the drive
     0    the main floor: foyer, great room, kitchen and dining, lounge, the north terrace
     3.7  the loft over the north half of the great room: the master suite, open to below
     9.8  the ridge of the central leaf; the wings peak at 7.0

  The plan is the owner's own marks on the aerial: the pool north-east, the outdoor fire east,
  the oak lounge west, the sacred gardens along the bank to the south-west. Their positions are
  those marks, read off the graticule to about three metres.

  Nothing here is a finished design. It is the shape at the right size on the right ground, so it
  can be walked around and argued with before anyone draws a wall for real.

    python3 scripts/massing/oak-leaf.py out.glb [plan.png]
"""
import json
import math
import sys
from pathlib import Path

import numpy as np
from scipy.interpolate import PchipInterpolator

sys.path.insert(0, str(Path(__file__).parent))
from glb import Model, Material, circle, rect, inside  # noqa: E402

# ---- materials -------------------------------------------------------------------------------
GREEN = Material('living roof', (0.30, 0.42, 0.20), rough=0.95)
TIMBER = Material('timber', (0.55, 0.38, 0.22), rough=0.7, double=True)
RIB = Material('timber rib', (0.42, 0.27, 0.15), rough=0.7)
GLASS = Material('glass', (0.72, 0.85, 0.92), alpha=0.32, rough=0.15, double=True)
BRONZE = Material('bronze', (0.25, 0.20, 0.15), rough=0.5, metal=0.3)
STONE_FLOOR = Material('travertine', (0.80, 0.74, 0.62), rough=0.8)
RIVER_STONE = Material('river stone', (0.52, 0.48, 0.42), rough=0.95)
CONCRETE = Material('concrete', (0.60, 0.58, 0.54), rough=0.9)
WATER = Material('water', (0.25, 0.55, 0.75), alpha=0.7, rough=0.05)
POOL_FLOOR = Material('pool floor', (0.55, 0.75, 0.85), rough=0.4, double=True)
DECK = Material('timber deck', (0.62, 0.45, 0.28), rough=0.75)
DARK_STONE = Material('dark stone', (0.30, 0.28, 0.26), rough=0.95)


def P(e, n, y=0.0):
    """plan (east, north) → model (x east, y up, z south)"""
    return (float(e), float(y), float(-n))


def ring_xz(pts):
    return [(float(e), float(-n)) for e, n in pts]


class Leaf:
    """one leaf of the roof: a pointed tip, a rounded base, a folded shell between"""

    def __init__(self, name, tip, base, width, ridge, eave=None, wall=0.85, fold=1.35, widest=0.6):
        self.name = name
        self.tip = np.array(tip, float); self.base = np.array(base, float)
        d = self.base - self.tip; self.L = float(np.linalg.norm(d)); self.a = d / self.L
        self.n = np.array([-self.a[1], self.a[0]])           # across, to the left looking from the tip to the base
        self.W = width; self.wall = wall; self.fold = fold; self.widest = widest
        self.ridge = PchipInterpolator([p[0] for p in ridge], [p[1] for p in ridge])
        # the edge of the leaf: low along the flanks, lifting at the tip and the base like a leaf curling up
        eave = eave or [(0, 4.6), (0.25, 3.1), (0.6, 2.9), (0.85, 3.1), (1, 3.9)]
        self.eave_curve = PchipInterpolator([p[0] for p in eave], [p[1] for p in eave])

    def half(self, t):
        tm = self.widest
        if t <= tm: return self.W / 2 * math.sin(math.pi / 2 * t / tm) ** 0.8
        u = (t - tm) / (1 - tm)
        return self.W / 2 * math.sqrt(max(0.0, 1 - u * u))

    def eave(self, t):
        return float(self.eave_curve(t))

    def plan(self, t, v):
        return self.tip + self.a * (t * self.L) + self.n * (v * self.half(t))

    def top(self, t, v):
        e = self.eave(t); r = float(self.ridge(t))
        return e + (r - e) * (1 - abs(v) ** self.fold)

    def outline(self, v=None, n=40):
        """the plan ring at |v| (the wall line by default), tip to base and back"""
        v = self.wall if v is None else v
        ts = np.linspace(0, 1, n)
        left = [self.plan(t, v) for t in ts]; right = [self.plan(t, -v) for t in ts[::-1]]
        return [tuple(p) for p in left + right]


def leaf_shell(m, leaf, thick=0.32, nt=56, nv=25):
    ts = np.linspace(0, 1, nt); vs = np.linspace(-1, 1, nv)
    top = np.zeros((nt, nv, 3)); sof = np.zeros((nt, nv, 3))
    for i, t in enumerate(ts):
        for j, v in enumerate(vs):
            e, n = leaf.plan(t, v); y = leaf.top(t, v)
            top[i, j] = P(e, n, y); sof[i, j] = P(e, n, y - thick)
    m.grid(GREEN, top, up=True)
    m.grid(TIMBER, sof, up=False)
    for side in (0, nv - 1):                                   # the edge band, top to soffit
        for i in range(nt - 1):
            a, b = top[i, side], top[i + 1, side]; c, d = sof[i + 1, side], sof[i, side]
            if side == 0: m.quad(TIMBER, a, b, c, d)
            else: m.quad(TIMBER, d, c, b, a)
    # ribs across, hung under the soffit and showing as veins on top; a midrib beam along, both sides
    for t in np.arange(0.12, 0.97, 2.4 / leaf.L):
        path = [P(*leaf.plan(t, v), leaf.top(t, v) - thick - 0.22) for v in np.linspace(-1, 1, 25)]
        m.sweep(RIB, path, 0.18, 0.45)
        path = [P(*leaf.plan(t, v), leaf.top(t, v) + 0.1) for v in np.linspace(-1, 1, 25)]
        m.sweep(RIB, path, 0.16, 0.24)
    path = [P(*leaf.plan(t, 0), leaf.top(t, 0) - thick - 0.3) for t in np.linspace(0.06, 0.98, 30)]
    m.sweep(RIB, path, 0.3, 0.6)
    path = [P(*leaf.plan(t, 0), leaf.top(t, 0) + 0.14) for t in np.linspace(0.02, 0.99, 30)]
    m.sweep(RIB, path, 0.28, 0.32)
    for side in (1, -1):                                      # the rim: a timber edge the leaf is bound with
        path = [P(*leaf.plan(t, side), leaf.top(t, side) - thick / 2) for t in np.linspace(0.005, 0.995, 40)]
        m.sweep(TIMBER, path, 0.3, thick + 0.16)


def leaf_walls(m, leaf, doors, skip_inside=(), step=1.8, floor=0.0):
    """glass under the eave on both flanks, a bronze post at each bay, and a wall solid per bay;
    `doors` are (t0, t1) spans left open on both sides; a bay whose middle is inside one of the
    rings in `skip_inside` is open too (that is where another leaf joins)"""
    nb = max(2, int(round(leaf.L / step)))
    ts = np.linspace(0, 1, nb + 1)
    v = leaf.wall
    for side in (1, -1):
        for i in range(nb):
            t0, t1 = ts[i], ts[i + 1]; tm = (t0 + t1) / 2
            if any(a <= tm <= b for a, b in doors): continue
            em, nm = leaf.plan(tm, side * v)
            if any(inside(em, -nm, r) for r in skip_inside): continue
            e0, n0 = leaf.plan(t0, side * v); e1, n1 = leaf.plan(t1, side * v)
            y0 = leaf.top(t0, v) - 0.32; y1 = leaf.top(t1, v) - 0.32
            m.grid(GLASS, [[P(e0, n0, floor), P(e1, n1, floor)], [P(e0, n0, y0), P(e1, n1, y1)]], up=True)
            # the solid: a thin bay, 0.16 m through
            ne = leaf.n * side * 0.08
            ring = [(e0 - ne[0], n0 - ne[1]), (e1 - ne[0], n1 - ne[1]), (e1 + ne[0], n1 + ne[1]), (e0 + ne[0], n0 + ne[1])]
            m.solid(ring_xz(ring), floor, max(y0, y1), f'{leaf.name} wall')
        # posts
        for t in ts:
            if any(a <= t <= b for a, b in doors): continue
            e, n = leaf.plan(t, side * v)
            if any(inside(e, -n, r) for r in skip_inside): continue
            post = rect(e - 0.07, -n - 0.07, e + 0.07, -n + 0.07)
            m.extrude(BRONZE, post, floor, leaf.top(t, v) - 0.32)


def stair(m, mat, x0, z0, dx, dz, w, rise, n, y0, name):
    """n steps from (x0,z0) going (dx,dz) per step, `w` wide across; step i's top is y0 + rise*i"""
    across = np.array([-dz, dx]); across = across / max(np.linalg.norm(across), 1e-9) * w / 2
    for i in range(1, n + 1):
        a = np.array([x0 + dx * (i - 1), z0 + dz * (i - 1)]); b = np.array([x0 + dx * i, z0 + dz * i])
        ring = [tuple(a - across), tuple(b - across), tuple(b + across), tuple(a + across)]
        top = y0 + rise * i
        m.extrude(mat, ring, y0 - 0.05, top)
        m.floor(ring, top, f'{name} step {i}')


def balustrade(m, pts, y, h=1.05):
    for i in range(len(pts) - 1):
        (x0, z0), (x1, z1) = pts[i], pts[i + 1]
        m.grid(GLASS, [[(x0, y, z0), (x1, y, z1)], [(x0, y + h, z0), (x1, y + h, z1)]], up=True)
        m.sweep(BRONZE, [(x0, y + h, z0), (x1, y + h, z1)], 0.06, 0.06)


def build():
    m = Model('The Oak Leaf — massing')

    # ---- the three leaves ------------------------------------------------------------------
    central = Leaf('central', tip=(0, -15), base=(0, 11), width=13,
                   ridge=[(0, 5.8), (0.3, 7.6), (0.62, 9.8), (0.85, 8.4), (1.0, 5.6)], widest=0.62)
    west = Leaf('west wing', tip=(-17.5, 5.6), base=(-3.5, 0.5), width=9.5,
                ridge=[(0, 5.6), (0.35, 6.2), (0.75, 7.0), (1.0, 6.4)], widest=0.62)
    east = Leaf('east wing', tip=(20.5, 9.2), base=(4.5, 1.5), width=9.5,
                ridge=[(0, 5.6), (0.35, 6.2), (0.75, 7.0), (1.0, 6.4)], widest=0.62)
    leaves = [central, west, east]
    for leaf in leaves: leaf_shell(m, leaf)

    c_ring = central.outline(); w_ring = west.outline(); e_ring = east.outline()
    c_xz, w_xz, e_xz = ring_xz(c_ring), ring_xz(w_ring), ring_xz(e_ring)

    # floors: a slab under each leaf, a hand wider than the wall line
    for leaf, xz in ((central, c_xz), (west, w_xz), (east, e_xz)):
        m.extrude(STONE_FLOOR, ring_xz(leaf.outline(v=0.92)), -0.4, 0.0)
        m.floor(xz, 0.0, f'{leaf.name} floor')

    # walls: the central leaf opens at its tip (the entrance), its base (the north terrace), onto
    # the roof terrace on the west flank, and wherever a wing joins; each wing opens at its tip
    leaf_walls(m, central, doors=[(0, 0.1), (0.27, 0.36), (0.92, 1.0)], skip_inside=(w_xz, e_xz))
    leaf_walls(m, west, doors=[(0, 0.12), (0.84, 1.0)], skip_inside=(c_xz,))
    leaf_walls(m, east, doors=[(0, 0.12), (0.84, 1.0)], skip_inside=(c_xz,))

    # ---- the chimney: the river-stone heart, standing where it stands today ----------------
    chim = circle(0, 0, 1.1, 12)
    m.extrude(RIVER_STONE, chim, -0.5, 11.2)
    m.solid(chim, -0.5, 11.2, 'chimney')
    hearth = rect(-1.6, 0.9, 1.6, 2.4)                          # the plinth, on the south side
    m.extrude(DARK_STONE, hearth, 0, 0.45)
    m.floor(hearth, 0.45, 'hearth')

    # ---- the loft over the north half of the great room -------------------------------------
    ts = np.linspace(0.58, 0.9, 16)
    loft = [tuple(central.plan(t, 0.78)) for t in ts] + [tuple(central.plan(t, -0.78)) for t in ts[::-1]]
    m.extrude(STONE_FLOOR, ring_xz(loft), 3.4, 3.7)
    m.floor(ring_xz(loft), 3.7, 'loft')
    edge = [P(*central.plan(0.58, v), 3.7) for v in np.linspace(-0.78, 0.78, 9)]
    balustrade(m, [(p[0], p[2]) for p in edge], 3.7)
    stair(m, TIMBER, 2.2, 4.6, 0, -0.6, 1.1, 3.7 / 9, 9, 0.0, 'loft stair')

    # ---- the lower level, cut into the south bank ------------------------------------------
    LX0, LX1, LN0, LN1 = -14.0, 2.0, -12.0, -3.0
    box = ring_xz([(LX0, LN0), (LX1, LN0), (LX1, LN1), (LX0, LN1)])
    m.extrude(CONCRETE, box, -3.6, -3.3)
    m.floor(box, -3.3, 'lower floor')
    for wall in (rect(LX0 - 0.4, -LN1, LX1 + 0.4, -LN1 + 0.4),        # north, retaining
                 rect(LX0 - 0.4, -LN1, LX0, -LN0), rect(LX1, -LN1, LX1 + 0.4, -LN0)):   # east and west
        m.extrude(RIVER_STONE, wall, -3.6, -0.4); m.solid(wall, -3.6, -0.4, 'lower wall')
    for e in (-8.7, -3.3):                                      # partitions between the suites
        part = rect(e - 0.08, -(-5.5), e + 0.08, -LN0)
        m.extrude(STONE_FLOOR, part, -3.3, -0.4); m.solid(part, -3.3, -0.4, 'partition')
    # the south face: glass between posts, a door for each suite
    doors = [(-12.0, -10.6), (-6.7, -5.3), (-1.35, 0.05)]
    xs = np.linspace(LX0, LX1, 13)
    for i in range(12):
        x0, x1 = xs[i], xs[i + 1]; xm = (x0 + x1) / 2
        if any(a <= xm <= b for a, b in doors): continue
        m.grid(GLASS, [[P(x0, LN0, -3.3), P(x1, LN0, -3.3)], [P(x0, LN0, -0.4), P(x1, LN0, -0.4)]], up=True)
        bay = rect(x0, -LN0 - 0.08, x1, -LN0 + 0.08)
        m.solid(bay, -3.3, -0.4, 'suite front')
    for x in xs: m.extrude(BRONZE, rect(x - 0.07, -LN0 - 0.07, x + 0.07, -LN0 + 0.07), -3.3, -0.4)
    # a carport for each suite: a timber canopy on four posts
    for cx in (-11.3, -6.0, -0.65):
        top = rect(cx - 2.6, -(-12.6), cx + 2.6, -(-18.2))
        m.extrude(TIMBER, top, -1.1, -0.85)
        for px, pn in ((cx - 2.4, -12.9), (cx + 2.4, -12.9), (cx - 2.4, -17.9), (cx + 2.4, -17.9)):
            m.extrude(BRONZE, rect(px - 0.1, -pn - 0.1, px + 0.1, -pn + 0.1), -3.5, -1.1)
    # the stair up, in the corridor, rising east
    stair(m, STONE_FLOOR, -8.0, 3.85, 0.6, 0, 1.1, 3.3 / 8, 8, -3.3, 'lower stair')
    # the roof of the lower level west of the central leaf: a green terrace off the lounge
    terr = ring_xz([(LX0, LN0), (-5.0, LN0), (-5.0, LN1), (LX0, LN1)])
    m.extrude(GREEN, terr, -0.4, 0.0)
    m.floor(terr, 0.0, 'roof terrace')
    balustrade(m, [(LX0, -LN1), (LX0, -LN0), (-5.0, -LN0)], 0.0)

    # ---- the front steps: from the court up the bank to the tip ----------------------------
    stair(m, RIVER_STONE, 0, 20.9, 0, -0.72, 2.6, 3.5 / 9, 9, -3.5, 'front steps')
    # the court itself is ground, shaped in the pack; a concrete apron marks it under the carports
    apron = ring_xz([(-15.5, -12.2), (3.5, -12.2), (3.5, -19.5), (-15.5, -19.5)])
    m.extrude(CONCRETE, apron, -3.55, -3.48)

    # ---- the north terrace, the steps down, the pool -----------------------------------------
    terrace = ring_xz([(-7, 9.5), (7, 9.5), (7, 14), (-7, 14)])
    m.extrude(STONE_FLOOR, terrace, -0.25, 0.0)
    m.floor(terrace, 0.0, 'north terrace')
    # the deck: a hand under the terrace, since the ground there is 424.3 to 425.6 m and the boards must clear it
    stair(m, STONE_FLOOR, 3.5, -14.6, 0, 0.6, 4.0, 0.3, 1, -0.3, 'pool step')
    deck = ring_xz([(1, 11), (25, 11), (25, 25), (1, 25)])
    m.extrude(DECK, deck, -0.55, -0.3, lid=False)
    m.floor(deck, -0.3, 'pool deck')
    pool = [(13 + 6.5 * math.cos(a) * (1 + 0.12 * math.sin(2 * a)), 18 + 3.6 * math.sin(a) * (1 + 0.15 * math.cos(a)))
            for a in np.linspace(0, 2 * math.pi, 40, endpoint=False)]
    pool_xz = ring_xz(pool)
    # the deck top is four boards around the pool's box and a collar from the box in to the water's edge
    bx0, bz0, bx1, bz1 = 5.0, -22.8, 21.0, -13.2
    for r in (rect(1, -25, 25, bz0), rect(1, bz1, 25, -11), rect(1, bz0, bx0, bz1), rect(bx1, bz0, 25, bz1)): m.cap(DECK, r, -0.3)
    m.collar(DECK, pool_xz, rect(bx0, bz0, bx1, bz1), -0.3)
    m.extrude(POOL_FLOOR, pool_xz, -2.1, -0.25, lid=False)                 # the basin, its coping a hand above the boards
    m.cap(WATER, pool_xz, -0.5, up=True)
    m.solid(pool_xz, -3.0, 0.2, 'pool')                                   # a body on the deck stays out of the basin
    tub = circle(21.5, -15.5, 1.6, 24)
    m.extrude(POOL_FLOOR, tub, -1.3, 0.15, lid=False); m.cap(WATER, tub, 0.0); m.solid(tub, -1.3, 0.15, 'hot tub')

    # ---- the outdoor fire, east; the oak lounge, west --------------------------------------
    for (cx, cn, y, mat, name) in ((20, 1, 0.0, STONE_FLOOR, 'fire terrace'), (-26, 1, -1.3, DECK, 'oak lounge')):
        ring = circle(cx, -cn, 5.2, 36)
        m.extrude(mat, ring, y - 0.2, y); m.floor(ring, y, name)
        pit = circle(cx, -cn, 1.1, 16)
        m.extrude(DARK_STONE, pit, y, y + 0.45); m.solid(pit, y, y + 0.45, name + ' fire')
        for k in range(8):                                     # a ring of low stone seats
            a = 2 * math.pi * k / 8
            if 1.5 < a < 2.2: continue                         # one gap to walk in through
            sx, sz = cx + 3.6 * math.cos(a), -cn + 3.6 * math.sin(a)
            ux, uz = math.cos(a), math.sin(a); vx, vz = -uz, ux
            seat = [(sx - 0.25 * ux - 0.9 * vx, sz - 0.25 * uz - 0.9 * vz), (sx + 0.25 * ux - 0.9 * vx, sz + 0.25 * uz - 0.9 * vz),
                    (sx + 0.25 * ux + 0.9 * vx, sz + 0.25 * uz + 0.9 * vz), (sx - 0.25 * ux + 0.9 * vx, sz - 0.25 * uz + 0.9 * vz)]
            m.extrude(DARK_STONE, seat, y, y + 0.45); m.solid(seat, y, y + 0.45, name + ' seat')

    # the footprint the proposal occupies, for the registry: the three wall lines merged by hand
    # into one ring is more than a massing needs — the central leaf's ring plus the wings' rings
    # are handed over separately
    return m, {'central': c_ring, 'west': w_ring, 'east': e_ring, 'pool': pool, 'lower': [(LX0, LN0), (LX1, LN0), (LX1, LN1), (LX0, LN1)]}


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'oak-leaf-massing.glb'
    m, rings = build()
    info = m.write(out, extras={'levels_m': {'court': -3.5, 'lower': -3.3, 'main': 0.0, 'loft': 3.7, 'ridge': 9.8}})
    info['floors'] = len(m.walk['floors']); info['solids'] = len(m.walk['solids'])
    print(json.dumps(info))
    if len(sys.argv) > 2:
        json.dump({k: [[round(float(e), 2), round(float(n), 2)] for e, n in v] for k, v in rings.items()}, open(sys.argv[2], 'w'))
