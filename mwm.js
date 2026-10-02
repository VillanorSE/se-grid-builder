// Reads triangles from a Space Engineers .mwm model (the classic tagged layout written by MwmBuilder, "Version:01157001"
// and similar). Header: "Debug" tag + strings, then an index of (tag name, byte offset). Each tag's data starts with
// its name again. Vertices are HalfVector4 (x, y, z, scale); position = xyz * scale. MeshParts hold int32 indices.
// Returns { tris: Float32Array (9 floats per triangle, model metres), bbox: [min, max] | null } or throws.

function halfToFloat(h) {
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function readMwm(buf) {
  const dv = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
  const u8 = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
  let p = 0;
  const i32 = () => { const v = dv.getInt32(p, true); p += 4; return v; };
  const str = () => {
    let n = 0, sh = 0, c;
    do { c = u8[p++]; n |= (c & 0x7f) << sh; sh += 7; } while (c & 0x80);
    if (n > 4096 || p + n > u8.length) throw new Error('bad string');
    let s = ''; for (let k = 0; k < n; k++) s += String.fromCharCode(u8[p + k]); p += n; return s;
  };
  if (str() !== 'Debug') throw new Error('not an mwm model');
  const nd = i32(); for (let k = 0; k < nd; k++) str();
  const ni = i32(), index = {};
  if (ni < 1 || ni > 200) throw new Error('unsupported mwm layout');
  for (let k = 0; k < ni; k++) { const name = str(); index[name] = i32(); }
  if (!('Vertices' in index) || !('MeshParts' in index)) throw new Error('mwm has no Vertices/MeshParts');

  p = index.Vertices; if (str() !== 'Vertices') throw new Error('bad Vertices offset');
  const nv = i32();
  if (nv < 0 || p + nv * 8 > u8.length) throw new Error('bad vertex count');
  const verts = new Float32Array(nv * 3);
  for (let k = 0; k < nv; k++) {
    const x = halfToFloat(dv.getUint16(p, true)), y = halfToFloat(dv.getUint16(p + 2, true)),
      z = halfToFloat(dv.getUint16(p + 4, true)), w = halfToFloat(dv.getUint16(p + 6, true));
    p += 8; verts[k * 3] = x * w; verts[k * 3 + 1] = y * w; verts[k * 3 + 2] = z * w;
  }

  let bbox = null;
  if ('BoundingBox' in index) {
    p = index.BoundingBox; str();
    const f = [0, 1, 2, 3, 4, 5].map(k => dv.getFloat32(p + 4 * k, true));
    bbox = [f.slice(0, 3), f.slice(3)];
  }

  p = index.MeshParts; str();
  const np = i32(), idx = [];
  if (np < 0 || np > 1000) throw new Error('bad mesh part count');
  for (let q = 0; q < np; q++) {
    i32();                                   // material hash
    const n = i32();
    if (n < 0 || p + n * 4 > u8.length) throw new Error('bad index count');
    for (let k = 0; k < n; k++) idx.push(i32());
    if (u8[p++]) {                           // has material
      str();                                 // material name
      const nt = i32(); if (nt < 0 || nt > 64) throw new Error('bad texture count');
      for (let k = 0; k < nt; k++) { str(); str(); }                     // textures
      // user-data dict, then the technique name. Older files (e.g. 01097001) put a float and two vec3s (specular and
      // colour values, 28 bytes) between the two; try without them first.
      const nu = i32(); if (nu < 0 || nu > 64) throw new Error('bad user data count');
      for (let k = 0; k < nu; k++) { str(); str(); }
      const at = p, tech = () => { try { const t = str(); return /^[A-Z_0-9]{2,32}$/.test(t) ? t : null; } catch (e) { return null; } };
      let t = tech();
      if (!t) { p = at + 28; t = tech(); }
      if (!t) throw new Error('unknown material layout');
      if (t === 'GLASS') { str(); str(); p++; }      // glass adds CW/CCW material names and a smooth flag
    }
  }
  const tris = new Float32Array(Math.floor(idx.length / 3) * 9);
  for (let t = 0; t + 2 < idx.length; t += 3) for (let c = 0; c < 3; c++) {
    const v = idx[t + c]; if (v < 0 || v >= nv) throw new Error('index out of range');
    tris.set(verts.subarray(v * 3, v * 3 + 3), (t + c) * 3);
  }
  return { tris, bbox };
}
