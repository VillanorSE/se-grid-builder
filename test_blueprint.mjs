// Node tests for blueprint.js (blueprint export):  node tools/se-grid-builder/test_blueprint.mjs
// Orientation round-trips, symmetry plane, colours, zip, bp.sbc well-formedness and structure. When the game is
// installed, the cards' base orientations are checked again against the game's own data (mount points, construction
// models, panel models), and the bp.sbc layout against one of the owner's local blueprints (read only).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const C = await import(pathToFileURL(path.join(here, 'core.js')));
const BP = await import(pathToFileURL(path.join(here, 'blueprint.js')));
const { readMwm } = await import(pathToFileURL(path.join(here, 'mwm.js')));
const { seedLibrary } = await import(pathToFileURL(path.join(here, 'seed.js')));

let failed = 0;
const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) failed++; };
const lib = seedLibrary();
const N = BP.BP_DIRS, names = Object.keys(N);
const T = M => [0, 1, 2].map(i => [0, 1, 2].map(j => M[j][i]));
const mul = (A, B) => [0, 1, 2].map(r => [0, 1, 2].map(c => A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c]));
const app = (M, v) => [0, 1, 2].map(r => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
const eqM = (A, B) => A.every((r, i) => r.every((v, j) => v === B[i][j]));

// 1. orientation algebra
const pairs = names.flatMap(f => names.filter(u => N[f].every((x, i) => x * N[u][i] === 0) && !N[f].every((x, i) => Math.abs(x) === Math.abs(N[u][i]))).map(u => [f, u]));
check(pairs.length === 24, `24 Forward/Up pairs (${pairs.length})`);
check(pairs.every(([f, u]) => { const M = BP.orientMatrix(f, u), o = BP.orientOf(M); return o[0] === f && o[1] === u; }), 'Forward/Up -> matrix -> Forward/Up round-trips for all 24');
check(C.ROTS.every(R => { const [f, u] = BP.orientOf(R); return eqM(BP.orientMatrix(f, u), R); }), 'every tool turn (ROTS) is exactly one Forward/Up pair');
check(pairs.every(([f, u]) => { const M = BP.orientMatrix(f, u); return eqM(mul(M, T(M)), [[1, 0, 0], [0, 1, 0], [0, 0, 1]]); }), 'orientation matrices are rotations');
check(BP.orientMatrix('Forward', 'Up').every((r, i) => r.every((v, j) => v === (i === j ? 1 : 0))), 'Forward/Up is the identity');
// Base6Directions: Forward x Up = Right
check(BP.bpDirName(app(BP.orientMatrix('Forward', 'Up'), [1, 0, 0])) === 'Right', 'block +X is Right');
const G = BP.TOOL_TO_GRID;
check(BP.bpDirName(app(G, [1, 0, 0])) === 'Forward' && BP.bpDirName(app(G, [0, 1, 0])) === 'Up' && BP.bpDirName(app(G, [0, 0, 1])) === 'Right',
  'tool front -> grid Forward, up -> Up, +z side -> Right');
// all 24 tool turns of an unturned card give 24 different grid orientations
const seen = new Set(C.ROTS.map((R, r) => { const o = BP.gridOrientation(r, ['Forward', 'Up']); return o.forward + '/' + o.up; }));
check(seen.size === 24, `24 tool turns -> 24 different block orientations (${seen.size})`);

// 2. geometry round-trip: for every card and turn, the game block placed with the exported Forward/Up covers exactly the
//    cell the tool shows. Points p in the grid cell: tool shows card(R^T G^T p); the game shows block(M^T p), and the
//    block is the card held as CARD_ORIENT says: block(q) = card(Q q).
const pts = []; for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) for (let k = 0; k < 4; k++) pts.push([(i + .5) / 4 - .5, (j + .5) / 4 - .5, (k + .5) / 4 - .5]);
const inCard = (s, c) => C.shapeInside(s, c.map(v => v + .5));
let geoOk = true, geoN = 0;
for (const s of lib.filter(s => s.solids[0].type === 'planes')) {
  const pb = BP.pickBlock(s, 'Large', 'light'), Q = BP.orientMatrix(pb.orient[0], pb.orient[1]);
  for (let r = 0; r < 24; r++) {
    const o = BP.gridOrientation(r, pb.orient), M = BP.orientMatrix(o.forward, o.up);
    for (const p of pts) { geoN++;
      const tool = inCard(s, app(T(C.ROTS[r]), app(T(G), p))), game = inCard(s, app(Q, app(T(M), p)));
      if (tool !== game) geoOk = false; }
  }
}
check(geoOk, `game block at the exported Forward/Up = the tool's template, every card x 24 turns (${geoN} points)`);
// importer: a block matched to a card in some turn gets the Forward/Up that turns it back
{
  const s = lib.find(x => x.key === 'SCT'), cm = C.shapeMask(s).mask; let ok = true;
  for (let r = 0; r < 24; r++) {
    const bm = BP.turnMask(cm, r), o = BP.blockOrientOnCard(cm, bm);
    // the block held as o on the card: block = Q^T card, i.e. the card turned by Q^T must equal the block's mask
    const Qt = T(BP.orientMatrix(o[0], o[1])), rq = C.ROTS.findIndex(R => eqM(R, Qt));
    if (BP.turnMask(cm, rq).join() !== bm.join()) ok = false;
  }
  check(ok, 'importer turn (blockOrientOnCard) round-trips for all 24 turns');
}

