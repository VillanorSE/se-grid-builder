// Fit benchmark: models built from known library blocks, so the right answer is known.
//   node tools/se-grid-builder/bench_fit.mjs [seed]
// Scene: blocks at random rotations with empty cells between them. Each scene is fitted on the grid and with every block nudged up to 10% of a cell.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const C = await import(pathToFileURL(path.join(here, 'core.js')));
const { seedLibrary } = await import(pathToFileURL(path.join(here, 'seed.js')));

let seed = +(process.argv[2] || 7);
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const lib = seedLibrary(), T = C.buildTemplates(lib);
const tris = lib.map(s => C.shapeTriangles(s));

// a template's triangles placed in cell (x, y, z) of a grid starting at (0, 0, -nz/2)
function placed(ti, x, y, z, nz, j = [0, 0, 0], shrink = 0.998) {
  const t = T.list[ti], R = C.ROTS[t.rot], src = tris[t.shape], out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    const p = C.rotP(R, [src[i] - .5, src[i + 1] - .5, src[i + 2] - .5]).map(v => v * shrink);   // a hair inside the cell walls
    out[i] = p[0] + .5 + x + j[0]; out[i + 1] = p[1] + .5 + y + j[1]; out[i + 2] = p[2] + .5 + z - nz / 2 + j[2];
  }
  return out;
}
const cubeT = T.list.findIndex(t => lib[t.shape].key === 'C');
let dbgShown = 0;

function sparseScene(jitter) {
  const nx = 10, ny = 6, nz = 10, truth = new Map(), parts = [];
  const put = (ti, x, y, z, j, s) => { truth.set(x + ',' + y + ',' + z, ti); parts.push({ group: 'body', name: 'b', tris: placed(ti, x, y, z, nz, j, s) }); };
  for (const x of [0, nx - 1]) for (const y of [0, ny - 1]) for (const z of [0, nz - 1]) put(cubeT, x, y, z, [0, 0, 0], 1);   // full cubes pin the grid
  // each block nudged up to +-jitter cells per axis (a model that is nearly, not exactly, on the grid)
  for (let x = 2; x < nx - 1; x += 2) for (let y = 1; y < ny - 1; y += 2) for (let z = 2; z < nz - 1; z += 2)
    put(Math.floor(rnd() * T.list.length), x, y, z, [0, 1, 2].map(() => (rnd() * 2 - 1) * jitter));
  return { nx, ny, nz, truth, parts };
}

function fit(scene, scoring) {
  const parts = scene.parts.map(p => ({ ...p, tris: p.tris.map(v => v) }));
  const t0 = Date.now();
  const dbg = process.env.DEBUG && scoring === 'surface' ? (x, y, z, cand) => {
    const tt = scene.truth.get(x + ',' + y + ',' + z); if (tt === undefined || T.list[cand[0].ti].sig === T.list[tt].sig || dbgShown++ > 12) return;
    const f = c => `${lib[T.list[c.ti].shape].key} ${c.sc.toFixed(2)} (iou ${c.iou.toFixed(2)} m2b ${(c.m2b ?? 0).toFixed(2)} b2m ${(c.b2m ?? 0).toFixed(2)})`;
    const tc = cand.find(c => T.list[c.ti].sig === T.list[tt].sig);
    console.log(`  ${x},${y},${z} truth ${lib[T.list[tt].shape].key}: ${tc ? f(tc) : 'not a candidate'} | picked ${f(cand[0])}`);
  } : null;
  const g = C.computeGrid(parts, { scale: 1, block: 1, offX: 0, offY: 0, centre: 'line', fill: 'solid', minFill: 0.3, scoring, candidates: K, penaltyScale: process.env.SIMPLIFY ? +process.env.SIMPLIFY : 1, pokeThrough: process.env.POKE === 'skip' ? 'skip' : process.env.POKE === '0' ? false : 'noPlates', minScore: process.env.MINS ? +process.env.MINS : undefined,
    groupsOn: new Set(['body']), groupNames: ['body'], shapes: lib, T, debug: dbg });
  let ok = 0, n = 0, extra = 0; const wrong = {};
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    const k = x + ',' + y + ',' + z, f = g.fit[g.idx(x, y, z)];
    if (scene.truth.has(k)) {
      const tt = scene.truth.get(k); n++;
      if (f >= 0 && T.list[f].sig === T.list[tt].sig) ok++;
      else { const key = lib[T.list[tt].shape].key + '->' + (f >= 0 ? lib[T.list[f].shape].key + (T.list[f].shape === T.list[tt].shape ? '(rot)' : '') : 'none'); wrong[key] = (wrong[key] || 0) + 1; }
    } else if (f >= 0) extra++;
  }
  return { acc: ok / n, n, extra, ms: Date.now() - t0, wrong };
}

if (process.env.TOL) C.setSurfTolerance(+process.env.TOL);
if (process.env.STEP) C.setSurfStep(+process.env.STEP);
if (process.env.NPOW) C.setNormalPow(+process.env.NPOW);
const K = +(process.env.K || 0) || undefined;
for (const jitter of [0, 0.1]) {
  const scenes = [1, 2, 3, 4].map(() => sparseScene(jitter));
  for (const scoring of ['volume', 'surface']) {
    let ok = 0, n = 0, extra = 0, ms = 0; const wrong = {};
    for (const sc of scenes) { const r = fit(sc, scoring); ok += r.acc * r.n; n += r.n; extra += r.extra; ms += r.ms;
      for (const [k, v] of Object.entries(r.wrong)) wrong[k] = (wrong[k] || 0) + v; }
    const top = Object.entries(wrong).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => k + ' ' + v).join(', ');
    console.log(`jitter ${jitter} ${scoring.padEnd(7)}: ${(100 * ok / n).toFixed(1)}% right (${n} blocks), ${extra} blocks in empty cells, ${ms} ms  | ${top}`);
  }
}
