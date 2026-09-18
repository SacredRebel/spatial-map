// The walkable world.
//
//   One community, one world. The atlas decides what is where — parcels, the 1 m ground, the
//   buildings that are proposed — and this renders it as somewhere you can stand. It reads the
//   atlas over HTTP rather than owning a copy, so there is exactly one answer to "where does the
//   house go", and it is the one on the map.
//
//   URL: ?community=sulphur-mountain&at=<lng>,<lat>,<heading>&t=<hours>&avatar=<url>&atlas=<origin>
//        &pack=<url of a data pack, or 0 for none>&far=<a coarse terrain template for the horizon, or 0>
//
//   G flies (god mode: anywhere, any height); B edits. Edits are features of the pack's own edits
//   layer, or changes to the atlas's registry of structures, drawn the moment they are made and kept
//   in the browser until they go to the atlas as a proposal. Who may do what is a ROLE — member,
//   builder, admin — from a PIN the atlas checks; the table is in world/roles.ts.
//
//   A community may also have a PACK — one repository of that property's ground truth (the
//   surveyed line, the roofs the lidar measured, every tree it saw, the road, the placed zones).
//   Where the pack speaks, the world listens to it instead of guessing: the real trees stand where
//   the record puts them and the rule keeps out of that ground; what stands is raised to its
//   measured height; the county's aerial is laid over the ground you walk on.

import * as THREE from 'three';
import { Frame } from './world/geo';
import { HeightField, GLOBAL_TERRAIN } from './world/heightfield';
import { Terrain } from './world/terrain';
import { Vegetation } from './world/vegetation';
import { Sky } from './world/sky';
import { instantAt } from './world/sun';
import { Structures } from './world/structures';
import { solidsFrom, inRing } from './world/collide';
import { loadPack, applyEdits, type PackData, type Feature } from './world/pack';
import { Today, type TodayTiles } from './world/today';
import { Build } from './world/build';
import { loadGrain, loadTile } from './world/grain';
import { Editor } from './edit/editor';
import { Panel } from './edit/panel';
import { Magic } from './edit/magic';
import { GroundGrid } from './edit/grid';
import { Inspect } from './ui/inspect';
import { CAPS, loadSession, saveSession, roleFor, type Session } from './world/roles';
import { mergeChanges, type Structure, type StructureChange } from './world/structures';
import { shapingFrom, type Shaping } from './world/shaping';
import { Player } from './player/player';
import { loadAvatar } from './player/avatar';
import { Hud } from './ui/hud';
import { Stick, touchCapable } from './ui/stick';
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

/** the pack each community keeps, unless the URL says otherwise */
const PACKS: Record<string, string> = {
  'sulphur-mountain': 'https://raw.githubusercontent.com/SacredRebel/sulphur-mountain-world/main/'
};

const FINE = { radius: 320, segments: 257 };     // a vertex every 2.5 m out to 320 m
const COARSE = { radius: 1600, segments: 129 };  // the middle distance, a vertex every 25 m
const FAR = { radius: 24000, segments: 257 };    // the ridges across the valley, a vertex every 190 m
const PLANTED = { radius: 420 };                 // vegetation reaches past the fine ring's edge
const HAZE = { near: 500, far: 26000 };          // aerial perspective: the far ring dissolves into the sky

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
// Number(null) is 0, not NaN, so an absent parameter must be caught before it is parsed — otherwise
// "no time given" silently becomes midnight and the world opens in the dark.
const num = (key: string, fallback: number, lo: number, hi: number): number => {
  const raw = qs.get(key);
  if (raw == null || raw === '') return fallback;
  const v = Number(raw);
  return isFinite(v) && v >= lo && v <= hi ? v : fallback;
};
const startHours = num('t', 13.5, 0, 24);   // early afternoon reads the land best
const avatarUrl = qs.get('avatar');
const plantDensity = num('plants', 1, 0, 2);
const packParam = qs.get('pack');
const packUrl = packParam === '0' || packParam === 'none' ? null : packParam || PACKS[slug] || null;
// the ground beyond the property: the global terrarium set, another {z}/{x}/{y} template, or none
const farParam = qs.get('far');
const farSource = farParam === '0' || farParam === 'none' ? null : farParam ? { template: farParam, minzoom: 0, maxzoom: 12 } : GLOBAL_TERRAIN;

