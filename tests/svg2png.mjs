import { chromium } from 'playwright';
const [, , svg, out] = process.argv;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 1300 }, deviceScaleFactor: 2 });
await p.goto('file://' + svg);
const el = await p.$('svg');
await el.screenshot({ path: out });
console.log('png', out);
await b.close();
