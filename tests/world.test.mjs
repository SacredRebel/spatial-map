// The world, driven in a real browser against a known hillside.
//
//   The fixture ground is a tilted plane whose height at any point is arithmetic — base 500 m,
//   rising 5 % east and falling 3 % north — so every claim here is checked against a number we can
//   work out rather than against whatever the renderer happens to produce. If the decoder, the
//   interpolation, the local frame or the walker is wrong by a metre, these fail.
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { start } from './serve.mjs';
import { height, ORIGIN, PACK_TREES, PACK_STANDING, removedByEdits, PACK_HOUSE, PACK_GARAGE, PACK_AOI, at } from './fixture.mjs';

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

// the close-up: four ground tiles under the aerial and asphalt on the road, all named by the pack
const grain = await page.evaluate(() => {
  const w = window.world, m = w.terrain.group.getObjectByName('terrain-fine').material;
  const road = w.today.group.getObjectByName('road:fixture-rd');
  const mats = w.pack?.materials || {};
  return {
    materials: Object.keys(mats).sort(), absolute: Object.values(mats).every(x => /^http/.test(x.albedo)),
    active: w.terrain.grainActive, patched: typeof m.onBeforeCompile === 'function' && m.customProgramCacheKey() === 'grain',
    roadMap: !!(road && road.material.map), roadUv: !!(road && road.geometry.getAttribute('uv')),
    programs: w.renderer.info.programs.length
  };
});
check('grain: the pack names its close-up materials and the fine ring carries them under the aerial',
  grain.materials.join() === 'asphalt,dirt,gravel,litter,straw' && grain.absolute && grain.active && grain.patched && grain.roadMap && grain.roadUv, grain);
// the patched shader must actually draw: a compile error would surface as a console error and an unlit ring
const grainPixel = await page.evaluate(() => {
  const w = window.world;
  w.player.setView('first');
  w.renderer.render(w.scene, w.camera);
  const gl = w.renderer.getContext();
  const px = new Uint8Array(4 * 16 * 16);
  gl.readPixels(Math.floor(gl.drawingBufferWidth / 2) - 8, 40, 16, 16, gl.RGBA, gl.UNSIGNED_BYTE, px);   // the ground just in front of the feet
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
  w.player.setView('third');
  return { r: r / 256, g: g / 256, b: b / 256 };
});
check('grain: the ground in front of the feet draws as lit straw, not black and not magenta',
  grainPixel.r > 60 && grainPixel.g > 50 && grainPixel.r >= grainPixel.b && !(grainPixel.r > 200 && grainPixel.g < 40), grainPixel);

const hudPack = await page.evaluate(() => { const el = document.querySelector('[data-el="pack"]'); return { hidden: el.hidden, text: el.textContent }; });
check('pack: the HUD says what the pack brought, and what has gone since', !hudPack.hidden && /Fixture Hill/.test(hudPack.text) && /37 trees/.test(hudPack.text) && /3 since gone/.test(hudPack.text), hudPack);

// ---- god mode: flying ---------------------------------------------------------------------------
// G leaves the ground. In the air there is no gravity, Space climbs, W goes where you look, and
// landing puts the body back on the surface exactly.
const flight = await page.evaluate(() => {
  const w = window.world, p = w.player;
  w.goto(-119.156345, 34.432675, 0);
  const g0 = p.state();
  p.setMode('fly');
  const up0 = p.state();
  p.update(1);                                   // a second of nothing: no falling
  const hang = p.state();
  p.key(' ', true); p.update(1); p.key(' ', false);
  const climbed = p.state();
  p.key('w', true); p.update(1); p.key('w', false);
  const forward = p.state();
  p.setMode('walk');
  const landed = p.state();
  return { g0, up0, hang, climbed, forward, landed, ground: w.state().groundM };
});
check('fly: taking off lifts the eye above the ground and nothing pulls it back down',
  flight.g0.mode === 'walk' && flight.up0.mode === 'fly' && flight.up0.heightM > 1 && Math.abs(flight.hang.heightM - flight.up0.heightM) < 0.01,
  { off: +flight.up0.heightM.toFixed(2), hang: +flight.hang.heightM.toFixed(2) });
check('fly: Space climbs, W flies along the heading, and the height readout is metres over the ground below',
  flight.climbed.heightM - flight.hang.heightM > 8 && (flight.forward.lat - flight.climbed.lat) * MY > 8 && Math.abs(flight.forward.lng - flight.climbed.lng) * MX < 0.5,
  { climb: +(flight.climbed.heightM - flight.hang.heightM).toFixed(1), north: +((flight.forward.lat - flight.climbed.lat) * MY).toFixed(1) });
check('fly: landing drops the body onto the surface under it',
  flight.landed.mode === 'walk' && flight.landed.grounded && Math.abs(flight.landed.groundM - truth(flight.landed.lng, flight.landed.lat)) < 0.05,
  { y: +flight.landed.groundM.toFixed(2), truth: +truth(flight.landed.lng, flight.landed.lat).toFixed(2) });

// ---- the editor: picking --------------------------------------------------------------------------
// Stand 15 m south of a known tree, facing it. Its canopy projected to the screen must pick that
// tree and no other; the ground picked at the screen's centre must be on the surface.
// ---- roles ------------------------------------------------------------------------------------------
// A member walks and reads; the pencil needs a builder or admin PIN, and the atlas says which.
const roles = await page.evaluate(async () => {
  const w = window.world, ed = w.editor;
  const member = w.session.role;
  ed.setActive(true);
  const refused = { active: ed.active, editing: w.player.editing, said: ed.lastSave?.message, editButton: document.querySelector('[data-el="edit"]').hidden };
  const r = await fetch(`${w.state().atlas}/api/pack/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '0000' }) });
  const wrong = r.status;
  const r2 = await fetch(`${w.state().atlas}/api/pack/role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '2424' }) });
  const builder = (await r2.json()).role;
  w.setSession({ role: 'admin', pin: '4242' });
  return { member, refused, wrong, builder, roleButton: document.querySelector('[data-el="role"]').textContent, editButton: document.querySelector('[data-el="edit"]').hidden };
});
check('roles: a member cannot pick up the pencil — B does nothing and the edit button is not offered',
  roles.member === 'member' && !roles.refused.active && !roles.refused.editing && /PIN/.test(roles.refused.said || '') && roles.refused.editButton === true, roles.refused);