// 3. grid positions and the symmetry plane: mirrored tool cells land on the game's mirror of each other
for (const [centre, nz] of [['col', 7], ['line', 8]]) {
  const m = BP.mirrorPlane(centre); let ok = true;
  for (let z = 0; z < nz; z++) {
    const a = BP.gridPos(3, 1, z, nz, centre)[0], b = BP.gridPos(3, 1, nz - 1 - z, nz, centre)[0];
    if (2 * m.plane[0] - a - (m.odd ? 1 : 0) !== b) ok = false;      // MyCubeBuilderGizmo.MirrorBlockByPlane, X plane
  }
  check(ok && Number.isInteger(BP.gridPos(0, 0, 0, nz, centre)[0]), `symmetry plane on the centreline (${centre}, ${nz} wide, odd=${m.odd})`);
}
check(BP.gridPos(5, 2, 3, 7, 'col').join() === '0,2,-5', 'tool cell (5,2,3) of 7 wide -> grid (0,2,-5): front towards -Z');

// 4. colours (MyColorPickerConstants: saturation - 0.8, value - 0.45)
const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
check(near(BP.colorMaskHSV('#ffffff'), [0, -0.8, 0.55]) && near(BP.colorMaskHSV('#000000'), [0, -0.8, -0.45]) &&
  near(BP.colorMaskHSV('#ff0000'), [0, 0.2, 0.55]) && near(BP.colorMaskHSV('#00ff00'), [1 / 3, 0.2, 0.55]), 'ColorMaskHSV conversion');

// 5. blocks per grid size and armour
const byKey = k => lib.find(s => s.key === k);
check(BP.pickBlock(byKey('C'), 'Large', 'light').subtype === 'LargeBlockArmorBlock' && BP.pickBlock(byKey('C'), 'Small', 'heavy').subtype === 'SmallHeavyBlockArmorBlock' &&
  BP.pickBlock(byKey('H'), 'Small', 'light').subtype === 'HalfArmorBlock' && BP.pickBlock(byKey('CSI'), 'Large', 'heavy').subtype === 'LargeBlockHeavyArmorCornerSquareInverted',
  'armour subtypes by grid size and light/heavy');
check(BP.pickBlock(byKey('P'), 'Large', 'heavy').subtype === 'LargeArmorPanelHeavy' && BP.pickBlock(byKey('P'), 'Small', 'light').subtype === 'SmallArmorPanelLight', 'panel subtypes');
check(lib.every(s => BP.pickBlock(s, 'Large', 'light') && BP.pickBlock(s, 'Small', 'heavy')), 'every starting card has a block in both grid sizes');
const mod = { id: 'mesh:Some Mod:WingA', name: 'Wing A', blocks: [{ subtype: 'WingA', size: 'Small', mod: 'Some Mod' }, { subtype: 'WingB', size: 'Large', mod: 'Other' }] };
check(BP.pickBlock(mod, 'Small').subtype === 'WingA' && BP.pickBlock(mod, 'Small').sure && !BP.pickBlock(mod, 'Large').sure && BP.pickBlock(mod, 'Small').typeId === 'CubeBlock',
  'mod block: real subtype; turn known for the defining block, unknown for an old merged one');
