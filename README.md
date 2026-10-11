# SE Grid Builder

Turn a 3D model (OBJ or STL) into a Space Engineers block layout: the model is cut into grid cells and each cell gets
the armour block, slope or panel that best matches the model's shape there.

**Open it:** https://villanorse.github.io/se-grid-builder/ (Chrome or Edge recommended; it runs entirely in your
browser, nothing is uploaded).

Made for the *WW2: War in the Mediterranean* scenario mods, usable for any build.

## What it does

- **Grid Builder:** load an `.obj` or `.stl`, give its real length, and pick the build scale and grid size (small 0.5 m
  or large 2.5 m). The model is fitted block by block:
  - a block is considered only when the model fills enough of the block's own volume;
  - the winner is the block whose faces best match the model's surface, preferring simple blocks
    (Simplify setting);
  - hidden part groups (e.g. wheels you'll build from suspension) keep their space clear;
  - a layer map shows the result layer by layer, and clicking a cell lists its best matches to pick from.
- **Cube Library:** every block shape the builder can use:
  - starts with the 33 vanilla light armour shapes and the 18 vanilla armour panels;
  - **Import from world** reads a world's mod list and brings in the one-cell armour, panel and plate blocks from its
    mods, reading their shapes from the game models and grouping identical shapes;
  - switch blocks on or off for the builder, and export/import the library as JSON.
- **Sketch:** draw a block's edges on a cube to add or correct a shape; concave shapes work.
- **Sessions:** **Save session** writes the model, settings, cell edits and library to one file; **Open session** on
  any browser brings it back. That's how to share a grid with someone.

Everything is stored in your browser (IndexedDB). Clearing site data clears it; export the library or save a session
to keep it.

### Importing blocks from a world

Click **Import from world...** in the Cube Library and pick:

1. the world's save folder (the one holding `Sandbox.sbc`);
2. the Workshop folder `...\steamapps\workshop\content\244850`;
3. optionally, the game's `Content` folder (vanilla blocks and real block names) and `%APPDATA%\SpaceEngineers\Mods`
   (local mods).

Chrome and Edge open folders directly and remember them. **Firefox** can't open folders, so run the same import from
a command line instead, then use **Import JSON** in the Cube Library:

    node import_world.mjs "%APPDATA%\SpaceEngineers\Saves\<id>\<world>"

Imported mod blocks start switched off: turn on the ones you build with. Blocks larger than one cell (most wings) are
counted but not imported yet (see `design/multicell-blocks.md`).

## Blueprint export

Grid Builder > Blueprint. One `CubeGrid` of the block size above (0.5 m = small grid, 2.5 m = large), every cell that
has a block (fitted or edited; empty and "no block" cells left out):

- **Blocks:** vanilla armour cards use the game's subtype for the grid size and the Armour choice (light by default,
  heavy); panels and imported blocks use their own TypeId/SubtypeId of that grid size (heavy variant when there is one).
  Cards without a block of that grid size (own sketches, mod blocks of the other size) are left out and listed.
- **Placement:** the model's front becomes the grid's Forward (-Z), up stays up, the model's +z side becomes the grid's
  Right (+X). `Min` is the cell; `BlockOrientation` comes from the card's turn in the cell and the card's base
  orientation (below).
- **Symmetry:** `XMirroxPlane`/`XMirroxOdd` on the hull centreline, so the in-game X symmetry mode lines up: centre on a
  block column = plane through the middle column (X = 0); on a grid line = `XMirroxOdd` (plane between X = -1 and 0).
  ENGINE_CONSTRAINT from the game's code (MyCubeBuilderGizmo.MirrorBlockByPlane: Odd mirrors x to 2P - x - 1).
- **Colour** (optional): one colour, or per block kind as drawn (armour blue, panels tan, mod blocks green), written as
  `ColorMaskHSV` with the game's conversion (VRage ColorToHSV, then saturation - 0.8, value - 0.45).
