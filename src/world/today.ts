// What stands here.
//
//   The atlas draws what is proposed; the pack knows what is there. This puts the pack's record on
//   the ground: the house and the sheds at the heights the lidar measured, the surveyed line and
//   the pipes the surveyor found, the easement, the road, and a marker wherever something is
//   planned. Every one of them is a place you can walk to.
//
//   Two rules the pack carries and this respects. The surveyed line is drawn from the survey and
//   nothing else — the county's ring is shown faintly beside it precisely so the drift is visible.
//   And a county "footprint" the lidar says is a slab of concrete is drawn as a slab of concrete;
//   nothing is raised on the strength of a database class.

import * as THREE from 'three';
import type { Frame } from './geo';
import type { HeightField } from './heightfield';
import type { Solid } from './collide';
import type { Feature, PackData } from './pack';

/** close-up tiles the pack may supply for what stands: the road's surface, so far */
export interface TodayTiles { asphalt?: THREE.Texture | null; asphaltMetres?: number }

export interface TodayCounts {
  buildings: number; pads: number; monuments: number; roads: number; zones: number; lines: number;
  notes: number; magic: number; drawn: number; territories: number;
}

const ROOF = new THREE.Color('#8b7d6e');
const METAL = new THREE.Color('#9aa0a3');
const CONCRETE = new THREE.Color('#b9b5ae');
const ASPHALT = new THREE.Color('#4b4a47');
const VIOLET = new THREE.Color('#a86bff');
const TEAL = '#4fd1c5';
const FENCE = new THREE.Color('#8a7355');
const PATH = new THREE.Color('#c9b48e');
/** a territory's colour by what it is for */
const ZONE_COLOURS: Record<string, string> = {
  zone: '#7fe0c8', garden: '#8ed47a', orchard: '#a3c95a', pasture: '#c9d47a', site: '#c9a2ff', camp: '#f0b070', water: '#6fb7e8', keep: '#f08a8a', forest: '#5aa86a'
};
const DIRT_ROAD = new THREE.Color('#b8a27c');

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

export class Today {
  group = new THREE.Group();
  solids: Solid[] = [];
  counts: TodayCounts = { buildings: 0, pads: 0, monuments: 0, roads: 0, zones: 0, lines: 0, notes: 0, magic: 0, drawn: 0, territories: 0 };
  private disposables: (THREE.BufferGeometry | THREE.Material | THREE.Texture)[] = [];

  constructor(private frame: Frame, private field: HeightField) {
    this.group.name = 'today';
  }

  build(pack: PackData, tiles: TodayTiles = {}, cleared: Set<string> = new Set()) {
    this.dispose();
    this.buildings(pack, cleared);
    this.survey(pack);
    this.roads(pack, tiles);
    this.zones(pack);
    this.notes(pack);
    this.drawn(pack);
    this.territories(pack);
  }

  // ---- buildings --------------------------------------------------------------------------------
  private buildings(pack: PackData, cleared: Set<string>) {
    // county footprints, raised to what the lidar measured over them — or laid flat when it measured nothing;
    // a kind a proposal clears is left out, so what replaces it is not drawn through it
    for (const f of pack.county.features) {
      if (f.properties.layer !== 'footprint' || f.geometry.type !== 'Polygon') continue;
      const lidar = f.properties.lidar_2018 as { kind?: string; roof_m?: number | null; roof_p50_m?: number } | undefined;
      const kind = (lidar?.kind || 'building') as string;
      if (cleared.has(slug(kind))) continue;
      const h = lidar?.roof_p50_m ?? lidar?.roof_m ?? null;
      if (h == null || h < 1) this.pad(f.geometry.coordinates[0], kind);
      else this.prism(f.geometry.coordinates[0], h, kind, ROOF);
    }
    // roofs the lidar found that no county footprint claims
    for (const f of pack.roofs.features) {
      if (f.geometry.type !== 'Polygon') continue;
      if (f.properties.county_footprint != null) continue;
      const h = Number(f.properties.roof_m);
      if (!isFinite(h) || h < 1) continue;
      if (cleared.has(slug(String(f.properties.kind || 'building')))) continue;
      this.prism(f.geometry.coordinates[0], h, String(f.properties.kind || 'building'), METAL);
    }
  }

