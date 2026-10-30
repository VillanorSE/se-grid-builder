// SE Grid Builder core: library shapes, sketch-to-solid, block import (SBC + MWM), model loading (OBJ/STL),
// voxelising and block fitting. No three.js and no DOM, so it runs in Node too (test_core.mjs).
// A block cell is the unit cube 0..1 in "cell space"; y is up, Forward is -z (as in the game).

export const SUB = 6;                       // samples per cell edge when comparing shapes
export const NS = SUB ** 3;                 // samples per cell
const W = Math.ceil(NS / 32);               // 32-bit words per sample mask

// ---------- vectors
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const near = (a, b, e = 1e-6) => Math.abs(a[0] - b[0]) < e && Math.abs(a[1] - b[1]) < e && Math.abs(a[2] - b[2]) < e;

// ---------- the 24 proper rotations of a cube (signed permutation matrices, det +1)
export const ROTS = (() => {
  const out = [], perms = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];
  for (const pm of perms) for (let sg = 0; sg < 8; sg++) {
    const M = [[0,0,0],[0,0,0],[0,0,0]];
    for (let r = 0; r < 3; r++) M[r][pm[r]] = (sg >> r) & 1 ? -1 : 1;
    const det = M[0][0]*(M[1][1]*M[2][2]-M[1][2]*M[2][1]) - M[0][1]*(M[1][0]*M[2][2]-M[1][2]*M[2][0]) + M[0][2]*(M[1][0]*M[2][1]-M[1][1]*M[2][0]);
    if (det === 1) out.push(M);
  }
  return out;
})();
export const rotP = (R, p) => [0, 1, 2].map(r => R[r][0] * p[0] + R[r][1] * p[1] + R[r][2] * p[2]);

// sample k <-> point in the cell; sample index (y*SUB + z)*SUB + x
const SAMPLE = []; for (let y = 0; y < SUB; y++) for (let z = 0; z < SUB; z++) for (let x = 0; x < SUB; x++) SAMPLE.push([(x + .5) / SUB, (y + .5) / SUB, (z + .5) / SUB]);
const sIndex = q => { const c = q.map(v => Math.round((v + .5) * SUB - .5)); return (c[1] * SUB + c[2]) * SUB + c[0]; };
// ROT_MAP[r][k] = the sample of the unrotated shape that lands on sample k after rotation r (R^T p)
const ROT_MAP = ROTS.map(R => SAMPLE.map(p => sIndex([0, 1, 2].map(c => R[0][c] * (p[0] - .5) + R[1][c] * (p[1] - .5) + R[2][c] * (p[2] - .5)))));
// 90-degree turns about X, Y, Z as sample permutations (for the cell editor)
const TURN_MAP = [0, 1, 2].map(axis => SAMPLE.map(p => { const q = [p[0] - .5, p[1] - .5, p[2] - .5];
  const r = axis === 1 ? [-q[2], q[1], q[0]] : axis === 0 ? [q[0], q[2], -q[1]] : [q[1], -q[0], q[2]]; return sIndex(r); }));
// the same turns (and the centreline mirror) of a direction: where a shape's point at v goes
export const turnVec = (axis, v) => axis === 1 ? [v[2], v[1], -v[0]] : axis === 0 ? [v[0], -v[2], v[1]] : [-v[1], v[0], v[2]];
const mirrorVec = v => [v[0], v[1], -v[2]];

// ---------- bit masks over the NS samples
export const newMask = () => new Uint32Array(W);
export const setBit = (m, k) => { m[k >> 5] |= 1 << (k & 31); };
export const getBit = (m, k) => (m[k >> 5] >>> (k & 31)) & 1;
const pop = v => { v -= (v >>> 1) & 0x55555555; v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24; };
export const maskCount = m => { let n = 0; for (let i = 0; i < W; i++) n += pop(m[i]); return n; };
const maskSig = m => Array.from(m, v => (v >>> 0).toString(36)).join('.');
const permute = (m, map) => { const o = newMask(); for (let k = 0; k < NS; k++) if (getBit(m, map[k])) setBit(o, k); return o; };

// ---------- solids (cell space). A shape's solids are { type:'planes', planes:[[nx,ny,nz,d]...], verts:[[x,y,z]...] }
// (convex, inside where n.p <= d) or { type:'tris', tris:[x,y,z, ...] } (a closed or nearly closed triangle surface;
// inside by ray-parity votes, 4 of 6 axis directions). A point is in the shape when it is in any of its solids.
function trisInside(tris, p) {
  let votes = 0;
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3, pu = p[u] + 1.37e-7, pv = p[v] + 2.11e-7;
    let below = 0, above = 0;
    for (let t = 0; t < tris.length; t += 9) {
      const Au = tris[t + u], Av = tris[t + v], Bu = tris[t + 3 + u], Bv = tris[t + 3 + v], Cu = tris[t + 6 + u], Cv = tris[t + 6 + v];
      const d = (Bu - Au) * (Cv - Av) - (Cu - Au) * (Bv - Av);
      if (Math.abs(d) < 1e-14) continue;
      const l1 = ((Bu - pu) * (Cv - pv) - (Cu - pu) * (Bv - pv)) / d;
      if (l1 < 0) continue;
      const l2 = ((Cu - pu) * (Av - pv) - (Au - pu) * (Cv - pv)) / d;
      if (l2 < 0 || l1 + l2 > 1) continue;
      const h = l1 * tris[t + a] + l2 * tris[t + 3 + a] + (1 - l1 - l2) * tris[t + 6 + a];
      if (Math.abs(h - p[a]) < 1e-5) return true;   // on the surface counts as inside (as for plane solids)
      if (h < p[a]) below++; else above++;
    }
    votes += (below & 1) + (above & 1);
  }
  return votes >= 4;
}
export function solidInside(s, p) {
  if (s.type === 'planes') return s.planes.every(q => q[0] * p[0] + q[1] * p[1] + q[2] * p[2] <= q[3] + 1e-7);
  return trisInside(s.tris, p);
}
export const shapeInside = (shape, p) => shape.solids.some(s => solidInside(s, p));

// samples a triangle surface passes through (for thin shapes such as armour panels)
function trisSurfaceMask(tris) {
  const m = newMask(), step = 0.5 / SUB;
  for (let t = 0; t < tris.length; t += 9) {
    const A = [tris[t], tris[t + 1], tris[t + 2]], B = [tris[t + 3], tris[t + 4], tris[t + 5]], C = [tris[t + 6], tris[t + 7], tris[t + 8]];
    const n = Math.max(1, Math.ceil(Math.max(len(sub(A, B)), len(sub(B, C)), len(sub(C, A))) / step));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      const c = [0, 1, 2].map(k => Math.min(SUB - 1, Math.floor((A[k] * w + B[k] * u + C[k] * v) * SUB)));
      if (c.some(q => q < 0)) continue;
      setBit(m, (c[1] * SUB + c[2]) * SUB + c[0]);
    }
  }
  return m;
}

// The shape's sample mask in its own orientation. Thin triangle shapes (little inside, mostly surface) are plates and
// use the samples their surface passes through.
export function shapeMask(shape) {
  const m = newMask();
  SAMPLE.forEach((p, k) => { if (shapeInside(shape, p)) setBit(m, k); });
  const ni = maskCount(m), tris = shape.solids.filter(s => s.type === 'tris');
  if (tris.length) {
    const all = new Float32Array(tris.reduce((n, s) => n + s.tris.length, 0)); let o = 0;
    tris.forEach(s => { all.set(s.tris, o); o += s.tris.length; });
    const sm = trisSurfaceMask(all);
    if (shape.plate || ni < maskCount(sm) * 0.25) return { mask: sm, plate: true };
  }
  return { mask: m, plate: !!shape.plate };
}

// A shape's exact volume (cells^3), finer than its sample mask: triangle solids by the divergence theorem (either
// winding; the whole model, also where it reaches past the cell), convex plane solids from the hull of their corners.
// Tells apart shapes the 6-sample mask can't, such as the pieces of a 1x7 and a 1x8 slope (the importer's grouping).
export function exactVolume(shape) {
  let v = 0;
  for (const s of shape.solids || []) {
    if (s.type === 'tris') {
      const t = s.tris; let w = 0;
      for (let i = 0; i < t.length; i += 9)
        w += t[i] * (t[i + 4] * t[i + 8] - t[i + 5] * t[i + 7]) - t[i + 1] * (t[i + 3] * t[i + 8] - t[i + 5] * t[i + 6]) + t[i + 2] * (t[i + 3] * t[i + 7] - t[i + 4] * t[i + 6]);
      v += Math.abs(w) / 6;
    } else if (s.type === 'planes') {
      const H = hullFaces(s); if (!H) continue;
      for (const { F, f } of H.faces) for (let i = 0; i < F.length; i++)   // each hull face: a fan of tetrahedra from the centre
        v += Math.abs(dot(sub(F[i], H.c), cross(sub(F[(i + 1) % F.length], H.c), sub(f, H.c)))) / 6;
    }
  }
  return v;
}
// a convex plane solid's hull faces from its corners: { c: corner average, faces: [{ F: corners in order, f: face centre }] }
function hullFaces(s) {
  if (!s.verts || s.verts.length < 4) return null;
  const V = []; s.verts.forEach(p => { const q = p.map(x => Math.round(x * 1e6) / 1e6 + 0); if (!V.some(r => near(r, q))) V.push(q); });
  const c = [0, 1, 2].map(k => V.reduce((a, p) => a + p[k], 0) / V.length), faces = [];
  for (const q of hullPlanes(V)) {
    const F = V.filter(p => Math.abs(q[0] * p[0] + q[1] * p[1] + q[2] * p[2] - q[3]) < 1e-6); if (F.length < 3) continue;
    const f = [0, 1, 2].map(k => F.reduce((a, p) => a + p[k], 0) / F.length), e1 = sub(F[0], f), e2 = cross(q, e1);
    F.sort((a, b) => Math.atan2(dot(sub(a, f), e2), dot(sub(a, f), e1)) - Math.atan2(dot(sub(b, f), e2), dot(sub(b, f), e1)));
    faces.push({ F, f });
  }
  return { c, faces };
}

// convex hull of a point set as half-spaces (brute force; fine for a handful of points)
export function hullPlanes(points) {
  const P = points, planes = [];
  for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) for (let c = b + 1; c < P.length; c++) {
    let n = cross(sub(P[b], P[a]), sub(P[c], P[a])); const L = len(n);
    if (L < 1e-9) continue;
    n = n.map(x => x / L); let d = dot(n, P[a]);
    const s = P.map(p => dot(n, p) - d);
    if (s.every(x => x <= 1e-7)) {} else if (s.every(x => x >= -1e-7)) { n = n.map(x => -x); d = -d; } else continue;
    if (!planes.some(q => near(q, n) && Math.abs(q[3] - d) < 1e-6)) planes.push([...n, d]);
  }
  return planes;
}
export const convexSolid = points => ({ type: 'planes', planes: hullPlanes(points), verts: points.map(p => [...p]) });