check('roles: the atlas turns a PIN into a role, and a role into the buttons', roles.wrong === 401 && roles.builder === 'builder' && /admin/.test(roles.roleButton) && roles.editButton === false, { wrong: roles.wrong, builder: roles.builder, button: roles.roleButton });

const treeAt = (e, n) => PACK_STANDING.findIndex(t => t.e === e && t.n === n);
const pickTree = await page.evaluate(({ tree, from }) => {
  const w = window.world, ed = w.editor;
  w.goto(from[0], from[1], 0);
  w.player.setView('first');                      // the eye itself, so no tree stands between it and the target
  w.renderer.render(w.scene, w.camera);
  ed.setActive(true);
  const t = w.pack.trees[tree];
  const wp = w.frame.toWorld(t.lng, t.lat);
  const y = w.field.atOr(t.lng, t.lat, 0) + t.height * 0.7;
  const v = new (Object.getPrototypeOf(w.camera.position).constructor)(wp.x, y, wp.z).project(w.camera);
  const r = w.renderer.domElement.getBoundingClientRect();
  const sx = r.left + (v.x + 1) / 2 * r.width, sy = r.top + (1 - v.y) / 2 * r.height;
  const hit = ed.pick(sx, sy);
  const centre = ed.pick(r.left + r.width / 2, r.top + r.height * 0.86);   // low on the screen: the ground a few metres ahead
  return { active: ed.active, editing: w.player.editing, panel: !document.querySelector('.edit-panel').hidden, sx, sy, kind: hit?.kind, index: hit?.index, height: hit?.tree?.height, centre: centre && { kind: centre.kind, lng: centre.lng, lat: centre.lat, y: centre.point?.y } };
}, { tree: treeAt(70, -40), from: at(70, -52) });
check('edit: B puts the world in edit mode — the panel opens, the walker stops grabbing the mouse',
  pickTree.active && pickTree.editing && pickTree.panel, { active: pickTree.active, editing: pickTree.editing, panel: pickTree.panel });
check('edit: the tree under the cursor is picked back to its own row of the record',
  pickTree.kind === 'tree' && pickTree.index === treeAt(70, -40) && pickTree.height === PACK_STANDING[treeAt(70, -40)].height,
  { kind: pickTree.kind, index: pickTree.index, want: treeAt(70, -40) });
check('edit: a click on open ground lands on the surface, not above it or below it',
  pickTree.centre?.kind === 'ground' && Math.abs(pickTree.centre.y - truth(pickTree.centre.lng, pickTree.centre.lat)) < 0.05,
  pickTree.centre && { y: +pickTree.centre.y.toFixed(2), truth: +truth(pickTree.centre.lng, pickTree.centre.lat).toFixed(2) });

// ---- the editor: every edit ---------------------------------------------------------------------
const edited = await page.evaluate(({ tree, moveTo, noteAt, plantAt, fence }) => {
  const w = window.world, ed = w.editor;
  const before = { trees: w.pack.trees.length, removed: w.pack.removed, zones: w.today.counts.zones };
  ed.markGone(w.pack.trees[tree]);
  const gone = { trees: w.pack.trees.length, removed: w.pack.removed, hud: document.querySelector('[data-el="pack"]').textContent };
  ed.moveVision('retreat', moveTo[0], moveTo[1]);
  const post = w.today.group.getObjectByName('vision:retreat');
  const want = w.frame.toWorld(moveTo[0], moveTo[1]);
  const moved = { dx: post.position.x - want.x, dz: post.position.z - want.z, flagged: w.pack.visionNow.features.find(f => f.properties.id === 'retreat').properties.moved === true, zones: w.today.counts.zones };
  ed.addNote(noteAt[0], noteAt[1], 'the gate');
  const noteId = ed.edits[ed.edits.length - 1].properties.id;
  const note = w.today.group.getObjectByName(`note:${noteId}`);
  const nw = w.frame.toWorld(noteAt[0], noteAt[1]);
  const noted = { found: !!note, dx: note ? note.position.x - nw.x : null, y: note?.position.y, ground: w.field.atOr(noteAt[0], noteAt[1], NaN), count: w.today.counts.notes };
  ed.addTree(plantAt[0], plantAt[1], 7);
  const planted = { trees: w.pack.trees.length, last: w.pack.trees[w.pack.trees.length - 1], drawn: w.vegetation.counts.record_oak + w.vegetation.counts.record_shrub };
  ed.addLine('fence', fence, 'north fence');
  const lineId = ed.edits[ed.edits.length - 1].properties.id;
  const drawn = { found: !!w.today.group.getObjectByName(`line:${lineId}`), count: w.today.counts.drawn };
  const stored = JSON.parse(localStorage.getItem(`spatial-map:edits:${w.pack.manifest.id}`) || '{"edits":[]}').edits;
  const ops = ed.edits.map(f => `${f.properties.op}:${f.properties.layer}`);
  const stamped = ed.edits.every(f => /^e-/.test(f.properties.id) && f.properties.by === 'owner' && f.properties.authority === 'owner' && /^\d{4}-\d\d-\d\d$/.test(f.properties.reported))
    && ed.edits.find(f => f.properties.op === 'move').properties.target === 'retreat';
  ed.undo();
  const undone = { found: !!w.today.group.getObjectByName(`line:${lineId}`), count: w.today.counts.drawn, edits: ed.edits.length };
  return { before, gone, moved, noted, planted, drawn, stored: stored.length, ops, stamped, undone };
}, { tree: treeAt(70, -40), moveTo: at(-60, -60), noteAt: at(-20, 50), plantAt: at(-70, 10), fence: [at(-90, 90), at(-40, 90), at(-40, 60)] });
check('edit: marking a tree gone takes it out of the world and the HUD counts it among the gone',
  edited.gone.trees === edited.before.trees - 1 && edited.gone.removed === edited.before.removed + 1 && /4 since gone/.test(edited.gone.hud),
  { trees: [edited.before.trees, edited.gone.trees], removed: [edited.before.removed, edited.gone.removed] });
check('edit: a project picked up and put down stands at the new place and is marked as moved',
  Math.abs(edited.moved.dx) < 0.01 && Math.abs(edited.moved.dz) < 0.01 && edited.moved.flagged && edited.moved.zones === edited.before.zones,
  { dx: +edited.moved.dx.toFixed(3), dz: +edited.moved.dz.toFixed(3), flagged: edited.moved.flagged });
