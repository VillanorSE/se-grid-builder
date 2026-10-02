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

## Development

| File | Holds |
|---|---|
| `app.html` | The page (UI, three.js rendering) |
| `core.js` | Shapes, masks, rotations, sketch-to-solid, OBJ/STL, voxelising, fitting, `.sbc` parsing (no DOM) |
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

Code: MIT (see `LICENSE`). three.js is loaded from jsDelivr (MIT).

The block shapes in `armor_data.js` were drawn and confirmed by hand. `panel_data.js` holds simplified outline
geometry read from Space Engineers' armour panel models. Space Engineers and its assets belong to Keen Software House;
this is a fan-made tool, not affiliated with or endorsed by Keen.
