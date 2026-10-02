# Design note: multi-cell blocks (wings) in SE Grid Builder

Status: proposal, 2026-10-01. Nothing built yet; owner to pick the options marked **Q**.

## What there is to support

The importer skips structural blocks bigger than one cell (`importer.js`, `multiCell`). In the WitM publish world, the
ones matching the armour/panel/wing filter are:

| Size (cells, sorted) | Blocks | of which wings |
|---|---|---|
| 1x1x2 / 1x1x3 / 1x1x4 / 1x1x5 / 1x1x6 | 48 / 45 / 32 / 42 / 8 | 6 / 5 / - / 10 / - |
| 1x2x2 / 1x2x3 / 1x2x5 | 4 / 20 / 12 | 4 / 6 / 12 |
| 1x3x3 / 1x3x5 / 1x4x5 / 1x5x5 | 5 / 12 / 12 / 6 | 5 / 12 / 12 / 6 |

By mod: CAP 81, AQD 76, Terran Titans Naval Blocks 40, SETB 18, Plane Parts 12, Thin Wings 10, VAP 7, IAP 2.

**Every one of them is a single cell thick.** That's what makes this tractable: a multi-cell block is a flat slab
lying on a plane of cells, never a 3D volume.

## Proposed approach

1. **Import:** keep each multi-cell block as one card with `size: [1, a, b]`. Read its model as now, but voxelise it
   cell by cell, so the card holds one 6x6x6 mask per cell it covers (plus the whole mesh for display). Thin ones are
   plates, as single-cell panels already are.
2. **Templates:** a multi-cell template is the per-cell masks laid out on an a x b patch, in each of the 24 turns that
   keep it one cell thick (8 distinct per flat block, plus mirror variants where the shape isn't symmetric).
3. **Fit as a second pass**, after the per-cell fit:
   - find flat patches: neighbouring cells in one layer of one axis whose model material is a thin skin (the cells
     where panels win today);
   - for each patch, try placing each enabled multi-cell template at each offset and turn that lies inside it; score
     it as the sum of the per-cell surface scores (the same scoring as now) minus a small per-block penalty;
   - place greedily, best first, never overlapping. Covered cells point at the placement (one shape, many cells).
     Cells it doesn't improve keep their single-cell pick.
4. **Display and editing:** draw a placement once over its whole footprint. Selecting any cell of a placement
   selects the whole block. "No block" removes it and the cells refit as single cells. The best-matches list shows
   the multi-cell candidates covering that cell, too.
5. **Cost:** at most a few hundred thin cells per model times about 300 placements each. That's comparable to the
   current fit, fine.

## Questions for the owner

- **Q1. Which multi-cell blocks to start with?** Recommendation: wings only (CAP, Thin Wings, Plane Parts; about 80
  blocks). Long slabs like 1x1x5 strips and AQD slopes could follow once wings work.
- **Q2. Prefer one big block over several small ones?** In game, a 1x3x5 wing is lighter and cleaner than fifteen
  panels. Recommendation: a modest bonus for covering more cells with one block, tuned on a plane model you mark up
  (your edit sets work as the target, as for the Panhard).
- **Q3. A test model:** a plane you plan to build (the D.520?) as OBJ/STL, so there's real wing geometry to tune
  against.
