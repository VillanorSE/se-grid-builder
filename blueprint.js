// SE Grid Builder: Space Engineers blueprint export (bp.sbc in a blueprint folder, or a zip). No DOM, no three.js, so
// it runs in Node too (test_blueprint.mjs). The page side (buttons, folder writing, thumbnail) is blueprint_ui.js.
//
// The blueprint layout follows the game's own local blueprints and two MIT-licensed tools (see the licence notice at
// the end of this file): se-blueprinter (imivi, generate-blueprint-xml.ts) and StlToBlueprint (austinvaness, Main.cs,
// ArmorCube.cs).
//
// Frames (all right-handed):
// - card frame: a library card's shape in its cell, 0..1 (core.js "cell space"; y up, Forward is -z as in the game).
// - tool frame: the Grid Builder's world and grid: x = the model's front, y = up, z = side. A fitted template is the card
//   turned by ROTS[rot] about the cell centre (core.js buildTemplates; the 3D view draws it that way).
// - block frame: the game block's own axes (Forward = -Z, Up = +Y, Right = +X); its .mwm model is in this frame.
// - SE grid frame: the blueprint's CubeGrid. The model's front becomes the grid's Forward (-Z), up stays +Y, so the
//   tool's +z side becomes the grid's Right (+X): grid = (z, y, -x). ENGINE_CONSTRAINT: grid Forward is -Z.
import { ROTS, SUB, NS, newMask, setBit, getBit } from './core.js';

// ---------- directions
export const BP_DIRS = { Forward: [0, 0, -1], Backward: [0, 0, 1], Left: [-1, 0, 0], Right: [1, 0, 0], Up: [0, 1, 0], Down: [0, -1, 0] };
export const bpDirName = v => Object.keys(BP_DIRS).find(k => BP_DIRS[k].every((x, i) => x === Math.round(v[i]))) || null;
const bpMul = (A, B) => [0, 1, 2].map(r => [0, 1, 2].map(c => A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c]));
const bpApply = (M, v) => [0, 1, 2].map(r => M[r][0] * v[0] + M[r][1] * v[1] + M[r][2] * v[2]);
const bpCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
// tool frame -> SE grid frame
export const TOOL_TO_GRID = [[0, 0, 1], [0, 1, 0], [-1, 0, 0]];
// the rotation (block frame -> another frame) that puts the block's Forward and Up on directions f and u (names)
export function orientMatrix(f, u) {
  const F = BP_DIRS[f], U = BP_DIRS[u];
  if (!F || !U || F.some((x, i) => x * U[i] !== 0) || F.every((x, i) => Math.abs(x) === Math.abs(U[i]))) throw new Error(`bad orientation ${f}/${u}`);
  const R = bpCross(F, U);                       // Right = Forward x Up (SE Base6Directions)
  return [0, 1, 2].map(r => [R[r], U[r], -F[r]]);  // columns: block +X, +Y, +Z
}
// Forward/Up names of a block-to-frame rotation
export const orientOf = M => [bpDirName(bpApply(M, [0, 0, -1])), bpDirName(bpApply(M, [0, 1, 0]))];

