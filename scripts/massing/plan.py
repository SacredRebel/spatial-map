"""
A measured plan of a massing, drawn from the model rather than about it.

  The value of this drawing is not that it is pretty. It is that every line in it comes from the
  same geometry the world stands on and the walker collides with, so a reader who scales a dimension
  off it gets the truth. No render, however good, can say that.

  What it draws, in plan, north up:

    the walk floors        — every surface a person can stand on, as the world knows them
    the walk solids        — every wall, post and the chimney, filled
    the leaf outlines      — the roofs above, dashed, because a roof is not a floor
    the zones              — pool, fire, oak lounge, garden, drive, each named where it sits
    a scale bar and a north arrow, and the level table

  Output is SVG: one file, no dependencies, crisp at any size, and it opens in anything.

    python3 scripts/massing/plan.py out.svg [scale]        # scale 200 means 1:200
"""
import importlib.util
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent


def load_massing():
    spec = importlib.util.spec_from_file_location('oakleaf', HERE / 'oak-leaf.py')
    mod = importlib.util.module_from_spec(spec)
    sys.modules['oakleaf'] = mod
    spec.loader.exec_module(mod)
    return mod.build()


# ---- the page ----------------------------------------------------------------------------------
MARGIN_MM = 18.0
LABELS = [
    # (east, north, text, anchor)
    (0, 4.5, 'GREAT ROOM', 'middle'),
    (0, -11.0, 'ENTRANCE', 'middle'),
    (10.0, 6.5, 'KITCHEN + DINING', 'middle'),
    (-9.0, 6.0, 'MASTER SUITE', 'middle'),
    (10.0, -6.5, 'PRIVATE LOUNGE', 'middle'),
    (-9.5, -6.5, 'SUITES BELOW', 'middle'),
    (-6.0, -15.5, 'PARKING · ONE PER SUITE', 'middle'),
    (-16.0, 23.0, 'POOL + HOT TUB', 'middle'),
    (3.5, 26.0, 'OUTDOOR FIRE', 'middle'),
    (13.0, -26.0, 'OAK LOUNGE', 'middle'),
    (26.0, 17.0, 'SACRED GARDEN', 'middle'),
    (-18.5, -16.5, 'DRIVE', 'middle'),
]

LEVELS = [('lower / parking', '−3.5 to −3.3 m'), ('main floor', '0.0 m'),
          ('loft', '+3.7 m'), ('ridge', '+9.8 m')]


