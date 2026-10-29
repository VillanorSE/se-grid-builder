// Import blocks from a world's mod list into the Cube Library.
// Folders are { read(path) -> ArrayBuffer | null, list(path) -> [{ name, kind: 'file'|'directory' }] } (async), so the
// page (File System Access API or a folder upload) and Node (test_core.mjs) share this code.
import { parseWorldMods, parseBlockDefs, parseResx, blockName, modelToCell, shapeMask, maskCount, shapeKeySig, makeKey, exactVolume } from './core.js';
import { readMwm } from './mwm.js';
import { MOD_PENALTY } from './seed.js';
import { blockOrientOnCard } from './blueprint.js';

export const DEFAULT_FILTER = 'armou?r|panel|plate|slope|corner|hull|wing';
const dec = new TextDecoder();
// Some blocks are drawn outside their own cell (KONTAKT's mantlet plates sit half a cell or more off, through ModelOffset,
// so the block goes in a spare cell and its plate shows over the next block). The cell a model shows in: per axis, its own cell when the
// model stays within it (give or take REACH_TOL of a cell) without lying wholly past one of its walls, else the cell
// holding the middle of its extent (KONTAKT's Mantlet Plate lies on the floor of the cell in front, 0 to 0.04 up;
// Mantlet Plate (Below) just under that floor, -0.04 to 0: the top of the cell below that). Returns
// { offset: [x, y, z] (cells, block frame), tris moved into that cell, spans }. A model across several cells (canopies,
// curved plates bulging past their cell) stays in its own cell, cut to it as before (spans: true).
export const REACH_TOL = 0.05;
export function shownCell(tris) {
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], tris[i + k]); mx[k] = Math.max(mx[k], tris[i + k]); }
  const past = k => (mx[k] <= 1e-3 && mn[k] < -1e-3) || (mn[k] >= 1 - 1e-3 && mx[k] > 1 + 1e-3);
  const offset = [0, 1, 2].map(k => mn[k] >= -REACH_TOL && mx[k] <= 1 + REACH_TOL && !past(k) ? 0 : Math.floor((mn[k] + mx[k]) / 2));
  if (offset.some((o, k) => mn[k] - o < -REACH_TOL || mx[k] - o > 1 + REACH_TOL)) return { offset: [0, 0, 0], tris, spans: true };
  if (offset.every(o => o === 0)) return { offset, tris };
  const t = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) t[i + k] = Math.round((tris[i + k] - offset[k]) * 1e4) / 1e4;
  return { offset, tris: t };
}
const text = async (fs, p) => { const b = await fs.read(p); return b ? dec.decode(b) : null; };

async function sbcFiles(fs, dir) {
  const out = [];
  for (const e of await fs.list(dir)) {
    const p = dir + '/' + e.name;
    if (e.kind === 'directory') out.push(...await sbcFiles(fs, p));
    else if (e.name.toLowerCase().endsWith('.sbc')) out.push(p);
  }
  return out;
}