// ---------- sketch (edge list in cell space) to solid
// Finds the faces the drawn edges outline: in every plane through three drawn points, the drawn edges lying in that
// plane form a planar graph whose bounded faces are candidate faces. The sketch is a solid when every drawn edge
// borders exactly two faces. Convex results are stored as planes, others as triangles. Otherwise: the convex hull of
// the drawn points, with ok: false and the reason.
export function sketchToShape(lines) {
  const pts = [], idxOf = new Map(), key = p => p.map(x => Math.round(x * 1e4)).join(',');
  const id = p => { const k = key(p); if (!idxOf.has(k)) { idxOf.set(k, pts.length); pts.push(p.map(Number)); } return idxOf.get(k); };
  const E = new Set(), edges = [];
  for (const [a, b] of lines) {
    const i = id(a), j = id(b); if (i === j) continue;
    const k = Math.min(i, j) + '-' + Math.max(i, j); if (E.has(k)) continue; E.add(k); edges.push([Math.min(i, j), Math.max(i, j)]);
  }
  if (pts.length < 4) return { ok: false, reason: 'draw at least 4 corner points', solids: null };
  const faces = [], faceKeys = new Set(), planesSeen = [];
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++) for (let c = b + 1; c < pts.length; c++) {
    let n = cross(sub(pts[b], pts[a]), sub(pts[c], pts[a])); const L = len(n); if (L < 1e-9) continue;
    n = n.map(x => x / L);
    if (n.find(x => Math.abs(x) > 1e-9) < 0) n = n.map(x => -x);
    const d = dot(n, pts[a]);
    if (planesSeen.some(q => near(q, n) && Math.abs(q[3] - d) < 1e-6)) continue;
    planesSeen.push([...n, d]);
    const onP = new Set(); pts.forEach((p, i) => { if (Math.abs(dot(n, p) - d) < 1e-6) onP.add(i); });
    const pe = edges.filter(([i, j]) => onP.has(i) && onP.has(j));
    if (pe.length < 3) continue;
    const t1 = Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]), t1n = t1.map(x => x / len(t1)), t2 = cross(n, t1n);
    const uv = i => [dot(pts[i], t1n), dot(pts[i], t2)];
    const adj = new Map();
    for (const [i, j] of pe) { if (!adj.has(i)) adj.set(i, []); if (!adj.has(j)) adj.set(j, []); adj.get(i).push(j); adj.get(j).push(i); }
    adj.forEach((nb, i) => { const o = uv(i); nb.sort((p, q) => Math.atan2(uv(p)[1] - o[1], uv(p)[0] - o[0]) - Math.atan2(uv(q)[1] - o[1], uv(q)[0] - o[0])); });
    const used = new Set();
    for (const [i0, j0] of pe) for (const [s0, t0] of [[i0, j0], [j0, i0]]) {
      if (used.has(s0 + '>' + t0)) continue;
      const cyc = []; let s = s0, t = t0, guard = 0;
      while (!used.has(s + '>' + t) && guard++ < 64) {
        used.add(s + '>' + t); cyc.push(s);
        const nb = adj.get(t), k = nb.indexOf(s);
        const nx = nb[(k - 1 + nb.length) % nb.length];
        s = t; t = nx;
      }
      if (cyc.length < 3 || s !== s0 || t !== t0) continue;
      let area = 0; for (let q = 0; q < cyc.length; q++) { const A = uv(cyc[q]), B = uv(cyc[(q + 1) % cyc.length]); area += A[0] * B[1] - B[0] * A[1]; }
      if (area <= 1e-9) continue;   // the outer (unbounded) face walks the other way round
      const fk = [...cyc].sort((x, y) => x - y).join(',');
      if (faceKeys.has(fk)) continue; faceKeys.add(fk);
      faces.push(cyc);
    }
  }
  const count = new Map(); edges.forEach(([i, j]) => count.set(i + '-' + j, 0));
  faces.forEach(f => f.forEach((v, q) => { const w = f[(q + 1) % f.length], k = Math.min(v, w) + '-' + Math.max(v, w); if (count.has(k)) count.set(k, count.get(k) + 1); }));
  const bad = [...count.values()].filter(c => c !== 2).length;
  if (bad) return { ok: false, reason: `${bad} drawn edge(s) aren't shared by exactly two faces, so the lines don't close into a solid. Saved as the convex hull of the points instead.`,
    solids: [convexSolid(pts)] };
  const convex = hullPlanes(pts);
  const isConvex = faces.length === convex.length && faces.every(f => convex.some(q => f.every(v => Math.abs(dot(q, pts[v]) - q[3]) < 1e-6)));
  if (isConvex) return { ok: true, reason: 'convex', solids: [{ type: 'planes', planes: convex, verts: pts }] };
  const tris = [];
  for (const f of faces) for (const [a, b, c] of earClip(f, pts)) tris.push(...pts[a], ...pts[b], ...pts[c]);
  return { ok: true, reason: 'non-convex', solids: [{ type: 'tris', tris }] };
}

