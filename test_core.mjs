// Node tests for core.js and mwm.js:  node tools/se-grid-builder/test_core.mjs [world folder] [workshop content folder]
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const C = await import(pathToFileURL(path.join(here, 'core.js')));
const { readMwm } = await import(pathToFileURL(path.join(here, 'mwm.js')));
const { seedLibrary } = await import(pathToFileURL(path.join(here, 'seed.js')));

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const vol = sh => C.maskCount(C.shapeMask(sh).mask) / C.NS;

// 1. seed library
const lib = seedLibrary();
check(lib.length === 51, `seed library has 51 shapes (${lib.length})`);
const T = C.buildTemplates(lib);
check(T.list.length > 669, `distinct rotated templates (${T.list.length})`);
const cube = lib.find(s => s.key === 'C');
check(vol(cube) === 1, 'cube fills the cell');
check(Math.abs(vol(lib.find(s => s.key === 'H')) - 0.5) < 1e-9, 'half block fills half');
// turning a template four times returns it
let closes = true; for (let ti = 0; ti < T.list.length; ti++) for (const ax of [0, 1, 2]) { let t = ti; for (let k = 0; k < 4; k++) t = C.rotateTemplate(T, t, ax); if (t !== ti) closes = false; }
check(closes, 'four 90-degree turns return every template to itself');

// 2. sketches
const cubeEdges = []; const cs = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
cs.forEach((a, i) => cs.forEach((b, j) => { if (j > i && a.reduce((s, v, k) => s + Math.abs(v - b[k]), 0) === 1) cubeEdges.push([a, b]); }));
let r = C.sketchToShape(cubeEdges);
check(r.ok && r.reason === 'convex' && vol({ solids: r.solids }) === 1, 'cube sketch -> convex solid, full volume');
// L-shaped prism (concave): profile in x-y, extruded along z
const prof = [[0,0],[1,0],[1,.5],[.5,.5],[.5,1],[0,1]], L = [];
prof.forEach((p, i) => { const q = prof[(i + 1) % prof.length]; L.push([[p[0], p[1], 0], [q[0], q[1], 0]], [[p[0], p[1], 1], [q[0], q[1], 1]], [[p[0], p[1], 0], [p[0], p[1], 1]]); });
r = C.sketchToShape(L);
check(r.ok && r.reason === 'non-convex', `L-prism sketch -> non-convex solid (${r.reason})`);
check(Math.abs(vol({ solids: r.solids }) - 0.75) < 0.03, `L-prism volume about 3/4 (${vol({ solids: r.solids }).toFixed(3)})`);
r = C.sketchToShape(cubeEdges.slice(0, 9));
check(!r.ok && r.solids && vol({ solids: r.solids }) === 1, 'open sketch -> hull fallback with a warning');

