// The world, driven in a real browser against a known hillside.
//
//   The fixture ground is a tilted plane whose height at any point is arithmetic — base 500 m,
//   rising 5 % east and falling 3 % north — so every claim here is checked against a number we can
//   work out rather than against whatever the renderer happens to produce. If the decoder, the
//   interpolation, the local frame or the walker is wrong by a metre, these fail.
import { chromium } from 'playwright';
import { existsSync } from 'fs';
import { start } from './serve.mjs';
import { height, ORIGIN } from './fixture.mjs';

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

await page.goto(`${BASE}/?atlas=${BASE}&community=sulphur-mountain`, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