check('edit: a marker is a post on the ground with its name, where the click was',
  edited.noted.found && Math.abs(edited.noted.dx) < 0.01 && Math.abs(edited.noted.y - edited.noted.ground) < 0.05 && edited.noted.count === 1,
  { dx: edited.noted.dx, y: edited.noted.y, ground: edited.noted.ground });
check('edit: a planted tree joins the record\'s trees at its height and is drawn with them',
  edited.planted.trees === edited.gone.trees + 1 && edited.planted.last.height === 7 && edited.planted.drawn === edited.planted.trees,
  { trees: edited.planted.trees, drawn: edited.planted.drawn, height: edited.planted.last.height });
check('edit: a fence is drawn where it was traced, and undo takes it away again',
  edited.drawn.found && edited.drawn.count === 1 && !edited.undone.found && edited.undone.count === 0 && edited.undone.edits === 4,
  { drawn: edited.drawn, undone: edited.undone });
check('edit: every edit is one feature of the pack\'s own vocabulary — its own id, the project it moves named as target — stamped as the owner\'s and kept in the browser',
  edited.ops.join(' ') === 'remove:trees move:vision add:notes add:trees add:lines' && edited.stamped && edited.stored === 5,
  { ops: edited.ops, stamped: edited.stamped, stored: edited.stored });

// ---- the editor: what survives a reload, and what a save does --------------------------------------
await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
await page.waitForFunction(() => window.world && window.world.ready, { timeout: 45000 });
await page.waitForTimeout(300);
const back = await page.evaluate(() => {
  const w = window.world;
  return { edits: w.editor.edits.length, trees: w.pack.trees.length, removed: w.pack.removed, notes: w.today.counts.notes, moved: !!w.pack.visionNow.features.find(f => f.properties.id === 'retreat').properties.moved };
});
check('edit: unsaved edits come back after a reload, applied on top of the record again',
  back.edits === 4 && back.trees === PACK_STANDING.length && back.removed === 4 && back.notes === 1 && back.moved, back);

const saved = await page.evaluate(async () => {
  const w = window.world, ed = w.editor;
  const wrong = await ed.save('0000');
  const still = ed.edits.length;
  const right = await ed.save('4242');
  return { wrong, still, right, edits: ed.edits.length, inPack: w.pack.edits.features.length, trees: w.pack.trees.length, removed: w.pack.removed, notes: w.today.counts.notes, stored: localStorage.getItem(`spatial-map:edits:${w.pack.manifest.id}`) };
});
check('save: the wrong PIN is refused and nothing is lost', !saved.wrong.ok && /wrong PIN/.test(saved.wrong.message) && saved.still === 4, saved.wrong);
check('save: the right PIN commits the edits to the pack — they leave the unsaved list, join the pack\'s edits layer, and the world does not change',
  saved.right.ok && saved.edits === 0 && saved.inPack === 3 + 4 && saved.trees === PACK_STANDING.length && saved.removed === 4 && saved.notes === 1 && JSON.parse(saved.stored).edits.length === 0 && server.saved.length === 4 && server.proposals.length === 1 && server.proposals[0].by === 'admin' && server.proposals[0].status === 'approved',
  { ...saved.right, inPack: saved.inPack, sent: server.saved.length, proposals: server.proposals.length });
check('save: what reached the atlas is exactly what was made here', server.saved.every(f => f.type === 'Feature' && f.properties.by === 'owner') && server.saved.map(f => f.properties.op).join(' ') === 'remove move add add', server.saved.map(f => `${f.properties.op}:${f.properties.layer}`));
// ---- placement: a block at real size -----------------------------------------------------------------
// A 12 × 8 × 4 m block put down facing east: its footprint reads 12 by 8, it stands on the ground,
// it stops the walker, it turns in fifteen-degree steps about its own centre, it moves on a
// half-metre snap, its height can be set, and undo takes each step back.
const placed = await page.evaluate(({ at }) => {
  const w = window.world, ed = w.editor;
  ed.setActive(true);                              // the reload above left the pencil down
  const before = { structures: w.structures.list.length, solids: w.player.solids.length };
  const id = ed.addBlock(at[0], at[1], { name: 'the shed', w: 12, d: 8, h: 4 }, 90);
  const s = ed.structure(id);
  const dims = ed.dimensions(s);
  const c0 = ed.centroid(s);
  const obj = w.structures.group.getObjectByName(`massing:${id}`);
  const solid = w.player.solids.find(x => x.id === id);
  const sel = ed.selection && ed.selection.kind === 'structure' ? ed.selection.id : null;
  // the corners, as put down: the first edge should run north-south, since the block faces east
  const ring = s.outline.slice(0, 4).map(([lng, lat]) => w.frame.toWorld(lng, lat));
  const edge0 = { dx: ring[1].x - ring[0].x, dz: ring[1].z - ring[0].z };
  ed.rotateStructure(id, 15);
  const dimsTurned = ed.dimensions(ed.structure(id));
  const c1 = ed.centroid(ed.structure(id));
  const ringTurned = ed.structure(id).outline.slice(0, 4).map(([lng, lat]) => w.frame.toWorld(lng, lat));
  const edge1 = { dx: ringTurned[1].x - ringTurned[0].x, dz: ringTurned[1].z - ringTurned[0].z };
  const angle = Math.atan2(edge1.dx * edge0.dz - edge1.dz * edge0.dx, edge1.dx * edge0.dx + edge1.dz * edge0.dz) * 180 / Math.PI;
  ed.moveStructure(id, 10.3, 0);
  const c2 = ed.centroid(ed.structure(id));
  ed.setHeight(id, 6);
  const h = ed.structure(id).heightFt;
  const unsaved = ed.unsaved;
  ed.undo(); ed.undo(); ed.undo();
  const back = ed.structure(id);
  const cBack = ed.centroid(back);
  return { before, id, dims, y: c0.y, ground: w.field.atOr(at[0], at[1], NaN), drawn: !!obj, solid: !!solid, top: solid ? solid.top - solid.base : null, sel, edge0, angle: +angle.toFixed(1), dimsTurned, centreMoved: +Math.hypot(c1.x - c0.x, c1.z - c0.z).toFixed(3), east: +(c2.x - c1.x).toFixed(3), h, unsaved, backH: back.heightFt, backEast: +(cBack.x - c0.x).toFixed(3), unsavedAfter: ed.unsaved, listed: w.structures.list.length };
}, { at: at(-40, -40) });
check('place: a block put down at real size — 12 by 8 read off its own footprint, 4 m high, on the ground, drawn, solid, selected',
  Math.abs(placed.dims.w - 12) < 0.01 && Math.abs(placed.dims.d - 8) < 0.01 && Math.abs(placed.dims.h - 4) < 0.05 && Math.abs(placed.y - placed.ground) < 0.6 && placed.drawn && placed.solid && Math.abs(placed.top - 4) < 0.05 && placed.sel === placed.id && placed.listed === placed.before.structures + 1,
  { dims: placed.dims, y: +placed.y.toFixed(2), ground: +placed.ground.toFixed(2), drawn: placed.drawn, solid: placed.solid, top: placed.top });
