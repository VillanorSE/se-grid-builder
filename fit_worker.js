// SE Grid Builder fit worker: runs computeGrid off the page's main thread so the page stays responsive.
// build.py bundles core.js and this file into a script block of the page, which starts it from a Blob URL (a page
// opened from disk can't load a worker file next to it). The page (app.html, Fit) sends:
//   { lib: { ver, shapes } }      the library (shapes not in use as { use: false } stubs, so indices match the page's)
//   { parts: { ver, parts } }     the prepared model
//   { type: 'fit', job, opts, tag, share: { k, n } | null, scores }
// share: score only cells ci % n === k and send the surface scores back (several workers split one fit);
// no share: the full fit, using the scores sent in `scores` and computing any missing ones.
// Replies: { type: 'progress', job, done, scores } while fitting, { type: 'done', job, grid, scores, tplCount },
// { type: 'error', job, message }.
import { buildTemplates, computeGrid, newSurfCache, takeSurfScores, addSurfScores } from './core.js';

let LIB = null, T = null, PARTS = null;
const cache = newSurfCache();
const buffers = s => [s.keys.buffer, s.m2b.buffer, s.b2m.buffer];

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.lib) { LIB = m.lib.shapes; T = buildTemplates(LIB); }
    if (m.parts) PARTS = m.parts.parts;
    if (m.type !== 'fit') return;
    if (m.scores) addSurfScores(cache, m.scores);
    let last = Date.now();
    const share = m.share;
    const o = { ...m.opts, groupsOn: new Set(m.opts.groupsOn), shapes: LIB, T, surfCache: cache, surfTag: m.tag,
      onlyCell: share ? ci => ci % share.n === share.k : null,
      progress: f => { const t = Date.now(); if (t - last < 150) return; last = t;
        const s = takeSurfScores(cache); self.postMessage({ type: 'progress', job: m.job, done: f, scores: s }, buffers(s)); } };
    const g = computeGrid(PARTS, o);
    const s = takeSurfScores(cache);
    if (share || !g) { self.postMessage({ type: 'done', job: m.job, grid: null, scores: s, tplCount: T.list.length }, buffers(s)); return; }
    const grid = { nx: g.nx, ny: g.ny, nz: g.nz, b: g.b, ox: g.ox, oy: g.oy, oz: g.oz, cell: g.cell, fit: g.fit, fill: g.fill, mat: g.mat,
      alt: g.alt, altScore: g.altScore, ALT: g.ALT, hiddenShare: g.hiddenShare };
    // mat is copied, not moved: it belongs to the kept surface scores (refits of the same grid reuse it)
    self.postMessage({ type: 'done', job: m.job, grid, scores: s, tplCount: T.list.length },
      [g.cell.buffer, g.fit.buffer, g.fill.buffer, g.alt.buffer, g.altScore.buffer, ...buffers(s)]);
  } catch (err) {
    self.postMessage({ type: 'error', job: m.job, message: (err && err.message || String(err)) + (err && err.stack ? '\n' + err.stack : '') });
  }
};
