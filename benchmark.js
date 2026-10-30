// SE Grid Builder: blueprint benchmarking (README, "Benchmark"). A hand-built blueprint or prefab of a model is read as a
// reference, lined up with the model's grid and compared cell by cell with the fit. No DOM, no three.js, so it runs in
// the page and in Node (owner_cases.mjs, test_core.mjs).
//
// The reading is blueprint.js run backwards: a block's subtype gives its card (pickBlock's lists and VANILLA_ARMOR),
// its BlockOrientation gives the card's turn (gridOrientation), its Min the cell (gridPos, TOOL_TO_GRID).
import { ROTS, NS, getBit, maskCount, shapeMask } from './core.js';
import { orientMatrix, TOOL_TO_GRID, CARD_ORIENT, VANILLA_ARMOR, turnMask, pickBlock } from './blueprint.js';

const bmMul = (A, B) => [0, 1, 2].map(r => [0, 1, 2].map(c => A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c]));
const bmTr = A => [0, 1, 2].map(i => [0, 1, 2].map(j => A[j][i]));
const bmApp = (M, v) => [0, 1, 2].map(r => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
const bmRotIndex = M => ROTS.findIndex(R => R.every((row, i) => row.every((v, j) => v === M[i][j])));
const GRID_TO_TOOL = bmTr(TOOL_TO_GRID);
const bmUnxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const bmAttr = (s, k) => { const m = s.match(new RegExp('\\b' + k + '\\s*=\\s*"([^"]*)"')); return m ? m[1] : null; };

// ---------- reading: a bp.sbc blueprint or a prefab .sbc (both hold <CubeGrid>s of <MyObjectBuilder_CubeBlock>s)
// -> { name, grids: [{ name, size: 'Small'|'Large', blocks: [[typeId, subtype, [x, y, z], forward, up]] }] }
// (the compact block rows are what a benchmark file keeps). The game leaves out Min (0,0,0) and BlockOrientation
// (Forward/Up) when they are the defaults.
export function parseBlueprint(xml) {
  const name = bmUnxml((xml.match(/<Id\b[^>]*\bSubtype="([^"]*)"/) || [])[1] || '');
  const grids = [];
  for (const gm of xml.matchAll(/<CubeGrid>([\s\S]*?)<\/CubeGrid>/g)) {
    const g = gm[1], blocks = [];
    for (const bm of g.matchAll(/<MyObjectBuilder_CubeBlock\b([^>]*)>([\s\S]*?)<\/MyObjectBuilder_CubeBlock>/g)) {
      const b = bm[2], typeId = (bmAttr(bm[1], 'xsi:type') || 'MyObjectBuilder_CubeBlock').replace('MyObjectBuilder_', '');
      const st = b.match(/<SubtypeName>([^<]*)<\/SubtypeName>|<SubtypeName\s*\/>/);   // the first one is the block's own
      const mn = b.match(/<Min\b([^>]*)\/>/), bo = b.match(/<BlockOrientation\b([^>]*)\/>/);
      blocks.push([typeId, st && st[1] ? bmUnxml(st[1]) : '', mn ? ['x', 'y', 'z'].map(k => +(bmAttr(mn[1], k) || 0)) : [0, 0, 0],
        (bo && bmAttr(bo[1], 'Forward')) || 'Forward', (bo && bmAttr(bo[1], 'Up')) || 'Up']);
    }
    const rest = g.replace(/<CubeBlocks>[\s\S]*?<\/CubeBlocks>/, '');
    grids.push({ name: bmUnxml((rest.match(/<DisplayName>([^<]*)<\/DisplayName>/) || [])[1] || ''),
      size: (rest.match(/<GridSizeEnum>([^<]*)<\/GridSizeEnum>/) || [])[1] || 'Large', blocks });
  }
  return { name, grids };
}
// the main grid: the one with most blocks
export const mainGrid = bp => bp.grids.reduce((a, g) => (!a || g.blocks.length > a.blocks.length ? g : a), null);

// ---------- which card a game block is: subtype -> { si, orient (the block's Forward/Up in the card's frame) }
// Every card counts, used or not (a reference block whose card is switched off is a finding, not an unknown).
// A subtype on several cards: the card read from that block first, then a card in use, then the first.
export function blockIndex(lib, size) {
  const idx = new Map(), rank = new Map();
  const put = (sub, si, orient, r) => { if (!sub) return; if (!idx.has(sub) || r < rank.get(sub)) { idx.set(sub, { si, orient }); rank.set(sub, r); } };
  lib.forEach((sh, si) => {
    const cardOrient = CARD_ORIENT[sh.id] || ['Forward', 'Up'], used = sh.use ? 0 : 1;
    const va = sh.topology && VANILLA_ARMOR[sh.topology];
    if (va) va.slice(size === 'Large' ? 2 : 0, size === 'Large' ? 4 : 2).forEach(sub => put(sub, si, cardOrient, 2 + used));
    for (const b of sh.blocks || []) if (b.size === size && b.subtype)
      put(b.subtype, si, b.orient || cardOrient, sh.id === 'mesh:' + b.mod + ':' + b.subtype ? 0 : 2 + used);
  });
  return idx;
}

// ---------- the reference's blocks in the grid's frame, each with its cells
// grid: a parseBlueprint grid; o: { sizes: Map funcId-like 'typeId:subtype' -> [x, y, z] cells (block frame) }
// kind: 'armour' (a library card), 'functional' (any non-CubeBlock type: reserves its cells), 'unmapped' (a CubeBlock
// subtype no card holds).
export function referenceBlocks(grid, lib, o = {}) {
  const idx = blockIndex(lib, grid.size), sizes = o.sizes || new Map();
  return grid.blocks.map(([typeId, subtype, min, forward, up]) => {
    const M = orientMatrix(forward, up), hit = idx.get(subtype);
    const kind = hit ? 'armour' : typeId === 'CubeBlock' ? 'unmapped' : 'functional';
    const size = kind === 'armour' ? [1, 1, 1] : sizes.get(typeId + ':' + subtype) || [1, 1, 1];
    const ext = [0, 1, 2].map(r => M[r].reduce((n, v, j) => n + Math.abs(v) * size[j], 0)), cells = [];
    for (let i = 0; i < ext[0]; i++) for (let j = 0; j < ext[1]; j++) for (let k = 0; k < ext[2]; k++) cells.push([min[0] + i, min[1] + j, min[2] + k]);
    return { typeId, subtype, kind, M, cells, ...(hit ? { si: hit.si, orient: hit.orient } : {}), ...(sizes.has(typeId + ':' + subtype) ? {} : kind === 'functional' ? { sizeUnknown: true } : {}) };
  });
}

// ---------- lining the reference up with the model's grid
// A hand-built grid's origin and facing are its own. Tried: the 24 turns of the grid (no mirror) and whole-cell shifts
// around the model; scored by how the reference's cells cover the model's material (g.mat, not the fit, so the line-up
// can't favour the fit): overlap / (reference cells + material cells - overlap).
// Returns { rot, t: [x, y, z], score, next } (next: the best score with another turn, to show a near-tie).
const MAT_MIN = Math.round(NS * 0.08);   // as the fit's empty rule: under 8% material is no material
export function toolCell(al, gc) { const p = bmApp(bmMul(ROTS[al.rot], GRID_TO_TOOL), gc); return [p[0] + al.t[0], p[1] + al.t[1], p[2] + al.t[2]]; }
export function alignReference(blocks, g, o = {}) {
  const span = o.span ?? 3, keys = new Set(), cells = [];
  for (const b of blocks) for (const c of b.cells) { const k = c.join(','); if (!keys.has(k)) { keys.add(k); cells.push(c); } }
  const mlo = [1e9, 1e9, 1e9], mhi = [-1e9, -1e9, -1e9]; let nMat = 0;
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) if (g.mat[g.idx(x, y, z)] >= MAT_MIN) {
    nMat++; [x, y, z].forEach((v, i) => { mlo[i] = Math.min(mlo[i], v); mhi[i] = Math.max(mhi[i], v); }); }
  if (!nMat || !cells.length) return null;
  const isMat = (x, y, z) => x >= 0 && y >= 0 && z >= 0 && x < g.nx && y < g.ny && z < g.nz && g.mat[g.idx(x, y, z)] >= MAT_MIN;
  let best = null; const bestPerRot = [];
  for (const r of o.rots || ROTS.keys()) {   // o.rots: only these turns (the page's Turn button)
    const A = bmMul(ROTS[r], GRID_TO_TOOL), P = cells.map(c => bmApp(A, c));
    const lo = [0, 1, 2].map(i => Math.min(...P.map(p => p[i]))), hi = [0, 1, 2].map(i => Math.max(...P.map(p => p[i])));
    // shifts that put the reference's box within `span` cells of the material's box on every side
    const range = [0, 1, 2].map(i => { const a = mlo[i] - lo[i], b = mhi[i] - hi[i]; return [Math.min(a, b) - span, Math.max(a, b) + span]; });
    let rb = null;
    for (let tx = range[0][0]; tx <= range[0][1]; tx++) for (let ty = range[1][0]; ty <= range[1][1]; ty++) for (let tz = range[2][0]; tz <= range[2][1]; tz++) {
      let ov = 0; for (const p of P) if (isMat(p[0] + tx, p[1] + ty, p[2] + tz)) ov++;
      const s = ov / (P.length + nMat - ov);
      if (!rb || s > rb.score) rb = { rot: r, t: [tx, ty, tz], score: s };
    }
    bestPerRot.push(rb);
    if (!best || rb.score > best.score) best = rb;
  }
  const next = Math.max(0, ...bestPerRot.filter(b => b.rot !== best.rot).map(b => b.score));
  return { ...best, score: +best.score.toFixed(4), next: +next.toFixed(4) };
}

// ---------- the comparison
// One category per cell where either side has a block (README, "Benchmark"):
//   match, turn (same card, other turn), rank-miss (the reference's card is among the cell's alternatives),
//   candidate-miss (it isn't), not-in-library (its card is switched off for the fit), missing (fit left the cell empty;
//   sub 'dropped' where the model has material, 'beyond' where it has none or the cell is outside the grid), extra (fit
//   has a block where the reference has none; sub 'functional' where a reference functional block sits, else 'open'),
//   shifted (a miss whose reference block the fit put in a neighbouring cell), unmapped (reference block no card holds).
// Scored over every category but unmapped: exact = match, shape = match + turn, overlap = mean mask IoU (0 for a block
// against nothing). Armour grades (light/heavy, a mod's thickness) aren't the fit's choice: a matched cell whose exported
// block (pickBlock with o.armour) differs from the reference's only counts in gradeDiff.
// fitAt(ci) -> template index, or < 0 for no block (default g.fit; the page passes its edits).
export const SCORED = ['match', 'turn', 'rank-miss', 'candidate-miss', 'not-in-library', 'shifted', 'missing', 'extra'];
// The reference's cells in the fit's tool frame: 'x,y,z' -> { b (the block), rot (its card's turn in ROTS, armour only,
// else -1), p (the cell) }, plus the cells outside the grid. The page draws the reference from this too.
export function referenceCells(blocks, al, g) {
  const inGrid = p => p[0] >= 0 && p[1] >= 0 && p[2] >= 0 && p[0] < g.nx && p[1] < g.ny && p[2] < g.nz;
  const A = bmMul(ROTS[al.rot], GRID_TO_TOOL);
  const ref = new Map(), outside = [];
  for (const b of blocks) {
    let rot = -1;
    if (b.kind === 'armour') rot = bmRotIndex(bmMul(bmMul(A, b.M), bmTr(orientMatrix(b.orient[0], b.orient[1]))));
    for (const c of b.cells) {
      const p = toolCell(al, c), k = p.join(',');
      if (ref.has(k)) continue;
      const e = { b, rot, p };
      if (!inGrid(p)) outside.push(e); else ref.set(k, e);
    }
  }
  return { ref, outside };
}
export function compareReference(blocks, al, g, T, lib, o = {}) {
  const fitAt = o.fitAt || (ci => g.fit[ci]), size = o.size || (g.b > 1 ? 'Large' : 'Small');
  const { ref, outside } = referenceCells(blocks, al, g);   // tool cell key -> reference entry
  const masks = new Map(), refMask = (si, rot) => { const k = si + ':' + rot;
    if (!masks.has(k)) { const sh = lib[si]; if (!sh._m) sh._m = shapeMask(sh); masks.set(k, turnMask(sh._m.mask, rot)); } return masks.get(k); };
  const iou = (a, b) => { let i = 0, u = 0; for (let k = 0; k < NS; k++) { const x = getBit(a, k), y = getBit(b, k); i += x & y; u += x | y; } return u ? i / u : 1; };
  const key = si => lib[si].key, rows = [], counts = {}, unmapped = {}, notInLibrary = {};
  let gradeDiff = 0;
  const add = (p, cat, extra) => { counts[cat] = (counts[cat] || 0) + 1; rows.push({ column: p[0] + 1, layer: p[1] + 1, row: p[2] + 1, cat, ...extra }); };
  const fitInfo = fi => fi >= 0 ? { key: key(T.list[fi].shape), shape: lib[T.list[fi].shape].id } : 'none';
  const refInfo = e => ({ key: e.b.si != null ? key(e.b.si) : null, shape: e.b.si != null ? lib[e.b.si].id : null, subtype: e.b.subtype, typeId: e.b.typeId });
  const cardOfFit = new Map();   // tool cell key -> fitted card index (for shifted)
  const seen = new Set();
  for (let y = 0; y < g.ny; y++) for (let z = 0; z < g.nz; z++) for (let x = 0; x < g.nx; x++) {
    const ci = g.idx(x, y, z), fi = fitAt(ci), k = x + ',' + y + ',' + z, e = ref.get(k);
    if (fi >= 0) cardOfFit.set(k, T.list[fi].shape);
    if (!e && fi < 0) continue;
    seen.add(k);
    const p = [x, y, z], fit = fitInfo(fi);
    if (!e) { add(p, 'extra', { sub: 'open', fit, iou: 0 }); continue; }
    if (e.b.kind === 'unmapped') { unmapped[e.b.subtype] = (unmapped[e.b.subtype] || 0) + 1; add(p, 'unmapped', { ref: refInfo(e), fit }); continue; }
    if (e.b.kind === 'functional') { if (fi >= 0) add(p, 'extra', { sub: 'functional', ref: refInfo(e), fit, iou: 0 }); continue; }
    const si = e.b.si, rm = refMask(si, e.rot), r = refInfo(e);
    const vol = fi >= 0 ? +((maskCount(T.list[fi].mask) - maskCount(rm)) / NS).toFixed(3) : +(-maskCount(rm) / NS).toFixed(3);
    const ov = fi >= 0 ? +iou(T.list[fi].mask, rm).toFixed(3) : 0;
    if (!lib[si].use) { const nm = `${lib[si].name} [${key(si)}]`; notInLibrary[nm] = (notInLibrary[nm] || 0) + 1; add(p, 'not-in-library', { ref: r, fit, iou: ov, vol }); continue; }
    if (fi < 0) { add(p, 'missing', { sub: g.mat[ci] >= MAT_MIN ? 'dropped' : 'beyond', ref: r, fit, iou: 0, vol }); continue; }
    if (T.list[fi].shape === si) {
      const tr2 = T.turns && T.turns.get(si), same = tr2 ? tr2[e.rot] === fi : ov === 1;
      const pb = pickBlock(lib[si], size, o.armour || 'light');
      if (pb && pb.subtype !== e.b.subtype) gradeDiff++;
      add(p, same ? 'match' : 'turn', { ref: r, fit, iou: ov, ...(pb && pb.subtype !== e.b.subtype ? { exported: pb.subtype } : {}) });
      continue;
    }
    let rank = 0; for (let a = 0; a < g.ALT && !rank; a++) { const ti = g.alt[ci * g.ALT + a]; if (ti >= 0 && T.list[ti].shape === si) rank = a + 1; }
    add(p, rank ? 'rank-miss' : 'candidate-miss', { ref: r, fit, iou: ov, vol, ...(rank ? { rank } : {}) });
  }
  for (const e of outside) if (e.b.kind === 'armour') add(e.p, 'missing', { sub: 'outside', ref: refInfo(e), fit: 'none', iou: 0 });
    else if (e.b.kind === 'unmapped') { unmapped[e.b.subtype] = (unmapped[e.b.subtype] || 0) + 1; add(e.p, 'unmapped', { ref: refInfo(e), fit: 'none' }); }
  // shifted: a miss whose reference card the fit put in a neighbouring cell that itself is a miss (an extra, or another card)
  const at = new Map(rows.map(r => [(r.column - 1) + ',' + (r.layer - 1) + ',' + (r.row - 1), r]));
  const N6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const miss = c => c === 'rank-miss' || c === 'candidate-miss' || c === 'missing' || c === 'extra';
  const moves = [];
  for (const r of rows) {
    if (!miss(r.cat) || !r.ref || r.ref.key == null || r.cat === 'extra') continue;
    const si = lib.findIndex(s => s.id === r.ref.shape), p = [r.column - 1, r.layer - 1, r.row - 1];
    for (const d of N6) { const q = p.map((v, i) => v + d[i]).join(','), n = at.get(q);
      if (cardOfFit.get(q) === si && n && miss(n.cat)) { moves.push([r, d]); break; } }
  }
  for (const [r, d] of moves) { counts[r.cat]--; r.was = r.cat; r.cat = 'shifted'; r.by = d; counts.shifted = (counts.shifted || 0) + 1; }
  for (const c of Object.keys(counts)) if (!counts[c]) delete counts[c];
  const scored = rows.filter(r => r.cat !== 'unmapped'), n = scored.length;
  const exact = counts.match || 0, shape = exact + (counts.turn || 0);
  const overlap = n ? scored.reduce((s, r) => s + (r.iou || 0), 0) / n : 0;
  return { n, exact, shape, overlap: +overlap.toFixed(4), counts, gradeDiff, unmapped, notInLibrary,
    functional: blocks.filter(b => b.kind === 'functional').length, sizeUnknown: [...new Set(blocks.filter(b => b.sizeUnknown).map(b => b.typeId + ':' + b.subtype))],
    cells: rows };
}

// ---------- the benchmark file (se-grid-builder-benchmark v1): the edits file's model/grid/library, the reference
// (raw block rows, so it maps again when the library changes) with its line-up, and the result when exported
export function benchmarkFile({ model, grid, library, reference, result }) {
  const { cells, ...summary } = result || {};
  return { format: 'se-grid-builder-benchmark', version: 1, exported: new Date().toISOString(), model, grid, library, reference,
    ...(result ? { result: { ...summary, mismatches: cells.filter(c => c.cat !== 'match') } } : {}) };
}
export const pct = (a, n) => n ? (100 * a / n).toFixed(1) + '%' : '-';
export function summaryLine(r) {
  const order = ['match', 'turn', 'rank-miss', 'candidate-miss', 'not-in-library', 'shifted', 'missing', 'extra', 'unmapped'];
  return `right block and turn ${r.exact}/${r.n} (${pct(r.exact, r.n)}), right block ${r.shape}/${r.n} (${pct(r.shape, r.n)}), shape overlap ${(100 * r.overlap).toFixed(1)}%; ` +
    order.filter(c => r.counts[c]).map(c => `${c} ${r.counts[c]}`).join(', ');
}