// ---------- the orientation map: one place to correct a card
// For each built-in card, how the game block sits in the card's frame: the block's Forward and Up as card directions.
// A card that isn't listed shows its block unturned (Forward, Up). Verified 2026-10-11 against three independent game
// sources (tools/se-grid-builder/README.md, "Blueprint export"): the armour tile table in Sandbox.Game.dll
// (MyCubeGridDefinitions: face normals, full faces, edges), the blocks' mount points (CubeBlocks_Armor*.sbc), and the
// blocks' construction-stage models (*Construction_3.mwm). All 33 armour shapes and 18 panels agree on one turn; the 10
// listed here are owner sketches drawn turned. InvCorner2Base is the least certain (three turns fit the mount points and
// construction models nearly equally; the tile table's cut-face normal picks this one): check it in game first.
// Imported mod blocks carry their own turn (block.orient, set by the importer); it wins over this table.
export const CARD_ORIENT = {
  'vanilla:Corner2Base': ['Right', 'Up'],
  'vanilla:InvCorner2Base': ['Left', 'Down'],
  'vanilla:InvCorner2Tip': ['Right', 'Forward'],
  'vanilla:HalfBox': ['Down', 'Backward'],
  'vanilla:HalfSlopeBox': ['Down', 'Left'],
  'vanilla:HalfSlopeCorner': ['Backward', 'Up'],
  'vanilla:HalfSlopeCornerInverted': ['Up', 'Backward'],
  'vanilla:SlopedCornerTip': ['Right', 'Up'],
  'vanilla:CornerSquareInverted': ['Right', 'Up'],
  'vanilla:SquareSlopedCornerTipInv': ['Backward', 'Up'],
};

// Vanilla armour subtypes per cube topology: [small light, small heavy, large light, large heavy]
// (from Content/Data/CubeBlocks/CubeBlocks_Armor*.sbc, 2026-10-11)
const bpA = (s, sh, l, lh) => [s, sh, l, lh];
export const VANILLA_ARMOR = {
  Box: bpA('SmallBlockArmorBlock', 'SmallHeavyBlockArmorBlock', 'LargeBlockArmorBlock', 'LargeHeavyBlockArmorBlock'),
  Slope: bpA('SmallBlockArmorSlope', 'SmallHeavyBlockArmorSlope', 'LargeBlockArmorSlope', 'LargeHeavyBlockArmorSlope'),
  Corner: bpA('SmallBlockArmorCorner', 'SmallHeavyBlockArmorCorner', 'LargeBlockArmorCorner', 'LargeHeavyBlockArmorCorner'),
  InvCorner: bpA('SmallBlockArmorCornerInv', 'SmallHeavyBlockArmorCornerInv', 'LargeBlockArmorCornerInv', 'LargeHeavyBlockArmorCornerInv'),
  HalfBox: bpA('HalfArmorBlock', 'HeavyHalfArmorBlock', 'LargeHalfArmorBlock', 'LargeHeavyHalfArmorBlock'),
  HalfSlopeBox: bpA('HalfSlopeArmorBlock', 'HeavyHalfSlopeArmorBlock', 'LargeHalfSlopeArmorBlock', 'LargeHeavyHalfSlopeArmorBlock'),
};
for (const t of ['Slope2Base', 'Slope2Tip', 'Corner2Base', 'Corner2Tip', 'InvCorner2Base', 'InvCorner2Tip'])
  VANILLA_ARMOR[t] = bpA(`SmallBlockArmor${t}`, `SmallHeavyBlockArmor${t}`, `LargeBlockArmor${t}`, `LargeHeavyBlockArmor${t}`);
for (const t of ['CornerSquare', 'CornerSquareInverted', 'HalfCorner', 'HalfSlopeCorner', 'HalfSlopeCornerInverted', 'HalfSlopedCorner',
  'HalfSlopedCornerBase', 'HalfSlopeInverted', 'SlopedCorner', 'SlopedCornerBase', 'SlopedCornerTip', 'RaisedSlopedCorner', 'SlopeTransition',
  'SlopeTransitionBase', 'SlopeTransitionBaseMirrored', 'SlopeTransitionMirrored', 'SlopeTransitionTip', 'SlopeTransitionTipMirrored',
  'SquareSlopedCornerBase', 'SquareSlopedCornerTip', 'SquareSlopedCornerTipInv'])
  VANILLA_ARMOR[t] = bpA(`SmallBlockArmor${t}`, `SmallBlockHeavyArmor${t}`, `LargeBlockArmor${t}`, `LargeBlockHeavyArmor${t}`);