check('place: facing east, the block\'s first edge runs north-south; ] turns it 15° about its centre without changing its size',
  Math.abs(placed.edge0.dx) < 0.01 && Math.abs(Math.abs(placed.edge0.dz) - 12) < 0.01 && Math.abs(Math.abs(placed.angle) - 15) < 0.2 && Math.abs(placed.dimsTurned.w - 12) < 0.01 && placed.centreMoved < 0.01,
  { edge0: placed.edge0, angle: placed.angle, turned: placed.dimsTurned, centreMoved: placed.centreMoved });
check('place: a move of 10.3 m east lands on the half-metre snap, the height can be set, and undo walks it all back',
  Math.abs(placed.east - 10.5) < 0.01 && Math.abs(placed.h - 6 / 0.3048) < 0.1 && placed.unsaved === 1 && Math.abs(placed.backH - 4 / 0.3048) < 0.1 && Math.abs(placed.backEast) < 0.01 && placed.unsavedAfter === 1,
  { east: placed.east, h: placed.h, backH: placed.backH, backEast: placed.backEast, unsaved: [placed.unsaved, placed.unsavedAfter] });

const walls = await page.evaluate(({ id, at }) => {
  const w = window.world, p = w.player, ed = w.editor;
  const c = ed.centroid(ed.structure(id));
  const ll = w.frame.toLngLat(c.x, c.z + 14);       // 14 m south of the block's centre, facing north; its south wall is 6 m from the centre
  w.goto(ll.lng, ll.lat, 0);
  p.key('w', true); for (let i = 0; i < 12; i++) p.update(1); p.key('w', false);
  const s = p.state();
  const here = w.frame.toWorld(s.lng, s.lat);
  return { touching: s.touching, gap: +(here.z - (c.z + 6)).toFixed(2) };
}, { id: placed.id, at: at(-40, -40) });
check('place: the block stops the walker at its wall, like any building', walls.touching === placed.id && walls.gap > 0 && walls.gap < 0.6, walls);

// ---- the grid ------------------------------------------------------------------------------------------
const gridded = await page.evaluate(() => {
  const w = window.world;
  w.editor.frame();
  const g = w.grid.group.children.map(l => l.geometry.getAttribute('position'));
  const n = g.reduce((a, p) => a + p.count, 0);
  let worst = 0, sampled = 0;
  for (const pos of g) for (let i = 0; i < pos.count; i += 97) {
    const ll = w.frame.toLngLat(pos.getX(i), pos.getZ(i));
    const t = w.field.atOr(ll.lng, ll.lat, NaN);
    if (!isFinite(t)) continue;
    worst = Math.max(worst, Math.abs(pos.getY(i) - 0.06 - t)); sampled++;
  }
  const on = w.grid.visible;
  w.editor.toggleGrid();
  const off = w.grid.visible;
  w.editor.toggleGrid();
  return { on, off, n, worst: +worst.toFixed(3), sampled };
});
check('grid: a metre raster lies on the hillside while editing — thousands of segments, every sampled vertex on the surface — and V turns it off and on',
  gridded.on && !gridded.off && gridded.n > 4000 && gridded.sampled > 20 && gridded.worst < 0.02, gridded);

// ---- a builder proposes ---------------------------------------------------------------------------------
const proposedBy = await page.evaluate(async () => {
  const w = window.world, ed = w.editor;
  w.setSession({ role: 'builder', pin: '2424' });
  const label = document.querySelector('.edit-panel [data-act="save"]')?.textContent;
  const r = await ed.save('2424', 'a shed by the gate');
  const stillDrawn = !!w.structures.group.getObjectByName(`massing:${ed.proposed.structures[0]?.id}`);
  return { role: w.session.role, label, r, unsaved: ed.unsaved, proposed: ed.proposed.structures.length, stillDrawn, header: document.querySelector('.ep-head span')?.textContent };
});
check('propose: a builder\'s save goes to the atlas as a proposal — it waits for an admin, stays drawn here, and leaves the unsaved list',
  proposedBy.role === 'builder' && /propose/.test(proposedBy.label || '') && proposedBy.r.ok && /waiting for an admin/.test(proposedBy.r.message) && proposedBy.unsaved === 0 && proposedBy.proposed === 1 && proposedBy.stillDrawn && /1 proposed/.test(proposedBy.header || '')
    && server.proposals.length === 2 && server.proposals[1].by === 'builder' && server.proposals[1].status === 'pending' && server.proposals[1].structures.length === 1 && server.proposals[1].note === 'a shed by the gate',
  { ...proposedBy, sent: server.proposals.length });

