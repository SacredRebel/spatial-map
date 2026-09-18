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
  return new Promise(resolve => server.listen(port, () => resolve(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log(`fixture atlas + world on http://localhost:${PORT}`));
}
