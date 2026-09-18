// Make the massing models at build time, so no .glb is ever committed: the model IS the script.
//
//   node scripts/massing/build-models.mjs
//
//   Runs each generator under scripts/massing into public/models, where Vite copies it into the
//   build and Vercel serves it beside the world. Needs python3 with numpy and scipy; if they are
//   missing it tries to install them, and if that fails too it says so and lets the build go on —
//   the world must deploy whether or not the house does.
import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, statSync } from 'node:fs';

const MODELS = [
  { script: 'scripts/massing/oak-leaf.py', out: 'public/models/oak-leaf-massing.glb' }
];

const run = (cmd, args) => spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
const python = ['python3', 'python'].find(p => run(p, ['--version']).status === 0);
if (!python) { console.warn('[models] no python3 on this machine — the massing models are not built'); process.exit(0); }

if (run(python, ['-c', 'import numpy, scipy']).status !== 0) {
  console.log('[models] installing numpy and scipy…');
  const pip = run(python, ['-m', 'pip', 'install', '--quiet', '--user', 'numpy', 'scipy']);
  if (pip.status !== 0) {
    console.warn('[models] could not install numpy/scipy — the massing models are not built\n' + (pip.stderr || '').slice(-600));
    process.exit(0);
  }
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