  private ring(coords: [number, number][]): { pts: THREE.Vector3[]; base: number } {
    let base = Infinity;
    const pts = coords.map(([lng, lat]) => {
      const w = this.frame.toWorld(lng, lat);
      const h = this.field.atOr(lng, lat, 0);
      if (h < base) base = h;
      return new THREE.Vector3(w.x, h, w.z);
    });
    if (pts.length > 1 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-6) pts.pop();
    return { pts, base: isFinite(base) ? base : 0 };
  }

  private prism(coords: [number, number][], h: number, kind: string, colour: THREE.Color) {
    const { pts, base } = this.ring(coords);
    if (pts.length < 3) return;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false });
    geo.rotateX(Math.PI / 2);                 // extrude grows in +z; stand it up
    const mat = new THREE.MeshLambertMaterial({ color: colour });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = base + h;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.name = `today:${slug(kind)}`;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
    this.solids.push({ id: slug(kind), ring: pts.map(p => ({ x: p.x, z: p.z })), base, top: base + h });
    this.counts.buildings++;
  }

  private pad(coords: [number, number][], kind: string) {
    const { pts, base } = this.ring(coords);
    if (pts.length < 3) return;
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.z)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshLambertMaterial({ color: CONCRETE, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = base + 0.08;
    mesh.receiveShadow = true;
    mesh.name = `pad:${slug(kind)}`;
    this.group.add(mesh);
    this.disposables.push(geo, mat);
    this.counts.pads++;
  }

  // ---- the surveyed line ---------------------------------------------------------------------------
  /** a line that follows the ground, sampled every couple of metres so it never sinks into a rise */
  private groundLine(coords: [number, number][], lift: number, step = 2): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < coords.length - 1; i++) {
      const a = this.frame.toWorld(coords[i][0], coords[i][1]);
      const b = this.frame.toWorld(coords[i + 1][0], coords[i + 1][1]);
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const ll = this.frame.toLngLat(x, z);
        out.push(new THREE.Vector3(x, this.field.atOr(ll.lng, ll.lat, 0) + lift, z));
      }
    }
    const last = this.frame.toWorld(coords[coords.length - 1][0], coords[coords.length - 1][1]);
    const ll = this.frame.toLngLat(last.x, last.z);
    out.push(new THREE.Vector3(last.x, this.field.atOr(ll.lng, ll.lat, 0) + lift, last.z));
    return out;
  }

  private line(coords: [number, number][], colour: string, name: string, lift = 0.15, opacity = 1) {
    const pts = this.groundLine(coords, lift);
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({ color: colour, transparent: opacity < 1, opacity });
    const line = new THREE.Line(geo, mat);
    line.name = name;
    this.group.add(line);
    this.disposables.push(geo, mat);
    this.counts.lines++;
    return line;
  }

  private survey(pack: PackData) {
    for (const f of pack.survey.features) {
      const L = f.properties.layer;
      if (L === 'boundary' && f.geometry.type === 'Polygon') this.line(f.geometry.coordinates[0], '#ffffff', 'survey:boundary', 0.15);
      else if (L === 'easement' && f.geometry.type === 'Polygon') this.line(f.geometry.coordinates[0], '#ffbe00', 'survey:easement', 0.12, 0.9);
      else if (L === 'monument' && f.geometry.type === 'Point') this.monument(f);
    }
    for (const f of pack.county.features) {
      if (f.properties.layer === 'parcel' && f.geometry.type === 'Polygon') {
        this.line(f.geometry.coordinates[0], '#ff33ff', 'county:parcel', 0.1, 0.45);
      }
    }
  }

  private monument(f: Feature) {
    if (f.geometry.type !== 'Point') return;
    const [lng, lat] = f.geometry.coordinates;
    const w = this.frame.toWorld(lng, lat);
    const geo = new THREE.CylinderGeometry(0.06, 0.06, 0.9, 8);
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const post = new THREE.Mesh(geo, mat);
    post.position.set(w.x, this.field.atOr(lng, lat, 0) + 0.45, w.z);
    post.castShadow = true;
    post.name = `monument:${this.counts.monuments}`;
    this.group.add(post);
    this.disposables.push(geo, mat);
    this.counts.monuments++;
  }

  // ---- roads ----------------------------------------------------------------------------------------
  /** a strip of a fixed width laid along the centreline, hugging the ground */
  private roads(pack: PackData, tiles: TodayTiles) {
    for (const f of pack.county.features) {
      if (f.properties.layer !== 'road' || f.geometry.type !== 'LineString') continue;
      const mesh = this.strip(f.geometry.coordinates, 4.4, tiles.asphalt ? '#ffffff' : ASPHALT, tiles.asphalt || null, tiles.asphaltMetres || 3);
      if (!mesh) continue;
      mesh.name = `road:${slug(String(f.properties.name || 'road'))}`;
      this.counts.roads++;
    }
  }

  /** a strip of a fixed width laid along a line, hugging the ground: a road, a path, a track */
  private strip(coords: [number, number][], width: number, colour: THREE.ColorRepresentation, map: THREE.Texture | null, metres: number): THREE.Mesh | null {
    {
      const centre = this.groundLine(coords, 0, 3);
      if (centre.length < 2) return null;
      const half = width / 2;
      const pos: number[] = [];
      const uv: number[] = [];
      let along = 0;
      for (let i = 0; i < centre.length; i++) {
        const p = centre[i];
        const q = centre[Math.min(centre.length - 1, i + 1)], o = centre[Math.max(0, i - 1)];
        let dx = q.x - o.x, dz = q.z - o.z;
        const len = Math.hypot(dx, dz) || 1;
        dx /= len; dz /= len;
        const nx = -dz, nz = dx;                                  // the perpendicular, in the ground plane
        if (i > 0) along += Math.hypot(p.x - centre[i - 1].x, p.z - centre[i - 1].z);
        for (const s of [-half, half]) {
          const x = p.x + nx * s, z = p.z + nz * s;
          const ll = this.frame.toLngLat(x, z);
          pos.push(x, this.field.atOr(ll.lng, ll.lat, p.y) + 0.06, z);
          uv.push(s < 0 ? 0 : (2 * half) / metres, along / metres);   // the tile runs along the road, at its own scale
        }
      }
      const idx: number[] = [];
      for (let i = 0; i < centre.length - 1; i++) {
        const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
        idx.push(a, c, b, b, c, d);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mat = new THREE.MeshLambertMaterial({
        color: colour, map,
        side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      this.group.add(mesh);
      this.disposables.push(geo, mat);
      return mesh;
    }
  }

  // ---- what the owner pinned and drew ---------------------------------------------------------------
  /** a marker with a label: a gate, a well, a fence corner, "photo taken here" */
  private notes(pack: PackData) {
    for (const f of pack.notes.features) {
      if (f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates;
      const w = this.frame.toWorld(lng, lat);
      const marker = new THREE.Group();
      marker.name = `note:${String(f.properties.id || this.counts.notes)}`;
      marker.position.set(w.x, this.field.atOr(lng, lat, 0), w.z);
      const magic = f.properties.kind === 'magic';
      if (magic) {
        // the magic box: a cube of the vision's violet, hovering, with a thin post under it
        const boxGeo = new THREE.BoxGeometry(0.7, 0.7, 0.7);
        const boxMat = new THREE.MeshLambertMaterial({ color: VIOLET, emissive: VIOLET, emissiveIntensity: 0.35, transparent: true, opacity: 0.85 });
        const box = new THREE.Mesh(boxGeo, boxMat);
        box.position.y = 1.5;
        box.rotation.set(Math.PI / 5, Math.PI / 4, 0);
        box.castShadow = true;
        marker.add(box);
        const edgeGeo = new THREE.EdgesGeometry(boxGeo);
        const edgeMat = new THREE.LineBasicMaterial({ color: '#f2efe6', transparent: true, opacity: 0.8 });
        const edges = new THREE.LineSegments(edgeGeo, edgeMat);
        edges.position.copy(box.position); edges.rotation.copy(box.rotation);
        marker.add(edges);
        const stemGeo = new THREE.CylinderGeometry(0.02, 0.02, 1.1, 6);
        const stemMat = new THREE.MeshLambertMaterial({ color: VIOLET });
        const stem = new THREE.Mesh(stemGeo, stemMat);
        stem.position.y = 0.55;
        marker.add(stem);
        this.disposables.push(boxGeo, boxMat, edgeGeo, edgeMat, stemGeo, stemMat);
        this.counts.magic++;
      } else {
        const postGeo = new THREE.CylinderGeometry(0.04, 0.04, 1.6, 8);
        const postMat = new THREE.MeshLambertMaterial({ color: TEAL });
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.y = 0.8;
        post.castShadow = true;
        marker.add(post);
        this.disposables.push(postGeo, postMat);
      }
      const tex = this.label(String(f.properties.name || (magic ? 'magic box' : 'note')), false, magic ? '#c9a2ff' : TEAL);
      const sprMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const spr = new THREE.Sprite(sprMat);
      spr.scale.set(4.5, 1.125, 1);
      spr.position.y = magic ? 2.6 : 2.2;
      marker.add(spr);
      this.group.add(marker);
      this.disposables.push(tex, sprMat);
      this.counts.notes++;
    }
  }

  /** fences as posts and a rail, paths and dirt roads as strips on the ground */
  private drawn(pack: PackData) {
    for (const f of pack.lines.features) {
      if (f.geometry.type !== 'LineString' || f.geometry.coordinates.length < 2) continue;
      const kind = String(f.properties.kind || 'fence');
      const id = String(f.properties.id || this.counts.drawn);
      if (kind === 'fence') {
        const g = new THREE.Group();
        g.name = `line:${id}`;
        const rail = this.groundLine(f.geometry.coordinates, 1.1, 2);
        const geo = new THREE.BufferGeometry().setFromPoints(rail);
        const mat = new THREE.LineBasicMaterial({ color: FENCE });
        g.add(new THREE.Line(geo, mat));
        const posts = this.groundLine(f.geometry.coordinates, 0, 3);
        const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6);
        const postMat = new THREE.MeshLambertMaterial({ color: FENCE });
        const inst = new THREE.InstancedMesh(postGeo, postMat, posts.length);
        const m = new THREE.Matrix4();
        posts.forEach((p, i) => inst.setMatrixAt(i, m.makeTranslation(p.x, p.y + 0.65, p.z)));
        inst.castShadow = true;
        g.add(inst);
        this.group.add(g);
        this.disposables.push(geo, mat, postGeo, postMat);
      } else {
        const mesh = this.strip(f.geometry.coordinates, kind === 'road' ? 3.5 : 1.2, kind === 'road' ? DIRT_ROAD : PATH, null, 2);
        if (!mesh) continue;
        mesh.name = `line:${id}`;
      }
      this.counts.drawn++;
    }
  }

  /**
   * Territories drawn on the ground: a translucent fill that follows the hillside — a lattice of
   * metre cells clipped to the polygon, every corner on the ground — an outline, and a label.
   */
  private territories(pack: PackData) {
    for (const f of pack.zones.features) {
      if (f.geometry.type !== 'Polygon' || !f.geometry.coordinates[0] || f.geometry.coordinates[0].length < 3) continue;
      const id = String(f.properties.id || this.counts.territories);
      const ring = f.geometry.coordinates[0].map(([lng, lat]) => this.frame.toWorld(lng, lat));
      const xs = ring.map(p => p.x), zs = ring.map(p => p.z);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
      const span = Math.max(x1 - x0, z1 - z0);
      const cell = span > 120 ? 4 : span > 60 ? 2 : 1;                       // at most a few thousand cells
      const inside = (x: number, z: number) => {
        let hit = false;
        for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a.z > z) !== (b.z > z) && x < ((b.x - a.x) * (z - a.z)) / (b.z - a.z) + a.x) hit = !hit;
        }
        return hit;
      };
      const h = (x: number, z: number) => { const ll = this.frame.toLngLat(x, z); return this.field.atOr(ll.lng, ll.lat, 0) + 0.08; };
      const pos: number[] = [];
      for (let x = Math.floor(x0 / cell) * cell; x < x1; x += cell) {
        for (let z = Math.floor(z0 / cell) * cell; z < z1; z += cell) {
          if (!inside(x + cell / 2, z + cell / 2)) continue;
          const a = [x, h(x, z), z], b = [x + cell, h(x + cell, z), z], c = [x + cell, h(x + cell, z + cell), z + cell], d = [x, h(x, z + cell), z + cell];
          pos.push(...a, ...c, ...b, ...a, ...d, ...c);                       // two triangles, facing up
        }
      }
      const g = new THREE.Group();
      g.name = `zone:${id}`;
      const colour = new THREE.Color(String(f.properties.colour || ZONE_COLOURS[String(f.properties.kind || 'zone')] || '#7fe0c8'));
      if (pos.length) {
        const geo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.computeVertexNormals();
        const mat = new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 1;
        g.add(mesh);
        this.disposables.push(geo, mat);
      }
      const closed = f.geometry.coordinates[0].slice();
      if (closed[0][0] !== closed[closed.length - 1][0] || closed[0][1] !== closed[closed.length - 1][1]) closed.push(closed[0]);
      const outline = this.groundLine(closed, 0.2, 2);
      const lgeo = new THREE.BufferGeometry().setFromPoints(outline);
      const lmat = new THREE.LineBasicMaterial({ color: colour });
      g.add(new THREE.Line(lgeo, lmat));
      this.disposables.push(lgeo, lmat);
      // the label at the centre of the ring
      const cx = xs.reduce((a, v) => a + v, 0) / xs.length, cz = zs.reduce((a, v) => a + v, 0) / zs.length;
      const tex = this.label(String(f.properties.name || f.properties.kind || 'zone'), false, '#' + colour.getHexString());
      const sprMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const spr = new THREE.Sprite(sprMat);
      spr.scale.set(6, 1.5, 1);
      spr.position.set(cx, h(cx, cz) + 1.6, cz);
      g.add(spr);
      this.disposables.push(tex, sprMat);
      this.group.add(g);
      this.counts.territories++;
    }
  }

  // ---- what is planned ------------------------------------------------------------------------------
  /** a post and a label at each placed zone — the placeholder a model will one day replace */
  private zones(pack: PackData) {
    for (const f of pack.visionNow.features) {
      if (f.geometry.type !== 'Point') continue;
      const [lng, lat] = f.geometry.coordinates;
      const w = this.frame.toWorld(lng, lat);
      const y = this.field.atOr(lng, lat, 0);
      const standing = f.properties.mode === 'both';
      const marker = new THREE.Group();
      marker.name = `vision:${String(f.properties.id || this.counts.zones)}`;
      marker.position.set(w.x, y, w.z);

      const postGeo = new THREE.CylinderGeometry(0.05, 0.05, 2.4, 8);
      const postMat = new THREE.MeshLambertMaterial({ color: standing ? '#e0b64a' : VIOLET });
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.y = 1.2;
      post.castShadow = true;
      marker.add(post);

      const tex = this.label(String(f.properties.name || f.properties.id || ''), standing);
      const sprMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
      const spr = new THREE.Sprite(sprMat);
      spr.scale.set(7, 1.75, 1);
      spr.position.y = 3.2;
      marker.add(spr);

      this.group.add(marker);
      this.disposables.push(postGeo, postMat, tex, sprMat);
      this.counts.zones++;
    }
  }

  private label(text: string, standing: boolean, edge?: string): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512; c.height = 128;
    const g = c.getContext('2d')!;
    g.fillStyle = 'rgba(12,16,14,0.82)';
    const r = 26;
    g.beginPath();
    g.moveTo(r, 0); g.lineTo(512 - r, 0); g.quadraticCurveTo(512, 0, 512, r);
    g.lineTo(512, 128 - r); g.quadraticCurveTo(512, 128, 512 - r, 128);
    g.lineTo(r, 128); g.quadraticCurveTo(0, 128, 0, 128 - r);
    g.lineTo(0, r); g.quadraticCurveTo(0, 0, r, 0); g.closePath(); g.fill();
    g.strokeStyle = edge || (standing ? '#e0b64a' : '#a86bff');
    g.lineWidth = 4; g.stroke();
    g.fillStyle = '#f2efe6';
    g.font = `${standing ? '700' : '600'} 40px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    let t = text;
    while (t.length > 3 && g.measureText(t).width > 480) t = t.slice(0, -2);
    if (t !== text) t = t.replace(/\s+\S*$/, '') + '…';
    g.fillText(t, 256, 66);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  dispose() {
    for (const o of this.group.children.slice()) this.group.remove(o);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.solids = [];
    this.counts = { buildings: 0, pads: 0, monuments: 0, roads: 0, zones: 0, lines: 0, notes: 0, magic: 0, drawn: 0, territories: 0 };
  }
}
