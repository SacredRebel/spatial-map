// Look at the world: node scripts/shot.mjs "<url>" out.png [lng,lat,heading] [first|third|fly|edit]
//
//   `fly` takes off and looks down from 40 m; `edit` does that and opens the editor with a marker
//   and a fence already made, so the panel and the drawn things are in the picture.
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
if (view === 'fly' || view === 'edit') {
  await page.evaluate(edit => {
    const w = window.world, p = w.player;
    p.setMode('fly');
    p.key(' ', true); for (let i = 0; i < 4; i++) p.update(1); p.key(' ', false);   // ~48 m up: update caps a step at a second
    p.look(0, 0.55);
    if (edit && w.pack) {
      const s = w.state();
      const MX = 111320 * Math.cos(s.lat * Math.PI / 180), MY = 110574;
      const off = (e, n) => [s.lng + e / MX, s.lat + n / MY];
      w.editor.setActive(true);
      w.editor.addNote(...off(12, 18), 'the gate');
      w.editor.addLine('fence', [off(-30, 8), off(-10, 14), off(10, 22), off(28, 24)], 'north fence');
      w.editor.addLine('path', [off(-6, -20), off(4, -2), off(12, 18)], 'to the gate');
    }
  }, view === 'edit');
}
await page.evaluate(() => window.world.terrain.imageryReady);
await page.waitForTimeout(2500);
await page.screenshot({ path: out });
console.log('wrote', out, await page.evaluate(() => JSON.stringify({ ...window.world.state(), veg: window.world.vegetation.counts, today: window.world.today.counts, drape: window.world.terrain.imageryState, grain: window.world.terrain.grainActive })));
await browser.close();