// ---------- turns of sample masks (the same permutation as core.js ROT_MAP: mask turned by ROTS[r])
const BP_SAMPLE = []; for (let y = 0; y < SUB; y++) for (let z = 0; z < SUB; z++) for (let x = 0; x < SUB; x++) BP_SAMPLE.push([(x + .5) / SUB, (y + .5) / SUB, (z + .5) / SUB]);
const bpIndex = q => { const c = q.map(v => Math.round((v + .5) * SUB - .5)); return (c[1] * SUB + c[2]) * SUB + c[0]; };
const BP_ROT_MAP = ROTS.map(R => BP_SAMPLE.map(p => bpIndex([0, 1, 2].map(c => R[0][c] * (p[0] - .5) + R[1][c] * (p[1] - .5) + R[2][c] * (p[2] - .5)))));
export function turnMask(m, ri) { const o = newMask(), map = BP_ROT_MAP[ri]; for (let k = 0; k < NS; k++) if (getBit(m, map[k])) setBit(o, k); return o; }
const bpSame = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
// How a block sits on a card whose shape matched it in some turn: the block's Forward/Up in the card's frame, or null.
// cardMask, blockMask: core.js shapeMask(...).mask of the card and of the block's own model (block frame).
export function blockOrientOnCard(cardMask, blockMask) {
  for (let r = 0; r < ROTS.length; r++) if (bpSame(turnMask(cardMask, r), blockMask)) {
    // block = ROTS[r] . card, so a block direction d is ROTS[r]^T d in the card's frame
    const Rt = [0, 1, 2].map(i => [0, 1, 2].map(j => ROTS[r][j][i]));
    return orientOf(Rt);
  }
  return null;
}

// ---------- which game block a card becomes
// size: 'Large' | 'Small'; armour: 'light' | 'heavy'. Returns { typeId, subtype, orient: [F, U], sure } or null when the
// card has no block of that grid size. sure = false: an imported block whose turn on the card was never recorded.
export function pickBlock(shape, size, armour = 'light') {
  const heavy = armour === 'heavy', cardOrient = CARD_ORIENT[shape.id] || ['Forward', 'Up'];
  const va = shape.topology && VANILLA_ARMOR[shape.topology];
  if (va) return { typeId: 'CubeBlock', subtype: va[(size === 'Large' ? 2 : 0) + (heavy ? 1 : 0)], orient: cardOrient, sure: true };
  const list = (shape.blocks || []).filter(b => b.size === size && b.subtype);
  if (!list.length) return null;
  const isHeavy = b => /heavy/i.test(b.subtype + ' ' + (b.name || ''));
  const rank = b => (isHeavy(b) === heavy ? 0 : 2) + (b.mod === 'Vanilla' ? 0 : 1);
  const b = [...list].sort((p, q) => rank(p) - rank(q))[0];
  const defining = shape.id === 'mesh:' + b.mod + ':' + b.subtype;   // the block the card's shape was read from
  const orient = b.orient || cardOrient;
  return { typeId: b.typeId || 'CubeBlock', subtype: b.subtype, orient, sure: !!(b.orient || !shape.id.startsWith('mesh:') || defining) };
}

// a template's block orientation in the SE grid: rot = the tool's turn of the card (ROTS index), orient = pickBlock's
export function gridOrientation(rot, orient) {
  const M = bpMul(TOOL_TO_GRID, bpMul(ROTS[rot], orientMatrix(orient[0], orient[1])));
  const [forward, up] = orientOf(M);
  return { forward, up };
}
// tool cell -> SE grid cell. centre 'col': the middle column is X = 0; 'line': the centreline lies between X = -1 and 0
export function gridPos(x, y, z, nz, centre) { return [z - (centre === 'line' ? nz / 2 : (nz - 1) / 2), y, -x]; }
// the symmetry plane on the hull centreline (ENGINE_CONSTRAINT, MyCubeBuilderGizmo.MirrorBlockByPlane: X mirror maps
// x -> 2P - x, minus 1 more with Odd, so Odd puts the plane between P - 1 and P)
export const mirrorPlane = centre => ({ plane: [0, 0, 0], odd: centre === 'line' });

