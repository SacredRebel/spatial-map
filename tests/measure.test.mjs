// Measuring, checked without a browser: the frame against the licensed survey, feet and inches
// both ways, and square footage the way an appraiser counts it.
//
//   node tests/measure.test.mjs
//
// The survey calls below are the eleven boundary lines of the Sulphur Mountain parcel as the
// public pack carries them (sulphur-mountain-world/survey.geojson): each line's two ends in
// longitude and latitude, and the distance the licensed surveyor recorded, in US survey feet.
import { build } from 'esbuild';
import { fileURLToPath } from 'url';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = await build({
  stdin: { contents: "export * from './src/edit/measure.ts'; export * from './src/world/geo.ts';", resolveDir: here + '..', loader: 'ts' },
  bundle: true, format: 'esm', write: false, platform: 'neutral', logLevel: 'silent'
});
const M = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const fails = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300)}`);
  if (!ok) fails.push(name);
};

// ---- the frame is true metres ------------------------------------------------------------------------
const CALLS = [[1, 630.04, [-119.1548396, 34.4335522], [-119.1569291, 34.4335632]], [2, 377.58, [-119.1569291, 34.4335632], [-119.1569371, 34.4325257]], [3, 280.0, [-119.1569371, 34.4325257], [-119.1578497, 34.4323837]], [4, 38.0, [-119.1578497, 34.4323837], [-119.1578505, 34.4322793]], [5, 279.12, [-119.1578505, 34.4322793], [-119.15694, 34.432141]], [6, 125.0, [-119.15694, 34.432141], [-119.1569426, 34.4317976]], [7, 585.92, [-119.1569426, 34.4317976], [-119.1549996, 34.4317873]], [8, 318.72, [-119.1549996, 34.4317873], [-119.1549928, 34.4326631]], [9, 70.06, [-119.1549928, 34.4326631], [-119.1549783, 34.4328552]], [10, 40.19, [-119.1549783, 34.4328552], [-119.154845, 34.4328545]], [11, 253.91, [-119.154845, 34.4328545], [-119.1548396, 34.4335522]]];
const US_FT = 1200 / 3937;
const mpd = M.metresPerDegree(34.4326);
check('frame: a degree at the parcel is 91,913.9 m east–west and 110,930.2 m north–south (WGS84)',
  Math.abs(mpd.mx - 91913.9) < 0.5 && Math.abs(mpd.my - 110930.2) < 0.5, { mx: +mpd.mx.toFixed(1), my: +mpd.my.toFixed(1) });
// through the world's own frame, set at the world's start point (the front of the house)
const frame = new M.Frame({ lng: -119.15614, lat: 34.43272 });
const err = CALLS.map(([n, ft, a, b]) => { const p = frame.toWorld(a[0], a[1]), q = frame.toWorld(b[0], b[1]); return { n, ft, got: +(Math.hypot(q.x - p.x, q.z - p.z) / US_FT).toFixed(2) }; });
const worst = Math.max(...err.map(e => Math.abs(e.got - e.ft)));
check('frame: all eleven surveyed boundary lines measure within 0.1 ft of the surveyor\'s distances', worst < 0.1, { worstFt: +worst.toFixed(3), lines: err });
const worstBetween = Math.max(...CALLS.map(([, ft, a, b]) => Math.abs(M.metresBetween(a, b) / US_FT - ft)));
check('frame: the same, point to point without a frame', worstBetween < 0.1, { worstFt: +worstBetween.toFixed(3) });
// the old spherical frame, for the record: it was a third of a percent long north–south
const oldMy = 6378137 * Math.PI / 180;
const c2 = CALLS[1], oldLen = Math.abs(c2[3][1] - c2[2][1]) * oldMy / US_FT;
check('frame: the sphere this replaces read the 377.58 ft line about 1.3 ft long', oldLen - 377.58 > 1.2 && oldLen - 377.58 < 1.45, { old: +oldLen.toFixed(2) });
const acres = M.ringAreaM2(CALLS.map(c => c[2])) / 4046.8564224;
check('frame: the parcel inside the calls comes to its recorded 9.465 acres', Math.abs(acres - 9.465) < 0.01, { acres: +acres.toFixed(3) });

// ---- feet and inches, out and in ---------------------------------------------------------------------
check('read out: 9.906 m is 32′ 6″, 1.5 m is 4′ 11″, half inches show, and under a foot is inches alone', M.feetInches(9.906) === '32′ 6″' && M.feetInches(1.5) === '4′ 11″' && M.feetInches(0.3175) === '1′ 0½″' && M.feetInches(0.254) === '10″',
  [M.feetInches(9.906), M.feetInches(1.5), M.feetInches(0.3175), M.feetInches(0.254)]);
check('read out: both ways, owner\'s units first', M.fmtLen(9.906, 'ft') === '32′ 6″ · 9.91 m' && M.fmtLen(9.906, 'm') === '9.91 m · 32′ 6″', [M.fmtLen(9.906, 'ft'), M.fmtLen(9.906, 'm')]);
const P = (s, u = 'ft') => M.parseLength(s, u);
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9;
const typed = { a: P(`32'6"`), b: P(`32' 6`), c: P('32.5\''), d: P('32ft 6in'), e: P('9.906m'), f: P('20'), g: P('20', 'm'), h: P('6"'), i: P('990cm'), j: P('32′ 6″'), k: P('abc'), l: P('0') };
check('read in: 32\'6", 32\' 6, 32.5\', 32ft 6in and 32′ 6″ are all 9.906 m; a bare number is in the chosen units; nonsense is refused',
  near(typed.a, 9.906) && near(typed.b, 9.906) && near(typed.c, 9.906) && near(typed.d, 9.906) && near(typed.e, 9.906) && near(typed.j, 9.906)
    && near(typed.f, 6.096) && near(typed.g, 20) && near(typed.h, 0.1524) && near(typed.i, 9.9) && typed.k === null && typed.l === null, typed);
const areas = { a: M.parseArea('5,000', 'ft'), b: M.parseArea('5000 sq ft', 'm'), c: M.parseArea('465 m2', 'ft'), d: M.parseArea('465', 'm') };
check('read in: 5,000 (sq ft) is 464.5 m²; 465 m² stays 465', Math.abs(areas.a - 464.5152) < 0.001 && Math.abs(areas.b - 464.5152) < 0.001 && areas.c === 465 && areas.d === 465, areas);

// ---- square footage -----------------------------------------------------------------------------------
const rect = (w, d, x = 0, z = 0) => [{ x, z }, { x: x + w, z }, { x: x + w, z: z + d }, { x, z: z + d }];
check('rings: a 10 m square grown by 12.5 cm is 10.25 m square, whichever way it was drawn',
  Math.abs(M.area(M.growRing(rect(10, 10), 0.125)) - 105.0625) < 1e-6 && Math.abs(M.area(M.growRing(rect(10, 10).reverse(), 0.125)) - 105.0625) < 1e-6);
const wall = (centre, extra = {}) => ({ centre, thick: 0.3, height: 2.7, base: 0, closed: true, smooth: false, openings: [], id: 'w', ...extra });
const one = M.measureBuilding([wall(rect(20, 23.225))], []);
check('building: one storey inside a 0.3 m wall is measured gross to the outside face, net to the inside face',
  Math.abs(one.grossM2 - 20.3 * 23.525) < 1e-6 && Math.abs(one.netM2 - 19.7 * 22.925) < 1e-6 && one.levels.length === 1 && one.levels[0].from === 'walls',
  { gross: one.grossM2, net: one.netM2, width: one.width, depth: one.depth });
check('building: its outside dimensions are read along its own walls', Math.abs(Math.max(one.width, one.depth) - 23.525) < 1e-6 && Math.abs(Math.min(one.width, one.depth) - 20.3) < 1e-6);
// four walls drawn one by one, meeting at the corners, are the same room
const r = rect(20, 23.225);
const four = M.measureBuilding(r.map((p, i) => ({ ...wall([p, r[(i + 1) % 4]]), closed: false })), []);
check('building: four walls drawn one at a time that meet at the corners measure as one room', Math.abs(four.grossM2 - one.grossM2) < 1e-6, { gross: four.grossM2 });
// two storeys and a loft too low to count
const floors = [{ ring: rect(20, 23.225), level: 0, thick: 0.2, id: 'f0' }, { ring: rect(20, 23.225), level: 3, thick: 0.2, id: 'f1' }, { ring: rect(8, 8, 6, 7), level: 4.9, thick: 0.15, id: 'f2' }];
const two = M.measureBuilding([wall(rect(20, 23.225), { height: 6 })], floors);
check('building: two full storeys count twice; a loft with 3 ft 7 in of headroom is drawn but not counted (ANSI Z765)',
  two.levels.length === 3 && two.levels[0].counted && two.levels[1].counted && !two.levels[2].counted && Math.abs(two.grossM2 - 2 * one.grossM2) < 1e-6,
  two.levels.map(l => ({ level: l.level, gross: +l.grossM2.toFixed(1), ceiling: l.ceilingM == null ? null : +l.ceilingM.toFixed(2), counted: l.counted })));
// sizing to a target: scale the walls, keep their thickness, solve
const target = 5000 * 0.3048 * 0.3048;
const at = k => M.measureBuilding([wall(rect(20 * k, 23.225 * k))], []).grossM2;
let k = 1;
for (let i = 0; i < 10; i++) { const g = at(k); if (Math.abs(g - target) < 0.01) break; k *= M.scaleFor(g, target); }
check('building: resized to 5,000 sq ft it comes to 5,000 sq ft, the walls still 0.3 m thick', Math.abs(at(k) / (0.3048 * 0.3048) - 5000) < 0.5, { sqft: +(at(k) / 0.09290304).toFixed(2), scale: +k.toFixed(5) });
check('site: the setback from a building to a line is the nearest distance between them',
  Math.abs(M.nearest(rect(10, 10, 5, 5), rect(40, 40)).d - 5) < 1e-9);

if (fails.length) { console.log(`\nmeasure: ${fails.length} failed — ${fails.join(', ')}`); process.exitCode = 1; }
else console.log('\nmeasure: all checks passed');