mod.blocks[1].orient = ['Up', 'Backward'];
check(BP.pickBlock(mod, 'Large').sure && BP.pickBlock(mod, 'Large').orient.join() === 'Up,Backward', 'mod block: recorded turn is used');
// armour grades read from the mods: a graded mod on three cards (one of them vanilla), a one-grade mod with a card in use
const gr = ['4mm', '12mm', '100mm'], gMod = 'Tank Kit', gBlocks = n => gr.map(g => ({ subtype: `TK_Armour_${n}_${g}`, size: 'Small', mod: gMod }));
const gLib = [{ ...byKey('C'), blocks: [...byKey('C').blocks, ...gBlocks('Cube')] },
  { id: 'mesh:Tank Kit:TK_Armour_Wedge_4mm', source: gMod, use: false, blocks: gBlocks('Wedge') },
  { id: 'mesh:Tank Kit:TK_Armour_Tip_4mm', source: gMod, use: false, blocks: gBlocks('Tip') },
  { id: 'mesh:[PP] Plane Pack:PP_Nose_1', source: '[PP] Plane Pack', use: true, blocks: [{ subtype: 'PP_Nose_1', size: 'Small', mod: '[PP] Plane Pack' }] },
  { id: 'mesh:Off Mod:OM_A', source: 'Off Mod', use: false, blocks: [{ subtype: 'OM_A', size: 'Small', mod: 'Off Mod' }] }];
const grades = BP.armourGrades(gLib), tk = grades.find(m => m.mod === gMod), pp = grades.find(m => m.mod === '[PP] Plane Pack');
check(tk && tk.grades.map(g => g.label).join() === '4mm,12mm,100mm' && pp && pp.label === 'PP' && pp.grades.length === 1 && grades.length === 2,
  'armour grades: varying subtype part per card, sorted by number; a one-grade mod named by its tag; mods with no card in use left out');
const g12 = tk.grades[1].value, cube12 = BP.pickBlock(gLib[0], 'Small', g12), cubeL = BP.pickBlock(gLib[0], 'Large', g12);
check(cube12.subtype === 'TK_Armour_Cube_12mm' && !cube12.other && cubeL.subtype === 'LargeBlockArmorBlock' && cubeL.other &&
  BP.pickBlock(gLib[3], 'Small', pp.grades[0].value).subtype === 'PP_Nose_1' && BP.pickBlock(gLib[0], 'Small', 'light').subtype === 'SmallBlockArmorBlock',
  'armour grades: a grade picks its block, also on a vanilla card; a card without one falls back to light');

// 6. bp.sbc well-formed, and its structure
function parseXml(s) {               // small strict checker: balanced tags, quoted attributes, known entities only
  const stack = [], tree = { name: '#doc', kids: [] }, nodes = [tree];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<\/([A-Za-z_][\w.:-]*)\s*>|<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"<]*")*)\s*(\/?)>|([^<]+)|(<)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m[6]) throw new Error('stray < at ' + m.index);
    if (m[5] !== undefined) { if (/&(?!(amp|lt|gt|quot|apos);)/.test(m[5])) throw new Error('bad entity'); if (nodes.at(-1).kids) nodes.at(-1).text = (nodes.at(-1).text || '') + m[5]; continue; }
    if (m[1]) { if (stack.pop() !== m[1]) throw new Error('unbalanced </' + m[1] + '>'); nodes.pop(); continue; }
    if (m[2]) { const n = { name: m[2], attrs: m[3], kids: [] }; nodes.at(-1).kids.push(n); if (!m[4]) { stack.push(m[2]); nodes.push(n); } }
  }
  if (stack.length) throw new Error('unclosed ' + stack.join(','));
  return tree;
}
const find = (n, name) => n.name === name ? n : n.kids.map(k => find(k, name)).find(Boolean);
const { cells } = BP.testLayout(lib, { size: 'Small', armour: 'light' });
const tb = BP.testBlueprint(lib, { size: 'Small', armour: 'heavy', color: true });
const xml = BP.blueprintXml({ name: 'Test & <"name">', gridSize: 'Small', blocks: tb.blocks, mirror: BP.mirrorPlane('line') });
let tree = null; try { tree = parseXml(xml); } catch (e) { console.log('     ' + e.message); }
check(!!tree, 'bp.sbc is well-formed XML (name with & < " escaped)');
check(tb.rows.length === 51 && cells.filter(c => !c.marker).length === 51 * 24, `test layout: 51 cards x 24 turns (${tb.rows.length} rows)`);
if (tree) {
  const grid = find(tree, 'CubeGrid'), blocks = find(grid, 'CubeBlocks').kids;
  check(blocks.length === tb.blocks.length, `all blocks written (${blocks.length})`);
  const mins = new Set(blocks.map(b => b.kids.find(k => k.name === 'Min').attrs));
  check(mins.size === blocks.length, 'no two blocks share a cell');
  check(!!grid.kids.find(k => k.name === 'XMirroxPlane') && grid.kids.find(k => k.name === 'XMirroxOdd').text === 'true', 'XMirroxPlane / XMirroxOdd written');
}

