// A stand-in atlas, and the built world, on one port.
//
//   The suite must not depend on the live atlas: a test that fails because a deploy is mid-flight
//   tells you nothing. So the fixture terrain is generated and served under /terrain, a small
//   registry of designed structures under /api/structures, and the built world itself from dist —
//   with the same cross-origin headers the real atlas sends, so the browser is doing exactly what
//   it will do in production.
import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { join, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { index, tilePng, Z, packFiles, aerialPng, tilePngFlat } from './fixture.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = Number(process.env.PORT || 5181);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary'
};

/** the same shape the atlas serves, so the client cannot tell the difference */
export const STRUCTURES = {
  note: 'Fixture registry for the test suite.',
  structures: [
    {
      id: 'fixture-site', pid: 'fixture', mode: 'vision', name: 'Reserved ground', status: 'site',
      outline: [
        [-119.15660, 34.43250], [-119.15600, 34.43250],
        [-119.15600, 34.43285], [-119.15660, 34.43285], [-119.15660, 34.43250]
      ]
    },
    {
      id: 'fixture-massing', pid: 'fixture', mode: 'vision', name: 'Massing block', status: 'massing',
      heightFt: 24,
      outline: [
        [-119.15700, 34.43300], [-119.15670, 34.43300],
        [-119.15670, 34.43320], [-119.15700, 34.43320], [-119.15700, 34.43300]
      ]
    }
  ]
};

const send = (res, code, body, type) => {
  res.writeHead(code, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

export const FIXTURE_PIN = '4242';
export const BUILDER_PIN = '2424';

export function start(port = PORT) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    let p = decodeURIComponent(url.pathname);
    try {
      if (p === '/terrain/index.json') return send(res, 200, JSON.stringify(index()), TYPES['.json']);
      const tile = /^\/terrain\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(p);
      if (tile) {
        const [z, x, y] = tile.slice(1).map(Number);
        if (z !== Z) return send(res, 404, 'not baked');
        return send(res, 200, tilePng(z, x, y), TYPES['.png']);
      }
      if (p.startsWith('/api/structures')) {
        return send(res, 200, JSON.stringify(STRUCTURES), TYPES['.json']);
      }
      // the atlas's role check: two PINs the fixture knows
      if (p === '/api/pack/role' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { body = {}; }
        const role = body.pin === FIXTURE_PIN ? 'admin' : body.pin === BUILDER_PIN ? 'builder' : null;
        if (!role) return send(res, 401, JSON.stringify({ ok: false, error: 'bad_pin' }), TYPES['.json']);
        return send(res, 200, JSON.stringify({ ok: true, role }), TYPES['.json']);
      }
      // the atlas's proposals endpoint, as the world sees it: an admin's is applied, a builder's waits
      if (p === '/api/pack/proposals' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'bad_json' }), TYPES['.json']); }
        const role = body.pin === FIXTURE_PIN ? 'admin' : body.pin === BUILDER_PIN ? 'builder' : null;
        if (!role) return send(res, 401, JSON.stringify({ ok: false, error: 'bad_pin' }), TYPES['.json']);
        if (body.pack !== 'fixture-pack') return send(res, 404, JSON.stringify({ ok: false, error: 'unknown_pack' }), TYPES['.json']);
        const E = Array.isArray(body.edits) ? body.edits : [], S = Array.isArray(body.structures) ? body.structures : [];
        if (!E.length && !S.length) return send(res, 400, JSON.stringify({ ok: false, error: 'no_changes' }), TYPES['.json']);
        const id = 'p-' + (server.proposals.length + 1).toString(36) + '-test';
        server.proposals.push({ id, by: role, note: body.note || '', status: role === 'admin' ? 'approved' : 'pending', edits: E, structures: S });
        if (role === 'admin') server.saved.push(...E);
        return send(res, 200, JSON.stringify({ ok: true, id, applied: role === 'admin', status: role === 'admin' ? 'approved' : 'pending', count: E.length + S.length, commit: role === 'admin' ? 'f1x7ur3000000' : undefined }), TYPES['.json']);
      }
      // the atlas's save endpoint, as the world sees it: the PIN is checked, the features are kept
      if (p === '/api/pack/edits' && req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return send(res, 400, JSON.stringify({ ok: false, error: 'bad_json' }), TYPES['.json']); }
        if (body.pin !== FIXTURE_PIN) return send(res, 401, JSON.stringify({ ok: false, error: 'bad_pin' }), TYPES['.json']);
        if (body.pack !== 'fixture-pack') return send(res, 404, JSON.stringify({ ok: false, error: 'unknown_pack' }), TYPES['.json']);
        if (!Array.isArray(body.features) || !body.features.length) return send(res, 400, JSON.stringify({ ok: false, error: 'no_features' }), TYPES['.json']);
        server.saved.push(...body.features);
        return send(res, 200, JSON.stringify({ ok: true, count: body.features.length, commit: 'f1x7ur3000000' }), TYPES['.json']);
      }
      // the fixture data pack, and the aerial it names
      const pk = /^\/pack\/([a-z.]+)$/.exec(p);
      if (pk) {
        const files = packFiles(`http://localhost:${port}`);
        const body = files[pk[1]];
        if (body == null) return send(res, 404, 'no such file in the pack');
        return typeof body === 'string'
          ? send(res, 200, body, 'text/csv; charset=utf-8')
          : send(res, 200, JSON.stringify(body), TYPES['.json']);
      }
      // a real pack from disk, for looking at one: PACK_DIR=../sulphur-mountain-world node tests/serve.mjs
      if (process.env.PACK_DIR && p.startsWith('/realpack/')) {
        const file = join(process.env.PACK_DIR, p.slice('/realpack/'.length));
        const info = await stat(file).catch(() => null);
        if (!info || !info.isFile()) return send(res, 404, 'not in the pack');
        const type = file.endsWith('.csv') ? 'text/csv; charset=utf-8' : TYPES[extname(file)] || 'application/octet-stream';
        return send(res, 200, await readFile(file), type);
      }
      const flat = /^\/tile\/([a-z]+)\.png$/.exec(p);
      if (flat) return send(res, 200, tilePngFlat(flat[1]), TYPES['.png']);
      const air = /^\/aerial\/(\d+)\/(\d+)\/(\d+)$/.exec(p);
      if (air) {
        const [z, y, x] = air.slice(1).map(Number);
        return send(res, 200, aerialPng(z, x, y), TYPES['.png']);
      }
      if (p === '/') p = '/index.html';
      const file = join(root, 'dist', p);
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) return send(res, 404, 'not found');
      return send(res, 200, await readFile(file), TYPES[extname(file)] || 'application/octet-stream');
    } catch {
      return send(res, 404, 'not found');
    }
  });
  /** what the mock atlas has been asked to commit */
  server.saved = [];
  /** every proposal the mock atlas received */
  server.proposals = [];
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log(`fixture atlas + world on http://localhost:${PORT}`));
}