// 3. model fit on a real model, if given: SGB_TEST_OBJ=<path to .obj> (the project tuned on a Panhard 178 OBJ, 4.79 m)
const obj = process.env.SGB_TEST_OBJ || '';
if (fs.existsSync(obj)) {
  const raw = C.parseObj(fs.readFileSync(obj, 'utf8'));
  const { parts, size } = C.prepareModel(raw, { up: 'y', front: '+x', length: +(process.env.SGB_TEST_LENGTH || 4.79) });
  const rules = 'turret=turret,gun,mgun,cover_0,cover_cover;wheels=wheel;antennas=antenn';
  parts.forEach(p => p.group = C.groupOf(p.name, rules));
  const groupNames = [...new Set(parts.map(p => p.group))];
  const t0 = Date.now();
  const g = C.computeGrid(parts, { scale: 1.5, block: 0.5, offX: 0, offY: 0, centre: 'col', fill: 'solid', minFill: 0.3,
    groupsOn: new Set(groupNames.filter(g => g !== 'antennas')), groupNames, groupPriority: ['turret', 'body', 'wheels', 'antennas'], shapes: lib, T });
  let blocks = 0, none = 0; const byShape = {};
  for (let i = 0; i < g.fit.length; i++) { if (g.fit[i] >= 0) { blocks++; const k = lib[T.list[g.fit[i]].shape].key; byShape[k] = (byShape[k] || 0) + 1; } else if (g.fit[i] === -2) none++; }
  console.log(`     model ${size.map(v => v.toFixed(2)).join(' x ')} m, grid ${g.nx}x${g.nz}x${g.ny}, ${blocks} blocks, ${none} cells without a block, ${Date.now() - t0} ms`);
  console.log('     ' + Object.entries(byShape).sort((a, b) => b[1] - a[1]).map(([k, n]) => k + ':' + n).join(' '));
  check(blocks > 0, 'model fit places blocks');
  // the project owner's hand picks on the Panhard 178 model (only when that model is the one given), at the owner's settings: length 4.8 m, 150%, grid moved forward 0.1, wheels off (built
  // with suspension blocks). [column, layer, row] (1-based, as on the layer map) -> the block the owner would use.
  const OWNER = [[[7, 1, 4], 'H'], [[8, 1, 4], 'H'], [[9, 1, 4], 'H'], [[10, 1, 4], 'H'],   // flat underside 2/3 up the cell
    [[15, 1, 3], 'T'], [[15, 1, 5], 'T'], [[2, 2, 3], 'B'], [[2, 2, 5], 'B']];             // plain slopes over corner pieces
  if (/panhard/i.test(obj)) {
    const op = C.prepareModel(raw, { up: 'y', front: '+x', length: 4.8 }).parts;
    op.forEach(p => p.group = C.groupOf(p.name, rules));
    const og = C.computeGrid(op, { scale: 1.5, block: 0.5, offX: 0.1, offY: 0, centre: 'col', fill: 'solid', minFill: 0.3,
      groupsOn: new Set(groupNames.filter(g => g !== 'antennas' && g !== 'wheels')), groupNames, groupPriority: ['turret', 'body', 'wheels', 'antennas'], shapes: lib, T });
    const got = OWNER.map(([[c, l, r], want]) => { const f = og.fit[og.idx(c - 1, l - 1, r - 1)], k = f >= 0 ? lib[T.list[f].shape].key : String(f);
      return { ok: k === want, s: `L${l} R${r} C${c} ${k}${k === want ? '' : ' (want ' + want + ')'}` }; });
    check(got.every(g => g.ok), `owner's picks: ${got.map(g => g.s).join(', ')}`);
  }
}

// armour skin (owner, R35 hull): a box 4 x 1.9 x 3 cells, one free cell in front and one under it. The floor's panels go
// under the hull, the front's in front of it, the top's on the top face inside (the top is 0.9 up its cell), the inside
// stays empty
{
  const box = (x0, y0, z0, x1, y1, z1) => { const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    return [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]].flatMap(f => f.flatMap(i => v[i])); };
  const parts = [{ name: 'hull', group: 'body', tris: Float32Array.from(box(0, 0, -0.75, 2, 0.95, 0.75)) }];
  const g = C.computeGrid(parts, { scale: 1, block: 0.5, offX: -1, offY: -1, centre: 'col', fill: 'skin', penaltyScale: 3,
    groupsOn: new Set(['body']), groupNames: ['body'], groupPriority: ['body'], shapes: lib, T });
  const panelOn = (x, y, z, w) => { const f = g.fit[g.idx(x, y, z)], t = f >= 0 ? T.list[f] : null; return !!t && t.plate && t.walls.every((v, k) => v === (k === w)); };
  check(g.nx === 5 && g.ny === 3 && g.nz === 3, `armour skin: grid ${g.nx} x ${g.ny} x ${g.nz} (want 5 x 3 x 3)`);
  check([2, 3].every(x => panelOn(x, 0, 1, 3)), 'armour skin: floor panels under the hull');
  check([2, 3].every(x => g.fit[g.idx(x, 1, 1)] < 0), 'armour skin: inside left empty');
  check([2, 3].every(x => panelOn(x, 2, 1, 3)), 'armour skin: top panels on the top face of the top cells');
  check(panelOn(0, 1, 1, 1), 'armour skin: front panel in the cell in front');
}