const app = document.getElementById('app')!;
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const EXPOSURE = 0.75;                           // at midday; the sky opens the eye further at dusk
renderer.toneMappingExposure = EXPOSURE;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.1, 60000);

const frame = new Frame({ lng: start.lng, lat: start.lat });
const field = new HeightField(atlas, farSource);
const terrain = new Terrain(frame, field);
const vegetation = new Vegetation(frame, field);
const sky = new Sky();
const structures = new Structures(frame, field, atlas);
const today = new Today(frame, field);
const build = new Build(frame, field);

/** everything a body can stand on or walk into, gathered from the registry, the record, and what is built */
function refreshWalk() {
  player.solids = solidsFrom(structures.list, frame, field, pid).concat(today.solids, build.solids, structures.solids);
  player.platforms = build.platforms.concat(structures.platforms);
}
structures.onWalk = refreshWalk;

/** the record's trees, less the ones a proposal stands on */
function recordTrees() {
  if (!pack) return [];
  const taken = structures.occupied(pid);
  const out: { x: number; z: number; height: number; crown: number }[] = [];
  for (const t of pack.trees) {
    const w = frame.toWorld(t.lng, t.lat);
    if (taken.some(r => inRing(w.x, w.z, r))) continue;
    out.push({ x: w.x, z: w.z, height: t.height, crown: t.crown });
  }
  return out;
}
const player = new Player(frame, field, camera, renderer.domElement);
let pack: PackData | null = null;
/** the close-up tiles the standing things carry, kept so a rebuild can carry them again */
let tiles: TodayTiles = {};
/** the atlas's registry as loaded, before any change made here */
let structuresBase: Structure[] = [];
let pid = community.pid;
let session: Session = loadSession();
const caps = () => CAPS[session.role];
const grid = new GroundGrid(frame, field);

scene.add(terrain.group, vegetation.group, structures.group, today.group, build.group, player.object, grid.group);
sky.addTo(scene);

// the clock is the community's own wall time, not the viewer's: a shadow at half past two means
// half past two on that hillside, wherever in the world the person looking at it happens to be
let clockHours = startHours;

const hud = new Hud(app, {
  community: community.name,
  hours: clockHours,
  onTime: h => { clockHours = h; applySun(); },
  onView: () => player.toggleView(),
  onRecentre: () => player.placeAt(start.lng, start.lat, start.heading),
  onFly: () => { if (caps().fly) player.toggleMode(); },
  onEdit: () => editor.toggle(),
  onRole: () => void signIn()
});

const editor = new Editor({
  dom: renderer.domElement, camera, frame, field, player, vegetation, today, structures, build, grid, scene, atlas,
  pack: () => pack,
  pid: () => pid,
  structuresBase: () => structuresBase,
  caps,
  rebuild: (edits, changes) => rebuild(edits, changes),
  onChange: () => { panel.render(); magic.open(editor.magicOpen); hud.setMode(player.mode === 'fly', editor.active); }
});
const magic = new Magic(app, editor, { atlas, pack: () => pack, session: () => session, heading: () => player.state().headingDeg });
const panel = new Panel(app, editor, {
  askPin: () => session.pin ?? window.prompt('The atlas PIN:'),
  role: () => session.role,
  caps
});
const inspect = new Inspect(app, renderer.domElement, editor, () => pack);
hud.setRole(session.role, caps().edit);

/** the role button: a PIN makes a builder or an admin; a second click signs out */
async function signIn() {
  if (session.role !== 'member') {
    session = { role: 'member', pin: null };
    saveSession(session);
    editor.setActive(false);
    hud.setRole(session.role, caps().edit);
    editor.refresh();
    return;
  }
  const pin = window.prompt('Your PIN — a builder proposes, an admin decides:');
  if (!pin) return;
  const role = await roleFor(atlas, pin.trim());
  if (!role) { window.alert('That PIN is not known to the atlas.'); return; }
  session = { role, pin: pin.trim() };
  saveSession(session);
  hud.setRole(session.role, caps().edit);
  editor.refresh();
}