// ---- the magic box ---------------------------------------------------------------------------------------
// A box put down on the ground opens its chat; a line sent reaches the agent with the box and the
// heading; the agent's proposals are cards, and taking one makes an ordinary unsaved edit at the
// right place — the block ten metres east of the box, facing east, the marker at its door.
const boxed = await page.evaluate(async ({ at }) => {
  const w = window.world, ed = w.editor, mg = w.magic;
  w.setSession({ role: 'admin', pin: '4242' });
  ed.setActive(true);
  w.goto(at[0], at[1], 45);
  const id = ed.addMagic(at[0], at[1], 'the knoll');
  const drawn = w.today.group.getObjectByName(`note:${id}`);
  const isCube = !!drawn && drawn.children.some(c => c.geometry && c.geometry.type === 'BoxGeometry');
  const opened = { open: ed.magicOpen === id, panel: !document.querySelector('.magic').hidden, title: document.querySelector('.mg-head b')?.textContent, greeting: mg.turns.length };
  const turn = await mg.send('I want a shed here');
  const cards = document.querySelectorAll('.mg-action').length;
  const before = { unsaved: ed.unsaved, structures: w.structures.list.length };
  const ok = mg.take(mg.turns.length - 1, 0);
  const s = ed.structures[ed.structures.length - 1];
  const c = ed.centroid(s);
  const bw = w.frame.toWorld(at[0], at[1]);
  const dims = ed.dimensions(s);
  const ok2 = mg.take(mg.turns.length - 1, 1);
  const marker = ed.edits[ed.edits.length - 1];
  const mw = w.frame.toWorld(marker.geometry.coordinates[0], marker.geometry.coordinates[1]);
  const twice = mg.take(mg.turns.length - 1, 0);
  const stored = JSON.parse(localStorage.getItem(`spatial-map:magic:${id}`) || '[]');
  return { id, drawn: !!drawn, isCube, opened, reply: turn?.text, actions: turn?.actions?.length, cards, before, ok, ok2, twice, east: +(c.x - bw.x).toFixed(2), north: +(bw.z - c.z).toFixed(2), dims, markerName: marker.properties.name, markerEast: +(mw.x - bw.x).toFixed(2), unsaved: ed.unsaved, stored: stored.length, takenFlags: mg.turns[mg.turns.length - 1].taken };
}, { at: at(-30, 30) });
check('magic: a box put down is a cube with a name, and its chat opens on it',
  boxed.drawn && boxed.isCube && boxed.opened.open && boxed.opened.panel && /the knoll/.test(boxed.opened.title || '') && boxed.opened.greeting === 1, boxed.opened);
check('magic: a line sent reaches the agent with the box, the heading and the transcript; the reply and its proposals come back as cards',
  server.asked.length === 1 && server.asked[0].box.name === 'the knoll' && Math.abs(server.asked[0].box.lng - at(-30, 30)[0]) < 1e-9 && server.asked[0].heading === 45 && server.asked[0].turns === 2 && /shed/.test(boxed.reply || '') && boxed.actions === 2 && boxed.cards === 2,
  { asked: server.asked[0], reply: boxed.reply, cards: boxed.cards });
check('magic: taking a proposal makes an ordinary unsaved edit at the right place — the shed 10 m east of the box, 6 by 4, facing east; the marker at its door',
  boxed.ok && boxed.ok2 && !boxed.twice && Math.abs(boxed.east - 10) < 0.6 && Math.abs(boxed.north) < 0.6 && Math.abs(boxed.dims.w - 6) < 0.01 && Math.abs(boxed.dims.d - 4) < 0.01 && Math.abs(boxed.dims.h - 3) < 0.05 && boxed.markerName === 'shed door' && Math.abs(boxed.markerEast - 7) < 0.01 && boxed.unsaved === boxed.before.unsaved + 2 && boxed.stored === 3 && boxed.takenFlags.every(Boolean),
  { east: boxed.east, north: boxed.north, dims: boxed.dims, marker: [boxed.markerName, boxed.markerEast], unsaved: [boxed.before.unsaved, boxed.unsaved], stored: boxed.stored });
await page.evaluate(() => { const w = window.world; w.editor.openMagic(null); while (w.editor.unsaved) w.editor.undo(); });

// ---- territories and the ground ------------------------------------------------------------------------------
// A ring drawn on the ground is a translucent fill that lies on the hillside with a label. A ring
// flattened is a pad: the ground inside it is level at the mean of its outline, the bank outside
// eases back into the hill over three metres, and the terrain mesh, the trees and the walker all
// follow because every one of them asks the same height function.
const shaped = await page.evaluate(({ ring, pad, probe, inside, bank, far }) => {
  const w = window.world, ed = w.editor;
  w.setSession({ role: 'admin', pin: '4242' });
  ed.setActive(true);
  ed.addZone(ring, 'the orchard', 'orchard');
  const zid = ed.edits[ed.edits.length - 1].properties.id;
  const zone = w.today.group.getObjectByName(`zone:${zid}`);
  const fill = zone && zone.children.find(c => c.geometry && c.geometry.getAttribute && c.geometry.getAttribute('position').count > 6);
  let worst = 0, sampled = 0;
  if (fill) { const pos = fill.geometry.getAttribute('position'); for (let i = 0; i < pos.count; i += 13) { const ll = w.frame.toLngLat(pos.getX(i), pos.getZ(i)); const t = w.field.atOr(ll.lng, ll.lat, NaN); if (isFinite(t)) { worst = Math.max(worst, Math.abs(pos.getY(i) - 0.08 - t)); sampled++; } } }
  const zpick = ed.pick ? 'ok' : 'no';
  // now the pad
  const before = { inside: w.field.at(inside[0], inside[1]), bank: w.field.at(bank[0], bank[1]), far: w.field.at(far[0], far[1]), gen: w.field.shapingGen, fine: w.terrain.group.getObjectByName('terrain-fine').uuid };
  const level = pad.map(([lng, lat]) => w.field.raw(lng, lat)).reduce((a, v) => a + v, 0) / pad.length;
  ed.addShaping(pad, 'flatten', 0, 3);
  const after = { inside: w.field.at(inside[0], inside[1]), bank: w.field.at(bank[0], bank[1]), far: w.field.at(far[0], far[1]), gen: w.field.shapingGen, fine: w.terrain.group.getObjectByName('terrain-fine').uuid, raw: w.field.raw(inside[0], inside[1]) };
  // the terrain mesh at the pad's centre: find the nearest fine-ring vertex
  const fine = w.terrain.group.getObjectByName('terrain-fine');
  const pos = fine.geometry.getAttribute('position');
  const c = w.frame.toWorld(inside[0], inside[1]);
  let best = Infinity, meshY = NaN;
  for (let i = 0; i < pos.count; i++) { const d = Math.hypot(pos.getX(i) - c.x, pos.getZ(i) - c.z); if (d < best) { best = d; meshY = pos.getY(i); } }
  // the walker stands on the pad
  w.goto(inside[0], inside[1], 0);
  w.player.update(0.5);
  const stood = w.state().groundM;
  // the trees on the pad stand at the new ground
  let treeWorst = 0, treesOn = 0;
  for (const name of ['veg-oak', 'veg-shrub']) {
    const m = w.vegetation.group.getObjectByName(name);
    if (!m) continue;
    const e = m.instanceMatrix.array;
    for (let i = 0; i < m.count; i++) { const ll = w.frame.toLngLat(e[i * 16 + 12], e[i * 16 + 14]); const t = w.field.at(ll.lng, ll.lat); if (t != null && Math.abs(t - level) < 0.01) { treesOn++; treeWorst = Math.max(treeWorst, Math.abs(e[i * 16 + 13] - t)); } }
  }
  const hud = document.querySelector('[data-el="pack"]').textContent;
  ed.undo();
  const undone = { inside: w.field.at(inside[0], inside[1]), gen: w.field.shapingGen };
  ed.undo();
  return { zone: !!zone, fill: !!fill, worst: +worst.toFixed(3), sampled, zpick, before, after, level, meshY, meshD: +best.toFixed(2), stood, treesOn, treeWorst: +treeWorst.toFixed(3), hud, undone, probe };
}, { ring: [at(-80, -20), at(-40, -20), at(-40, 10), at(-80, 10)], pad: [at(120, 40), at(140, 40), at(140, 60), at(120, 60)], inside: at(137, 45), bank: at(141.5, 50), far: at(150, 50), probe: at(137, 45) });
check('territory: a ring drawn on the ground is a fill of metre cells lying on the hillside, with an outline and a label',
  shaped.zone && shaped.fill && shaped.sampled > 20 && shaped.worst < 0.02, { zone: shaped.zone, fill: shaped.fill, sampled: shaped.sampled, worst: shaped.worst });