// blueprint benchmark (README, "Benchmark"): a fit exported as a blueprint and read back is its own reference, also
// when the blueprint's grid is turned and moved (a hand-built grid's own origin and facing)
{
  const BP = await import(pathToFileURL(path.join(here, 'blueprint.js')));
  const BM = await import(pathToFileURL(path.join(here, 'benchmark.js')));
  const box = (x0, y0, z0, x1, y1, z1) => { const v = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
    return [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 7, 6], [3, 6, 2], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]].flatMap(f => f.flatMap(i => v[i])); };
  // a box with a ramp on its front top (x is the front): not the same turned any way, so the line-up has one answer
  const ramp = (x0, x1, y0, y1, z0, z1) => { const v = [[x0, y0, z0], [x1, y0, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x0, y1, z1]];
    return [[0, 2, 1], [3, 4, 5], [0, 1, 4], [0, 4, 3], [0, 3, 5], [0, 5, 2], [1, 2, 5], [1, 5, 4]].flatMap(f => f.flatMap(i => v[i])); };
  const parts = [{ name: 'hull', group: 'body', tris: Float32Array.from([...box(0, 0, -1, 2.5, 1, 1), ...ramp(2.5, 3.5, 0, 1, -1, 1), ...box(0, 1, -1, 1, 1.5, 1)]) }];
  const g = C.computeGrid(parts, { scale: 1, block: 0.5, offX: 0, offY: 0, centre: 'col', fill: 'solid', penaltyScale: 4,
    groupsOn: new Set(['body']), groupNames: ['body'], groupPriority: ['body'], shapes: lib, T });
  const BPmod = BP;
  const exported = ci => g.fit[ci] >= 0 && BPmod.pickBlock(lib[T.list[g.fit[ci]].shape], 'Small') ? g.fit[ci] : -1;
  const cellAt = (x, y, z) => { const f = exported(g.idx(x, y, z)); return f >= 0 ? { shape: lib[T.list[f].shape], rot: T.list[f].rot } : null; };
  const out = BP.gridBlocks({ nx: g.nx, ny: g.ny, nz: g.nz, centre: 'col' }, cellAt, { size: 'Small', armour: 'light' });
  const xml = BP.blueprintXml({ name: 'Bench', gridSize: 'Small', blocks: out.blocks, mirror: out.mirror });
  const shapes = new Set(out.blocks.map(b => b.card));
  const run = (gx, label) => {
    const bp = BM.parseBlueprint(gx), grid = BM.mainGrid(bp);
    const blocks = BM.referenceBlocks(grid, lib), al = BM.alignReference(blocks, g, { lib });
    const r = BM.compareReference(blocks, al, g, T, lib, { fitAt: exported });
    check(grid.blocks.length === out.blocks.length && r.n === out.blocks.length && r.exact === r.n && r.overlap === 1,
      `benchmark round trip${label}: ${r.n} blocks (${shapes.size} cards), ${BM.summaryLine(r)}; line-up ${al.score} (next turn ${al.next})`);
    return al;
  };
  const al = run(xml, '');
  check(al.rot === C.ROTS.findIndex(R => R.every((row, i) => row.every((v, j) => v === (i === j ? 1 : 0)))), 'benchmark: the exported grid lines up unturned');
  // the same grid turned (grid Forward to Left, Up stays) and moved: Min and BlockOrientation turn with it
  const app = (M, v) => [0, 1, 2].map(i => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2]);
  const turnedXml = Q => BP.blueprintXml({ name: 'Bench', gridSize: 'Small', blocks: out.blocks.map(b => {
    const M = BP.orientMatrix(b.forward, b.up), QM = [0, 1, 2].map(i => [0, 1, 2].map(j => Q[i][0] * M[0][j] + Q[i][1] * M[1][j] + Q[i][2] * M[2][j]));
    const [forward, up] = BP.orientOf(QM), m = app(Q, b.min);
    return { ...b, min: [m[0] + 7, m[1] - 3, m[2] + 11], forward, up }; }) });
  run(turnedXml(BP.orientMatrix('Left', 'Up')), ', grid turned and moved');
  run(turnedXml(BP.orientMatrix('Forward', 'Down')), ', grid built upside down');   // the grid's own Up is the model's down
}