function earClip(poly, pts) {
  if (poly.length === 3) return [[...poly]];
  let n = [0, 0, 0];
  for (let i = 0; i < poly.length; i++) { const a = pts[poly[i]], b = pts[poly[(i + 1) % poly.length]]; n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
  const ax = [0, 1, 2].reduce((m, k) => Math.abs(n[k]) > Math.abs(n[m]) ? k : m, 0), u = (ax + 1) % 3, v = (ax + 2) % 3;
  const P = i => [pts[i][u], pts[i][v]];
  const ring = [...poly];
  const area = ring.reduce((s, _, q) => { const A = P(ring[q]), B = P(ring[(q + 1) % ring.length]); return s + A[0] * B[1] - B[0] * A[1]; }, 0);
  if (area < 0) ring.reverse();
  const out = []; let guard = 0;
  while (ring.length > 3 && guard++ < 200) {
    let cut = false;
    for (let q = 0; q < ring.length; q++) {
      const a = ring[(q - 1 + ring.length) % ring.length], b = ring[q], c = ring[(q + 1) % ring.length];
      const A = P(a), B = P(b), C = P(c);
      if ((B[0] - A[0]) * (C[1] - A[1]) - (B[1] - A[1]) * (C[0] - A[0]) <= 1e-12) continue;
      const blocked = ring.some(w => { if (w === a || w === b || w === c) return false; const X = P(w);
        const d1 = (B[0] - A[0]) * (X[1] - A[1]) - (B[1] - A[1]) * (X[0] - A[0]), d2 = (C[0] - B[0]) * (X[1] - B[1]) - (C[1] - B[1]) * (X[0] - B[0]), d3 = (A[0] - C[0]) * (X[1] - C[1]) - (A[1] - C[1]) * (X[0] - C[0]);
        return d1 > 1e-12 && d2 > 1e-12 && d3 > 1e-12; });
      if (blocked) continue;
      out.push([a, b, c]); ring.splice(q, 1); cut = true; break;
    }
    if (!cut) break;
  }
  if (ring.length === 3) out.push(ring);
  return out;
}

// ---------- templates: every distinct (shape, rotation) of the shapes in use, as bit masks
// shapes: library entries ({ solids, use, plate?, penalty?, reach? }); the mask is cached on the entry as _m. A reach
// card (a block drawn outside its own cell, importer.js) gives hand-only templates: the cell editor offers them, the fit doesn't.
// Its solids are where it shows, one cell over by its shift ([x, y, z] cells, card frame); the template's key adds the
// shift as turned (shiftT), since a plate on one side of its block and on another look alike to the mask.
// A template's sig is its mask; cards the mask can't tell apart (a 1x7 and a 1x8 slope piece, a mantlet plate and a
// panel: the importer keeps them apart by volume) each keep their templates, the second and later ones with
// "#<card id>" added (the first card in the library keeps the plain mask, as cell edits saved before this have it).
// A card's turns are told apart by its mask and its centre (shapeCentre): a 1x8 slope's piece rises 1/8 of a cell, which the
// 6-sample mask can't see, so its mask looks alike turned about the vertical while the block doesn't. A turn whose mask
// another turn of the card already has adds "%<centre>". T.turns[shape][ri] = the template of that card's turn ri.
export function buildTemplates(shapes) {
  const list = [], bySig = new Map(), owner = new Map(), turns = new Map(), byMask = new Map();   // owner: mask sig -> the card whose templates have it plain
  shapes.forEach((sh, si) => {
    if (!sh.use || !sh.solids || !sh.solids.length) return;
    if (!sh._m) sh._m = shapeMask(sh);
    const { mask, plate } = sh._m;
    if (!maskCount(mask)) return;
    const own = new Map(), tr = new Array(ROTS.length).fill(-1), c0 = shapeCentre(sh);   // own: this card's turns by mask
    turns.set(si, tr);
    ROT_MAP.forEach((map, ri) => {
      const m = permute(mask, map), shiftT = sh.shift ? rotP(ROTS[ri], sh.shift) : null, ms = tplKey(maskSig(m), shiftT), cen = rotP(ROTS[ri], c0);
      const same = (own.get(ms) || []).find(j => sameCentre(list[j].cen, cen));
      if (same !== undefined) { tr[ri] = same; return; }   // the card's own turns that look alike
      if (!owner.has(ms)) owner.set(ms, si);
      let sig = owner.get(ms) === si ? ms : ms + '#' + sh.id;
      if (own.has(ms)) sig += '%' + cen.map(v => Math.round(v * 1e3)).join(',');   // a turn the mask can't tell from another of this card's
      if (!own.has(ms)) own.set(ms, []); own.get(ms).push(list.length); tr[ri] = list.length;
      if (!byMask.has(ms)) byMask.set(ms, []); byMask.get(ms).push(list.length);
      bySig.set(sig, list.length);
      let minY = SUB; for (let k = 0; k < NS && minY === SUB; k++) if (getBit(m, k)) minY = Math.floor(k / (SUB * SUB));   // lowest sample layer
      const walls = [0, 1, 2, 3, 4, 5].map(w => { const ax = w >> 1, at = w & 1 ? SUB - 1 : 0;
        for (let u = 0; u < SUB; u++) for (let v = 0; v < SUB; v++) { const q = [0, 0, 0]; q[ax] = at; q[(ax + 1) % 3] = u; q[(ax + 2) % 3] = v;
          if (!getBit(m, (q[1] * SUB + q[2]) * SUB + q[0])) return false; } return true; });
      const face = [0, 1, 2, 3, 4, 5].map(w => { const ax = w >> 1, at = w & 1 ? SUB - 1 : 0, f = new Uint8Array(SUB * SUB);
        for (let u = 0; u < SUB; u++) for (let v = 0; v < SUB; v++) { const q = [0, 0, 0]; q[ax] = at; q[(ax + 1) % 3] = u; q[(ax + 2) % 3] = v;
          f[u * SUB + v] = getBit(m, (q[1] * SUB + q[2]) * SUB + q[0]); } return f; });
      list.push({ shape: si, rot: ri, mask: m, n: maskCount(m), plate, sig, card: sh.id, cen, minY, walls, face, ...(sh.reach ? { hand: true } : {}), ...(shiftT ? { shiftT } : {}) });
    });
  });
  return { list, bySig, turns, byMask };
}
// Where a shape's surface is centred (area-weighted over its triangles, or its plane solids' hull faces), relative to the
// cell centre, a reach card's shift included: told apart from the mask, it shows which way a turn faces where the mask
// can't (a 1x8 slope piece's 1/8 rise moves it 0.016 to 0.03 of a cell; panel bevels and plate details under 0.001).
const centreCache = new WeakMap();
export function shapeCentre(sh) {
  if (centreCache.has(sh)) return centreCache.get(sh);
  let A = 0; const c = [0, 0, 0];
  const tri = (p, q, r) => { const a = len(cross(sub(q, p), sub(r, p))) / 2; A += a; for (let k = 0; k < 3; k++) c[k] += a * (p[k] + q[k] + r[k]) / 3; };
  for (const so of sh.solids || []) {
    if (so.type === 'tris') { const t = so.tris;
      for (let i = 0; i < t.length; i += 9) tri([t[i], t[i + 1], t[i + 2]], [t[i + 3], t[i + 4], t[i + 5]], [t[i + 6], t[i + 7], t[i + 8]]); }
    else { const H = hullFaces(so); if (H) for (const { F, f } of H.faces) for (let i = 0; i < F.length; i++) tri(F[i], F[(i + 1) % F.length], f); }
  }
  const sft = sh.shift || [0, 0, 0];
  const out = A ? c.map((x, k) => x / A - .5 + sft[k]) : [0, 0, 0];
  centreCache.set(sh, out); return out;
}
const CENTRE_TOL = 0.004;
export const sameCentre = (a, b) => a.every((v, k) => Math.abs(v - b[k]) < CENTRE_TOL);
// the editor's 90-degree turns as matrices (the turns of turnVec): about X (length), Y (vertical), Z (width)
const TURN_M = [[[1, 0, 0], [0, 0, -1], [0, 1, 0]], [[0, 0, 1], [0, 1, 0], [-1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]]];
const mulM = (A, B) => [0, 1, 2].map(r => [0, 1, 2].map(c => A[r][0] * B[0][c] + A[r][1] * B[1][c] + A[r][2] * B[2][c]));
const rotIndex = M => ROTS.findIndex(R => R.every((row, i) => row.every((v, j) => v === M[i][j])));
// a mask's template of the same card when it has one of its own (see buildTemplates), else whichever card has it
const sameCard = (T, ti, ms) => T.bySig.get(ms + '#' + T.list[ti].card) ?? T.bySig.get(ms);
const tplKey = (ms, shiftT) => shiftT ? ms + '@' + shiftT.join(',') : ms;
// the same block turned 90 degrees about an axis (0 = X length, 1 = Y vertical, 2 = Z width): the card's own turn
export function rotateTemplate(T, ti, axis) {
  const t = T.list[ti], tr = T.turns && T.turns.get(t.shape);
  if (tr) { const r = tr[rotIndex(mulM(TURN_M[axis], ROTS[t.rot]))]; return r >= 0 ? r : ti; }
  const r = sameCard(T, ti, tplKey(maskSig(permute(t.mask, TURN_MAP[axis])), t.shiftT && turnVec(axis, t.shiftT)));
  return r === undefined ? ti : r;
}
// the block mirrored across the hull centreline (Z, the width): the template whose mask is this one flipped in Z, or -1
// when the library has no such block (a left/right-handed shape without its twin in use). The cell editor's mirror.
const MIRROR_Z = SAMPLE.map(p => sIndex([p[0] - .5, p[1] - .5, .5 - p[2]]));
// Of the blocks whose mask is this one's mirrored, the one centred where its mirror image is (this card's first).
export function mirrorTemplate(T, ti) {
  const t = T.list[ti], ms = tplKey(maskSig(permute(t.mask, MIRROR_Z)), t.shiftT && mirrorVec(t.shiftT));
  const cands = T.byMask ? T.byMask.get(ms) || [] : [], mc = mirrorVec(t.cen);
  if (cands.length) {
    const near = cands.filter(j => sameCentre(T.list[j].cen, mc));
    return (near.find(j => T.list[j].card === t.card) ?? near[0]) ?? (cands.find(j => T.list[j].card === t.card) ?? cands[0]);
  }
  const r = sameCard(T, ti, ms);
  return r === undefined ? -1 : r;
}
// rotation-independent signature of a shape's mask (finds duplicate shapes)
export const shapeKeySig = mask => ROT_MAP.map(map => maskSig(permute(mask, map))).sort()[0];

// ---------- models: OBJ and STL
export function parseObj(text) {
  const v = [], parts = new Map(); let cur = 'model';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('v ')) v.push(line.split(/\s+/).slice(1, 4).map(Number));
    else if (line.startsWith('o ') || line.startsWith('g ')) cur = line.slice(2).trim() || 'model';
    else if (line.startsWith('f ')) {
      const idx = line.split(/\s+/).slice(1).map(t => { const i = parseInt(t.split('/')[0]); return i > 0 ? i - 1 : v.length + i; });
      if (!parts.has(cur)) parts.set(cur, []);
      const arr = parts.get(cur);
      for (let k = 1; k < idx.length - 1; k++) arr.push(...v[idx[0]], ...v[idx[k]], ...v[idx[k + 1]]);
    }
  }
  return [...parts.entries()].filter(([, t]) => t.length).map(([name, t]) => ({ name, tris: Float32Array.from(t) }));
}
export function parseStl(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length >= 84) {
    const n = dv.getUint32(80, true);
    if (84 + n * 50 === u8.length) {           // binary
      const t = new Float32Array(n * 9);
      for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) t[i * 9 + k] = dv.getFloat32(84 + i * 50 + 12 + k * 4, true);
      return [{ name: 'model', tris: t }];
    }
  }
  const text = new TextDecoder().decode(u8), parts = []; let cur = 'model', arr = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('endsolid')) { if (arr.length) parts.push({ name: cur, tris: Float32Array.from(arr) }); arr = []; }
    else if (line.startsWith('solid')) { cur = line.slice(5).trim() || 'model'; arr = []; }
    else if (line.startsWith('vertex')) arr.push(...line.split(/\s+/).slice(1, 4).map(Number));
  }
  if (arr.length) parts.push({ name: cur, tris: Float32Array.from(arr) });
  return parts;
}
// orient and scale: world X = front, Y = up, Z = side; rear at x = 0, ground at y = 0, centred in z.
// o: { up: 'y'|'z'|'x', front: '+x'|'-x'|'+y'|'-y'|'+z'|'-z', length: real metres along the front axis }
export function prepareModel(rawParts, o) {
  const up = 'xyz'.indexOf(o.up), fa = 'xyz'.indexOf(o.front[1]), sg = o.front[0] === '-' ? -1 : 1;
  if (fa === up) throw new Error('front and up must be different axes');
  const side = [0, 1, 2].find(i => i !== up && i !== fa);
  // the side axis takes whichever sign keeps this a rotation (determinant +1); a fixed sign mirrored the model
  // left-to-right for some front/up choices (e.g. front -y, up z), swapping port and starboard
  const even = (fa === 0 && up === 1) || (fa === 1 && up === 2) || (fa === 2 && up === 0);
  const ss = sg * (even ? 1 : -1);
  const parts = rawParts.map(p => { const t = new Float32Array(p.tris.length);
    for (let i = 0; i < t.length; i += 3) { t[i] = p.tris[i + fa] * sg; t[i + 1] = p.tris[i + up]; t[i + 2] = p.tris[i + side] * ss; }
    return { name: p.name, tris: t }; });
  const mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  parts.forEach(p => { for (let i = 0; i < p.tris.length; i += 3) for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], p.tris[i + k]); mx[k] = Math.max(mx[k], p.tris[i + k]); } });
  const s = o.length / (mx[0] - mn[0]), cz = (mn[2] + mx[2]) / 2;
  parts.forEach(p => { for (let i = 0; i < p.tris.length; i += 3) { p.tris[i] = (p.tris[i] - mn[0]) * s; p.tris[i + 1] = (p.tris[i + 1] - mn[1]) * s; p.tris[i + 2] = (p.tris[i + 2] - cz) * s; } });
  return { parts, size: [(mx[0] - mn[0]) * s, (mx[1] - mn[1]) * s, (mx[2] - mn[2]) * s] };
}
// big models (3D-print meshes run to millions of triangles, far finer than the fit's 1/SUB-cell voxels): every corner in
// the same box of side `size` is merged into one point (the mean of its corners) and triangles that collapse are dropped
// (vertex clustering). A closed mesh stays closed; walls thinner than the box fold flat, below what the voxels see.
// Each part keeps its original bounds (lo, hi), so the grid's placement doesn't move.
// The surface scores depend on mesh density (at least one sample per triangle), so a simplified mesh shifts some
// near-ties (2026-10-20, 1/24 cell: Littorio 2 of 3134 cells, M13/40 38 of 371): only models too big to fit as they are
// get it, and the owner's tuned models (all under 500k triangles) keep their exact picks.
export const CLUSTER_PER_CELL = 24;          // merge box = 1/24 of a cell (a quarter voxel) for the fit
export const SIMPLIFY_FROM = 500000;         // triangles; smaller models are fitted as they are
export function clusterParts(parts, size) {
  return parts.map(p => {
    const t = p.tris, nv = t.length / 3, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < t.length; i += 3) for (let k = 0; k < 3; k++) { const v = t[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    const sz = Math.max(size, (Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) || 1) / 130000);   // keys stay exact integers (< 2^53)
    const ids = new Int32Array(nv), map = new Map(); let sums = [];
    for (let v = 0; v < nv; v++) {
      const x = t[v * 3], y = t[v * 3 + 1], z = t[v * 3 + 2];
      const key = (Math.floor((x - lo[0]) / sz) * 131072 + Math.floor((y - lo[1]) / sz)) * 131072 + Math.floor((z - lo[2]) / sz);
      let id = map.get(key); if (id === undefined) { id = map.size; map.set(key, id); sums.push(0, 0, 0, 0); }
      ids[v] = id; sums[id * 4] += x; sums[id * 4 + 1] += y; sums[id * 4 + 2] += z; sums[id * 4 + 3]++;
    }
    const out = new Float32Array(t.length); let o = 0;
    for (let v = 0; v < nv; v += 3) {
      const a = ids[v], b = ids[v + 1], c = ids[v + 2]; if (a === b || b === c || a === c) continue;
      for (const id of [a, b, c]) { const n = sums[id * 4 + 3]; out[o++] = sums[id * 4] / n; out[o++] = sums[id * 4 + 1] / n; out[o++] = sums[id * 4 + 2] / n; }
    }
    sums = null;
    return { ...p, tris: out.slice(0, o), lo, hi };
  });
}
// the scaled bounds of the parts in use (a clustered part's own lo/hi: its original extent)
function partBounds(parts, o) {
  const s = o.scale, mn = [1e9, 1e9, 1e9], mx = [-1e9, -1e9, -1e9];
  parts.forEach(p => { if (!o.groupsOn.has(p.group)) return;
    if (p.lo) { for (let k = 0; k < 3; k++) { mn[k] = Math.min(mn[k], Math.fround(p.lo[k] * s)); mx[k] = Math.max(mx[k], Math.fround(p.hi[k] * s)); } return; }
    for (let i = 0; i < p.tris.length; i += 3) for (let k = 0; k < 3; k++) { const v = Math.fround(p.tris[i + k] * s); mn[k] = Math.min(mn[k], v); mx[k] = Math.max(mx[k], v); } });
  return { mn, mx };
}
// "turret=turret,gun;wheels=wheel" -> group of a part name (first match wins; anything else is "body")
export function groupOf(name, rules) {
  const n = name.toLowerCase();
  for (const r of rules.split(';')) { const [g, list] = r.split('='); if (!list) continue;
    if (list.split(',').some(w => w.trim() && n.includes(w.trim().toLowerCase()))) return g.trim(); }
  return 'body';
}

