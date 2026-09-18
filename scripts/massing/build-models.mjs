// Make the massing models at build time, so no .glb is ever committed: the model IS the script.
//
//   node scripts/massing/build-models.mjs
//
//   Runs each generator under scripts/massing into public/models, where Vite copies it into the
//   build and Vercel serves it beside the world. Needs python3 with numpy and scipy; if they are
//   missing it makes a small virtual environment for them (Vercel's Python is managed by uv and
//   refuses a plain pip install), and if that fails too it says so and lets the build go on —
//   the world must deploy whether or not the house does.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODELS = [
  { script: 'scripts/massing/oak-leaf.py', out: 'public/models/oak-leaf-massing.glb' }
];
const VENV = '.venv-models';

const run = (cmd, args) => spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const has = py => run(py, ['-c', 'import numpy, scipy']).status === 0;

let python = ['python3', 'python'].find(p => run(p, ['--version']).status === 0);
if (!python) { console.warn('[models] no python3 on this machine — the massing models are not built'); process.exit(0); }

if (!has(python)) {
  const venvPy = join(VENV, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!(existsSync(venvPy) && has(venvPy))) {
    console.log('[models] numpy and scipy are missing — making a virtual environment for them…');
    const mk = run(python, ['-m', 'venv', VENV]);
    const pip = mk.status === 0 ? run(venvPy, ['-m', 'pip', 'install', '--quiet', 'numpy', 'scipy']) : mk;
    if (pip.status !== 0 || !has(venvPy)) {
      console.warn('[models] could not get numpy/scipy — the massing models are not built\n' + (pip.stderr || '').slice(-600));
      process.exit(0);
    }
  }
  python = venvPy;
}

mkdirSync('public/models', { recursive: true });
for (const m of MODELS) {
  const r = run(python, [m.script, m.out]);
  if (r.status !== 0 || !existsSync(m.out)) {
    console.warn(`[models] ${m.script} failed — ${m.out} not built\n` + (r.stderr || '').slice(-600));
    continue;
  }
  console.log(`[models] ${m.out} ${(statSync(m.out).size / 1024).toFixed(0)} KB ${r.stdout.trim()}`);
}
