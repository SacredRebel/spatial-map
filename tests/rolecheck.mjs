import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1280, height: 720 } });
p.on('pageerror', e => console.log('PAGEERROR', e.message));
const base = 'http://localhost:5181/?community=sulphur-mountain&pack=https://raw.githubusercontent.com/SacredRebel/sulphur-mountain-world/main/&atlas=http://localhost:5181&far=0';
for (const [label, url] of [['member', base], ['builder', base + '&role=builder']]) {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await p.waitForFunction(() => window.world && window.world.ready, null, { timeout: 90000 });
  const before = await p.evaluate(() => ({ role: window.world.session.role, active: window.world.editor.active }));
  await p.keyboard.press('b');                       // a real DOM keydown: the editor listens on window
  await p.waitForTimeout(400);
  const out = await p.evaluate(() => ({
    role: window.world.session.role,
    after: window.world.editor.active,
    panel: !!document.querySelector('.panel'),
    notice: document.querySelector('[data-el="notice"]')?.textContent || null
  }));
  out.before = before.active;
  console.log(label, JSON.stringify(out));
}
await b.close();