/**
 * Redraw everything the record, the edits and the structure changes together decide: the trees
 * that stand, the projects where they now are, the markers and the lines, the blocks and the
 * designed buildings where they now sit. The ground, the sky and the county's buildings are
 * untouched — an edit never reaches them.
 */
function rebuild(edits: Feature[], changes: StructureChange[]) {
  let replant = false;
  if (pack) {
    pack = applyEdits(pack, edits);
    // the ground first: if it has been reshaped, the rings are sampled again and the hillside replanted
    const gen = field.shapingGen;
    field.setShapings(pack.terrain.features.map(f => shapingFrom(f, (lng, lat) => field.raw(lng, lat))).filter((x): x is Shaping => !!x));
    if (field.shapingGen !== gen) {
      terrain.reshape();
      replant = true;
      grid.visible = grid.visible;                // forgets its centre, so it is rebuilt on the next frame
    }
  }
  structures.list = mergeChanges(structuresBase, changes);
  structures.build(pid);
  if (pack) {
    today.build(pack, tiles, structures.cleared(pid));
    const was = `${build.solids.length}:${build.platforms.length}:${build.counts.roofs}`;
    build.build(pack);
    if (`${build.solids.length}:${build.platforms.length}:${build.counts.roofs}` !== was) replant = true;   // nothing grows through a new floor
    vegetation.buildRecords(recordTrees());
    hud.setPack(packLine(pack));
  }
  refreshWalk();
  if (replant) {
    const p = player.position;
    vegetation.build(p.x, p.z, { radius: PLANTED.radius, keepOut: keepOut(), density: plantDensity, exclude: packRing() });
  }
}

const stick = new Stick(app, {
  onAxis: (fwd, side, run) => player.setAxis(fwd, side, run),
  onJump: () => player.jump(),
  onView: () => player.toggleView()
});
stick.show(touchCapable() || qs.get('stick') === '1');

function applySun() {
  const { pos, horizon } = sky.set(instantAt(clockHours, community.tz), start.lat, start.lng);
  hud.setSun(pos.altitude, pos.azimuth);
  renderer.toneMappingExposure = EXPOSURE * sky.exposure;
  // the haze is the colour the sky itself is at the horizon, so far ground dissolves into it
  if (!scene.fog) scene.fog = new THREE.Fog(horizon, HAZE.near, HAZE.far);
  else scene.fog.color.copy(horizon);
  renderer.setClearColor(horizon);
}

/** the ring of the pack's area, in world metres — the rule stays out of it, the record fills it */
function packRing(): { x: number; z: number }[] {
  if (!pack) return [];
  const [w, s, e, n] = pack.manifest.aoi.bbox;
  return [[w, s], [e, s], [e, n], [w, n]].map(([lng, lat]) => {
    const p = frame.toWorld(lng, lat);
    return { x: p.x, z: p.z };
  });
}

/** what the plants must leave clear: every footprint the atlas knows about, plus where you stand */
function keepOut() {
  const out = structures.list
    .filter(s => s.outline && s.outline.length >= 3)
    .map(s => ({
      ring: s.outline!.map(([lng, lat]) => {
        const w = frame.toWorld(lng, lat);
        return { x: w.x, z: w.z };
      }),
      pad: 3.5
    }));
  // nothing grows through a floor or a wall
  for (const f of build.platforms) out.push({ ring: f.ring, pad: 1.5 });
  for (const s of build.solids) out.push({ ring: s.ring, pad: 1 });
  const p = frame.toWorld(start.lng, start.lat);
  const r = 7;
  out.push({
    ring: [
      { x: p.x - r, z: p.z - r }, { x: p.x + r, z: p.z - r },
      { x: p.x + r, z: p.z + r }, { x: p.x - r, z: p.z + r }
    ],
    pad: 0
  });
  return out;
}

