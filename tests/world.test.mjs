// The world, driven in a real browser against a known hillside.
//
//   The fixture ground is a tilted plane whose height at any point is arithmetic — base 500 m,
//   rising 5 % east and falling 3 % north — so every claim here is checked against a number we can
//   work out rather than against whatever the renderer happens to produce. If the decoder, the
//   interpolation, the local frame or the walker is wrong by a metre, these fail.
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { start } from './serve.mjs';
import { height, ORIGIN, PACK_TREES, PACK_STANDING, removedByEdits, PACK_HOUSE, PACK_GARAGE, PACK_AOI } from './fixture.mjs';

const PORT = 5181;
const BASE = `http://localhost:${PORT}`;
const R = 6378137, D2R = Math.PI / 180;
const MX = R * Math.cos(ORIGIN.lat * D2R) * D2R, MY = R * D2R;

/** the fixture surface itself: every assertion below is checked against this, not against pixels */
const truth = (lng, lat) => height(lng, lat);

const fails = [];
const check = (name, ok, detail) => {
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 320)}`;
  console.log(line);
  if (!ok) fails.push(name);
};

const server = await start(PORT);
const sys = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const opts = { args: ['--no-sandbox', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
else if (!existsSync(chromium.executablePath()) && sys) opts.executablePath = sys;
const browser = await chromium.launch(opts);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errs = [];
page.on('pageerror', e => errs.push('PAGE ' + e.message));
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 200)); });

await page.goto(`${BASE}/?atlas=${BASE}&community=sulphur-mountain&pack=${BASE}/pack/`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.world && window.world.ready, { timeout: 45000 });
await page.waitForTimeout(400);

// ---- the ground -------------------------------------------------------------------------------
const boot = await page.evaluate(() => {
  const w = window.world;
  return { ...w.state(), fine: !!w.terrain.group.getObjectByName('terrain-fine'), coarse: !!w.terrain.group.getObjectByName('terrain-coarse') };
});
check('boot: the world loads the baked index, builds both terrain rings and stands the player on the ground',
  boot.tiles >= 4 && boot.fine && boot.coarse && boot.community === 'sulphur-mountain', boot);

const want = truth(ORIGIN.lng, ORIGIN.lat);
check('ground: the height under the start point matches the surface to a centimetre',
  Math.abs(boot.groundM - want) < 0.01, { read: +boot.groundM.toFixed(3), want: +want.toFixed(3) });

// sample the field away from the origin: this is the decoder and the bilinear read, not luck
const samples = await page.evaluate(() => {
  const f = window.world.field;
  const pts = [[-119.1575, 34.4335], [-119.1550, 34.4320], [-119.1565, 34.4330]];
  return pts.map(([lng, lat]) => ({ lng, lat, h: f.at(lng, lat) }));
});
const worst = Math.max(...samples.map(s => Math.abs(s.h - truth(s.lng, s.lat))));
check('ground: the height field reads the tilted plane correctly across three tiles', worst < 0.05,
  { worstErrorM: +worst.toFixed(4), samples: samples.map(s => +s.h.toFixed(2)) });

// ---- the mesh ---------------------------------------------------------------------------------
const mesh = await page.evaluate(() => {
  const m = window.world.terrain.group.getObjectByName('terrain-fine');
  const pos = m.geometry.getAttribute('position');
  let lo = Infinity, hi = -Infinity;
  for (let i = 1; i < pos.count * 3; i += 3) { const y = pos.array[i]; if (y < lo) lo = y; if (y > hi) hi = y; }
  return { verts: pos.count, colours: !!m.geometry.getAttribute('color'), lo, hi, indexed: !!m.geometry.getIndex() };
});
// corner to corner over a 640 m square on a plane rising 5 % east and falling 3 % north:
// 640 x 0.05 + 640 x 0.03 = 51.2 m of relief, and the mesh has to carry all of it
check('terrain: the fine ring is one indexed, vertex-coloured grid carrying the full relief of the slope',
  mesh.verts === 257 * 257 && mesh.colours && mesh.indexed && Math.abs((mesh.hi - mesh.lo) - 51.2) < 0.6,
  { verts: mesh.verts, relief: +(mesh.hi - mesh.lo).toFixed(2), want: 51.2 });

// ---- walking ----------------------------------------------------------------------------------
// the step, not the frame rate: under software GL this page draws a couple of times a second, so
// holding a key for a wall-clock second would measure the renderer rather than the walker
const walk = await page.evaluate(() => {
  const w = window.world, p = w.player;
  const step = (keys, dt, heading) => {
    w.goto(-119.156345, 34.432675, heading);
    const a = p.state();
    for (const k of keys) p.key(k, true);
    p.update(dt);
    for (const k of keys) p.key(k, false);
    return { a, b: p.state() };
  };
  return { north: step(['w'], 1, 0), run: step(['w', 'shift'], 1, 0), east: step(['w'], 1, 90), strafe: step(['d'], 1, 0) };
});
const metres = (r) => ({ n: (r.b.lat - r.a.lat) * MY, e: (r.b.lng - r.a.lng) * MX });
const n1 = metres(walk.north), r1 = metres(walk.run), e1 = metres(walk.east), s1 = metres(walk.strafe);
check('walk: a second of W covers 1.6 m along the heading — north when facing north, east when facing east',
  Math.abs(n1.n - 1.6) < 0.02 && Math.abs(n1.e) < 0.02 && Math.abs(e1.e - 1.6) < 0.02 && Math.abs(e1.n) < 0.02,
  { north: +n1.n.toFixed(2), east: +e1.e.toFixed(2) });
check('walk: Shift runs at 5.2 m/s, and D strafes right without turning',
  Math.abs(r1.n - 5.2) < 0.05 && Math.abs(s1.e - 1.6) < 0.02 && Math.abs(s1.n) < 0.02,
  { run: +r1.n.toFixed(2), strafeEast: +s1.e.toFixed(2) });

const walkEnd = walk.north.b;

check('walk: the walker follows the slope — the ground under it is what the surface says it should be',
  Math.abs(walkEnd.groundM - truth(walkEnd.lng, walkEnd.lat)) < 0.05,
  { stood: +walkEnd.groundM.toFixed(2), surface: +truth(walkEnd.lng, walkEnd.lat).toFixed(2) });

const cam = await page.evaluate(() => {
  const w = window.world;
  const third = { y: w.camera.position.y, view: w.player.state().view };
  w.player.setView('first');
  const first = { y: w.camera.position.y, view: w.player.state().view };
  const eye = w.player.position.y + 1.68;
  w.player.setView('third');
  return { third, first, eye, ground: w.player.state().groundM };
});
check('camera: first person puts the eye 1.68 m over the ground; third person lifts and pulls back',
  cam.first.view === 'first' && Math.abs(cam.first.y - cam.eye) < 0.02 && cam.third.y > cam.first.y, cam);

// ---- what is proposed to stand here -----------------------------------------------------------
const built = await page.evaluate(() => {
  const g = window.world.structures;
  return {
    loaded: g.list.length,
    names: g.group.children.map(c => c.name).sort(),
    massingY: (g.group.children.find(c => c.name === 'massing:fixture-massing') || {}).position?.y ?? null
  };
});
check('structures: the registry is read from the atlas and drawn — a reserved site and a massing block',
  built.loaded === 2 && built.names.includes('plan:fixture-site') && built.names.includes('massing:fixture-massing'),
  built.names);
check('structures: the massing block sits on the ground, not at sea level', built.massingY > 480 && built.massingY < 560,
  { y: built.massingY == null ? null : +built.massingY.toFixed(1) });

// ---- what grows here ---------------------------------------------------------------------------
// The scatter is a rule, not a list, so what is checked is that the rule was obeyed: every plant
// stands ON the surface, none stands inside a building, and the species split matches the ground.
// The fixture is a gentle slope that falls to the north, which is oak country, so oaks should not
// be outnumbered by chaparral on it.
const veg = await page.evaluate(() => {
  const v = window.world.vegetation;
  const meshes = v.group.children.map(m => m.name);
  const sample = [];
  for (const m of v.group.children) {
    const step = Math.max(1, Math.floor(m.count / 24));
    for (let i = 0; i < m.count; i += step) {
      const e = m.instanceMatrix.array;
      const o = i * 16;
      sample.push({ name: m.name, x: e[o + 12], y: e[o + 13], z: e[o + 14] });
    }
  }
  return { counts: v.counts, meshes, sample, total: v.group.children.reduce((a, m) => a + m.count, 0) };
});
check('vegetation: both species are planted, instanced, and there are enough of them to be a hillside',
  veg.counts.oak > 80 && veg.counts.shrub > 40 && veg.meshes.includes('veg-oak') && veg.meshes.includes('veg-shrub'),
  { ...veg.counts, meshes: veg.meshes });
// nothing grows through a building: the footprint of the massing block has to come out bare
const overlap = await page.evaluate(() => {
  const w = window.world;
  // every footprint the atlas knows about, built as well as merely reserved
  const rings = w.structures.list
    .filter(x => x.outline && x.outline.length >= 3)
    .map(x => x.outline.map(([lng, lat]) => w.frame.toWorld(lng, lat)));
  const inside = (x, z) => rings.some(ring => {
    let hit = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
    }
    return hit;
  });
  let hits = 0, checked = 0;
  for (const m of w.vegetation.group.children) {
    const e = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) {
      checked++;
      if (inside(e[i * 16 + 12], e[i * 16 + 14])) hits++;
    }
  }
  return { hits, checked };
});
check('vegetation: not one plant grows inside a footprint the atlas has drawn', overlap.hits === 0, overlap);

// the rule itself, asked directly: oak on the gentle cool ground, chaparral on the steep dry ground
const rule = await page.evaluate(() => ({
  gentleNorth: window.world.vegetation.mix(0.05, 1),
  steepSouth: window.world.vegetation.mix(0.55, -1)
}));
check('vegetation: the rule prefers oak on gentle north-facing ground and chaparral on steep south-facing ground',
  rule.gentleNorth.oak > rule.gentleNorth.shrub * 3 && rule.steepSouth.shrub > rule.steepSouth.oak * 3,
  { gentleNorth: { oak: +rule.gentleNorth.oak.toFixed(2), shrub: +rule.gentleNorth.shrub.toFixed(2) },
    steepSouth: { oak: +rule.steepSouth.oak.toFixed(2), shrub: +rule.steepSouth.shrub.toFixed(2) } });

// 200,000 m2 of fixture ground: real coast live oak woodland runs 40-120 stems a hectare
{
  const perHa = veg.counts.oak / 20;
  check('vegetation: the oaks come out at the density of real oak woodland, not a plantation or a park',
    perHa > 35 && perHa < 160, { oaksPerHectare: +perHa.toFixed(0) });
}

// the scatter is seeded by POSITION, so replanting from somewhere else must not move a single plant
const stable = await page.evaluate(() => {
  const w = window.world, v = w.vegetation;
  const opts = { radius: 420, density: 1 };
  const grab = () => {
    const m = v.group.children.find(c => c.name === 'veg-oak');
    const out = new Map();
    const e = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) {
      out.set(`${e[i * 16 + 12].toFixed(3)}|${e[i * 16 + 14].toFixed(3)}`, e[i * 16 + 13]);
    }
    return out;
  };
  const p = w.player.position;
  v.build(p.x, p.z, opts);
  const a = grab();
  v.build(p.x + 60, p.z - 45, opts);      // walk away and replant
  const b = grab();
  let shared = 0, moved = 0;
  for (const [k, y] of a) if (b.has(k)) { shared++; if (Math.abs(b.get(k) - y) > 1e-6) moved++; }
  w.replant();                              // put the world back the way it plants itself
  return { a: a.size, b: b.size, shared, moved };
});
check('vegetation: replanting from a different standing position puts every shared plant back in exactly the same place',
  stable.shared > 200 && stable.moved === 0, stable);

{
  // every sampled plant must sit exactly on the surface the walker stands on
  const wrong = veg.sample.map(p => {
    const ll = { lng: ORIGIN.lng + p.x / MX, lat: ORIGIN.lat - p.z / MY };
    return Math.abs(p.y - truth(ll.lng, ll.lat));
  });
  const worstPlant = Math.max(...wrong);
  check('vegetation: every plant stands on the ground, not above or below it', worstPlant < 0.05,
    { sampled: veg.sample.length, worstErrorM: +worstPlant.toFixed(4) });
}

// ---- walls ---------------------------------------------------------------------------------------
const wall = await page.evaluate(() => {
  const w = window.world, p = w.player;
  // stand five metres south of the massing block, face north, and walk into it for ten seconds
  w.goto(-119.15685, 34.432955, 0);
  p.key('w', true);
  for (let i = 0; i < 10; i++) p.update(1);
  p.key('w', false);
  const s = p.state();
  return { lat: s.lat, lng: s.lng, touching: s.touching, solids: p.solids.map(x => x.id).sort() };
});
// the block's south edge is at 34.43300; a body with a shoulder of 0.34 m stops just short of it
check('walls: the massing block stops the walker instead of letting them through it',
  wall.lat < 34.43300 && wall.lat > 34.43290 && wall.touching === 'fixture-massing',
  { lat: +wall.lat.toFixed(6), stoppedShortM: +((34.43300 - wall.lat) * MY).toFixed(2), touching: wall.touching });
// the reserved site and the concrete pad are ground; the massing block and what the pack says stands are walls
check('walls: only what is built is solid — reserved ground and the concrete pad are still walkable',
  wall.solids.join() === 'fixture-massing,house,warehouse', { solids: wall.solids });

// ---- the walk cycle --------------------------------------------------------------------------
// One stride is 1.55 m (STRIDE in player/avatar.ts). The gait is paced by ground covered, so after
// exactly one stride the legs are back where they started, and after half a stride they have swapped.
const cycle = await page.evaluate(() => {
  const rig = window.world.player.rig;
  const step = (d) => rig.update({ dt: 0.1, distance: d, speed: 1.6, grounded: true });
  step(0);
  const a = { ...rig.pose };
  step(1.55);
  const full = { ...rig.pose };
  step(1.55 / 2);
  const half = { ...rig.pose };
  step(1.55 / 2);          // back to the top of the cycle
  rig.update({ dt: 0.1, distance: 0, speed: 0, grounded: true });
  const still = { ...rig.pose };
  return { a, full, half, still, kind: rig.kind };
});
check('gait: one stride of ground covered returns the legs to where they started',
  Math.abs(cycle.full.leftLeg - cycle.a.leftLeg) < 1e-6 && Math.abs(cycle.full.rightLeg - cycle.a.rightLeg) < 1e-6,
  { start: +cycle.a.leftLeg.toFixed(4), afterOneStride: +cycle.full.leftLeg.toFixed(4) });
check('gait: half a stride later the legs have swapped, and the arms swing opposite the legs',
  Math.abs(cycle.half.leftLeg - cycle.full.rightLeg) < 1e-6 &&
  Math.sign(cycle.half.leftArm) === Math.sign(cycle.half.rightLeg) &&
  cycle.half.leftKnee >= 0 && cycle.half.rightKnee >= 0,
  { leftLeg: +cycle.half.leftLeg.toFixed(3), rightLeg: +cycle.half.rightLeg.toFixed(3), leftArm: +cycle.half.leftArm.toFixed(3) });
check('gait: standing still, the body stands still', Math.abs(cycle.still.leftLeg) < 1e-9 && cycle.still.bob < 1e-9,
  cycle.still);

// ---- thumbs ------------------------------------------------------------------------------------
// The stick feeds the same movement axis the keys do. Half a stick must be half a walk, or a phone
// and a keyboard are two different worlds.
const thumb = await page.evaluate(() => {
  const w = window.world, p = w.player;
  const run = (fwd) => {
    w.goto(-119.156345, 34.432675, 0);
    const a = p.state();
    p.setAxis(fwd, 0, false);
    p.update(1);
    p.setAxis(0, 0, false);
    return (p.state().lat - a.lat);
  };
  const full = run(1), half = run(0.5);
  w.stick.set(0, 0, false);
  return { full: full, half: half, hasStick: !!w.stick };
});
check('thumbstick: a full stick walks 1.6 m and half a stick walks half of it, through the same axis as the keys',
  Math.abs(thumb.full * MY - 1.6) < 0.02 && Math.abs(thumb.half * MY - 0.8) < 0.02 && thumb.hasStick,
  { fullM: +(thumb.full * MY).toFixed(2), halfM: +(thumb.half * MY).toFixed(2) });

// ---- the character ------------------------------------------------------------------------------
// A missing or broken avatar file must never leave the world without a body.
const fallback = await page.evaluate(() => window.world.setAvatar('/no-such-avatar.vrm'));
check('avatar: a file that will not load falls back to the built-in body rather than emptying the world',
  fallback === 'capsule', { kind: fallback });


// ---- the pack --------------------------------------------------------------------------------
// A property's record, loaded by URL. Where it speaks the world stops guessing: the lidar's trees
// stand where the record puts them and the rule keeps out of that ground; what stands is raised
// to its measured height and stops you; the surveyed line is on the ground; the aerial is on it.
const pk = await page.evaluate(() => {
  const w = window.world;
  return { id: w.pack?.manifest?.id, trees: w.pack?.trees?.length, removed: w.pack?.removed, edits: w.pack?.edits?.features?.length, counts: w.vegetation.counts, today: w.today.counts };
});
check('pack: the manifest and every layer load from the pack url', pk.id === 'fixture-pack' && pk.edits === 3 && pk.trees + pk.removed === PACK_TREES.length, pk);
// the owner's edits are applied on top of the record, never written into it: three trees are gone,
// two within 12 m of the house and one at a point, and a feature whose op is not "remove" does nothing
check('pack: the edits take down exactly the trees they name and leave the record intact',
  pk.removed === PACK_TREES.length - PACK_STANDING.length && pk.removed === 3 && pk.trees === PACK_STANDING.length,
  { removed: pk.removed, standing: pk.trees, record: PACK_TREES.length });

// read the record instances back: position and height from each instance matrix
const records = await page.evaluate(() => {
  const w = window.world;
  const list = [];
  for (const name of ['veg-record-oak', 'veg-record-shrub']) {
    const m = w.vegetation.group.getObjectByName(name);
    if (!m) continue;
    const e = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) {
      const o = i * 16;
      const sy = Math.hypot(e[o + 4], e[o + 5], e[o + 6]);          // the y column's length is the y scale
      const ll = w.frame.toLngLat(e[o + 12], e[o + 14]);
      list.push({ lng: ll.lng, lat: ll.lat, y: e[o + 13], height: sy * (name.endsWith('oak') ? 4.9 : 1.03) });
    }
  }
  return list;
});
{
  const ll = t => ({ lng: ORIGIN.lng + t.e / MX, lat: ORIGIN.lat + t.n / MY, height: t.height });
  const nearest = t => records.map(r => ({ r, d: Math.hypot((r.lng - t.lng) * MX, (r.lat - t.lat) * MY) })).sort((a, b) => a.d - b.d)[0];
  let worstPos = 0, worstH = 0, worstGround = 0;
  for (const t of PACK_STANDING.map(ll)) {
    const near = nearest(t);
    worstPos = Math.max(worstPos, near.d);
    worstH = Math.max(worstH, Math.abs(near.r.height - t.height));
    worstGround = Math.max(worstGround, Math.abs(near.r.y - truth(t.lng, t.lat)));
  }
  check('pack: every standing tree is where the record puts it, at its recorded height, on the ground',
    records.length === PACK_STANDING.length && worstPos < 0.05 && worstH < 0.05 && worstGround < 0.05,
    { planted: records.length, worstPositionM: +worstPos.toFixed(3), worstHeightM: +worstH.toFixed(3), worstGroundM: +worstGround.toFixed(3) });
  // and nothing stands where an edit says a tree came down
  const ghosts = PACK_TREES.filter(removedByEdits).map(ll).map(t => nearest(t).d);
  check('pack: no tree stands where the owner said one came down', ghosts.length === 3 && Math.min(...ghosts) > 1,
    { removed: ghosts.length, nearestStandingM: +Math.min(...ghosts).toFixed(1) });
}
const inside = await page.evaluate((aoi) => {
  const w = window.world;
  let n = 0;
  for (const name of ['veg-oak', 'veg-shrub']) {
    const m = w.vegetation.group.getObjectByName(name);
    if (!m) continue;
    const e = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) {
      const ll = w.frame.toLngLat(e[i * 16 + 12], e[i * 16 + 14]);
      if (ll.lng > aoi[0] && ll.lng < aoi[2] && ll.lat > aoi[1] && ll.lat < aoi[3]) n++;
    }
  }
  return n;
}, PACK_AOI);
check("pack: the rule plants nothing inside the pack's ground — the record is the only tree there", inside === 0, { ruleTreesInsideAoi: inside });

const stands = await page.evaluate(() => {
  const w = window.world, g = w.today.group;
  const names = g.children.map(c => c.name).sort();
  const house = g.getObjectByName('today:house'), garage = g.getObjectByName('today:warehouse');
  return {
    names, houseY: house?.position.y ?? null, garageY: garage?.position.y ?? null,
    hasPad: !!g.getObjectByName('pad:concrete-pad'), raisedPad: !!g.getObjectByName('today:concrete-pad'),
    solids: w.player.solids.map(s => s.id).sort()
  };
});
{
  const corners = (b) => [[b.e0, b.n0], [b.e1, b.n0], [b.e1, b.n1], [b.e0, b.n1]].map(([e, n]) => truth(ORIGIN.lng + e / MX, ORIGIN.lat + n / MY));
  const houseTop = Math.min(...corners(PACK_HOUSE)) + PACK_HOUSE.roof;
  const garageTop = Math.min(...corners(PACK_GARAGE)) + PACK_GARAGE.roof;
  check('pack: the house and the unmapped warehouse are raised to their lidar heights, the concrete pad is laid flat',
    stands.houseY != null && Math.abs(stands.houseY - houseTop) < 0.05 && stands.garageY != null && Math.abs(stands.garageY - garageTop) < 0.05 && stands.hasPad && !stands.raisedPad,
    { houseTop: stands.houseY == null ? null : +stands.houseY.toFixed(2), want: +houseTop.toFixed(2), garageTop: stands.garageY == null ? null : +stands.garageY.toFixed(2), wantGarage: +garageTop.toFixed(2), pad: stands.hasPad, raisedPad: stands.raisedPad });
  check('pack: what stands is solid — the house, the warehouse, and nothing for the pad',
    stands.solids.includes('house') && stands.solids.includes('warehouse') && !stands.solids.includes('concrete-pad'), stands.solids);
}
const bump = await page.evaluate(([lng, lat]) => {
  const w = window.world, p = w.player;
  // six metres south of the house's south wall, facing north, walking into it for ten seconds
  w.goto(lng, lat, 0);
  p.key('w', true);
  for (let i = 0; i < 10; i++) p.update(1);
  p.key('w', false);
  const s = p.state();
  return { lat: s.lat, touching: s.touching };
}, [ORIGIN.lng + ((PACK_HOUSE.e0 + PACK_HOUSE.e1) / 2) / MX, ORIGIN.lat + (PACK_HOUSE.n0 - 6) / MY]);
{
  const wall = ORIGIN.lat + PACK_HOUSE.n0 / MY;
  check('pack: the house stops the walker at its wall', bump.touching === 'house' && bump.lat < wall && (wall - bump.lat) * MY < 0.6,
    { touching: bump.touching, stoppedShortM: +((wall - bump.lat) * MY).toFixed(2) });
}

const lines = await page.evaluate(() => {
  const g = window.world.today.group;
  const n = (name) => { const o = g.getObjectByName(name); return o ? o.geometry.getAttribute('position').count : 0; };
  return { boundary: n('survey:boundary'), easement: n('survey:easement'), county: n('county:parcel'), road: n('road:fixture-rd'), monument: !!g.getObjectByName('monument:0'),
    zones: g.children.filter(c => c.name.startsWith('vision:')).map(c => ({ name: c.name, sprite: c.children.some(k => k.isSprite), gold: c.children.some(k => k.isMesh && k.material.color.getHexString() === 'e0b64a') })) };
});
// the boundary is a 320 m square sampled every 2 m; the road 180 m every 3 m, two vertices a sample
check('pack: the surveyed line, the easement, the county ring and the road are laid on the ground, and the pipe is a post',
  lines.boundary >= 160 && lines.easement >= 80 && lines.county >= 160 && lines.road >= 120 && lines.monument, lines);
check('pack: each placed zone is a post with a label — gold where something already stands, violet where it is planned',
  lines.zones.length === 3 && lines.zones.every(z => z.sprite) && lines.zones.filter(z => z.gold).length === 1 && lines.zones.find(z => z.gold).name === 'vision:the-barn',
  lines.zones);

await page.evaluate(() => window.world.terrain.imageryReady);
const drape = await page.evaluate(() => {
  const w = window.world, m = w.terrain.group.getObjectByName('terrain-fine');
  return { ...w.terrain.imageryState, hasMap: !!m.material.map, isCanvas: !!(m.material.map && m.material.map.isCanvasTexture), vertexColours: m.material.vertexColors, uv: !!m.geometry.getAttribute('uv') };
});
check('pack: the aerial is draped over the fine ring — every tile drawn, the slope colours retired, a uv for every vertex',
  drape.active && drape.tiles > 0 && drape.loaded === drape.tiles && drape.failed === 0 && drape.hasMap && drape.isCanvas && drape.vertexColours === false && drape.uv, drape);

const hudPack = await page.evaluate(() => { const el = document.querySelector('[data-el="pack"]'); return { hidden: el.hidden, text: el.textContent }; });
check('pack: the HUD says what the pack brought, and what has gone since', !hudPack.hidden && /Fixture Hill/.test(hudPack.text) && /37 trees/.test(hudPack.text) && /3 since gone/.test(hudPack.text), hudPack);

// and without a pack, the world is what it was: the rule plants everywhere and nothing stands
const bare = await ctx.newPage();
await bare.goto(`${BASE}/?atlas=${BASE}&community=sulphur-mountain&pack=0`, { waitUntil: 'domcontentloaded', timeout: 30000 });
await bare.waitForFunction(() => window.world && window.world.ready, { timeout: 45000 });
const plain = await bare.evaluate((aoi) => {
  const w = window.world;
  let n = 0;
  const m = w.vegetation.group.getObjectByName('veg-oak');
  const e = m.instanceMatrix.array;
  for (let i = 0; i < m.count; i++) {
    const ll = w.frame.toLngLat(e[i * 16 + 12], e[i * 16 + 14]);
    if (ll.lng > aoi[0] && ll.lng < aoi[2] && ll.lat > aoi[1] && ll.lat < aoi[3]) n++;
  }
  return { pack: w.pack, ruleOaksInsideAoi: n, today: w.today.group.children.length, map: !!w.terrain.group.getObjectByName('terrain-fine').material.map };
}, PACK_AOI);
check('no pack: the rule plants the same ground, nothing stands, the slope colours stay', plain.pack === null && plain.ruleOaksInsideAoi > 10 && plain.today === 0 && !plain.map, plain);
// an aerial that never arrives must not leave the ground a flat placeholder colour
const gone = await bare.evaluate(async (base) => {
  const w = window.world;
  w.terrain.setImagery({ template: `${base}/nowhere/{z}/{x}/{y}`, maxzoom: 18 });
  await w.terrain.imageryReady;
  const m = w.terrain.group.getObjectByName('terrain-fine').material;
  return { ...w.terrain.imageryState, map: !!m.map, vertexColours: m.vertexColors };
}, BASE);
check('no aerial: when every tile fails the ring goes back to its slope colours', gone.tiles > 0 && gone.failed === gone.tiles && !gone.active && !gone.map && gone.vertexColours === true, gone);
await bare.close();

// ---- the sun ----------------------------------------------------------------------------------
const sun = await page.evaluate(() => {
  const out = [];
  for (const h of [6, 12, 18, 23]) {
    window.world.setTime(h);
    const d = window.world.sky.sun.position.clone().normalize();
    out.push({ h, y: +d.y.toFixed(3), x: +d.x.toFixed(3), z: +d.z.toFixed(3) });
  }
  window.world.setTime(13.5);
  return out;
});
const noon = sun.find(s => s.h === 12), night = sun.find(s => s.h === 23), dawn = sun.find(s => s.h === 6);
// local time at the community, not the viewer's clock: noon means noon on that hillside
check('sun: at local noon it is high and to the south, at dawn it is low and east, at 23:00 it is down',
  noon.y > 0.55 && noon.z > 0 && dawn.x > 0.4 && dawn.y < 0.45 && night.y <= 0.03, { noon, dawn, night });

// ---- nothing threw ------------------------------------------------------------------------------
const real = errs.filter(e => !/WebGL|GL_INVALID|swiftshader|GPU stall|Failed to load resource/i.test(e));
check('no page errors', real.length === 0, real.slice(0, 4));

await browser.close();
server.close();
if (fails.length) { console.log(`\nworld: ${fails.length} failed — ${fails.join(', ')}`); process.exitCode = 1; }
else console.log('\nworld: all checks passed');