// ---------- colour: an RGB colour as the game's ColorMaskHSV (VRage ColorExtensions.ColorToHSV, then
// MyColorPickerConstants.HSVToHSVOffset: saturation - 0.8, value - 0.55 + 0.1)
export function colorMaskHSV(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  let h = 0;                                      // System.Drawing.Color.GetHue (0 for greys)
  if (mx !== mn) { const d = mx - mn; h = mx === r ? (g - b) / d : mx === g ? 2 + (b - r) / d : 4 + (r - g) / d; h *= 60; if (h < 0) h += 360; }
  const s = mx === 0 ? 0 : 1 - mn / mx, v = mx / 255;
  return [h / 360, s - 0.8, v - 0.55 + 0.1];
}

// ---------- blocks of a fitted grid
// grid: { nx, ny, nz, centre }; cellAt(x, y, z) -> { shape: library entry, rot } | null (empty / no block)
// o: { size, armour, color(shape) -> '#rrggbb' | null }
// Returns { blocks, skipped: { reason: count }, unsure, mirror }
export function gridBlocks(grid, cellAt, o) {
  const blocks = [], skipped = {}, skip = r => { skipped[r] = (skipped[r] || 0) + 1; };
  let unsure = 0;
  for (let y = 0; y < grid.ny; y++) for (let z = 0; z < grid.nz; z++) for (let x = 0; x < grid.nx; x++) {
    const c = cellAt(x, y, z); if (!c) continue;
    const pb = pickBlock(c.shape, o.size, o.armour);
    if (!pb) { skip(`${c.shape.name} (no ${o.size.toLowerCase()} grid block)`); continue; }
    if (!pb.sure) unsure++;
    const col = o.color ? o.color(c.shape) : null;
    blocks.push({ typeId: pb.typeId, subtype: pb.subtype, min: gridPos(x, y, z, grid.nz, grid.centre), ...gridOrientation(c.rot, pb.orient),
      color: col ? colorMaskHSV(col) : null, card: c.shape.id });
  }
  return { blocks, skipped, unsure, mirror: mirrorPlane(grid.centre) };
}