def svg_plan(rings, walk, scale=200.0):
    """rings: name → [(e, n)]; walk: the model's floors and solids, in x/z metres (z south)."""
    # everything drawn, in plan metres, so the page can be sized to it
    pts = []
    for v in rings.values():
        pts += [(float(e), float(n)) for e, n in v]
    for f in walk['floors'] + walk['solids']:
        pts += [(float(x), -float(z)) for x, z in f['ring']]
    for e, n, *_ in LABELS:
        pts.append((e, n))
    e0 = min(p[0] for p in pts) - 4; e1 = max(p[0] for p in pts) + 4
    n0 = min(p[1] for p in pts) - 6; n1 = max(p[1] for p in pts) + 8

    mm_per_m = 1000.0 / scale                      # 1:200 → 5 mm to the metre
    w_mm = (e1 - e0) * mm_per_m + 2 * MARGIN_MM
    h_mm = (n1 - n0) * mm_per_m + 2 * MARGIN_MM + 16

    def X(e): return MARGIN_MM + (e - e0) * mm_per_m
    def Y(n): return MARGIN_MM + (n1 - n) * mm_per_m       # north up

    def path(ring, close=True):
        d = ' '.join(f'{"M" if i == 0 else "L"}{X(e):.2f},{Y(n):.2f}' for i, (e, n) in enumerate(ring))
        return d + (' Z' if close else '')

    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{w_mm:.1f}mm" height="{h_mm:.1f}mm" '
         f'viewBox="0 0 {w_mm:.2f} {h_mm:.2f}">',
         '<style>'
         'text{font-family:Georgia,"Times New Roman",serif;fill:#1a1a1a}'
         '.k{font-size:2.1px;letter-spacing:.45px}'
         '.s{font-size:1.9px;fill:#555}'
         '.t{font-size:3.4px;letter-spacing:1.1px}'
         '.floor{fill:#f2efe8;stroke:#b9b2a4;stroke-width:.12}'
         '.solid{fill:#2e2a26;stroke:none}'
         '.below{fill:none;stroke:#6f6a63;stroke-width:.2;stroke-dasharray:1.1 .8}'
         '.water{fill:#dbe7ef;stroke:#7d9cb0;stroke-width:.22}'
         '.roof{fill:none;stroke:#8d9a73;stroke-width:.35;stroke-dasharray:1.6 1.1}'
         '.zone{fill:none;stroke:#9aa7b4;stroke-width:.25;stroke-dasharray:.9 .9}'
         '</style>',
         f'<rect width="{w_mm:.2f}" height="{h_mm:.2f}" fill="#fdfcfa"/>']

    # the floors first: everything a person stands on
    for f in walk['floors']:
        ring = [(float(x), -float(z)) for x, z in f['ring']]
        if len(ring) >= 3:
            o.append(f'<path class="floor" d="{path(ring)}"/>')
    # the roofs above, dashed — a roof is not a floor
    for name, ring in rings.items():
        if name in ('pool', 'lower'):
            continue
        o.append(f'<path class="roof" d="{path([(float(e), float(n)) for e, n in ring])}"/>')
    # the pool, as a zone
    if 'pool' in rings:
        o.append(f'<path class="zone" d="{path([(float(e), float(n)) for e, n in rings["pool"]])}"/>')
    # the solids last, so walls read over the floors they sit on — but a plan of the MAIN floor
    # must say what it is: water is water, and anything wholly below this floor is dashed, because
    # a reader who sees a wall at full weight will believe there is a wall there
    for s in walk['solids']:
        ring = [(float(x), -float(z)) for x, z in s['ring']]
        if len(ring) < 3:
            continue
        name = str(s.get('name', ''))
        if 'pool' in name or 'tub' in name:
            cls = 'water'
        elif float(s.get('top', 0)) <= -0.25:
            cls = 'below'
        else:
            cls = 'solid'
        o.append(f'<path class="{cls}" d="{path(ring)}"/>')

    for e, n, text, anchor in LABELS:
        o.append(f'<text class="k" x="{X(e):.2f}" y="{Y(n):.2f}" text-anchor="{anchor}">{text}</text>')

    # ---- north arrow ---------------------------------------------------------------------------
    ax, ay = w_mm - MARGIN_MM - 6, MARGIN_MM + 10
    o.append(f'<path d="M{ax:.2f},{ay - 7:.2f} L{ax + 2.1:.2f},{ay:.2f} L{ax:.2f},{ay - 1.8:.2f} '
             f'L{ax - 2.1:.2f},{ay:.2f} Z" fill="#2e2a26"/>')
    o.append(f'<text class="s" x="{ax:.2f}" y="{ay + 3.4:.2f}" text-anchor="middle">N</text>')

    # ---- scale bar, 10 m ------------------------------------------------------------------------
    bx, by = MARGIN_MM, h_mm - MARGIN_MM + 4
    ten = 10 * mm_per_m
    for i in range(5):
        fill = '#2e2a26' if i % 2 == 0 else '#fdfcfa'
        o.append(f'<rect x="{bx + i * ten / 5:.2f}" y="{by:.2f}" width="{ten / 5:.2f}" height="1.5" '
                 f'fill="{fill}" stroke="#2e2a26" stroke-width=".1"/>')
    o.append(f'<text class="s" x="{bx:.2f}" y="{by + 4.6:.2f}">0</text>')
    o.append(f'<text class="s" x="{bx + ten:.2f}" y="{by + 4.6:.2f}" text-anchor="middle">10 m</text>')
    o.append(f'<text class="s" x="{bx + ten + 9:.2f}" y="{by + 4.6:.2f}">1:{int(scale)}</text>')

    # ---- title and levels -----------------------------------------------------------------------
    o.append(f'<text class="t" x="{MARGIN_MM:.2f}" y="{MARGIN_MM - 7:.2f}">THE OAK LEAF — MAIN FLOOR</text>')
    o.append(f'<text class="s" x="{MARGIN_MM:.2f}" y="{MARGIN_MM - 3:.2f}">'
             'Sulphur Mountain, Ojai · drawn from the massing model, not over it</text>')
    lx = w_mm - MARGIN_MM
    for i, (name, h) in enumerate(LEVELS):
        o.append(f'<text class="s" x="{lx:.2f}" y="{h_mm - MARGIN_MM + 1 - (len(LEVELS) - 1 - i) * 3.4:.2f}" '
                 f'text-anchor="end">{name} &#183; {h}</text>')

    o.append('</svg>')
    return '\n'.join(o)


if __name__ == '__main__':
    out = sys.argv[1] if len(sys.argv) > 1 else 'oak-leaf-plan.svg'
    scale = float(sys.argv[2]) if len(sys.argv) > 2 else 200.0
    m, rings = load_massing()
    svg = svg_plan(rings, m.walk, scale)
    Path(out).write_text(svg)
    print(json.dumps({'svg': out, 'scale': scale, 'floors': len(m.walk['floors']),
                      'solids': len(m.walk['solids']), 'bytes': len(svg)}))