// ---------- surfaces: sample points with (unsigned) normals, for comparing the model's surface with a block's faces
export let SURF_STEP = 0.2;              // spacing of surface samples (model and blocks), in cells
export const setSurfStep = s => { SURF_STEP = s; };     // for tuning (bench_fit.mjs)
// triangles of a shape's solids in cell space (convex solids: the faces of the hull of their corners)
export function shapeTriangles(shape) {
  const out = [];
  for (const s of shape.solids || []) {
    if (s.type === 'tris') { for (let i = 0; i < s.tris.length; i++) out.push(s.tris[i]); continue; }
    const V = []; s.verts.forEach(v => { const q = v.map(x => Math.round(x * 1e6) / 1e6 + 0); if (!V.some(w => near(w, q))) V.push(q); });
    for (const pl of hullPlanes(V)) {
      const f = V.filter(v => Math.abs(dot(pl, v) - pl[3]) < 1e-6); if (f.length < 3) continue;
      const c = [0, 1, 2].map(k => f.reduce((a, v) => a + v[k], 0) / f.length);
      const t1 = sub(f[0], c), t1n = t1.map(x => x / len(t1)), t2 = cross(pl, t1n);
      f.sort((a, b) => Math.atan2(dot(sub(a, c), t2), dot(sub(a, c), t1n)) - Math.atan2(dot(sub(b, c), t2), dot(sub(b, c), t1n)));
      for (let i = 1; i + 1 < f.length; i++) out.push(...f[0], ...f[i], ...f[i + 1]);
    }
  }
  return out;
}
// evenly spread points on triangles: calls fn(x, y, z, nx, ny, nz, weight) (weight = area per point; unit normal)
export function sampleTris(tris, step, fn) {
  for (let t = 0; t + 8 < tris.length; t += 9) {
    const A = [tris[t], tris[t + 1], tris[t + 2]], B = [tris[t + 3], tris[t + 4], tris[t + 5]], C = [tris[t + 6], tris[t + 7], tris[t + 8]];
    const nrm = cross(sub(B, A), sub(C, A)), area2 = len(nrm); if (area2 < 1e-12) continue;
    const n = nrm.map(x => x / area2), L = Math.max(len(sub(A, B)), len(sub(B, C)), len(sub(C, A)));
    const k = Math.max(1, Math.ceil(L / step)), pts = [];
    for (let i = 0; i < k; i++) for (let j = 0; j < k - i; j++) {
      pts.push([(i + 1 / 3) / k, (j + 1 / 3) / k]);
      if (i + j < k - 1) pts.push([(i + 2 / 3) / k, (j + 2 / 3) / k]);
    }
    const w = area2 / 2 / pts.length;
    for (const [u, v] of pts) { const q = 1 - u - v; fn(A[0] * q + B[0] * u + C[0] * v, A[1] * q + B[1] * u + C[1] * v, A[2] * q + B[2] * u + C[2] * v, n[0], n[1], n[2], w); }
  }
}
// a shape's real surface (seams between its pieces dropped) as samples x, y, z, nx, ny, nz, onCellWall, with a spatial
// hash for lookups. Cached on the shape as _s.
export function shapeSurface(shape) {
  if (shape._s && shape._s.tol === SURF_D && shape._s.step === SURF_STEP) return shape._s;
  const inCell = p => p.every(v => v >= -1e-9 && v <= 1 + 1e-9) && shapeInside(shape, p);
  const pts = [], e = 0.012, thin = shapeMask(shape).plate;
  sampleTris(shapeTriangles(shape), SURF_STEP, (x, y, z, nx, ny, nz) => {
    if (!thin) {                           // thin plates: keep every face (both sides are real)
      const a = inCell([x + nx * e, y + ny * e, z + nz * e]), b = inCell([x - nx * e, y - ny * e, z - nz * e]);
      if (a === b) return;                 // a seam between pieces, or a face inside the solid
    }
    const wall = [x, y, z].some((v, k) => (v < 1e-3 || v > 1 - 1e-3) && Math.abs([nx, ny, nz][k]) > 0.99) ? 1 : 0;
    pts.push(x, y, z, nx, ny, nz, wall);
  });
  const P = Float32Array.from(pts);
  let inner = 0; for (let i = 6; i < P.length; i += 7) if (!P[i]) inner++;
  return (shape._s = { pts: P, hash: makeHash(P, 7, -0.01, 1.02), inner, tol: SURF_D, step: SURF_STEP });
}
// spatial hash over samples (stride floats each) in the cube [lo, lo+size]^3, buckets of SURF_D / 2 (points outside
// the range go in the edge buckets, which reach to infinity). Each bucket is split three ways by the normal's largest
// component, and each part keeps the largest |normal component| per axis, so a lookup can skip parts whose normals
// can't line up with the query's. Samples are packed part by part into one Float64Array (x, y, z, nx, ny, nz).
const HASH_DIV = 1;
function makeHash(pts, stride, lo, size) {
  const h = SURF_D / HASH_DIV, G = Math.max(1, Math.ceil(size / h)), NB = G * G * G * 3, n = pts.length / stride;
  const partOf = new Int32Array(n), start = new Int32Array(NB + 1), maxN = new Float64Array(NB * 3);
  const b = v => Math.min(G - 1, Math.max(0, Math.floor((v - lo) / h)));
  for (let i = 0; i < n; i++) {
    const o = i * stride, ax = Math.abs(pts[o + 3]), ay = Math.abs(pts[o + 4]), az = Math.abs(pts[o + 5]);
    const p = ((b(pts[o + 1]) * G + b(pts[o + 2])) * G + b(pts[o])) * 3 + (ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2);
    partOf[i] = p; start[p + 1]++;
    if (ax > maxN[p * 3]) maxN[p * 3] = ax; if (ay > maxN[p * 3 + 1]) maxN[p * 3 + 1] = ay; if (az > maxN[p * 3 + 2]) maxN[p * 3 + 2] = az;
  }
  for (let p = 0; p < NB; p++) start[p + 1] += start[p];
  const packed = new Float64Array(n * 6), fillAt = start.slice(0, NB);
  for (let i = 0; i < n; i++) { const o = i * stride, q = 6 * fillAt[partOf[i]]++;
    packed[q] = pts[o]; packed[q + 1] = pts[o + 1]; packed[q + 2] = pts[o + 2]; packed[q + 3] = pts[o + 3]; packed[q + 4] = pts[o + 4]; packed[q + 5] = pts[o + 5]; }
  return { G, lo, h, start, maxN, packed };
}
// the best score among packed samples k0..k1 (see bestMatch), starting from best
function scanSamples(packed, k0, k1, x, y, z, nx, ny, nz, best) {
  const D = SURF_D, D2 = D * D, P1 = NORMAL_POW === 1;
  let r = (1 - best) * D + 1e-9, lim2 = r * r;
  for (let k = k0; k < k1; k++) {
    const o = 6 * k, dx = packed[o] - x, dy = packed[o + 1] - y, dz = packed[o + 2] - z, d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= D2 || d2 > lim2) continue;       // too far to count, or to beat best
    const al = Math.abs(packed[o + 3] * nx + packed[o + 4] * ny + packed[o + 5] * nz), al2 = al * al;
    let an = al2 * al2; for (let q = 4; q < NORMAL_POW; q *= 2) an *= an;          // agreement^NORMAL_POW (4, 8, 16)
    const fac = P1 ? al : an;
    if (fac <= best) continue;
    const s = (1 - Math.sqrt(d2) / D) * fac;   // parallel faces matter most
    if (s > best) { best = s; r = (1 - best) * D + 1e-9; lim2 = r * r; }
  }
  return best;
}
// best match for a point among hashed samples within SURF_D: max of closeness x |normal agreement|.
// Exact (the same value as checking every sample), but skips what can't beat the best so far: a sample at distance d
// scores at most 1 - d / SURF_D, and at most its normal agreement (bounded per bucket part by its largest components).
const BM_G = new Float64Array(3 * 8), BM_I = new Int32Array(3 * 8), BM_N = new Int32Array(3), BM_Q = new Float64Array(3);
function bestMatch(H, x, y, z, nx, ny, nz) {
  const { G, lo, h, start, maxN, packed } = H, D = SURF_D, P1 = NORMAL_POW === 1;
  const anx = Math.abs(nx), any = Math.abs(ny), anz = Math.abs(nz);
  BM_Q[0] = x; BM_Q[1] = y; BM_Q[2] = z;
  // per axis: the bucket indices that can hold samples within D, and the squared gap from the point to each
  for (let a = 0; a < 3; a++) {
    const v = BM_Q[a], f = (v - lo) / h;
    const i0 = Math.max(0, Math.floor(f - HASH_DIV - 1e-6)), i1 = Math.min(G - 1, Math.floor(f + HASH_DIV + 1e-6));
    let n = 0;
    for (let i = i0; i <= i1; i++) {
      const bl = i === 0 ? -Infinity : lo + i * h, bh = i === G - 1 ? Infinity : lo + (i + 1) * h;
      const g = v < bl ? bl - v : v > bh ? v - bh : 0;
      BM_I[a * 8 + n] = i; BM_G[a * 8 + n] = g * g; n++;
    }
    BM_N[a] = n;
  }
  const c0 = ((Math.min(G - 1, Math.max(0, Math.floor((y - lo) / h))) * G + Math.min(G - 1, Math.max(0, Math.floor((z - lo) / h)))) * G
    + Math.min(G - 1, Math.max(0, Math.floor((x - lo) / h))));
  let best = 0;
  // pass 0: the bucket holding the point (it usually holds the best match); pass 1: the rest
  for (let pass = 0; pass < 2; pass++)
  for (let iy = 0; iy < BM_N[1]; iy++) {
    for (let iz = 0; iz < BM_N[2]; iz++) {
      for (let ix = 0; ix < BM_N[0]; ix++) {
        const c = (BM_I[8 + iy] * G + BM_I[16 + iz]) * G + BM_I[ix];
        if ((c === c0) !== (pass === 0)) continue;
        const r = (1 - best) * D + 1e-9;
        if (BM_G[8 + iy] + BM_G[16 + iz] + BM_G[ix] > r * r) continue;      // the whole bucket is too far
        for (let p = c * 3; p < c * 3 + 3; p++) {
          const k0 = start[p], k1 = start[p + 1]; if (k0 === k1) continue;
          const bn = anx * maxN[p * 3] + any * maxN[p * 3 + 1] + anz * maxN[p * 3 + 2];
          if (bn === 0) continue;               // every normal here is square to the query's: all score 0
          const bb = bn * (1 + 1e-9), b2 = bb * bb; let bf = b2 * b2; for (let q = 4; q < NORMAL_POW; q *= 2) bf *= bf;
          if ((P1 ? bb : bf) <= best) continue;  // no normal here lines up well enough to beat best
          best = scanSamples(packed, k0, k1, x, y, z, nx, ny, nz, best);
        }
      } } }
  return best;
}
export let SURF_D = 0.25;                  // a surface point this close (cells) to the other surface counts as on it
export const setSurfTolerance = d => { SURF_D = d; };   // for tuning (bench_fit.mjs); shape hashes are per tolerance
export let NORMAL_POW = 8;                 // how strictly the faces must be parallel: agreement^8 (owner check 2026-10-01)
export const setNormalPow = n => { NORMAL_POW = n; };
// a shape's surface samples turned by rotation ri, into the cell: x, y, z, nx, ny, nz per sample and the cell wall
// each lies on (-1: none). Cached on the shape's surface per rotation (the same for every cell and every refit).
function turnedSurface(S, ri) {
  const cache = S.turned || (S.turned = []);
  if (cache[ri]) return cache[ri];
  const R = ROTS[ri], P = S.pts, n = P.length / 7, pts = new Float64Array(n * 6), wall = new Int8Array(n);
  for (let j = 0, i = 0; i < P.length; i += 7, j++) {
    const x = P[i] - .5, y = P[i + 1] - .5, z = P[i + 2] - .5, a = P[i + 3], b = P[i + 4], c = P[i + 5];
    const X = R[0][0] * x + R[0][1] * y + R[0][2] * z + .5, Y = R[1][0] * x + R[1][1] * y + R[1][2] * z + .5, Z = R[2][0] * x + R[2][1] * y + R[2][2] * z + .5;
    pts[j * 6] = X; pts[j * 6 + 1] = Y; pts[j * 6 + 2] = Z;
    pts[j * 6 + 3] = R[0][0] * a + R[0][1] * b + R[0][2] * c; pts[j * 6 + 4] = R[1][0] * a + R[1][1] * b + R[1][2] * c; pts[j * 6 + 5] = R[2][0] * a + R[2][1] * b + R[2][2] * c;
    wall[j] = P[i + 6] ? (X < .01 ? 0 : X > .99 ? 1 : Y < .01 ? 2 : Y > .99 ? 3 : Z < .01 ? 4 : 5) : -1;
  }
  return (cache[ri] = { pts, wall });
}
// surface agreement of one candidate (shape sh turned by rotation ri) with a cell's model samples.
// own: the cell's samples (x,y,z,nx,ny,nz,w, cell-local), wsum their total weight; nearH: hash of samples around it.
// exposed[w]: cell wall w (x-, x+, y-, y+, z-, z+) has an empty neighbour, so a block face there must be model surface.
// Returns [model surface lying on the block's faces, block's faces inside the cell or on exposed walls lying on model
// surface], each 0..1 (1 when there is nothing to check).
function surfaceScore(sh, ri, own, wsum, nearH, exposed, wallWeight = 1) {
  const S = shapeSurface(sh), R = ROTS[ri];
  let m2b = 1;
  if (wsum > 0) {
    let acc = 0;
    for (let i = 0; i < own.length; i += 7) {
      // model point into the shape's own orientation: q = R^T (p - .5) + .5
      const px = own[i] - .5, py = own[i + 1] - .5, pz = own[i + 2] - .5, a = own[i + 3], b = own[i + 4], c = own[i + 5];
      acc += own[i + 6] * bestMatch(S.hash,
        R[0][0] * px + R[1][0] * py + R[2][0] * pz + .5, R[0][1] * px + R[1][1] * py + R[2][1] * pz + .5, R[0][2] * px + R[1][2] * py + R[2][2] * pz + .5,
        R[0][0] * a + R[1][0] * b + R[2][0] * c, R[0][1] * a + R[1][1] * b + R[2][1] * c, R[0][2] * a + R[1][2] * b + R[2][2] * c);
    }
    m2b = acc / wsum;
  }
  let ok = 0, n = 0;
  const { pts: Q, wall } = turnedSurface(S, ri);
  for (let j = 0; j < wall.length; j++) {
    let wt = 1;
    if (wall[j] >= 0) {                     // on a cell wall: only counts where that wall is exposed (the outside skin)
      if (!exposed[wall[j]]) continue;
      wt = wallWeight;                      // the owner builds the outside skin first (2026-10-01 edits)
    }
    const o = j * 6;
    ok += wt * bestMatch(nearH, Q[o], Q[o + 1], Q[o + 2], Q[o + 3], Q[o + 4], Q[o + 5]);
    n += wt;
  }
  const b2m = n ? ok / n : 1;
  return [m2b, b2m];
}