// 7. zip
const crc = BP.crc32(new TextEncoder().encode('123456789'));
check(crc === 0xcbf43926, 'crc32 check value');
{
  const z = BP.makeZip([{ name: 'A b/bp.sbc', data: '<x/>' }, { name: 'A b/thumb.png', data: new Uint8Array([1, 2, 3]) }]);
  const dv = new DataView(z.buffer), end = z.length - 22;
  check(dv.getUint32(0, true) === 0x04034b50 && dv.getUint32(end, true) === 0x06054b50 && dv.getUint16(end + 10, true) === 2, 'zip: local headers and directory');
}
check(BP.blueprintFolderName('Panhard: "AMD" 178?') === 'Panhard_ _AMD_ 178_' && BP.blueprintFolderName(' . ') === 'Grid', 'folder names Windows accepts');

// 8. against the game, when installed: each card's base orientation (CARD_ORIENT) agrees with the game's mount points
//    and construction models; the panels' models match their cards unturned
const content = 'C:/Program Files (x86)/Steam/steamapps/common/SpaceEngineers/Content';
if (fs.existsSync(content + '/Data/CubeBlocks')) {
  const defs = new Map();
  for (const f of fs.readdirSync(content + '/Data/CubeBlocks')) {
    const x = fs.readFileSync(content + '/Data/CubeBlocks/' + f, 'utf8');
    for (const m of x.matchAll(/<Definition\b[^>]*>([\s\S]*?)<\/Definition>/g)) {
      const d = m[1], sub = (d.match(/<SubtypeId>([^<]*)</) || [])[1]; if (!sub) continue;
      defs.set(sub, { mounts: [...d.matchAll(/<MountPoint\s([^>]*)\/>/g)].map(q => Object.fromEntries([...q[1].matchAll(/(\w+)\s*=\s*"([^"]*)"/g)].map(a => [a[1], a[2]]))),
        size: (d.match(/<CubeSize>([^<]*)</) || [])[1], model: (d.match(/<Model>([^<]*)</) || [])[1], files: [...d.matchAll(/File="([^"]*)"/g)].map(q => q[1]) });
    }
  }
  // the card held in the block's frame: block(q) = card(Q q)
  const blockInside = (s, Q) => p => inCard(s, app(Q, p.map(v => v - .5)));
  // mount points -> block-frame face rectangles (Sandbox MyCubeBlockDefinition m_mountPointTransforms / WallOffsets)
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const fromDir = (d, u) => [cross(d, u), u, d.map(x => -x)];
  const TR = [[fromDir(N.Right, N.Up), [1, 1, -1]], [fromDir(N.Up, N.Forward), [-1, 1, 1]], [fromDir(N.Forward, N.Up), [-1, 1, 1]],
    [fromDir(N.Left, N.Up), [1, 1, -1]], [fromDir(N.Down, N.Backward), [-1, 1, 1]], [fromDir(N.Backward, N.Up), [-1, 1, 1]]];
  const OFF = [[1, 0, 1], [0, 1, 1], [1, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 1]], SIDES = ['Right', 'Top', 'Front', 'Left', 'Bottom', 'Back'];
  const tf = (p, w) => [0, 1, 2].map(c => (p[0] * TR[w][0][0][c] + p[1] * TR[w][0][1][c] + p[2] * TR[w][0][2][c]) * TR[w][1][c] + OFF[w][c]);
  const face = []; for (let w = 0; w < 6; w++) for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) { const u = (i + .5) / 16, v = (j + .5) / 16; face.push({ w, u, v, p: tf([u, v, -0.02], w) }); }
  const mountScore = (s, Q, mp) => {
    const inside = blockInside(s, Q); let on = 0, n = 0, agree = 0;
    face.forEach(q => { const mnt = mp.some(m => SIDES[q.w] === m.Side && q.u >= Math.min(+m.StartX, +m.EndX) && q.u <= Math.max(+m.StartX, +m.EndX) && q.v >= Math.min(+m.StartY, +m.EndY) && q.v <= Math.max(+m.StartY, +m.EndY));
      const ins = inside(q.p); if (mnt) { n++; if (ins) on++; } if (ins === mnt) agree++; });
    return (n ? on / n : 1) + agree / face.length;
  };
  const SUB = C.SUB, samplePts = []; for (let y = 0; y < SUB; y++) for (let z = 0; z < SUB; z++) for (let x = 0; x < SUB; x++) samplePts.push([(x + .5) / SUB, (y + .5) / SUB, (z + .5) / SUB]);
  const maskOf = inside => { const m = C.newMask(); samplePts.forEach((p, k) => { if (inside(p)) C.setBit(m, k); }); return m; };
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < C.NS; k++) { const x = C.getBit(a, k), y = C.getBit(b, k); i += x & y; u += x | y; } return u ? i / u : 1; };
  const bad = [];
  for (const s of lib.filter(s => s.topology)) {
    const sub = BP.pickBlock(s, 'Small', 'light').subtype, d = defs.get(sub); if (!d) { bad.push(s.key + ' no def'); continue; }
    const pb = BP.pickBlock(s, 'Small', 'light'), Q0 = BP.orientMatrix(pb.orient[0], pb.orient[1]);
    // the card's chosen hold must score best (ties allowed) among all 24 holds, on mount points and construction model
    const holds = pairs.map(([f, u]) => BP.orientMatrix(f, u));
    if (d.mounts.length) { const sc = holds.map(Q => mountScore(s, Q, d.mounts)); if (mountScore(s, Q0, d.mounts) < Math.max(...sc) - 1e-9) bad.push(s.key + ' mount points'); }
    const f = d.files[d.files.length - 1];
    if (f) {
      const P = path.join(content, f.split('\\').join('/'));
      let r; try { r = readMwm(fs.readFileSync(P)); } catch (e) { r = readMwm(fs.readFileSync(P.replace(/\.mwm$/, '_LOD0.mwm'))); }
      const bm = C.shapeMask({ solids: [{ type: 'tris', tris: C.modelToCell(r.tris, { cubeSize: d.size }) }] }).mask;
      const sc = holds.map(Q => iou(maskOf(blockInside(s, Q)), bm));
      if (iou(maskOf(blockInside(s, Q0)), bm) < Math.max(...sc) - 0.004) bad.push(s.key + ' construction model ' + iou(maskOf(blockInside(s, Q0)), bm).toFixed(2) + ' vs ' + Math.max(...sc).toFixed(2) + ' ' + f);
    }
  }
  check(!bad.length, `33 armour cards: base orientation agrees with the game's mount points and construction models${bad.length ? ' (' + bad.join(', ') + ')' : ''}`);
  const pbad = [];
  for (const s of lib.filter(s => s.id.startsWith('panel:'))) for (const b of s.blocks) {
    const d = defs.get(b.subtype); if (!d || !d.model) { pbad.push(b.subtype); continue; }
    const tris = C.modelToCell(readMwm(fs.readFileSync(path.join(content, d.model.split('\\').join('/')))).tris, { cubeSize: d.size });
    if (C.shapeMask({ plate: true, solids: [{ type: 'tris', tris }] }).mask.join() !== C.shapeMask(s).mask.join()) pbad.push(b.subtype);
  }
  check(!pbad.length, `18 panel cards: all 72 panel models match their card unturned${pbad.length ? ' (' + pbad.join(', ') + ')' : ''}`);
} else console.log('     (game Content folder not found: game-data checks skipped)');

// 9. structure against one of the owner's local blueprints (read only): the elements we write appear in the same order
const local = path.join(process.env.APPDATA || '', 'SpaceEngineers/Blueprints/local');
const ref = ['Pillbox', '(I40) Abandoned Lodge (Common)', 'Destroyer - Francesco Crispi'].map(n => path.join(local, n, 'bp.sbc')).filter(f => fs.existsSync(f));
if (ref.length && tree) {
  const refTrees = ref.map(f => parseXml(fs.readFileSync(f, 'utf8')));
  const all = (n, name, out = []) => { if (n.name === name) out.push(n); n.kids.forEach(k => all(k, name, out)); return out; };
  // every element we write exists in the game's files, and every pair of them comes in the same order wherever the
  // game writes both (the game leaves out elements at their defaults, so one file rarely has them all)
  const sameOrder = (ours, name) => {
    const inst = refTrees.flatMap(t => all(t, name)), known = new Set(inst.flatMap(n => n.kids.map(k => k.name)));
    const missing = ours.kids.map(k => k.name).filter(n => !known.has(n));
    if (missing.length) return 'not in the game files: ' + missing.join(', ');
    const names = ours.kids.map(k => k.name);
    for (const n of inst) { const pos = n.kids.map(k => k.name);
      for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++) {
        const i = pos.indexOf(names[a]), j = pos.indexOf(names[b]); if (i >= 0 && j >= 0 && i > j) return `${names[a]} after ${names[b]} in the game's file`; } }
    return null;
  };
  const ours = find(tree, 'CubeGrid'), oursB = find(ours, 'CubeBlocks').kids.find(b => b.kids.some(k => k.name === 'BlockOrientation') && b.kids.some(k => k.name === 'ColorMaskHSV'));
  for (const [n, node] of [['CubeGrid', ours], ['MyObjectBuilder_CubeBlock', oursB], ['ShipBlueprint', find(tree, 'ShipBlueprint')], ['PositionAndOrientation', find(tree, 'PositionAndOrientation')]]) {
    const r = sameOrder(node, n);
    check(!r, `${n}: elements and their order as in the game's own blueprints (${ref.length} local blueprints)${r ? ': ' + r : ''}`);
  }
} else console.log('     (no local blueprints found: structure comparison skipped)');

