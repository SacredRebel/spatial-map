// Look at the world: node scripts/shot.mjs "<url>" out.png [lng,lat,heading] [first|third|fly|edit|place|magic|ground]
//
//   `fly` takes off and looks down from 50 m; `edit` does that and opens the editor with a marker
//   and a fence already made, so the panel and the drawn things are in the picture; `place` puts a
//   12 × 8 × 4 m block down on the grid and selects it, dimensions and all.
//
//   Boots the built world in headless Chromium against whatever the url names, waits for the
//   ground and the aerial, optionally stands the player somewhere (and in first person, to look at
//   the ground), and writes a screenshot.
import { chromium } from 'playwright';
import { existsSync } from 'fs';

const [url, out, at, view] = process.argv.slice(2);
if (!url || !out) { console.error('usage: node scripts/shot.mjs <url> <out.png> [lng,lat,heading]'); process.exit(2); }
const sys = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const opts = { args: ['--no-sandbox', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
else if (!existsSync(chromium.executablePath()) && sys) opts.executablePath = sys;
const browser = await chromium.launch(opts);
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.world && window.world.ready, { timeout: 120000 });
if (at) {
  const [lng, lat, heading] = at.split(',').map(Number);
  await page.evaluate(([lng, lat, heading]) => window.world.goto(lng, lat, heading || 0), [lng, lat, heading]);
}
if (view === 'first' || view === 'third') await page.evaluate(v => window.world.player.setView(v), view);
if (view === 'magic') {
  // stand at a box, with a conversation and two proposals already in the transcript
  await page.evaluate(() => {
    const w = window.world;
    w.setSession({ role: 'admin', pin: '0000' });
    w.editor.setActive(true);
    w.player.setView('third');
    const s = w.state();
    const MX = 111320 * Math.cos(s.lat * Math.PI / 180), MY = 110574;
    const id = w.editor.addMagic(s.lng + 6 / MX, s.lat + 8 / MY, 'the knoll');
    w.magic.turns.push({ role: 'you', text: 'I want a small guest cabin here, facing the valley, with a deck on the south side', at: Date.now() });
    w.magic.turns.push({ role: 'agent', text: 'A cabin, then: six by four metres and three high, its long side to the valley, and a deck four by three on its south side. Take what you want.', actions: [
      { type: 'block', name: 'guest cabin', w: 6, d: 4, h: 3, e: 0, n: 0, heading: 200 },
      { type: 'block', name: 'deck', w: 4, d: 3, h: 0.5, e: 0, n: -4, heading: 200 },
      { type: 'marker', name: 'cabin door', e: 0, n: -2 }
    ], taken: [false, false, false], at: Date.now() });
    w.magic.take(w.magic.turns.length - 1, 0);
    w.editor.openMagic(id);
  });
}
if (view === 'fly' || view === 'edit' || view === 'place' || view === 'ground' || view === 'build' || view === 'inside') {
  await page.evaluate(mode => {
    const w = window.world, p = w.player;
    p.setMode('fly');
    if (mode !== 'inside') { p.key(' ', true); for (let i = 0; i < (mode === 'place' ? 2 : mode === 'ground' ? 3 : mode === 'build' ? 3 : 4); i++) p.update(1); p.key(' ', false); }   // up: update caps a step at a second
    p.look(0, mode === 'place' ? 0.75 : mode === 'ground' ? 0.7 : mode === 'build' ? 0.72 : mode === 'inside' ? 0.1 : 0.55);
    if (mode !== 'fly' && w.pack) {
      const s = w.state();
      const MX = 111320 * Math.cos(s.lat * Math.PI / 180), MY = 110574;
      const off = (e, n) => [s.lng + e / MX, s.lat + n / MY];
      w.setSession({ role: 'admin', pin: '0000' });
      w.editor.setActive(true);
      if (mode === 'edit') {
        w.editor.addNote(...off(12, 18), 'the gate');
        w.editor.addLine('fence', [off(-30, 8), off(-10, 14), off(10, 22), off(28, 24)], 'north fence');
        w.editor.addLine('path', [off(-6, -20), off(4, -2), off(12, 18)], 'to the gate');
      } else if (mode === 'ground') {
        // a pad flattened for the house on the slope, a raised bank behind it, and the orchard marked out
        w.editor.addShaping([off(-12, 10), off(12, 10), off(12, 28), off(-12, 28)], 'flatten', 0, 4);
        w.editor.addShaping([off(-30, 34), off(30, 34), off(30, 40), off(-30, 40)], 'raise', 1.5, 3);
        w.editor.addZone([off(-45, -10), off(-18, -10), off(-18, 30), off(-45, 30)], 'the orchard', 'orchard');
        w.editor.addZone([off(18, -10), off(48, -10), off(48, 18), off(18, 18)], 'kitchen garden', 'garden');
        const id = w.editor.addBlock(...off(0, 19), { name: 'the new house', w: 14, d: 9, h: 4.5 }, s.headingDeg);
        w.editor.setTool('terrain');
        void id;
      } else if (mode === 'build' || mode === 'inside') {
        // the pad flattened, then a house built part by part: a room, a curved adobe wing with windows, a deck
        w.editor.removeTreesAround(...off(2, 18), 24);
        w.editor.addShaping([off(-16, 6), off(16, 6), off(16, 30), off(-16, 30)], 'flatten', 0, 4);
        const wall = w.editor.addRoom(...off(0, 18), { name: 'the main house', w: 9, d: 6, h: 2.9, wall: 'lime', floor: 'wood', roof: 'gable', roofMaterial: 'tile', door: true }, s.headingDeg);
        w.editor.addOpening(wall, 2, { kind: 'window', width: 1.6, sill: 0.9, head: 2.2 });
        w.editor.addOpening(wall, 6.5, { kind: 'window', width: 1.6, sill: 0.9, head: 2.2 });
        w.editor.addOpening(wall, 12, { kind: 'window', width: 2.4, sill: 0.8, head: 2.3 });
        const wing = w.editor.addWall([off(6.5, 20), off(10.5, 21.5), off(14, 19), off(15, 15), off(12.5, 12)], { height: 2.6, thick: 0.35, material: 'adobe', smooth: true, base: 0, structure: 'the main house' });
        w.editor.addOpening(wing, 5, { kind: 'window', width: 1.2, sill: 0.9, head: 2.1 });
        w.editor.addOpening(wing, 9.5, { kind: 'door', width: 1, sill: 0, head: 2.1 });
        w.editor.addRoof([off(6.5, 12), off(15.5, 12), off(15.5, 22), off(6.5, 22)], { form: 'vault', eaves: 2.6, pitch: 30, overhang: 0.4, material: 'metal', structure: 'the main house' });
        w.editor.addFloor([off(-4.5, 6), off(4.5, 6), off(4.5, 12), off(-4.5, 12)], { level: 0, thick: 0.3, material: 'timber', structure: 'the deck' });
        w.editor.setTool(mode === 'inside' ? 'select' : 'wall');
        if (mode === 'inside') {
          // stand a step in from the middle of the back wall, looking at the door and the windows in the front
          const c = w.editor.buildFeature(wall).geometry.coordinates;
          const mid = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
          const back = mid(c[2], c[3], 0.5), centre = mid(mid(c[0], c[2], 0.5), mid(c[1], c[3], 0.5), 0.5);
          const stand = mid(back, centre, 0.3);
          p.setMode('walk'); w.goto(stand[0], stand[1], s.headingDeg + 180); for (let i = 0; i < 3; i++) p.update(0.5); p.setView('first'); w.editor.setActive(false);
        }
      } else {
        w.editor.setTool('block');
        const id = w.editor.addBlock(...off(0, 14), { name: 'the new house', w: 14, d: 9, h: 4.5 }, s.headingDeg);
        w.editor.rotateStructure(id, 15);
      }
    }
  }, view);
}
await page.evaluate(() => window.world.terrain.imageryReady);
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log('wrote', out, await page.evaluate(() => JSON.stringify({ ...window.world.state(), veg: window.world.vegetation.counts, today: window.world.today.counts, drape: window.world.terrain.imageryState, grain: window.world.terrain.grainActive })));
await browser.close();