// ---------- model voxelising (per part: surface samples + 6-ray parity inside votes)
function partSolid(tris, org, fb, fn, out, gi, prio) {
  const [fnx, , fnz] = fn, idx = (x, y, z) => (y * fnz + z) * fnx + x;
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], tris[i + k]); hi[k] = Math.max(hi[k], tris[i + k]); }
  const b0 = [0, 1, 2].map(k => Math.max(0, Math.floor((lo[k] - org[k]) / fb)));
  const b1 = [0, 1, 2].map(k => Math.min(fn[k] - 1, Math.floor((hi[k] - org[k]) / fb)));
  if (b0.some((v, k) => v > b1[k])) return;
  const dims = [0, 1, 2].map(k => b1[k] - b0[k] + 1);
  const lidx = (x, y, z) => ((y - b0[1]) * dims[2] + (z - b0[2])) * dims[0] + (x - b0[0]);
  const votes = new Uint8Array(dims[0] * dims[1] * dims[2]), surf = new Uint8Array(votes.length);
  for (let t = 0; t < tris.length; t += 9) {
    const A = [tris[t], tris[t + 1], tris[t + 2]], B = [tris[t + 3], tris[t + 4], tris[t + 5]], C = [tris[t + 6], tris[t + 7], tris[t + 8]];
    const n = Math.max(1, Math.ceil(Math.max(len(sub(A, B)), len(sub(B, C)), len(sub(C, A))) / (fb * 0.5)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v;
      const c = [0, 1, 2].map(k => Math.floor((A[k] * w + B[k] * u + C[k] * v - org[k]) / fb));
      if (c.some((q, k) => q < b0[k] || q > b1[k])) continue;
      surf[lidx(c[0], c[1], c[2])] = 1;
    }
  }
  for (let a = 0; a < 3; a++) {
    const u = (a + 1) % 3, v = (a + 2) % 3, cols = new Map();
    for (let t = 0; t < tris.length; t += 9) {
      const P = [[tris[t], tris[t + 1], tris[t + 2]], [tris[t + 3], tris[t + 4], tris[t + 5]], [tris[t + 6], tris[t + 7], tris[t + 8]]];
      const d = (P[1][u] - P[0][u]) * (P[2][v] - P[0][v]) - (P[2][u] - P[0][u]) * (P[1][v] - P[0][v]);
      if (Math.abs(d) < 1e-12) continue;
      const iu0 = Math.max(b0[u], Math.ceil((Math.min(P[0][u], P[1][u], P[2][u]) - org[u]) / fb - .5)), iu1 = Math.min(b1[u], Math.floor((Math.max(P[0][u], P[1][u], P[2][u]) - org[u]) / fb - .5));
      const iv0 = Math.max(b0[v], Math.ceil((Math.min(P[0][v], P[1][v], P[2][v]) - org[v]) / fb - .5)), iv1 = Math.min(b1[v], Math.floor((Math.max(P[0][v], P[1][v], P[2][v]) - org[v]) / fb - .5));
      for (let iu = iu0; iu <= iu1; iu++) for (let iv = iv0; iv <= iv1; iv++) {
        const cu = org[u] + (iu + .5) * fb, cv = org[v] + (iv + .5) * fb;
        const l1 = ((P[1][u] - cu) * (P[2][v] - cv) - (P[2][u] - cu) * (P[1][v] - cv)) / d;
        const l2 = ((P[2][u] - cu) * (P[0][v] - cv) - (P[0][u] - cu) * (P[2][v] - cv)) / d;
        const l3 = 1 - l1 - l2;
        if (l1 < 0 || l2 < 0 || l3 < 0) continue;
        const key = iu * 100000 + iv;
        if (!cols.has(key)) cols.set(key, []);
        cols.get(key).push(l1 * P[0][a] + l2 * P[1][a] + l3 * P[2][a]);
      }
    }
    cols.forEach((hits, key) => {
      hits.sort((p, q) => p - q);
      const iu = Math.floor(key / 100000), iv = key % 100000;
      let h = 0;
      for (let ia = b0[a]; ia <= b1[a]; ia++) {
        const ca = org[a] + (ia + .5) * fb;
        while (h < hits.length && hits[h] < ca) h++;
        const c = [0, 0, 0]; c[a] = ia; c[u] = iu; c[v] = iv;
        votes[lidx(c[0], c[1], c[2])] += (h & 1) + ((hits.length - h) & 1);
      }
    });
  }
  for (let y = b0[1]; y <= b1[1]; y++) for (let z = b0[2]; z <= b1[2]; z++) for (let x = b0[0]; x <= b1[0]; x++) {
    const li = lidx(x, y, z), g = idx(x, y, z);
    if (votes[li] >= 4 && (!out.g[g] || prio[gi] < prio[out.g[g]])) out.g[g] = gi;
    if (surf[li] && (!out.s[g] || prio[gi] < prio[out.s[g]])) out.s[g] = gi;
  }
}

// parts: [{group, tris}] in metres (prepared). o: { scale, block, offX, offY, centre: 'col'|'line', fill: 'solid'|'shell',
// minFill?, groupsOn: Set, groupNames: [], groupPriority: [], shapes, T (from buildTemplates) }
// Fit rule (owner, 2026-10-01): a block may go in a cell when the model fills at least minFill of that block's own
// volume (solid blocks against the model's inside samples; plates, in thin-skin cells, against its surface samples).
// Among the allowed blocks, the best overlap (IoU with the cell's model samples) minus the shape's penalty wins.
// fit per cell: template index, -2 = model there but no block passes, -1 = empty.
// the grid's placement from the scaled model's bounds
function gridFrame(mn, mx, o) {
  const b = o.block;
  let ox = mn[0] + o.offX * b; while (ox > mn[0] + 1e-9) ox -= b;
  let oy = mn[1] + o.offY * b; while (oy > mn[1] + 1e-9) oy -= b;
  const halfW = Math.max(-mn[2], mx[2]);
  let oz, nz;
  if (o.centre === 'col') { const k = Math.ceil(halfW / b - 0.5); nz = 2 * k + 1; oz = -(k + 0.5) * b; }
  else { const k = Math.ceil(halfW / b); nz = 2 * k; oz = -k * b; }
  const nx = Math.ceil((mx[0] - ox) / b - 1e-6), ny = Math.ceil((mx[1] - oy) / b - 1e-6);
  return { ox, oy, oz, nx, ny, nz };
}
// everything a cell's surface scores depend on besides the cell and the block: the model and library (o.surfTag, the
// caller's version of both), the parts in use, scale and grid placement, and the scoring constants
const frameKey = (o, ox, oy, oz, nx, ny, nz) => [o.surfTag || '', o.scale, o.block, ox, oy, oz, nx, ny, nz, [...o.groupsOn].sort().join(','),
  SURF_D, SURF_STEP, NORMAL_POW, o.wallWeight ?? 2].join('|');
// a cache of surface scores for computeGrid (o.surfCache): fits of the same model, library and grid placement reuse
// them, so changing Simplify or Fill refits in a fraction of the time. Results are identical either way.
export const newSurfCache = () => ({ key: null, parts: null, T: null, map: new Map(), fresh: [], complete: false, prep: null, prepKey: null });
// the cache key computeGrid will use for these parts and options (lets a caller pick stored scores before fitting)
export function surfCacheKey(parts, o) {
  const { mn, mx } = partBounds(parts, o), f = gridFrame(mn, mx, o);
  return frameKey(o, f.ox, f.oy, f.oz, f.nx, f.ny, f.nz);
}
// scores computed since the last call, as flat arrays (to pass between workers); clears the list
export function takeSurfScores(cache) {
  const n = cache.fresh.length, keys = new Float64Array(n), m2b = new Float64Array(n), b2m = new Float64Array(n);
  cache.fresh.forEach((k, i) => { const r = cache.map.get(k); keys[i] = k; m2b[i] = r[0]; b2m[i] = r[1]; });
  cache.fresh.length = 0;
  return { key: cache.key, keys, m2b, b2m };
}
// every stored score, in the same form
export function allSurfScores(cache) {
  const n = cache.map.size, keys = new Float64Array(n), m2b = new Float64Array(n), b2m = new Float64Array(n); let i = 0;
  cache.map.forEach((r, k) => { keys[i] = k; m2b[i] = r[0]; b2m[i] = r[1]; i++; });
  return { key: cache.key, keys, m2b, b2m };
}
// add scores (from takeSurfScores / allSurfScores) to a cache; scores for another grid replace what it holds
export function addSurfScores(cache, d) {
  if (!d || !d.key) return;
  if (cache.key !== d.key) { cache.map.clear(); cache.fresh.length = 0; cache.key = d.key; cache.complete = false; cache.prep = null; }
  for (let i = 0; i < d.keys.length; i++) cache.map.set(d.keys[i], [d.m2b[i], d.b2m[i]]);
}