check('ground: flattening a ring makes a pad at the mean level of its outline — the raw tiles untouched, the bank half way at 1.5 m out, the hill beyond untouched',
  Math.abs(shaped.after.inside - shaped.level) < 0.01 && Math.abs(shaped.after.raw - shaped.before.inside) < 0.01 && Math.abs(shaped.before.inside - shaped.level) > 0.3
    && Math.abs(shaped.after.bank - (shaped.before.bank + (shaped.level - shaped.before.bank) * 0.5)) < 0.05 && Math.abs(shaped.after.far - shaped.before.far) < 1e-9 && shaped.after.gen === shaped.before.gen + 1,
  { level: +shaped.level.toFixed(2), inside: [+shaped.before.inside.toFixed(2), +shaped.after.inside.toFixed(2)], bank: [+shaped.before.bank.toFixed(2), +shaped.after.bank.toFixed(2)], far: [+shaped.before.far.toFixed(2), +shaped.after.far.toFixed(2)] });
check('ground: the terrain mesh is sampled again, the walker stands on the pad, the trees on it stand at the new ground, and the HUD says the ground was shaped',
  shaped.after.fine !== shaped.before.fine && shaped.meshD < 2 && Math.abs(shaped.meshY - shaped.level) < 0.01 && Math.abs(shaped.stood - shaped.level) < 0.05 && shaped.treesOn > 0 && shaped.treeWorst < 0.05 && /ground shaped/.test(shaped.hud),
  { rebuilt: shaped.after.fine !== shaped.before.fine, meshY: +shaped.meshY.toFixed(2), meshD: shaped.meshD, stood: +shaped.stood.toFixed(2), treesOn: shaped.treesOn, treeWorst: shaped.treeWorst });
check('ground: undo gives the hill back', Math.abs(shaped.undone.inside - shaped.before.inside) < 1e-9 && shaped.undone.gen === shaped.before.gen + 2, shaped.undone);

// ---- construction ------------------------------------------------------------------------------------------
// A room is a floor, a closed wall with a door, and a roof, at real size on the half-metre grid.
// The wall stops the walker except at the door; the floor is stood on; a window cut into the wall
// is a hole in its geometry; a change to a part replaces it in place; a part is moved, turned and
// taken down; and the agent can propose a room and a wall like anything else.
const room = await page.evaluate(({ at }) => {
  const w = window.world, ed = w.editor, p = w.player;
  w.setSession({ role: 'admin', pin: '4242' });
  ed.setActive(true);
  const before = { unsaved: ed.unsaved, built: w.pack.build.features.length };
  const wallId = ed.addRoom(at[0], at[1], { name: 'the studio', w: 6, d: 4, h: 2.7, wall: 'plaster', floor: 'wood', roof: 'gable', roofMaterial: 'tile', door: true }, 0);
  const parts = w.pack.build.features.map(f => ({ id: f.properties.id, kind: f.properties.kind, structure: f.properties.structure }));
  const drawn = parts.map(x => !!w.build.group.getObjectByName(`build:${x.id}`));
  const wallF = w.pack.build.features.find(f => f.properties.kind === 'wall');
  const floorF = w.pack.build.features.find(f => f.properties.kind === 'floor');
  const roofF = w.pack.build.features.find(f => f.properties.kind === 'roof');
  const wallMesh = w.build.group.getObjectByName(`build:${wallId}`);
  const box = new w.THREE.Box3().setFromObject(wallMesh);
  // the room's corners in world metres: the centre snapped to the half metre, six by four, the first side south
  const c = w.frame.toWorld(at[0], at[1]);
  const cs = { x: Math.round(c.x / 0.5) * 0.5, z: Math.round(c.z / 0.5) * 0.5 };
  const ground = Math.min(...wallF.geometry.coordinates.map(([lng, lat]) => w.field.at(lng, lat)));
  const pos = wallMesh.geometry.getAttribute('position');
  let headVerts = 0;
  for (let i = 0; i < pos.count; i++) if (Math.abs(pos.getY(i) - (ground + 0.2 + 2.1)) < 0.005) headVerts++;
  // walk north through the door in the middle of the south side, then into the wall two metres east of it
  const walkNorth = (x, z) => {
    const ll = w.frame.toLngLat(x, z);
    w.goto(ll.lng, ll.lat, 0);
    p.key('w', true);
    for (let i = 0; i < 4; i++) p.update(1);
    p.key('w', false);
    const s = p.state();
    const e = w.frame.toWorld(s.lng, s.lat);
    return { z: +(e.z - cs.z).toFixed(2), x: +(e.x - cs.x).toFixed(2), touching: s.touching, ground: s.groundM };
  };
  const throughDoor = walkNorth(cs.x, cs.z + 5);
  const intoWall = walkNorth(cs.x + 2, cs.z + 5);
  const hud = document.querySelector('[data-el="pack"]').textContent;
  return { before, wallId, parts, drawn, counts: { ...w.build.counts }, solids: w.build.solids.length, platforms: w.build.platforms.length, unsaved: ed.unsaved,
    wall: { height: +wallF.properties.height_m, openings: wallF.properties.openings, closed: wallF.geometry.coordinates.length, structure: wallF.properties.structure },
    floorId: floorF.properties.id, roofId: roofF.properties.id, roof: { form: roofF.properties.form, ridge: roofF.properties.ridge_deg, eaves: roofF.properties.eaves_m },
    box: { w: +(box.max.x - box.min.x).toFixed(2), d: +(box.max.z - box.min.z).toFixed(2), bottom: +(box.min.y - ground).toFixed(2), top: +(box.max.y - ground).toFixed(2) },
    headVerts, throughDoor, intoWall, ground, hud, sel: ed.selection?.kind, label: document.querySelector('.ep-sel b')?.textContent };
}, { at: at(60, -60) });
check('room: a room put down is three parts of one structure — a floor, a closed wall with a door, a gable roof — all drawn, and the HUD counts them',
  room.parts.length === room.before.built + 3 && room.drawn.every(Boolean) && room.parts.every(x => x.structure === 'the studio') && room.counts.walls === 1 && room.counts.floors === 1 && room.counts.roofs === 1 && room.counts.openings === 1
    && room.wall.closed === 5 && room.wall.openings.length === 1 && room.wall.openings[0].kind === 'door' && room.roof.form === 'gable' && room.roof.ridge === 90 && room.unsaved === room.before.unsaved + 3 && /3 built/.test(room.hud) && room.sel === 'build' && /wall/.test(room.label || ''),
  { parts: room.parts, counts: room.counts, wall: room.wall, roof: room.roof, hud: room.hud, sel: room.sel, label: room.label });