async function boot() {
  hud.setLoading('reading the ground…');
  // the pack first: it may say where its own ground is kept, and the world should not depend on
  // the atlas answering to open at all
  const loaded = packUrl ? await loadPack(packUrl) : null;
  pack = loaded;
  if (pack?.ground) field.useSource(pack.ground.index, pack.ground.template);
  let index = await field.loadIndex();
  const around = (deg: number): [number, number, number, number] => [start.lng - deg, start.lat - deg, start.lng + deg, start.lat + deg];
  if (!index) {
    // the fine pyramid did not answer: open anyway on the coarse global ground and say so
    index = field.coarseOnly();
    if (!index) {
      hud.setLoading(`no ground could be read from ${field.indexUrl.replace(/\/terrain\/index\.json$/, '')} — and no far source to fall back on.`);
      return;
    }
    hud.setNotice(`the fine ground did not answer — walking on the coarse global set (about 10 m between samples). Reload to try again.`);
  }
  const area = field.coarse ? { pid: community.pid, bbox: around(0.006), tiles: 0 } : (field.areaAt(start.lng, start.lat) || index.areas[0]);
  pid = area.pid;
  // the property itself at full detail, then a wider box so the ground does not end at the fence,
  // then the valley and the ridges beyond it from the coarse global set — the horizon is real ground
  if (!field.coarse) {
    await field.loadBox(area.bbox, index.maxzoom);
    const pad = 0.004;
    await field.loadBox(
      [area.bbox[0] - pad, area.bbox[1] - pad, area.bbox[2] + pad, area.bbox[3] + pad],
      Math.max(index.minzoom, index.maxzoom - 3)
    );
  }
  if (farSource) await Promise.all([field.loadBox(around(0.01), 12), field.loadBox(around(0.05), 12), field.loadBox(around(0.3), 10)]);

  player.placeAt(start.lng, start.lat, start.heading);
  const p = player.position;
  terrain.buildFar(p.x, p.z, FAR);
  terrain.buildCoarse(p.x, p.z, COARSE);
  terrain.buildFine(p.x, p.z, FINE);
  applySun();

  hud.setLoading('reading what is proposed here…');
  await structures.load(area.pid);
  if (pack) {
    // the pack's own shapings of the ground, before anything stands on it; the rings were built before the pack arrived
    field.setShapings(pack.terrain.features.map(f => shapingFrom(f, (lng, lat) => field.raw(lng, lat))).filter((x): x is Shaping => !!x));
    if (field.shapingGen) terrain.reshape();
  }
  structuresBase = structures.list.slice();
  structures.build(area.pid);

  if (pack) {
    hud.setLoading('reading what stands here…');
    // the close-up tiles first, so what is built can carry them; a missing tile is a flat colour, never a wait
    const [grain, asphalt] = await Promise.all([
      loadGrain(pack.materials),
      loadTile(pack.materials?.asphalt?.albedo_512 || pack.materials?.asphalt?.albedo)
    ]);
    tiles = { asphalt, asphaltMetres: pack.materials?.asphalt?.metres };
    today.build(pack, tiles, structures.cleared(area.pid));
    build.build(pack);
    if (grain) terrain.setGrain(grain);
    // the record's trees, at their own positions; the rule keeps out of the pack's ground
    vegetation.buildRecords(recordTrees());
    if (pack.imagery) terrain.setImagery({ template: pack.imagery.template, maxzoom: pack.imagery.maxzoom });
    hud.setPack(packLine(pack));
  }
  refreshWalk();
  // the changes made here last time and not yet saved come back on top of what is known
  editor.restore();

  hud.setLoading('planting…');
  vegetation.build(p.x, p.z, { radius: PLANTED.radius, keepOut: keepOut(), density: plantDensity, exclude: packRing() });

  hud.setLoading(null);
  ready = true;
  (window as unknown as { world: unknown }).world = api;

  // the character, last: the world is already walkable with the built-in body, and a slow or
  // missing avatar file must never be the reason nobody can get in
  if (avatarUrl) {
    const rig = await loadAvatar(avatarUrl);
    player.setRig(rig);
    hud.setAvatar(rig.kind);
  }
}