// minFill: no longer a page setting (2026-10-28). Against the owner's edit sets, 0 to 0.2 fit best (Panhard 66/156,
// Littorio 80/116) and higher only lost agreement (0.5: 60, 70), since skin, buildable and surface rules now decide
export const MIN_FILL = 0.2;
export function computeGrid(parts, o) {
  o = { ...o, minFill: o.minFill ?? MIN_FILL };
  const s = o.scale, b = o.block, use = parts.filter(p => o.groupsOn.has(p.group));
  if (!use.length) return null;
  const scaled = use.map(p => ({ group: p.group, tris: Float32Array.from(p.tris, x => x * s) }));
  const { mn, mx } = partBounds(use, o);
  const { ox, oy, oz, nx, ny, nz } = gridFrame(mn, mx, o);
  const fb = b / SUB, fn = [nx * SUB, ny * SUB, nz * SUB];
  const surface = o.scoring !== 'volume', N = nx * ny * nz;
  const fidx = (x, y, z) => (y * fn[2] + z) * fn[0] + x, idx = (x, y, z) => (y * nz + z) * nx + x;
  // hidden groups keep their space clear (owner: wheels are left off because suspension blocks go there): a block may
  // not take more than reserveOverlap of its own volume from a hidden part (inside or surface: tyres are open meshes).
  // A panel lying on top of a wheel arch is fine; a block through the wheel is not.
  const reserveOverlap = o.reserveOverlap ?? 0.1;
  // surface scores kept from earlier fits of the same grid (o.surfCache from newSurfCache(); see surfCacheKey)
  const scache = o.surfCache && surface ? o.surfCache : null;
  if (scache) {
    const key = frameKey(o, ox, oy, oz, nx, ny, nz);
    if (scache.key !== key || (!o.surfTag && (scache.parts !== parts || scache.T !== o.T))) {
      scache.map.clear(); scache.fresh.length = 0; scache.key = key; scache.complete = false; scache.prep = null; }
    scache.parts = parts; scache.T = o.T;
  }
  // the voxelised model, its surface samples per cell and per-cell sample counts: kept with the surface scores, since
  // they depend only on the model and the grid placement
  const prepKey = [o.groupNames.join(','), (o.groupPriority || []).join(','), o.reserveOverlap ?? 0.1].join('|');
  let P = scache && scache.prep && scache.prepKey === prepKey ? scache.prep : null;
  if (!P) {
    const n3 = fn[0] * fn[1] * fn[2];
    P = { fine: { g: new Uint16Array(n3), s: new Uint16Array(n3) }, hid: { g: new Uint16Array(n3), s: new Uint16Array(n3) }, anyHidden: false,
      bins: new Map(), hidden: 0, seen: 0, niOf: new Uint16Array(N), matOf: new Uint16Array(N), matMask: new Uint32Array(N * W) };
    const { fine, hid, bins, niOf, matOf, matMask } = P;
    const prio = {}; o.groupNames.forEach((g, i) => { const p = (o.groupPriority || []).indexOf(g); prio[i + 1] = p < 0 ? 50 + i : p; });
    scaled.forEach(p => partSolid(p.tris, [ox, oy, oz], fb, fn, fine, o.groupNames.indexOf(p.group) + 1, prio));
    // each hidden part is filled solid between its outer surfaces along all three axes (its "visual hull"), so an open
    // tyre shell counts as a whole wheel; parts are filled one at a time so the gap between two wheels stays open
    if (reserveOverlap < 1) parts.filter(p => !o.groupsOn.has(p.group)).forEach(p => { P.anyHidden = true;
      const one = { g: new Uint16Array(fn[0] * fn[1] * fn[2]), s: new Uint16Array(fn[0] * fn[1] * fn[2]) };
      partSolid(Float32Array.from(p.tris, v => v * s), [ox, oy, oz], fb, fn, one, 1, { 1: 0 });
      const lo = [1e9, 1e9, 1e9], hi = [-1, -1, -1];
      for (let fy = 0; fy < fn[1]; fy++) for (let fz = 0; fz < fn[2]; fz++) for (let fx = 0; fx < fn[0]; fx++) if (one.s[fidx(fx, fy, fz)] || one.g[fidx(fx, fy, fz)]) {
        lo[0] = Math.min(lo[0], fx); lo[1] = Math.min(lo[1], fy); lo[2] = Math.min(lo[2], fz); hi[0] = Math.max(hi[0], fx); hi[1] = Math.max(hi[1], fy); hi[2] = Math.max(hi[2], fz); }
      if (hi[0] < 0) return;
      const on = (fx, fy, fz) => one.s[fidx(fx, fy, fz)] || one.g[fidx(fx, fy, fz)];
      for (let fy = lo[1]; fy <= hi[1]; fy++) for (let fz = lo[2]; fz <= hi[2]; fz++) for (let fx = lo[0]; fx <= hi[0]; fx++) {
        if (on(fx, fy, fz)) { hid.s[fidx(fx, fy, fz)] = 1; continue; }
        // inside the span along x, y and z: surface on both sides in every axis
        let ok = true;
        for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
          let a = false, b = false;
          for (let k = 1; !a; k++) { const X = fx - dx * k, Y = fy - dy * k, Z = fz - dz * k; if (X < lo[0] || Y < lo[1] || Z < lo[2]) break; if (on(X, Y, Z)) a = true; }
          for (let k = 1; !b; k++) { const X = fx + dx * k, Y = fy + dy * k, Z = fz + dz * k; if (X > hi[0] || Y > hi[1] || Z > hi[2]) break; if (on(X, Y, Z)) b = true; }
          if (!a || !b) { ok = false; break; }
        }
        if (ok) hid.g[fidx(fx, fy, fz)] = 1;
      }
    });
    // model surface samples binned per cell, cell-local (0..1); weights are areas in cell units
    // only surface facing open air counts: a sample with solid on both sides (a face buried inside another part, or between
    // overlapping parts) is hidden geometry a builder ignores
    const solidAt = (x, y, z) => { const fx = Math.floor((x - ox) / fb), fy = Math.floor((y - oy) / fb), fz = Math.floor((z - oz) / fb);
      return fx >= 0 && fy >= 0 && fz >= 0 && fx < fn[0] && fy < fn[1] && fz < fn[2] && fine.g[fidx(fx, fy, fz)] > 0; };
    if (surface) scaled.forEach(p => sampleTris(p.tris, SURF_STEP * b, (x, y, z, a, bb, c, w) => {
      const cx = Math.floor((x - ox) / b), cy = Math.floor((y - oy) / b), cz = Math.floor((z - oz) / b);
      if (cx < 0 || cy < 0 || cz < 0 || cx >= nx || cy >= ny || cz >= nz) return;
      P.seen++;
      const e = fb * 1.5;
      if (solidAt(x + a * e, y + bb * e, z + c * e) && solidAt(x - a * e, y - bb * e, z - c * e)) { P.hidden++; return; }
      const k = idx(cx, cy, cz); let arr = bins.get(k); if (!arr) bins.set(k, arr = []);
      arr.push((x - ox) / b - cx, (y - oy) / b - cy, (z - oz) / b - cz, a, bb, c, w / (b * b));
    }));
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) { let n = 0, m = 0;
      for (let sy = 0; sy < SUB; sy++) for (let sz = 0; sz < SUB; sz++) for (let sx = 0; sx < SUB; sx++) {
        const f = fidx(x * SUB + sx, y * SUB + sy, z * SUB + sz); if (fine.g[f]) n++;
        if (fine.g[f] || fine.s[f]) { m++; const k = (sy * SUB + sz) * SUB + sx; matMask[idx(x, y, z) * W + (k >> 5)] |= 1 << (k & 31); } }
      niOf[idx(x, y, z)] = n; matOf[idx(x, y, z)] = m; }
    if (scache) { scache.prep = P; scache.prepKey = prepKey; }
  }
  const { fine, hid, anyHidden, bins, niOf, matOf, matMask, hidden, seen } = P;   // niOf, matOf: inside samples; inside or surface samples (matMask: which, W words per cell)
  const mh = newMask();
  const cell = new Int16Array(N), fit = new Int32Array(N).fill(-1), fill = new Float32Array(N);
  const T = o.T.list, pen = T.map(tp => o.shapes[tp.shape].penalty ?? 0.11);
  const K = o.candidates || 12, ALT = 5, PEN_SCALE = o.penaltyScale ?? 4;   // simplicity penalties (seed.js) break near-ties
  const WV = o.weights ? o.weights[0] : 0.3, WM = o.weights ? o.weights[1] : 0.35, WB = o.weights ? o.weights[2] : 0.35;
  // model samples in and around a cell (neighbours within a margin), cell-local
  const nearPts = (x, y, z, m) => {
    const out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = x + dx, Y = y + dy, Z = z + dz; if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
      const arr = bins.get(idx(X, Y, Z)); if (!arr) continue;
      for (let i = 0; i < arr.length; i += 7) { const px = arr[i] + dx, py = arr[i + 1] + dy, pz = arr[i + 2] + dz;
        if (px < -m || py < -m || pz < -m || px > 1 + m || py > 1 + m || pz > 1 + m) continue; out.push(px, py, pz, arr[i + 3], arr[i + 4], arr[i + 5], arr[i + 6]); }
    }
    return out;
  };
  const alt = new Int32Array(N * ALT).fill(-1), altScore = new Float32Array(N * ALT), keep = new Map();
  // owner's style (2026-10-01 edits): shaped blocks only on the outside. A cell with model material in all six
  // neighbours and at least interiorFill of its own volume filled is part of the solid core: a cube.
  const interiorFill = o.interiorFill ?? 0.5, occupied = (o.occupiedFill ?? 0.1) * NS;
  const cubeTi = T.findIndex(tp => tp.n === NS && !tp.plate && !tp.hand);
  const isInterior = (x, y, z) => [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]]
    .every(([X, Y, Z]) => X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && matOf[idx(X, Y, Z)] >= occupied);
  // a thin cell whose material hugs a wall and carries straight on from the neighbour's solid there is that neighbour
  // poking through (or its face lying on the grid line), not a plate: no block there
  const spill = (x, y, z) => {
    let tot = 0; const layer = [0, 0, 0, 0, 0, 0];
    for (let sy = 0; sy < SUB; sy++) for (let sz = 0; sz < SUB; sz++) for (let sx = 0; sx < SUB; sx++) {
      const f = fidx(x * SUB + sx, y * SUB + sy, z * SUB + sz); if (!fine.g[f] && !fine.s[f]) continue; tot++;
      if (sx < 2) layer[0]++; if (sx >= SUB - 2) layer[1]++; if (sy < 2) layer[2]++; if (sy >= SUB - 2) layer[3]++; if (sz < 2) layer[4]++; if (sz >= SUB - 2) layer[5]++;
    }
    // the neighbour across wall k must have material in its own 2 layers at that wall (so this continues from it)
    const nb = [[x - 1, y, z, 0, SUB - 2], [x + 1, y, z, 0, 0], [x, y - 1, z, 1, SUB - 2], [x, y + 1, z, 1, 0], [x, y, z - 1, 2, SUB - 2], [x, y, z + 1, 2, 0]];
    return nb.some(([X, Y, Z, ax, from], k) => {
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || layer[k] < 0.8 * tot) return false;
      let m = 0;
      for (let a = from; a < from + 2; a++) for (let u = 0; u < SUB; u++) for (let v = 0; v < SUB; v++) {
        const s = [0, 0, 0]; s[ax] = a; s[(ax + 1) % 3] = u; s[(ax + 2) % 3] = v;
        if (fine.g[fidx(X * SUB + s[0], Y * SUB + s[1], Z * SUB + s[2])]) m++;
      }
      return m >= 0.5 * layer[k];
    });
  };
  // buildable surfaces: on by default for shell fill at large-grid sizes (a hull to build on), off otherwise (the
  // owner's small-grid vehicles use shaped and half blocks on top and sides)
  const buildable = o.buildable ?? (o.fill === 'shell' && b >= 1);
  const roundDepth = o.roundDepth ?? 2, roundCover = o.roundCover ?? 0.5, coverMin = o.coverMin ?? 0.8, mm = newMask();
  // a cell rounds out when every exposed wall but the bottom has the model's material within roundDepth samples of it
  // over most of the wall (so a full block widens the skin by at most that much), the bottom, if exposed, has material
  // on it (no rounding down), and at least one top or side wall is exposed
  const roundsOut = (x, y, z, mi, ms) => {
    let any = false;
    for (let w = 0; w < 6; w++) {
      const X = x + [-1, 1, 0, 0, 0, 0][w], Y = y + [0, 0, -1, 1, 0, 0][w], Z = z + [0, 0, 0, 0, -1, 1][w];
      if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && niOf[idx(X, Y, Z)] >= NS / 4) continue;   // not exposed
      const ax = w >> 1, depth = w === 2 ? 1 : roundDepth + 1;
      let hit = 0;
      for (let u = 0; u < SUB; u++) for (let v = 0; v < SUB; v++) { let on = false;
        for (let dd = 0; dd < depth && !on; dd++) { const q = [0, 0, 0]; q[ax] = w & 1 ? SUB - 1 - dd : dd; q[(ax + 1) % 3] = u; q[(ax + 2) % 3] = v;
          const k = (q[1] * SUB + q[2]) * SUB + q[0]; if (getBit(mi, k) || getBit(ms, k)) on = true; }
        if (on) hit++; }
      if (hit < roundCover * SUB * SUB) return false;
      if (w !== 2) any = true;
    }
    return any;
  };
  let nextProgress = 0;
  const mi = newMask(), ms = newMask(), cnt = new Uint32Array(o.groupNames.length + 1), cand = [];
  for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
    cnt.fill(0); mi.fill(0); ms.fill(0); let ni = 0, ns = 0;
    for (let sy = 0; sy < SUB; sy++) for (let sz = 0; sz < SUB; sz++) for (let sx = 0; sx < SUB; sx++) {
      const f = fidx(x * SUB + sx, y * SUB + sy, z * SUB + sz), k = (sy * SUB + sz) * SUB + sx, g = fine.g[f], gs = fine.s[f];
      if (g) { setBit(mi, k); ni++; cnt[g]++; }
      if (gs) { setBit(ms, k); ns++; if (!g) cnt[gs]++; }
    }
    if (!ni && !ns) continue;
    const ci = idx(x, y, z);
    let best = 1; for (let g = 1; g < cnt.length; g++) if (cnt[g] > cnt[best]) best = g;
    const inside = ni === NS && !ns;
    if ((o.fill === 'shell' || o.fill === 'skin') && inside) continue;
    // a cell with hardly any model in it (a speck past the hull) gets no block
    if (matOf[ci] < (o.minMaterial ?? 0.08) * NS) { fit[ci] = -2; if (o.skipped) o.skipped(x, y, z, 'speck', ni, ns); continue; }
    mh.fill(0); let nh = 0, hidTop = -1;
    if (anyHidden) for (let sy = 0; sy < SUB; sy++) for (let sz = 0; sz < SUB; sz++) for (let sx = 0; sx < SUB; sx++) {
      const f = fidx(x * SUB + sx, y * SUB + sy, z * SUB + sz); if (hid.g[f] || hid.s[f]) { setBit(mh, (sy * SUB + sz) * SUB + sx); nh++; hidTop = sy; } }
    // a cell a hidden part really occupies (a wheel well): only blocks entirely above the hidden part (mudguard tops)
    const wheelWell = nh >= (o.reserveFill ?? 0.15) * NS;
    cell[ci] = inside ? -best : best;
    const thin = ni <= NS / 6 + 4;            // at most about one sample layer: a thin skin, plates are allowed (on the surface samples)
    // poke-through: no plates (a sliver isn't a panel), but a shaped piece may round the edge off (owner's dome/edge
    // edits); 'skip' leaves the cell empty as before
    const poke = thin && (o.pokeThrough ?? 'noPlates') !== false && spill(x, y, z);
    if (poke && o.pokeThrough === 'skip') { fit[ci] = -2; if (o.skipped) o.skipped(x, y, z, 'poke-through', ni, ns); continue; }
    // a skin: an exposed cell wall with model surface over most of it (the hull's outside). Blocks with a full face on
    // it skip the fill rule (the owner thickens thin skins into half blocks; surface scoring then decides)
    const skin = [0, 1, 2, 3, 4, 5].map(w => {
      const ax = w >> 1, X = [x - 1, x + 1, x, x, x, x][w], Y = [y, y, y - 1, y + 1, y, y][w], Z = [z, z, z, z, z - 1, z + 1][w];
      if (X >= 0 && Y >= 0 && Z >= 0 && X < nx && Y < ny && Z < nz && niOf[idx(X, Y, Z)] >= NS / 4) return false;   // not exposed
      let hit = 0;
      for (let u = 0; u < SUB; u++) for (let v = 0; v < SUB; v++) { let on = false;
        for (let d = 0; d < 2 && !on; d++) { const q = [0, 0, 0]; q[ax] = w & 1 ? SUB - 1 - d : d; q[(ax + 1) % 3] = u; q[(ax + 2) % 3] = v;
          if (getBit(ms, (q[1] * SUB + q[2]) * SUB + q[0]) || getBit(mi, (q[1] * SUB + q[2]) * SUB + q[0])) on = true; }
        if (on) hit++; }
      return hit >= (o.skinCover ?? 0.6) * SUB * SUB;
    });
    const anySkin = skin.some(Boolean) && (o.skinCover ?? 0.6) < 1;
    // 1. volume (D-030): blocks the model fills enough of, ranked by overlap minus simplicity penalty
    cand.length = 0;
    for (let ti = 0; ti < T.length; ti++) {
      const tp = T[ti];
      if (tp.hand || (tp.plate && (!thin || poke))) continue;
      // cheap bound first: the overlap can't exceed the cell's own sample count, so too small a cell for this block's
      // volume fails the fill rule without counting bits (unless the skin rule lets it skip the fill rule)
      if ((tp.plate ? ns : ni) / tp.n < o.minFill && !(anySkin && !tp.plate && tp.walls.some((c, w) => c && skin[w]))) continue;
      const M = tp.plate ? ms : mi, tm = tp.mask;
      let inter = 0, uni = 0;
      for (let w = 0; w < W; w++) { inter += pop(tm[w] & M[w]); uni += pop(tm[w] | M[w]); }
      const bfill = inter / tp.n;
      if (!uni || (bfill < o.minFill && !(anySkin && !tp.plate && tp.walls.some((c, w) => c && skin[w])))) continue;
      if (nh) { if (wheelWell && tp.minY < hidTop) continue;
        let ov = 0; for (let w = 0; w < W; w++) ov += pop(tm[w] & mh[w]); if (ov > reserveOverlap * tp.n) continue; }
      cand.push({ ti, iou: inter / uni, bfill, sc: inter / uni - pen[ti] });
    }
    // buildable surfaces, round outward: of the blocks that hold (nearly) all of the cell's material, the one adding the
    // least volume past the model, simplicity penalty included. They may miss the fill rule (a half block keeping a
    // narrowing hull side full width). Skin cells only (an exposed wall), not where a hidden part keeps its space.
    let covers = null;
    if (buildable && !nh && [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]]
      .some(([X, Y, Z]) => X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || niOf[idx(X, Y, Z)] < NS / 4)) {
      let nm = 0; for (let w = 0; w < W; w++) { mm[w] = mi[w] | ms[w]; nm += pop(mm[w]); }
      let best = 1e9; const cost = new Map();
      for (let ti = 0; ti < T.length; ti++) {
        const tp = T[ti]; if (tp.plate || tp.hand) continue;
        let im = 0; for (let w = 0; w < W; w++) im += pop(tp.mask[w] & mm[w]);
        if (im < coverMin * nm) continue;
        const cst = (tp.n - im) / NS + PEN_SCALE * pen[ti]; cost.set(ti, cst); if (cst < best) best = cst;
      }
      covers = new Set([...cost].filter(([, c]) => c < best + 1e-6).map(([ti]) => ti));
      for (const ti of covers) if (!cand.some(c => c.ti === ti)) {
        let inter = 0, uni = 0; for (let w = 0; w < W; w++) { inter += pop(T[ti].mask[w] & mi[w]); uni += pop(T[ti].mask[w] | mi[w]); }
        cand.push({ ti, iou: uni ? inter / uni : 0, bfill: inter / T[ti].n, sc: (uni ? inter / uni : 0) - pen[ti], cover: true });
      }
      if (!covers.size) covers = null;
    }
    if (!cand.length) { fit[ci] = -2; if (o.skipped) o.skipped(x, y, z, 'no block passes the fill rule', ni, ns); continue; }
    cand.sort((p, q) => q.sc - p.sc);
    // keep the best K, at most 2 orientations per shape (so near-identical turns of one shape can't crowd out the rest)
    { const per = new Map(); let n = 0;
      for (const c of cand) { const s = T[c.ti].shape, k = per.get(s) || 0; if (!(covers && covers.has(c.ti)) && (k >= 2 || n >= K)) continue; per.set(s, k + 1); cand[n++] = c; }
      cand.length = n; }
    // 2. surface: the model's surface in the cell should run along the block's faces (model -> block), and every face
    //    the block adds inside the cell should have model surface on it (block -> model)
    if (surface && (!o.onlyCell || o.onlyCell(ci))) {
      let own = null, nearH = null, exposed = null, wsum = 0;
      for (const c of cand) {
        // the scores depend only on the model around the cell and the block, so they are kept across refits
        let r = scache ? scache.map.get(ci * T.length + c.ti) : undefined;
        if (!r) {
          if (!own) {
            own = bins.get(ci) || []; nearH = makeHash(nearPts(x, y, z, SURF_D), 7, -SURF_D, 1 + 2 * SURF_D);
            exposed = [[x - 1, y, z], [x + 1, y, z], [x, y - 1, z], [x, y + 1, z], [x, y, z - 1], [x, y, z + 1]]
              .map(([X, Y, Z]) => X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz || niOf[idx(X, Y, Z)] < NS / 4);
            for (let i = 6; i < own.length; i += 7) wsum += own[i];
          }
          r = surfaceScore(o.shapes[T[c.ti].shape], T[c.ti].rot, own, wsum, nearH, exposed, o.wallWeight ?? 2);
          if (scache) { scache.map.set(ci * T.length + c.ti, r); scache.fresh.push(ci * T.length + c.ti); }
        }
        const [m2b, b2m] = r;
        c.m2b = m2b; c.b2m = b2m; c.raw = WV * c.iou + WM * m2b + WB * b2m; c.sc = c.raw - PEN_SCALE * pen[c.ti];
      }
      cand.sort((p, q) => q.sc - p.sc);
    }
    if (o.progress && ci >= nextProgress) { o.progress(ci / N); nextProgress = ci + Math.max(1, N >> 6); }
    // buildable surfaces (owner, 2026-10-11, Littorio): a skin is rounded OUTWARD to a full block, never inward to a
    // half block: decks and other top skins are full blocks (half blocks on top are a pain to build on), and hull sides
    // keep their full width (room to mount guns and walk around them). Never downward: an underside stays where it is.
    let rounded = false;
    if (covers) { const c = cand.find(c => covers.has(c.ti)); if (c) { cand.splice(cand.indexOf(c), 1); cand.unshift(c); rounded = true; } }
    if (buildable && cubeTi >= 0 && T[cand[0].ti] !== T[cubeTi] && ni >= o.minFill * NS && !nh && roundsOut(x, y, z, mi, ms)) {
      const c = cand.find(c => c.ti === cubeTi) || { ti: cubeTi, sc: cand[0].sc, raw: cand[0].raw, iou: ni / NS, bfill: ni / NS };
      if (cand.indexOf(c) >= 0) cand.splice(cand.indexOf(c), 1);
      cand.unshift(c); rounded = true;
    }
    if (o.debug) o.debug(x, y, z, cand, ni, ns);
    if (interiorFill < 1 && cubeTi >= 0 && ni >= interiorFill * NS && isInterior(x, y, z) && T[cand[0].ti] !== T[cubeTi]) {
      const c = cand.find(c => c.ti === cubeTi) || { ti: cubeTi, sc: cand[0].sc, iou: ni / NS, bfill: ni / NS };
      cand.splice(cand.indexOf(c) >= 0 ? cand.indexOf(c) : 0, cand.indexOf(c) >= 0 ? 1 : 0); cand.unshift(c);
    }
    const top = cand[0], plateMin = o.plateMinScore ?? 0;
    const q = top.raw ?? top.sc;          // match quality before the simplicity tie-breaker
    fit[ci] = !rounded && surface && (q < (o.minScore ?? 0.2) || (T[top.ti].plate && q < plateMin)) ? -2 : top.ti; fill[ci] = top.bfill;   // -2: nothing matches well
    for (let k = 0; k < Math.min(ALT, cand.length); k++) { alt[ci * ALT + k] = cand[k].ti; altScore[ci * ALT + k] = cand[k].sc; }
    if (fit[ci] >= 0 && !rounded && !(interiorFill < 1 && cand[0].ti === cubeTi && isInterior(x, y, z))) keep.set(ci, { x, y, z, cand: cand.map(c => ({ ti: c.ti, sc: c.sc })) });
  }
  // continuity (owner, 2026-10-01: side walls and skins run on from block to block): a candidate gains for every face it
  // meets flush with the neighbouring block's face; two passes, each using the previous pass's picks
  const WC = surface ? (o.contactWeight ?? 2) : 0;
  if (WC > 0) for (let pass = 0; pass < 2; pass++) {
    const prev = Int32Array.from(fit);
    keep.forEach(({ x, y, z, cand }, ci) => {
      let best = null, bs = -1e9;
      for (const c of cand) {
        let contact = 0;
        for (let w = 0; w < 6; w++) {
          const X = x + [-1, 1, 0, 0, 0, 0][w], Y = y + [0, 0, -1, 1, 0, 0][w], Z = z + [0, 0, 0, 0, -1, 1][w];
          if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) continue;
          const nf = prev[idx(X, Y, Z)]; if (nf < 0) continue;
          const a = T[c.ti].face[w], b = T[nf].face[w ^ 1];
          let s2 = 0; for (let k = 0; k < SUB * SUB; k++) if (a[k] && b[k]) s2++;
          contact += s2 / (SUB * SUB);
        }
        const sc = c.sc + WC * contact / 6;
        if (sc > bs) { bs = sc; best = c; }
      }
      if (best) fit[ci] = best.ti;
    });
  }
  if (o.fill === 'skin') armourSkin();
  // armour skin (owner, 2026-10-29, R35 hull): the model's inside is kept for functional blocks and the armour wraps it.
  // Solid cells (a quarter or more inside) facing no outside air are emptied. One whose every outside face is flat skin
  // (the model's material over most of that wall), or that was fitted as a cube, is emptied too and each flat face gets a
  // panel: in the open cell beyond it where the model fills the cell right up to that wall (so the floor's panels go in
  // the layer under the hull), else, and on top faces, on the face inside the cell (a deck stays at the model's height).
  // Solid cells with sloped skin keep the shaped block the fit chose; open cells (slivers and edges of the model) get
  // only the panels asked of them.
  function armourSkin() {
    const solid = c => niOf[c] >= NS / 4, step = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1]];
    const nb = (x, y, z, w) => { const X = x + step[w][0], Y = y + step[w][1], Z = z + step[w][2];
      return X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz ? -1 : idx(X, Y, Z); };
    // outside air: open cells reached from the grid's edge through open cells (inner cavities are not outside)
    const air = new Uint8Array(N), queue = [];
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++)
      if ((x === 0 || y === 0 || z === 0 || x === nx - 1 || y === ny - 1 || z === nz - 1) && !solid(idx(x, y, z))) { air[idx(x, y, z)] = 1; queue.push(x, y, z); }
    for (let q = 0; q < queue.length; q += 3) for (let w = 0; w < 6; w++) {
      const n = nb(queue[q], queue[q + 1], queue[q + 2], w); if (n < 0 || air[n] || solid(n)) continue;
      air[n] = 1; queue.push(queue[q] + step[w][0], queue[q + 1] + step[w][1], queue[q + 2] + step[w][2]);
    }
    // share of a cell's wall w with model material within depth sample layers of it (inside samples, or surface ones too)
    const cover = (x, y, z, w, depth, surf) => { const ax = w >> 1; let hit = 0;
      for (let u = 0; u < SUB; u++) for (let v = 0; v < SUB; v++) { let on = false;
        for (let d = 0; d < depth && !on; d++) { const q = [x * SUB, y * SUB, z * SUB]; q[ax] += w & 1 ? SUB - 1 - d : d;
          q[(ax + 1) % 3] += u; q[(ax + 2) % 3] += v; const f = fidx(q[0], q[1], q[2]); if (fine.g[f] || (surf && fine.s[f])) on = true; }
        if (on) hit++; }
      return hit / (SUB * SUB); };
    const flat = (x, y, z, w) => cover(x, y, z, w, 2, true) >= 0.6, filled = (x, y, z, w) => cover(x, y, z, w, 1, false) === 1;
    const base = Int32Array.from(fit), cleared = new Set(), want = new Map(), asked = new Map();   // asked: open cell -> [[solid cell, face]]
    const add = (c, w) => { if (!want.has(c)) want.set(c, new Set()); want.get(c).add(w); };
    for (let c = 0; c < N; c++) if (!solid(c)) fit[c] = -1;
    for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) {
      const ci = idx(x, y, z); if (!solid(ci)) continue;
      const out = [0, 1, 2, 3, 4, 5].filter(w => { const n = nb(x, y, z, w); return n < 0 || air[n]; });
      if (!out.length) { fit[ci] = -1; continue; }
      if (!out.every(w => flat(x, y, z, w)) && base[ci] !== cubeTi) continue;
      fit[ci] = -1; cleared.add(ci);
      for (const w of out) {
        if (!flat(x, y, z, w)) continue;
        const n = nb(x, y, z, w);
        if (n >= 0 && w !== 3 && filled(x, y, z, w)) { if (!asked.has(n)) asked.set(n, []); asked.get(n).push([ci, w]); }
        else add(ci, w);
      }
    }
    // an open cell asked by two solid cells takes the floor's or ceiling's panel (a track guard under an overhang) and
    // the other cell puts its panel on its own face; two faces of one solid cell there make an edge plate
    for (const [n, asks] of asked) {
      const keep = (asks.find(([, w]) => w >> 1 === 1) || asks[0])[0];
      for (const [ci, w] of asks) if (ci === keep) add(n, w ^ 1); else add(ci, w);
    }
    // each cell takes the plate covering just the faces asked of it (a panel; an L or U plate on an edge), the simplest
    // first; with no such plate, an emptied cell keeps its block
    for (const [c, ws] of want) {
      let best = -1;
      for (let ti = 0; ti < T.length; ti++) { const tp = T[ti];
        if (!tp.plate || tp.hand || !tp.walls.every((v, w) => v === ws.has(w))) continue;
        if (best < 0 || pen[ti] < pen[best] || (pen[ti] === pen[best] && tp.n < T[best].n)) best = ti; }
      if (best >= 0) fit[c] = best; else if (cleared.has(c)) fit[c] = base[c];
    }
  }
  // mat: the model's material per cell (inside or surface samples, of NS), for benchmark.js
  return { nx, ny, nz, b, ox, oy, oz, cell, fit, fill, mat: matOf, matMask, idx, alt, altScore, ALT, hiddenShare: seen ? hidden / seen : 0 };

}