check('room: the wall is six by four metres outside to outside plus its thickness, stands 2.7 m over the slab, and its door head is cut at 2.1 m',
  Math.abs(room.box.w - 6.25) < 0.02 && Math.abs(room.box.d - 4.25) < 0.02 && Math.abs(room.box.bottom - 0.2) < 0.02 && Math.abs(room.box.top - 2.9) < 0.02 && room.headVerts >= 4,
  { box: room.box, headVerts: room.headVerts });
check('room: the walker goes in through the door and is stopped by the wall beside it; inside, the floor is the ground',
  room.throughDoor.z < 1.5 && room.throughDoor.z > -2 && Math.abs(room.throughDoor.ground - (room.ground + 0.2)) < 0.03
    && room.intoWall.z > 2.3 && room.intoWall.z < 2.8 && room.intoWall.touching === room.wallId && room.solids >= 2 && room.platforms === 1,
  { throughDoor: room.throughDoor, intoWall: room.intoWall, slab: +(room.ground + 0.2).toFixed(2), solids: room.solids });

const changed = await page.evaluate(({ wallId, floorId, roofId, arc }) => {
  const w = window.world, ed = w.editor;
  const verts = () => w.build.group.getObjectByName(`build:${wallId}`).geometry.getAttribute('position').count;
  const edits = () => ed.edits.filter(f => f.properties.layer === 'build').length;
  const plain = verts();
  const n0 = edits();
  ed.addOpening(wallId, 8, { kind: 'window', width: 1.2, sill: 0.9, head: 2.0 });
  const windowed = { verts: verts(), openings: ed.buildFeature(wallId).properties.openings.length, edits: edits() };
  ed.removeOpening(wallId, 1);
  const unwindowed = { verts: verts(), openings: ed.buildFeature(wallId).properties.openings.length };
  ed.updateBuild(wallId, { height_m: 3.5, material: 'stone' });
  const f = ed.buildFeature(wallId);
  const box = new w.THREE.Box3().setFromObject(w.build.group.getObjectByName(`build:${wallId}`));
  const taller = { height: f.properties.height_m, material: f.properties.material, span: +(box.max.y - box.min.y).toFixed(2), edits: edits() };
  // move the floor two metres east, turn the roof a quarter turn
  const centre = id => ed.buildCentre(ed.buildFeature(id));
  const c0 = centre(floorId);
  ed.moveBuild(floorId, 2, 0);
  const c1 = centre(floorId);
  const ridge0 = ed.buildFeature(roofId).properties.ridge_deg;
  ed.rotateBuild(roofId, 90);
  const ridge1 = ed.buildFeature(roofId).properties.ridge_deg;
  // a curved wall through four points: sampled every half metre, so many more vertices than its straight twin
  const straightId = ed.addWall(arc, { height: 2.4, thick: 0.3, material: 'adobe', smooth: false, base: 0, structure: '' });
  const straightVerts = w.build.group.getObjectByName(`build:${straightId}`).geometry.getAttribute('position').count;
  const curvedId = ed.addWall(arc, { height: 2.4, thick: 0.3, material: 'adobe', smooth: true, base: 0, structure: '' });
  const curvedVerts = w.build.group.getObjectByName(`build:${curvedId}`).geometry.getAttribute('position').count;
  const curvedSolids = w.build.solids.filter(s => s.id === curvedId).length;
  // taking down: a part never saved simply vanishes; one the pack holds becomes a removal to propose
  ed.removeBuild(straightId);
  const vanished = { drawn: !!w.build.group.getObjectByName(`build:${straightId}`), removal: ed.edits.some(x => x.properties.op === 'remove' && x.properties.target === straightId) };
  const saved = JSON.parse(JSON.stringify(ed.buildFeature(curvedId)));
  w.pack.edits.features.push(saved);
  ed.edits = ed.edits.filter(x => x.properties.id !== curvedId);
  w.rebuild();
  const heldByPack = !!w.build.group.getObjectByName(`build:${curvedId}`);
  ed.removeBuild(curvedId);
  const removal = ed.edits.find(x => x.properties.op === 'remove' && x.properties.layer === 'build' && x.properties.target === curvedId);
  const takenDown = { drawn: !!w.build.group.getObjectByName(`build:${curvedId}`), removal: !!removal, what: removal?.properties.what };
  w.pack.edits.features.splice(w.pack.edits.features.indexOf(saved), 1);
  const stored = JSON.parse(localStorage.getItem('spatial-map:edits:fixture-pack')).edits.filter(x => x.properties.layer === 'build').length;
  return { plain, n0, windowed, unwindowed, taller, moved: { east: +(c1.x - c0.x).toFixed(2), south: +(c1.z - c0.z).toFixed(2) }, ridge: [ridge0, ridge1], straightVerts, curvedVerts, curvedSolids, vanished, heldByPack, takenDown, stored, unsaved: ed.unsaved };
}, { wallId: room.wallId, floorId: room.floorId, roofId: room.roofId, arc: [at(80, -40), at(84, -34), at(90, -32), at(96, -34)] });
check('construction: a window cut into the wall is a hole in its geometry, and taking it out closes it',
  changed.windowed.verts > changed.plain && changed.windowed.openings === 2 && changed.windowed.edits === changed.n0 && changed.unwindowed.verts === changed.plain && changed.unwindowed.openings === 1,
  { plain: changed.plain, windowed: changed.windowed, unwindowed: changed.unwindowed });
