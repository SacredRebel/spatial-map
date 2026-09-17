// The walkable world.
//
//   One community, one world. The atlas decides what is where — parcels, the 1 m ground, the
//   buildings that are proposed — and this renders it as somewhere you can stand. It reads the
//   atlas over HTTP rather than owning a copy, so there is exactly one answer to "where does the
//   house go", and it is the one on the map.
//
//   URL: ?community=sulphur-mountain&at=<lng>,<lat>,<heading>&atlas=<origin>

import * as THREE from 'three';
import { Frame } from './world/geo';
import { HeightField } from './world/heightfield';
import { Terrain } from './world/terrain';
import { Sky } from './world/sky';
import { instantAt } from './world/sun';
import { Structures } from './world/structures';
import { Player } from './player/player';
import { Hud } from './ui/hud';
import './style.css';

const DEFAULT_ATLAS = 'https://eco-village-map.vercel.app';
interface Community { name: string; pid: string; lng: number; lat: number; heading: number; tz: string }
const TZ = 'America/Los_Angeles';
const COMMUNITIES: Record<string, Community> = {
  'sulphur-mountain': { name: 'Sulphur Mountain', pid: 'sulphur-mountain', lng: -119.156345, lat: 34.432675, heading: 200, tz: TZ },
  'howard': { name: 'Howard', pid: 'howard', lng: -119.319741, lat: 34.424183, heading: 180, tz: TZ },
  'keris-property': { name: "Keri's", pid: 'keris-property', lng: -119.331364, lat: 34.433173, heading: 180, tz: TZ },
  'chers-property': { name: "Cher's", pid: 'chers-property', lng: -119.288871, lat: 34.402005, heading: 180, tz: TZ }
};

const FINE = { radius: 320, segments: 257 };     // a vertex every 2.5 m out to 320 m
const COARSE = { radius: 1600, segments: 129 };  // the horizon, a vertex every 25 m

const qs = new URLSearchParams(location.search);
const atlas = (qs.get('atlas') || DEFAULT_ATLAS).replace(/\/$/, '');
const slug = qs.get('community') || 'sulphur-mountain';
const community = COMMUNITIES[slug] || COMMUNITIES['sulphur-mountain'];
const at = (qs.get('at') || '').split(',').map(Number);
const start = {
  lng: isFinite(at[0]) && at[0] !== 0 ? at[0] : community.lng,
  lat: isFinite(at[1]) && at[1] !== 0 ? at[1] : community.lat,
  heading: isFinite(at[2]) ? at[2] : community.heading
};

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 12000);

const frame = new Frame({ lng: start.lng, lat: start.lat });
const field = new HeightField(atlas);
const terrain = new Terrain(frame, field);
const sky = new Sky();
const structures = new Structures(frame, field, atlas);
const player = new Player(frame, field, camera, renderer.domElement);

scene.add(terrain.group, structures.group, player.object);
sky.addTo(scene);

// the clock is the community's own wall time, not the viewer's: a shadow at half past two means
// half past two on that hillside, wherever in the world the person looking at it happens to be
let clockHours = 13.5;                         // early afternoon reads the land best

const hud = new Hud(app, {
  community: community.name,
  onTime: h => { clockHours = h; applySun(); },
  onView: () => player.toggleView(),
  onRecentre: () => player.placeAt(start.lng, start.lat, start.heading)
});

function applySun() {
  const { pos, horizon } = sky.set(instantAt(clockHours, community.tz), start.lat, start.lng);
  hud.setSun(pos.altitude, pos.azimuth);
  scene.fog = new THREE.Fog(horizon.getHex(), 420, 4200);
  renderer.setClearColor(horizon.getHex());
}

async function boot() {
  hud.setLoading('reading the ground…');
  const index = await field.loadIndex();
  if (!index) {
    hud.setLoading(`no ground published at ${atlas} — the atlas has not baked this area yet.`);
    return;
  }
  const area = field.areaAt(start.lng, start.lat) || index.areas[0];
  // the property itself at full detail, then a wider box so the ground does not end at the fence
  await field.loadBox(area.bbox, index.maxzoom);
  const pad = 0.004;
  await field.loadBox(
    [area.bbox[0] - pad, area.bbox[1] - pad, area.bbox[2] + pad, area.bbox[3] + pad],
    Math.max(index.minzoom, index.maxzoom - 3)
  );

  player.placeAt(start.lng, start.lat, start.heading);
  const p = player.position;
  terrain.buildCoarse(p.x, p.z, COARSE);
  terrain.buildFine(p.x, p.z, FINE);
  applySun();

  hud.setLoading('reading what is proposed here…');
  await structures.load(area.pid);
  structures.build(area.pid);

  hud.setLoading(null);
  ready = true;
  (window as unknown as { world: unknown }).world = api;
}

let ready = false;
let last = performance.now();

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  if (ready) {
    player.update(dt);
    const p = player.position;
    terrain.update(p.x, p.z, FINE);
    sky.mesh.position.copy(camera.position);
    sky.sun.target.position.set(p.x, p.y, p.z);
    sky.sun.position.copy(sky.sun.target.position).add(sunOffset());
    hud.frame(player.state(), field.loadedTiles);
  }
  renderer.render(scene, camera);
}

const _sunOffset = new THREE.Vector3();
function sunOffset(): THREE.Vector3 {
  // keep the shadow camera tight around the player by moving the light with them
  return _sunOffset.copy(sky.sun.position).sub(sky.sun.target.position).setLength(900);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// a small surface for tests and for the Playground shell to drive
const api = {
  player, field, terrain, structures, sky, scene, camera, renderer,
  get ready() { return ready; },
  state: () => ({ ...player.state(), tiles: field.loadedTiles, community: slug, atlas }),
  goto: (lng: number, lat: number, heading = 0) => player.placeAt(lng, lat, heading),
  setTime: (h: number) => { clockHours = h; applySun(); }
};
(window as unknown as { world: unknown }).world = api;

loop();
void boot();