// ---------- block import: world mod list, block definitions (.sbc), models (.mwm via mwm.js)
const unxml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export function parseWorldMods(sandboxXml) {
  const sect = (sandboxXml.match(/<Mods>([\s\S]*?)<\/Mods>/) || [])[1] || '';
  return [...sect.matchAll(/<ModItem\b([^>]*)>([\s\S]*?)<\/ModItem>/g)].map(m => ({
    name: unxml((m[1].match(/FriendlyName="([^"]*)"/) || [])[1] || ''),
    file: (m[2].match(/<Name>([^<]*)<\/Name>/) || [])[1] || '',
    id: (m[2].match(/<PublishedFileId>(\d+)<\/PublishedFileId>/) || [])[1] || '',
  }));
}
const tag = (s, t) => { const m = s.match(new RegExp('<' + t + '>\\s*([^<]*?)\\s*</' + t + '>')); return m ? unxml(m[1]) : null; };
const vec = (s, t) => { const m = s.match(new RegExp('<' + t + '\\s+x\\s*=\\s*"([-\\d.]+)"\\s+y\\s*=\\s*"([-\\d.]+)"\\s+z\\s*=\\s*"([-\\d.]+)"')); return m ? [+m[1], +m[2], +m[3]] : null; };
// cube block definitions in one .sbc file
export function parseBlockDefs(xml) {
  const out = [];
  for (const cb of xml.matchAll(/<CubeBlocks>([\s\S]*?)<\/CubeBlocks>/g)) for (const m of cb[1].matchAll(/<Definition\b([^>]*)>([\s\S]*?)<\/Definition>/g)) {
    const d = m[2], idm = d.match(/<Id>([\s\S]*?)<\/Id>/); if (!idm) continue;
    const xsi = (m[1].match(/xsi:type="([^"]*)"/) || [])[1] || '';
    const typeId = tag(idm[1], 'TypeId') || xsi.replace('MyObjectBuilder_', '').replace(/Definition$/, '');
    const head = d.replace(/<BuildProgressModels>[\s\S]*?<\/BuildProgressModels>/g, '').replace(/<CubeDefinition>[\s\S]*?<\/CubeDefinition>/g, m2 => m2.replace(/<Sides>[\s\S]*?<\/Sides>/, ''));
    out.push({ typeId, subtype: tag(idm[1], 'SubtypeId') || '', displayName: tag(d, 'DisplayName') || '', cubeSize: tag(d, 'CubeSize') || '',
      size: vec(d, 'Size') || [1, 1, 1], model: tag(head, 'Model'), modelOffset: vec(d, 'ModelOffset') || [0, 0, 0],
      topology: tag(d, 'CubeTopology'), public: tag(d, 'Public') !== 'false' });
  }
  return out;
}
// model triangles (metres, block centred on the origin) -> cell space. ENGINE_CONSTRAINT: small cell 0.5 m, large 2.5 m.
export const CELL_M = { Small: 0.5, Large: 2.5 };
export function modelToCell(tris, def) {
  const c = CELL_M[def.cubeSize] || 0.5, off = def.modelOffset || [0, 0, 0], t = new Float32Array(tris.length);
  for (let i = 0; i < tris.length; i += 3) for (let k = 0; k < 3; k++) t[i + k] = Math.round(((tris[i + k] + off[k]) / c + .5) * 1e4) / 1e4;
  return t;
}
// localisation keys (DisplayName_Block_...) -> English text, from Content/Data/Localization/MyTexts.resx
export function parseResx(xml) {
  const out = {};
  for (const m of xml.matchAll(/<data name="([^"]+)"[^>]*>\s*<value>([\s\S]*?)<\/value>/g)) out[m[1]] = unxml(m[2]);
  return out;
}
// a readable name for a block definition
export function blockName(d, texts) {
  const n = d.displayName;
  if (n && texts && texts[n]) return texts[n];
  if (n && !/^DisplayName_/.test(n)) return n;
  return d.subtype.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
}
// edges of a convex solid (pairs of its points that share two face planes) - a starting sketch for an existing shape
export function solidEdges(solid) {
  if (solid.type !== 'planes') return [];
  // stored planes may leave out the cell walls (the cell clips them) and are rounded, so use the hull of the corners
  const V = [];
  solid.verts.forEach(v => { const p = v.map(x => Math.round(x * 1e6) / 1e6 + 0); if (!V.some(q => near(q, p))) V.push(p); });
  const P = hullPlanes(V), out = [], seen = new Set();
  const on = V.map(v => P.map((q, i) => Math.abs(q[0] * v[0] + q[1] * v[1] + q[2] * v[2] - q[3]) < 1e-6 ? i : -1).filter(i => i >= 0));
  for (let a = 0; a < V.length; a++) for (let b = a + 1; b < V.length; b++) {
    if (near(V[a], V[b])) continue;
    const common = on[a].filter(i => on[b].includes(i));
    if (common.length < 2) continue;
    // drop segments that contain another point of the same edge line (keep the short pieces)
    if (V.some((v, c) => c !== a && c !== b && !near(v, V[a]) && !near(v, V[b]) && common.every(i => on[c].includes(i)) &&
      dot(sub(v, V[a]), sub(v, V[b])) < 0)) continue;
    const k = [V[a], V[b]].map(v => v.map(x => Math.round(x * 1e4)).join(',')).sort().join('|');
    if (seen.has(k)) continue; seen.add(k);
    out.push([V[a].map(x => Math.round(x * 1e4) / 1e4), V[b].map(x => Math.round(x * 1e4) / 1e4)]);
  }
  return out;
}
// edges of a whole shape. For several pieces, keep only real edges of their union: around the middle of each piece
// edge, look at 16 directions across it; inside all round = buried, inside on exactly one side of a line = a seam on
// a flat face; anything else is a real edge.
export function shapeEdges(shape) {
  const all = shape.solids.flatMap(solidEdges);
  if (shape.solids.length < 2) return all;
  const inCell = p => p.every(v => v >= -1e-9 && v <= 1 + 1e-9) && shapeInside(shape, p);
  const out = [], seen = new Set();
  for (const [a, b] of all) {
    const k = [a, b].map(v => v.join(',')).sort().join('|'); if (seen.has(k)) continue; seen.add(k);
    const d = sub(b, a), dl = len(d), dn = d.map(x => x / dl);
    const u0 = Math.abs(dn[0]) < 0.9 ? cross(dn, [1, 0, 0]) : cross(dn, [0, 1, 0]), u = u0.map(x => x / len(u0)), w = cross(dn, u);
    const mids = [0.3, 0.5, 0.7].map(t => a.map((x, i) => x + d[i] * t));
    let keep = false;
    for (const m of mids) {
      const ins = [];
      for (let q = 0; q < 16; q++) { const an = q * Math.PI / 8 + 0.1, r = 0.02; ins.push(inCell(m.map((x, i) => x + r * (Math.cos(an) * u[i] + Math.sin(an) * w[i])))); }
      const n = ins.filter(Boolean).length;
      const flat = ins.every((v, q) => v !== ins[(q + 8) % 16]);
      if (n > 0 && n < 16 && !flat) { keep = true; break; }
    }
    if (keep) out.push([a, b]);
  }
  return out;
}
// short unique key from a name: "Light Armor Panel" -> "P", "Half Sloped Panel" -> "HSP"
export function makeKey(name, taken) {
  const words = name.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(w => w && !/^(small|large|light|heavy|armor|armour|block|grid)$/i.test(w));
  const base = (words.map(w => /^\d/.test(w) ? w : w[0].toUpperCase()).join('') || 'X').slice(0, 4);
  let k = base, n = 2; while (taken.has(k)) k = base.slice(0, 3) + n++;
  return k;
}