// 4. STL round trip (binary)
{
  const tri = [0,0,0, 1,0,0, 0,1,0], buf = new ArrayBuffer(84 + 50); const dv = new DataView(buf); dv.setUint32(80, 1, true);
  tri.forEach((v, k) => dv.setFloat32(84 + 12 + k * 4, v, true));
  const p = C.parseStl(buf); check(p.length === 1 && p[0].tris.length === 9 && p[0].tris[3] === 1, 'binary STL parses');
  const a = C.parseStl(new TextEncoder().encode('solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n'));
  check(a.length === 1 && a[0].tris.length === 9, 'text STL parses');
}

// 5. import from a world (if present), through the same importer the page uses
const { importWorldBlocks } = await import(pathToFileURL(path.join(here, 'importer.js')));
const nodeFS = root => ({
  async read(p) { try { const b = fs.readFileSync(path.join(root, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch (e) { return null; } },
  async list(p) { try { return fs.readdirSync(path.join(root, p), { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' })); } catch (e) { return []; } },
});
const world = process.argv[2] || process.env.SGB_TEST_WORLD || '';   // a world save folder (holds Sandbox.sbc)
const workshop = process.argv[3] || 'C:/Program Files (x86)/Steam/steamapps/workshop/content/244850';
if (fs.existsSync(path.join(world, 'Sandbox.sbc'))) {
  const lib2 = seedLibrary(), t0 = Date.now(), logs = [];
  const sum = await importWorldBlocks(lib2, { world: nodeFS(world), workshop: nodeFS(workshop),
    content: nodeFS('C:/Program Files (x86)/Steam/steamapps/common/SpaceEngineers/Content'),
    localMods: nodeFS(path.join(process.env.APPDATA || '', 'SpaceEngineers/Mods')), includeVanilla: true, log: m => logs.push(m) });
  console.log('     ' + JSON.stringify(sum) + ` ${Date.now() - t0} ms`);
  logs.filter(l => /not found/.test(l)).forEach(l => console.log('     ' + l.trim()));
  check(sum.newShapes > 0 && lib2.length === 51 + sum.newShapes, `import adds ${sum.newShapes} shapes`);
  const box = lib2.find(s => s.topology === 'Box');
  check(box.blocks.some(b => b.size === 'Large'), `vanilla cube now lists large-grid blocks too (${box.blocks.length} blocks)`);
  const panel = lib2.find(s => s.blocks && s.blocks.some(b => b.subtype === 'SmallArmorPanelLight'));
  check(panel && panel.id === 'panel:ArmorPanel' && ['SmallArmorPanelLight', 'SmallArmorPanelHeavy', 'LargeArmorPanelLight', 'LargeArmorPanelHeavy'].every(n => panel.blocks.some(b => b.subtype === n)),
    `vanilla armour panels join the panel card (${panel && panel.key}, ${panel && panel.blocks.length} blocks incl. mod panels of the same shape)`);
  const sloped = lib2.find(s => s.blocks && s.blocks.some(b => b.subtype === 'SmallArmorSlopedPanelHeavy'));
  check(sloped && sloped.id === 'panel:ArmorSlopedPanel', `sloped panels join their card, not a duplicate (${sloped && sloped.id})`);
  const T2 = C.buildTemplates(lib2);
  console.log(`     ${T2.list.length} templates with the imported library`);
}

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