// library: array of shapes (changed in place). Returns a summary. o: { world, workshop, content?, localMods?, filter,
// includeVanilla, log(msg), yieldNow() }
export async function importWorldBlocks(library, o) {
  const log = o.log || (() => {}), pause = o.yieldNow || (async () => {});
  const sandbox = await text(o.world, 'Sandbox.sbc');
  if (!sandbox) throw new Error('Sandbox.sbc not found in the world folder');
  const mods = parseWorldMods(sandbox);
  log(`World lists ${mods.length} mods.`);
  let texts = null;
  if (o.content) { const r = await text(o.content, 'Data/Localization/MyTexts.resx'); if (r) texts = parseResx(r); }

  const sources = [];
  if (o.includeVanilla && o.content) sources.push({ name: 'Vanilla', fs: o.content, root: '' });
  for (const m of mods) {
    if (m.id && o.workshop && (await o.workshop.list(m.id)).length) sources.push({ name: m.name || m.id, fs: o.workshop, root: m.id });
    else if (o.localMods && m.file && (await o.localMods.list(m.file)).length) sources.push({ name: m.name || m.file, fs: o.localMods, root: m.file });
    else log(`  not found: ${m.name || m.file} (${m.id ? 'Workshop ' + m.id : 'local mod'})`);
  }

  const re = new RegExp(o.filter || DEFAULT_FILTER, 'i');
  const byTopology = new Map(library.filter(s => s.topology).map(s => [s.topology, s]));
  // A block joins a card whose sample mask matches in some turn and whose volume matches too: the 6-sample mask alone
  // can't tell a 1x8 slope's pieces from a 1x7's or from quarter blocks. A mod's grades are one model (same volume);
  // the same piece from different modders differs by up to 0.6% of its volume, the 1x7 and 1x8 tips by 1%. Plates
  // (panels) group by outline, whatever their thickness.
  // Blocks drawn outside their cell get cards of their own ("reach" cards: the block's own cell, its model shift cells
  // off), keyed apart and unturned: a reach block joins a reach card only as the same shape, the same way round, with the
  // same shift.
  const bySig = new Map(), vols = new WeakMap();
  const sigKey = (mask, shift) => shift ? 'reach:' + Array.from(mask).join('.') + '@' + shift.join(',') : shapeKeySig(mask);
  const volOf = s => { if (!vols.has(s)) vols.set(s, exactVolume(s)); return vols.get(s); };
  const sameVolume = (a, b, plate) => { const d = Math.abs(a - b); return plate ? d < 0.05 : d < 0.006 && d < 0.03 * Math.max(a, b); };
  const addCard = (sig, s) => { if (!bySig.has(sig)) bySig.set(sig, []); bySig.get(sig).push(s); };
  for (const s of library) { if (!s.solids || !s.solids.length) continue; if (!s._m) s._m = shapeMask(s); if (maskCount(s._m.mask) && !(s.reach && !s.shift)) addCard(sigKey(s._m.mask, s.shift), s); }   // (reach cards from before shifts: replaced)
  // where each block is now, so a block read again moves to its right card (an older import may have put it elsewhere)
  const blockKey = (subtype, size) => subtype + '|' + size, cardOf = new Map();
  for (const s of library) for (const b of s.blocks || []) cardOf.set(blockKey(b.subtype, b.size), s);
  const keys = new Set(library.map(s => s.key));
  const sum = { mods: sources.length, defs: 0, matched: 0, topology: 0, models: 0, newShapes: 0, multiCell: 0, reach: 0, spansCells: 0, noShape: 0, unreadable: 0, filteredOut: 0, moved: 0 };
  // orient: for a block read from its model, how it sits on the card (its Forward and Up as card directions; the card
  // may hold it turned, since cards group shapes in any turn). Blueprint export needs it (blueprint.js).
  const addBlock = (s, d, src, orient) => {
    s.blocks ||= [];
    const k = blockKey(d.subtype, d.cubeSize), was = cardOf.get(k);
    if (was && was !== s) {
      const b = was.blocks.find(b => b.subtype === d.subtype && b.size === d.cubeSize);
      // the card was named after this block (not by hand): it takes a remaining block's name below
      if (was.id === 'mesh:' + b.mod + ':' + b.subtype && (was.name === b.name || was.name === was.autoName)) was._lostName = true;
      was.blocks = was.blocks.filter(x => x !== b); sum.moved++;
    }
    cardOf.set(k, s);
    const cur = s.blocks.find(b => b.subtype === d.subtype && b.size === d.cubeSize);
    if (!cur) s.blocks.push({ subtype: d.subtype, size: d.cubeSize, mod: src.name, name: blockName(d, texts), typeId: d.typeId, ...(orient ? { orient } : {}) });
    else if (orient && !cur.orient) cur.orient = orient;
  };
  for (const src of sources) {
    const files = await sbcFiles(src.fs, (src.root ? src.root + '/' : '') + 'Data');
    let n = 0;
    for (const f of files) {
      const xml = await text(src.fs, f); if (!xml || !xml.includes('<CubeBlocks')) continue;
      for (const d of parseBlockDefs(xml)) {
        sum.defs++;
        if (d.typeId !== 'CubeBlock' || !d.public) continue;
        if (!re.test(d.subtype + ' ' + d.displayName + ' ' + blockName(d, texts))) { sum.filteredOut++; continue; }
        sum.matched++;
        if (d.size.some(v => v !== 1)) { sum.multiCell++; continue; }
        if (d.topology) {
          const s = byTopology.get(d.topology);
          if (s) { addBlock(s, d, src); sum.topology++; n++; } else sum.noShape++;
          continue;
        }
        if (!d.model) { sum.noShape++; continue; }
        const mp = d.model.split('\\').join('/');
        let buf = await src.fs.read((src.root ? src.root + '/' : '') + mp);
        if (!buf && o.content) buf = await o.content.read(mp);
        let shown;
        try { if (!buf) throw new Error('missing'); shown = shownCell(modelToCell(readMwm(buf).tris, d)); } catch (e) { sum.unreadable++; continue; }
        if (shown.spans) sum.spansCells++;
        const reach = shown.offset.some(v => v);
        // blocks called panels or plates are plates even when their thin model happens to cover sample points
        const shape = { plate: /panel|plate/i.test(d.subtype + ' ' + blockName(d, texts)), solids: [{ type: 'tris', tris: shown.tris }] };
        shape._m = shapeMask(shape);
        if (!maskCount(shape._m.mask)) { sum.noShape++; continue; }
        const sig = sigKey(shape._m.mask, reach && shown.offset);
        const vol = volOf(shape);
        let s = (bySig.get(sig) || []).find(c => sameVolume(volOf(c), vol, shape._m.plate)), orient = ['Forward', 'Up'];
        if (s && !reach) { if (!s._m) s._m = shapeMask(s); orient = blockOrientOnCard(s._m.mask, shape._m.mask); }
        if (!s) {
          const name = blockName(d, texts);
          let id = 'mesh:' + src.name + ':' + d.subtype;
          if (library.some(x => x.id === id)) id += '~' + library.length;   // its card from an older import is still there: tidied below
          // reach cards are picked by hand (Edit a cell), never by the fit: the cell holds the block, its model shows next door
          s = Object.assign(shape, { id, key: makeKey(name, keys), name, source: src.name,
            blocks: [], use: false, penalty: MOD_PENALTY, lines: [], rev: 1, ...(reach ? { reach: true, shift: shown.offset } : {}) });   // mod blocks start off: switch on the ones you build with
          keys.add(s.key); library.push(s); addCard(sig, s); sum.newShapes++;
        }
        addBlock(s, d, src, orient); sum.models++; if (reach) sum.reach++; n++;
        if (n % 25 === 0) await pause();
      }
    }
    log(`  ${src.name}: ${n} blocks`);
    await pause();
  }
  // imported cards left with no blocks (their blocks moved to better cards) go; one that lost the block it was read from
  // is named after a block it still holds; a card that had to take a stand-in id gets its own back
  for (let i = library.length - 1; i >= 0; i--) if (library[i].id.startsWith('mesh:') && library[i].blocks && !library[i].blocks.length) library.splice(i, 1);
  for (const s of library) {
    if (!s.id.startsWith('mesh:') || !s.blocks || s.blocks.some(b => s.id === 'mesh:' + b.mod + ':' + b.subtype)) { delete s._lostName; continue; }
    const b = s.blocks.find(b => b.mod), id = b && 'mesh:' + b.mod + ':' + b.subtype;
    if (id && !library.some(x => x.id === id)) s.id = id;
    if (s._lostName && b) { s.name = b.name || b.subtype; delete s.autoName; }
    delete s._lostName;
  }
  for (const s of library) { const m = s.id.match(/^(mesh:.*)~\d+$/); if (m && !library.some(x => x.id === m[1])) s.id = m[1]; }
  return sum;
}
