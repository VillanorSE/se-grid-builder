// Import a world's blocks into a Cube Library file, for browsers that can't open folders (Firefox):
//   node tools/se-grid-builder/import_world.mjs "<world save folder>" [--out file.json] [--filter regex] [--no-vanilla]
//     [--workshop <...\steamapps\workshop\content\244850>] [--content <...\SpaceEngineers\Content>] [--mods <...\Mods>]
// Then in SE Grid Builder: Cube Library > Import JSON > Cancel (merge).
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const { importWorldBlocks, DEFAULT_FILTER } = await import(pathToFileURL(path.join(here, 'importer.js')));
const { seedLibrary } = await import(pathToFileURL(path.join(here, 'seed.js')));
const { nameCardsByFamily } = await import(pathToFileURL(path.join(here, 'blueprint.js')));

const args = process.argv.slice(2), opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : d; };
const steam = 'C:/Program Files (x86)/Steam/steamapps';
const out = opt('--out', 'cube-library-import.json'), filter = opt('--filter', DEFAULT_FILTER);
const workshop = opt('--workshop', steam + '/workshop/content/244850'), content = opt('--content', steam + '/common/SpaceEngineers/Content');
const mods = opt('--mods', path.join(process.env.APPDATA || '', 'SpaceEngineers/Mods'));
const vanilla = !args.includes('--no-vanilla'), world = args.find(a => !a.startsWith('--'));
if (!world || !fs.existsSync(path.join(world, 'Sandbox.sbc'))) { console.error('Give the world save folder (the one holding Sandbox.sbc).'); process.exit(1); }

const nodeFS = root => root && fs.existsSync(root) ? {
  name: root,
  async read(p) { try { const b = fs.readFileSync(path.join(root, p)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } catch (e) { return null; } },
  async list(p) { try { return fs.readdirSync(path.join(root, p), { withFileTypes: true }).map(e => ({ name: e.name, kind: e.isDirectory() ? 'directory' : 'file' })); } catch (e) { return []; } },
} : null;

const lib = seedLibrary(), t0 = Date.now();
const sum = await importWorldBlocks(lib, { world: nodeFS(world), workshop: nodeFS(workshop), content: nodeFS(content), localMods: nodeFS(mods),
  filter, includeVanilla: vanilla, log: m => console.log(m) });
nameCardsByFamily(lib);
const shapes = lib.map(({ _m, _s, ...s }) => ({ ...s, solids: (s.solids || []).map(sol => sol.type === 'tris'
  ? { type: 'tris', tris: Array.from(sol.tris, v => Math.round(v * 1e4) / 1e4) } : sol) }));
fs.writeFileSync(out, JSON.stringify({ format: 'se-grid-builder-library', version: 1, shapes }));
console.log(`\n${sum.matched} matching blocks: ${sum.topology} joined vanilla armour, ${sum.models} read from models (${sum.newShapes} new cards, switched off until you turn them on); ` +
  `skipped ${sum.multiCell} larger than one cell, ${sum.unreadable} unreadable models. ${((Date.now() - t0) / 1000).toFixed(1)} s`);
console.log(`Wrote ${path.resolve(out)} (${lib.length} cards). In SE Grid Builder: Cube Library > Import JSON, then Cancel to merge.`);