- **Name:** the model's name unless one is typed; it is the folder name and the grid's name.
- **Delivery:** Chrome/Edge write `bp.sbc` and `thumb.png` (the blocks seen from the 3D view's direction) straight into
  `%APPDATA%\SpaceEngineers\Blueprints\local\<name>\` (pick that folder once; it is remembered like the import
  folders; "folder..." picks it again). Replacing asks first and deletes the game's cache `bp.sbcB5`. **Download zip**
  (any browser) gives `<name>.zip` to unzip into `Blueprints\local`. In game: F10, select it, paste.

**Orientation map** (`blueprint.js`, `CARD_ORIENT`): for each card, how the game block sits in the card's frame (its
Forward and Up as card directions). Correct a wrong card there, in one line. Imported blocks carry their own turn
(`orient`, recorded by the importer). Verified 2026-10-11 for the 51 starting cards against three independent game
sources (`test_blueprint.mjs` repeats the check when the game is installed):

1. the armour tile table in `Sandbox.Game.dll` (`MyCubeGridDefinitions`: face normals, full faces, edges);
2. the blocks' mount points (`CubeBlocks_Armor*.sbc`, converted with the game's own mount-point transforms);
3. the blocks' construction-stage models (`*Construction_3.mwm`, all four light/heavy and size variants).

23 armour cards and all 18 panel cards (all 72 panel models) sit unturned; 10 armour cards are owner sketches drawn
turned (Corner 2x1 Base, Inv. Corner 2x1 Base and Tip, Half Block, Half Slope, Half Slope Corner and its Inverted,
Sloped Corner Tip, Corner Square Inverted, Square Sloped Corner Tip Inv.), and the map turns them back. Inv. Corner 2x1
Base is the least certain (three turns fit the mount points and models nearly equally; the tile table's cut face picks
one). The in-game check is the **test blueprint**: one row per card (only blocks used in builder by default), the card
in all 24 turns, one empty cell apart, red marker cubes at the back of each row (2 on every 5th row, 3 on every 10th).
Its folder also holds `layout.png` (the same layout drawn by the tool, row and turn numbers on it) and `layout.txt`
(the legend). Each block in game should look like the tool's drawing.

The blueprint XML follows the game's own files (element names and order checked against the owner's local blueprints
by `test_blueprint.mjs`) and two MIT-licensed tools, se-blueprinter (imivi) and StlToBlueprint (Austin Van Ess);
their licence notice is in `blueprint.js`.


## Development

| File | Holds |
|---|---|
| `app.html` | The page (UI, three.js rendering) |
| `core.js` | Shapes, masks, rotations, sketch-to-solid, OBJ/STL, voxelising, fitting, `.sbc` parsing (no DOM) |
| `fit_worker.js` | The fit running in Web Workers (inlined with `core.js` by `build.py` and started from a Blob URL) |
| `mwm.js` | Reads triangles from Space Engineers `.mwm` models (classic tagged layout) |
| `importer.js` | World import (mods -> block definitions -> shapes) over a small folder interface |
| `seed.js`, `armor_data.js`, `panel_data.js` | The starting library |
| `build.py` | Bundles everything into `docs/index.html` (the published page) |
| `test_core.mjs`, `bench_fit.mjs` | Node tests and the fit benchmark (models built from known blocks) |
| `import_world.mjs` | The world import from a command line |
| `tools/extract_panels.mjs` | Regenerates `panel_data.js` from an installed game |

After editing: `python build.py`, then `node test_core.mjs`. Optional real-model checks:
`SGB_TEST_OBJ=<model.obj> node test_core.mjs`, and a world import test with `node test_core.mjs "<world folder>"`.

## Credits and licence

Blueprint export borrows ideas and small pieces from se-blueprinter (MIT, (c) 2024 imivi) and StlToBlueprint
(MIT, (c) 2020 Austin Van Ess); their licence notices are in `blueprint.js`.


Code: MIT (see `LICENSE`). three.js is loaded from jsDelivr (MIT).

The block shapes in `armor_data.js` were drawn and confirmed by hand. `panel_data.js` holds simplified outline
geometry read from Space Engineers' armour panel models. Space Engineers and its assets belong to Keen Software House;
this is a fan-made tool, not affiliated with or endorsed by Keen.
