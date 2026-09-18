// Look at a massing model on its own, before it goes anywhere near the ground.
//
//   node scripts/massing/preview.mjs model.glb out-prefix [x,y,z ...]
//
//   Renders the .glb with the same three.js the world uses, from a few points of view, and writes
//   out-prefix-<n>.png for each. A view is a camera position in model metres looking at the origin;
//   the defaults circle the model at eye height and from above.
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { chromium } from 'playwright';

const [glb, prefix = 'preview', ...views] = process.argv.slice(2);
if (!glb) { console.error('usage: preview.mjs model.glb out-prefix [x,y,z ...]'); process.exit(1); }
const ROOT = resolve(process.cwd());
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.html': 'text/html' };

const html = `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#cfd8dc}canvas{display:block}</style>
<script type="importmap">{"imports":{"three":"/node_modules/three/build/three.module.js","three/addons/":"/node_modules/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(1280, 800); renderer.shadowMap.enabled = true; renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.1;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color('#cfd8dc');
scene.add(new THREE.HemisphereLight('#dfe8ff', '#5a4a30', 0.9));
const sun = new THREE.DirectionalLight('#fff4e0', 2.2); sun.position.set(30, 60, 20); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); const c = sun.shadow.camera; c.left = c.bottom = -60; c.right = c.top = 60; c.far = 200;
scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.MeshStandardMaterial({ color: '#7a8a5a', roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -3.5; ground.receiveShadow = true; scene.add(ground);
const camera = new THREE.PerspectiveCamera(50, 1280 / 800, 0.1, 1000);
const gltf = await new GLTFLoader().loadAsync('/model.glb');
gltf.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
scene.add(gltf.scene);
window.walk = gltf.scene.userData.walk; window.levels = gltf.scene.userData.levels_m;
window.look = (x, y, z) => { camera.position.set(x, y, z); camera.lookAt(0, 1.5, 0); renderer.render(scene, camera); };
window.ready = true;
</script>`;

const server = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  try {
    if (p === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(html); }
    const file = p === '/model.glb' ? resolve(glb) : join(ROOT, p);
    if (!file.startsWith(ROOT) && file !== resolve(glb)) throw new Error('outside');
    statSync(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch { res.writeHead(404); res.end('no'); }
});
await new Promise(r => server.listen(0, r));
const port = server.address().port;

const sys = ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync);
const opts = { args: ['--no-sandbox', '--enable-unsafe-swiftshader'] };
if (process.env.CHROMIUM_PATH) opts.executablePath = process.env.CHROMIUM_PATH;
else if (!existsSync(chromium.executablePath()) && sys) opts.executablePath = sys;
const browser = await chromium.launch(opts);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', m => { if (m.type() === 'error') console.error('[page]', m.text()); });
await page.goto(`http://localhost:${port}/`);
await page.waitForFunction(() => window.ready, null, { timeout: 60000 });
const walk = await page.evaluate(() => ({ floors: window.walk?.floors?.length, solids: window.walk?.solids?.length, levels: window.levels }));
console.log('walk', JSON.stringify(walk));
const list = views.length ? views.map(v => v.split(',').map(Number)) : [[38, 12, 48], [-42, 10, 30], [45, 9, -25], [0, 70, 55], [-4, 1.7, 12]];
for (let i = 0; i < list.length; i++) {
  await page.evaluate(([x, y, z]) => window.look(x, y, z), list[i]);
  await page.waitForTimeout(150);
  const png = await page.evaluate(() => document.querySelector('canvas').toDataURL('image/png'));
  writeFileSync(`${prefix}-${i}.png`, Buffer.from(png.split(',')[1], 'base64'));
  console.log(`${prefix}-${i}.png from`, list[i].join(','));
}
await browser.close(); server.close();