check('construction: a change to a part replaces it in place — the wall 3.5 m high in stone, still one edit; the floor moved 2 m east; the roof turned a quarter',
  changed.taller.height === 3.5 && changed.taller.material === 'stone' && Math.abs(changed.taller.span - 3.5) < 0.02 && changed.taller.edits === changed.n0
    && Math.abs(changed.moved.east - 2) < 0.01 && Math.abs(changed.moved.south) < 0.01 && changed.ridge[1] === (changed.ridge[0] + 90) % 360,
  { taller: changed.taller, moved: changed.moved, ridge: changed.ridge });
check('construction: a curved wall is the same points bent into a curve sampled every half metre — many more vertices, and one solid run',
  changed.curvedVerts > changed.straightVerts * 3 && changed.curvedSolids === 1, { straight: changed.straightVerts, curved: changed.curvedVerts, solids: changed.curvedSolids });
check('construction: taking down a part never saved makes it vanish; taking down one the pack holds is a removal to propose, and it is gone from the ground',
  !changed.vanished.drawn && !changed.vanished.removal && changed.heldByPack && !changed.takenDown.drawn && changed.takenDown.removal && changed.takenDown.what === 'wall' && changed.stored >= 4,
  { vanished: changed.vanished, heldByPack: changed.heldByPack, takenDown: changed.takenDown, stored: changed.stored });

// the agent proposes a room and a wall; taken, they are parts like any drawn by hand
const proposedRoom = await page.evaluate(async ({ at }) => {
  const w = window.world, ed = w.editor, mg = w.magic;
  const id = ed.addMagic(at[0], at[1], 'the terrace');
  const turn = await mg.send('an annex here');
  const n0 = w.pack.build.features.length;
  mg.takeAll(mg.turns.length - 1);
  const parts = w.pack.build.features.slice(n0);
  const studio = parts.filter(f => f.properties.structure === 'the annex');
  const stone = parts.find(f => f.properties.material === 'stone');
  const roof = studio.find(f => f.properties.kind === 'roof');
  const floor = studio.find(f => f.properties.kind === 'floor');
  const c = ed.buildCentre(floor);
  const b = w.frame.toWorld(at[0], at[1]);
  ed.openMagic(null);
  return { actions: turn?.actions?.map(a => a.type), parts: parts.length, studio: studio.length, vault: roof?.properties.form, adobe: studio.find(f => f.properties.kind === 'wall')?.properties.material, east: +(c.x - b.x).toFixed(1), north: +(b.z - c.z).toFixed(1), stone: { height: stone?.properties.height_m, doors: stone?.properties.openings?.length, at: stone?.properties.openings?.[0]?.at_m } };
}, { at: at(-60, -60) });
check('magic: the agent proposes a room and a stone wall with a door; taken, the annex stands 15 m east of the box in adobe under a vault, and the wall has its door 4 m along',
  proposedRoom.actions?.join() === 'room,wall' && proposedRoom.parts === 4 && proposedRoom.studio === 3 && proposedRoom.vault === 'vault' && proposedRoom.adobe === 'adobe' && Math.abs(proposedRoom.east - 15) < 0.6 && Math.abs(proposedRoom.north) < 0.6
    && proposedRoom.stone.height === 2 && proposedRoom.stone.doors === 1 && proposedRoom.stone.at === 4, proposedRoom);

// a member reads a part
const readPart = await page.evaluate(({ wallId }) => {
  const w = window.world;
  const f = w.editor.buildFeature(wallId);
  const obj = w.build.group.getObjectByName(`build:${wallId}`);
  w.inspect.show({ kind: 'build', id: wallId, feature: f, object: obj, point: obj.position.clone() });
  const card = document.querySelector('.inspect');
  return { hidden: card.hidden, text: card.textContent };
}, { wallId: room.wallId });
check('read: a click on a wall says what it is — the structure, its length, height and material, and that the owner built it',
  !readPart.hidden && /the studio · wall/.test(readPart.text) && /3\.5 m high/.test(readPart.text) && /stone/.test(readPart.text) && /one of 3 parts/.test(readPart.text) && /built by the owner/.test(readPart.text), readPart);
// the parts go to the atlas with everything else
const savedParts = await page.evaluate(async () => {
  const w = window.world;
  const n = w.editor.edits.filter(f => f.properties.layer === 'build').length;
  const r = await w.editor.save('4242');
  return { n, r, built: w.pack.build.features.length };
});
check('save: the parts go to the atlas as build features and, applied, become part of the pack',
  savedParts.n >= 7 && savedParts.r.ok && server.proposals[server.proposals.length - 1].edits.filter(f => f.properties.layer === 'build').length === savedParts.n && savedParts.built >= 7, { ...savedParts, sent: server.proposals.length });
await page.evaluate(() => { const w = window.world; w.inspect.hide(); w.editor.setActive(false); });

// ---- a member reads --------------------------------------------------------------------------------------
const read = await page.evaluate(() => {
  const w = window.world;
  w.setSession({ role: 'member', pin: null });
  const editorOff = !w.editor.active;
  const post = w.today.group.getObjectByName('vision:retreat');
  w.inspect.show({ kind: 'vision', id: 'retreat', name: 'Retreat Village', object: post, point: post.position.clone() });
  const card = document.querySelector('.inspect');
  const shown = { hidden: card.hidden, text: card.textContent };
  w.inspect.show({ kind: 'ground', point: post.position.clone(), lng: 0, lat: 0 });
  return { editorOff, shown, hiddenAfter: card.hidden, role: w.session.role };
});
check('read: signing out closes the editor; a click on a project as a member opens a card that says what it is, and the ground closes it',
  read.editorOff && read.role === 'member' && !read.shown.hidden && /Retreat Village/.test(read.shown.text) && /planned|hospitality|project/.test(read.shown.text) && read.hiddenAfter, read);
await page.evaluate(() => { window.world.setSession({ role: 'admin', pin: '4242' }); window.world.editor.setActive(false); });

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
    const d = window.world.sky.dir.clone();   // the sun's direction; the light itself now rides with the player
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