// ---------- bp.sbc
export const xmlEsc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const bpNum = v => { const s = (Math.round(v * 1e6) / 1e6).toString(); return s === '-0' ? '0' : s; };
// a random positive 63-bit entity id as a decimal string (the game re-maps ids when pasting)
const bpEntityId = () => { let s = String(1 + Math.floor(Math.random() * 8)); for (let i = 0; i < 17; i++) s += Math.floor(Math.random() * 10); return s; };
// o: { name, gridSize: 'Large'|'Small', blocks (gridBlocks), mirror?, isStatic?, author? }
export function blueprintXml(o) {
  const L = [];
  L.push('<?xml version="1.0"?>',
    '<Definitions xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">',
    '  <ShipBlueprints>',
    '    <ShipBlueprint xsi:type="MyObjectBuilder_ShipBlueprintDefinition">',
    `      <Id Type="MyObjectBuilder_ShipBlueprintDefinition" Subtype="${xmlEsc(o.name)}" />`,
    `      <DisplayName>${xmlEsc(o.author || 'SE Grid Builder')}</DisplayName>`,
    '      <CubeGrids>',
    '        <CubeGrid>',
    '          <SubtypeName />',
    `          <EntityId>${o.entityId || bpEntityId()}</EntityId>`,
    '          <PersistentFlags>CastShadows InScene</PersistentFlags>',
    '          <PositionAndOrientation>',
    '            <Position x="0" y="0" z="0" />',
    '            <Forward x="0" y="0" z="-1" />',
    '            <Up x="0" y="1" z="0" />',
    '            <Orientation>',
    '              <X>0</X>',
    '              <Y>0</Y>',
    '              <Z>0</Z>',
    '              <W>1</W>',
    '            </Orientation>',
    '          </PositionAndOrientation>',
    `          <GridSizeEnum>${o.gridSize === 'Large' ? 'Large' : 'Small'}</GridSizeEnum>`,
    '          <CubeBlocks>');
  for (const b of o.blocks) {
    L.push(`            <MyObjectBuilder_CubeBlock xsi:type="MyObjectBuilder_${xmlEsc(b.typeId || 'CubeBlock')}">`,
      `              <SubtypeName>${xmlEsc(b.subtype)}</SubtypeName>`,
      `              <Min x="${b.min[0]}" y="${b.min[1]}" z="${b.min[2]}" />`);
    if (b.forward !== 'Forward' || b.up !== 'Up') L.push(`              <BlockOrientation Forward="${b.forward}" Up="${b.up}" />`);
    if (b.color) L.push(`              <ColorMaskHSV x="${bpNum(b.color[0])}" y="${bpNum(b.color[1])}" z="${bpNum(b.color[2])}" />`);
    L.push('            </MyObjectBuilder_CubeBlock>');
  }
  L.push('          </CubeBlocks>', `          <IsStatic>${o.isStatic ? 'true' : 'false'}</IsStatic>`);
  if (o.mirror) {
    const p = o.mirror.plane;
    L.push(`          <XMirroxPlane x="${p[0]}" y="${p[1]}" z="${p[2]}" />`);
    if (o.mirror.odd) L.push('          <XMirroxOdd>true</XMirroxOdd>');
  }
  L.push(`          <DisplayName>${xmlEsc(o.name)}</DisplayName>`,
    '          <DestructibleBlocks>true</DestructibleBlocks>',
    '          <IsRespawnGrid>false</IsRespawnGrid>',
    '          <TargetingTargets />',
    '        </CubeGrid>',
    '      </CubeGrids>',
    '      <EnvironmentType>None</EnvironmentType>',
    '      <WorkshopId>0</WorkshopId>',
    '      <OwnerSteamId>0</OwnerSteamId>',
    '      <Points>0</Points>',
    '    </ShipBlueprint>',
    '  </ShipBlueprints>',
    '</Definitions>');
  return L.join('\r\n') + '\r\n';
}
// a blueprint folder name Windows accepts
export function blueprintFolderName(name) {
  let s = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += '_';
  return s.slice(0, 120) || 'Grid';
}