// 10. a real world import (if present): every block read from a model records its turn on its card
const world = 'C:/Users/valex/AppData/Roaming/SpaceEngineers/Saves/76561198019239090/WW2 Encounter Build World';
if (fs.existsSync(path.join(world, 'Sandbox.sbc')) && !process.argv.includes('--quick')) {
  const { importWorldBlocks } = await import(pathToFileURL(path.join(here, 'importer.js')));
  const nodeFS = root => ({
    async read(p) { try { const b = fs.readFileSync(path.join(root, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch (e) { return null; } },
    async list(p) { try { return fs.readdirSync(path.join(root, p), { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' })); } catch (e) { return []; } },
  });
  const lib2 = seedLibrary();
  await importWorldBlocks(lib2, { world: nodeFS(world), workshop: nodeFS('C:/Program Files (x86)/Steam/steamapps/workshop/content/244850'),
    content: nodeFS(content), localMods: nodeFS('C:/Users/valex/AppData/Roaming/SpaceEngineers/Mods'), includeVanilla: true });
  const mesh = lib2.filter(s => s.id.startsWith('mesh:')).flatMap(s => s.blocks), turned = mesh.filter(b => b.orient && (b.orient[0] !== 'Forward' || b.orient[1] !== 'Up'));
  check(mesh.length > 100 && mesh.every(b => b.orient && b.typeId === 'CubeBlock'), `imported model blocks all record their turn and TypeId (${mesh.length} blocks, ${turned.length} held turned on their card)`);
  const tb2 = BP.testBlueprint(lib2, { size: 'Large', armour: 'light' });
  let ok = true; try { parseXml(BP.blueprintXml({ name: 'All', gridSize: 'Large', blocks: tb2.blocks })); } catch (e) { ok = false; }
  check(ok && tb2.blocks.every(b => b.forward && b.up), `test blueprint of the whole imported library (${tb2.rows.length} cards with a large grid block) is well-formed`);
}

console.log(failed ? `${failed} FAILED` : 'all passed');
process.exit(failed ? 1 : 0);
