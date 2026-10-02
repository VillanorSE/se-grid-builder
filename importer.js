// Import blocks from a world's mod list into the Cube Library.
// Folders are { read(path) -> ArrayBuffer | null, list(path) -> [{ name, kind: 'file'|'directory' }] } (async), so the
// page (File System Access API or a folder upload) and Node (test_core.mjs) share this code.
import { parseWorldMods, parseBlockDefs, parseResx, blockName, modelToCell, shapeMask, maskCount, shapeKeySig, makeKey } from './core.js';
import { readMwm } from './mwm.js';
import { MOD_PENALTY } from './seed.js';

export const DEFAULT_FILTER = 'armou?r|panel|plate|slope|corner|hull|wing';
const dec = new TextDecoder();
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
  const bySig = new Map();
  for (const s of library) { if (!s.solids || !s.solids.length) continue; if (!s._m) s._m = shapeMask(s); if (maskCount(s._m.mask)) bySig.set(shapeKeySig(s._m.mask), s); }
  const keys = new Set(library.map(s => s.key));
  const sum = { mods: sources.length, defs: 0, matched: 0, topology: 0, models: 0, newShapes: 0, multiCell: 0, noShape: 0, unreadable: 0, filteredOut: 0 };
  const addBlock = (s, d, src) => {
    s.blocks ||= [];
    if (!s.blocks.some(b => b.subtype === d.subtype && b.size === d.cubeSize)) s.blocks.push({ subtype: d.subtype, size: d.cubeSize, mod: src.name, name: blockName(d, texts) });
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
        let tris;
        try { if (!buf) throw new Error('missing'); tris = modelToCell(readMwm(buf).tris, d); } catch (e) { sum.unreadable++; continue; }
        // blocks called panels or plates are plates even when their thin model happens to cover sample points
        const shape = { plate: /panel|plate/i.test(d.subtype + ' ' + blockName(d, texts)), solids: [{ type: 'tris', tris }] };
        shape._m = shapeMask(shape);
        if (!maskCount(shape._m.mask)) { sum.noShape++; continue; }
        const sig = shapeKeySig(shape._m.mask);
        let s = bySig.get(sig);
        if (!s) {
          const name = blockName(d, texts);
          s = Object.assign(shape, { id: 'mesh:' + src.name + ':' + d.subtype, key: makeKey(name, keys), name, source: src.name,
            blocks: [], use: false, penalty: MOD_PENALTY, lines: [], rev: 1 });   // mod blocks start off: switch on the ones you build with
          keys.add(s.key); library.push(s); bySig.set(sig, s); sum.newShapes++;
        }
        addBlock(s, d, src); sum.models++; n++;
        if (n % 25 === 0) await pause();
      }
    }
    log(`  ${src.name}: ${n} blocks`);
    await pause();
  }
  return sum;
}