// ---------- test blueprint: every card in all 24 turns, one row per card
// shapes: the library; o: { size, armour, onlyUsed }. Rows run along the tool's z (the grid's X), turns along the tool's
// x (towards the grid's Forward), one empty cell between blocks. Each row starts with a marker behind its first
// block (the grid's Backward side): 1 cube, 2 stacked on every 5th row, 3 on every 10th, so rows can be counted.
export function testLayout(shapes, o) {
  const cells = [], rows = [], marker = shapes.find(s => s.topology === 'Box');
  shapes.forEach((s, si) => {
    if (o.onlyUsed && !s.use) return;
    const pb = pickBlock(s, o.size, o.armour); if (!pb || !s.solids || !s.solids.length) return;
    const r = rows.length, z = 2 * r;
    rows.push({ row: r + 1, key: s.key, name: s.name, id: s.id, subtype: pb.subtype, sure: pb.sure,
      orient: CARD_ORIENT[s.id] || (pb.orient[0] !== 'Forward' || pb.orient[1] !== 'Up' ? pb.orient : null) });
    for (let ri = 0; ri < ROTS.length; ri++) cells.push({ x: 2 * ri, y: 0, z, shape: s, si, rot: ri });
    if (marker) { const h = 1 + ((r + 1) % 5 === 0) + ((r + 1) % 10 === 0); for (let k = 0; k < h; k++) cells.push({ x: -2, y: k, z, shape: marker, si: shapes.indexOf(marker), rot: 0, marker: true }); }
  });
  return { cells, rows };
}
// the test layout's blocks and a text legend
export function testBlueprint(shapes, o) {
  const { cells, rows } = testLayout(shapes, o), blocks = [];
  for (const c of cells) {
    const pb = pickBlock(c.shape, o.size, o.armour);
    blocks.push({ typeId: pb.typeId, subtype: pb.subtype, min: gridPos(c.x, c.y, c.z, 1, 'col'), ...gridOrientation(c.rot, pb.orient),
      color: o.color ? colorMaskHSV(c.marker ? '#d04040' : (rows.length && (c.z / 2) % 2 ? '#7090c0' : '#c0c0c0')) : null });
  }
  const turns = ROTS.map((R, ri) => { const t = orientOf(R); return `${String(ri + 1).padStart(2)}: card Forward -> ${t[0]}, card Up -> ${t[1]}`; });
  const legend = [`SE Grid Builder test blueprint: ${rows.length} cards x 24 turns, ${o.size} grid, ${o.armour} armour.`,
    '',
    'Layout (seen from above, the grid\'s Forward pointing away from you):',
    '- one row per card, rows side by side from left (row 1) to right; one empty cell between blocks;',
    '- red marker cubes at the back end of each row: 1 cube, 2 on every 5th row, 3 on every 10th;',
    '- along each row, going forward, the card in the tool\'s 24 turns (below). Turn 1 is the card unturned.',
    '',
    'Check: each block should look exactly like the tool draws that card in that turn (layout.png, same view).',
    'Turn 1: the card as its Cube Library thumbnail shows it, with the thumbnail\'s orange arrow pointing to the',
    'grid\'s Left (the tool\'s card -z is the grid\'s -X, the card\'s +x is the grid\'s Forward).',
    '',
    'Rows:', ...rows.map(r => `${String(r.row).padStart(3)}  ${r.key.padEnd(5)} ${r.name}  [${r.subtype}]` +
      (r.orient ? `  card orientation: block Forward = card ${r.orient[0]}, Up = card ${r.orient[1]}` : '') + (r.sure ? '' : '  (turn on the card not recorded: re-import)')),
    '', 'Turns (the tool\'s rotation of the card, in the tool frame: x front, y up, z side):', ...turns];
  return { blocks, rows, legend: legend.join('\r\n') + '\r\n', cells };
}

// ---------- zip (stored, no compression) for the download fallback
const BP_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(u8) { let c = 0xffffffff; for (let i = 0; i < u8.length; i++) c = BP_CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
// files: [{ name: 'folder/bp.sbc', data: Uint8Array | string }] -> Uint8Array
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  const now = new Date(), dtime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1),
    ddate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, dtime, true); h.setUint16(12, ddate, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true); h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, dtime, true); c.setUint16(14, ddate, true); c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + data.length;
  }
  const csize = central.reduce((n, p) => n + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  const all = [...parts, ...central, new Uint8Array(e.buffer)], out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let p = 0; for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

/* Licence notice for the parts adapted from se-blueprinter (https://github.com/imivi/se-blueprinter) and StlToBlueprint
   (https://github.com/austinvaness/StlToBlueprint): the blueprint XML layout and the zip-of-a-blueprint-folder idea
   (se-blueprinter), and writing into Blueprints\local with removal of the bp.sbcB5 cache (StlToBlueprint). Both are:

   MIT License. Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
   associated documentation files (the "Software"), to deal in the Software without restriction, including without
   limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
   Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
   The above copyright notice and this permission notice shall be included in all copies or substantial portions of
   the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
   LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
   SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
   CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
   THE SOFTWARE.
   Copyright (c) 2024 imivi (se-blueprinter); Copyright (c) 2020 Austin Van Ess (StlToBlueprint). */