let ready = false;
let last = performance.now();
let shownMode = '';

function loop() {
  requestAnimationFrame(loop);
  const now = performance.now();
  const dt = (now - last) / 1000;
  last = now;
  if (ready) {
    player.update(dt);
    editor.frame();
    const p = player.position;
    terrain.update(p.x, p.z, FINE);
    vegetation.update(p.x, p.z, { radius: PLANTED.radius, keepOut: keepOut(), density: plantDensity, exclude: packRing() });
    sky.mesh.position.copy(camera.position);
    // the light rides with the player so the shadow map stays tight around them; its direction is
    // the sun's. (It used to be derived from its own last position, which the same line had just
    // overwritten — so the light sat on its target and, having no direction, lit nothing at all.)
    sky.sun.target.position.set(p.x, p.y, p.z);
    sky.sun.position.copy(sky.sun.target.position).addScaledVector(sky.dir, 900);
    hud.frame(player.state(), field.loadedTiles);
    const m = `${player.mode}/${editor.active}`;
    if (m !== shownMode) { shownMode = m; hud.setMode(player.mode === 'fly', editor.active); }
  }
  renderer.render(scene, camera);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

/** one line for the HUD: what the pack brought, and how old each part is */
function packLine(p: PackData): string {
  const L = p.manifest.layers;
  const bits: string[] = [];
  if (L.survey) bits.push(`survey ${String(L.survey.date ?? '')}`.trim());
  if (p.trees.length) {
    const gone = p.removed ? `, ${p.removed} since gone` : '';
    bits.push(`${p.trees.length.toLocaleString()} trees (${String(L.trees?.captured ?? 'lidar')}${gone})`);
  }
  if (today.counts.buildings) bits.push(`${today.counts.buildings} standing`);
  if (p.notes.features.length || p.lines.features.length || p.zones.features.length) bits.push(`${p.notes.features.length + p.lines.features.length + p.zones.features.length} marked`);
  if (p.terrain.features.length) bits.push(`ground shaped ×${p.terrain.features.length}`);
  if (p.build.features.length) bits.push(`${build.counts.walls + build.counts.floors + build.counts.roofs} built`);
  if (p.imagery) bits.push(`aerial ${p.imagery.captured ?? ''}`.trim());
  return `${p.manifest.name} · ${bits.join(' · ')}`;
}

// a small surface for tests and for the Playground shell to drive
const api = {
  THREE, player, frame, field, terrain, vegetation, structures, today, build, sky, scene, camera, renderer, stick, editor, grid, inspect, magic,
  get ready() { return ready; },
  get pack() { return pack; },
  get session() { return session; },
  get structuresBase() { return structuresBase; },
  /** become a role without the atlas (tests and the playground shell); a PIN is still needed to save */
  setSession: (s: Session) => { session = s; saveSession(s); hud.setRole(s.role, caps().edit); if (!caps().edit) editor.setActive(false); editor.refresh(); },
  /** apply the editor's unsaved work (or any lists) on top of what is known and redraw */
  rebuild: (edits: Feature[] = editor.edits, changes: StructureChange[] = editor.structures) => { rebuild(edits, changes); return pack; },
  state: () => ({ ...player.state(), tiles: field.loadedTiles, community: slug, atlas }),
  goto: (lng: number, lat: number, heading = 0) => player.placeAt(lng, lat, heading),
  setTime: (h: number) => { clockHours = h; applySun(); },
  /** replant around where the player is standing, honouring the real keep-outs */
  replant: () => {
    const p = player.position;
    vegetation.build(p.x, p.z, { radius: PLANTED.radius, keepOut: keepOut(), density: plantDensity, exclude: packRing() });
    return vegetation.counts;
  },
  setAvatar: async (url: string | null) => {
    const rig = await loadAvatar(url);
    player.setRig(rig);
    hud.setAvatar(rig.kind);
    return rig.kind;
  }
};
(window as unknown as { world: unknown }).world = api;

loop();
void boot();
