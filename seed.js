// The starting Cube Library: the 33 owner-confirmed vanilla armour shapes (armor_data.js, generated from
// tools/grid-overlay/armor_shapes.json by build.py) plus the 18 vanilla armour panels (panel_data.js, generated from the
// game's models by extract_panels.mjs; round panels left out).
import { ARMOR } from './armor_data.js';
import { PANELS } from './panel_data.js';
import { hullPlanes } from './core.js';

// near-ties go to the simpler block: fit score minus this. Ranked the way the owner builds (2026-10-01: plain slopes over
// corner pieces): cube, half, slope, 2x1 slopes and the flat panel, half slopes and other panels, corners, the rest.
const PENALTY = { C: 0, H: 0.01, S: 0.02, B: 0.03, T: 0.03, P: 0.03, HS: 0.05, HSI: 0.05,
  K: 0.09, I: 0.09, CB: 0.09, CT: 0.09, IB: 0.09, IT: 0.09, HC: 0.09 };
export const DEFAULT_PENALTY = 0.11;   // other vanilla shapes
const PANEL_PENALTY = 0.05;
export const MOD_PENALTY = 0.13;       // imported mod blocks: used only when clearly better

export function seedLibrary() {
  const armour = ARMOR.map(s => ({
    id: 'vanilla:' + s.topology, key: s.key, name: s.name, topology: s.topology, source: 'Vanilla armour',
    blocks: [{ subtype: s.block, size: 'Small', mod: 'Vanilla' }], use: true, plate: false,
    penalty: PENALTY[s.key] ?? DEFAULT_PENALTY,
    // planes from the exact corner points (the stored ones are rounded and leave out the cell walls)
    solids: s.verts.map(vs => ({ type: 'planes', planes: hullPlanes(vs), verts: vs })), lines: [],
  }));
  const panels = PANELS.map(p => ({ id: p.id, key: p.key, name: p.name, source: 'Vanilla panels', blocks: p.blocks, use: true,
    plate: true, penalty: PENALTY[p.key] ?? PANEL_PENALTY, solids: [{ type: 'tris', tris: Float32Array.from(p.tris) }], lines: [] }));
  return [...armour, ...panels];
}
