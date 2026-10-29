// SE Grid Builder: the page side of blueprint export (the Blueprint panel on the Grid Builder tab). The blueprint itself
// is built by blueprint.js. Bundled into the page by build.py; it gets the page's pieces through initBlueprintUI(ctx),
// so its own top-level names stay few (one shared module scope).
import { ROTS } from './core.js';
import { gridBlocks, blueprintXml, blueprintFolderName, makeZip, armourGrades } from './blueprint.js';

// ctx: { THREE, el, DB, B, lib() -> library, effFit(x, y, z), shapeGeometry(shape), shapeColor(shape) -> THREE.Color }
// Returns { refreshArmour() }: the page calls it when the library may have changed.
export function initBlueprintUI(ctx) {
  const { THREE, el, DB, B } = ctx;
  const status = (msg, warn) => { el('bpStatus').innerHTML = msg; el('bpStatus').className = warn ? 'warn' : 'hint'; };
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const gridSize = () => (parseFloat(el('block').value) >= 1 ? 'Large' : 'Small');
  const modelBase = () => (B.modelName || 'Grid').replace(/\.(obj|stl)$/i, '');
  const name = () => blueprintFolderName(el('bpName').value.trim() || modelBase());
  const colorFn = () => {
    const mode = el('bpColour').value;
    if (mode === 'one') { const c = el('bpColourPick').value; return () => c; }
    if (mode === 'kind') return s => '#' + ctx.shapeColor(s).getHexString();
    return null;
  };
  // Armour: vanilla light and heavy, then the grades of the library's mods (blueprint.js armourGrades)
  let wantArmour = 'light';   // the saved choice, kept while its mod is out of the list (cards switched off)
  function refreshArmour() {
    const sel = el('bpArmour'), mods = armourGrades(ctx.lib()), opt = o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`;
    sel.innerHTML = '<optgroup label="Vanilla"><option value="light">light</option><option value="heavy">heavy</option></optgroup>' +
      mods.filter(m => m.grades.length > 1).map(m => `<optgroup label="${esc(m.label)}">${m.grades.map(opt).join('')}</optgroup>`).join('') +
      (mods.some(m => m.grades.length === 1) ? `<optgroup label="Mods">${mods.filter(m => m.grades.length === 1).map(m => opt(m.grades[0])).join('')}</optgroup>` : '');
    sel.value = wantArmour; if (sel.value !== wantArmour) sel.value = 'light';
  }
  const armourLabel = () => { const o = el('bpArmour').selectedOptions[0]; if (!o) return 'light'; const g = o.parentElement.label;
    return g && g !== 'Vanilla' && g !== 'Mods' ? `${g} ${o.textContent}` : o.textContent; };
  el('bpArmour').addEventListener('change', () => { wantArmour = el('bpArmour').value; });
  // settings kept in this browser
  const SAVE = ['bpArmour', 'bpColour', 'bpColourPick'];
  DB.get('blueprint').then(s => { if (s) SAVE.forEach(id => { if (s[id] !== undefined) el(id).value = s[id]; }); if (s && s.bpArmour) wantArmour = s.bpArmour; refreshArmour(); });
  SAVE.forEach(id => el(id).addEventListener('change', () => { const s = {}; SAVE.forEach(k => s[k] = el(k).value); s.bpArmour = wantArmour; DB.set('blueprint', s).catch(() => {}); }));
  // the name field shows the model's name until one is typed
  const showDefault = () => { el('bpName').placeholder = modelBase(); };
  new MutationObserver(showDefault).observe(el('bModelName'), { childList: true, characterData: true, subtree: true }); showDefault();

  // ---- the fitted grid as blueprint blocks (user edits included; empty and "no block" cells skipped)
  function fittedBlueprint() {
    const g = B.grid; if (!g || !B.T) throw new Error('Load a model first (and wait for the fit).');
    const lib = ctx.lib(), cells = [];
    const r = gridBlocks({ nx: g.nx, ny: g.ny, nz: g.nz, centre: el('centre').value }, (x, y, z) => {
      const f = ctx.effFit(x, y, z); if (f < 0) return null;
      const t = B.T.list[f]; cells.push({ x, y, z, shape: lib[t.shape], si: t.shape, rot: t.rot }); return { shape: lib[t.shape], rot: t.rot };
    }, { size: gridSize(), armour: el('bpArmour').value, color: colorFn() });
    if (!r.blocks.length) throw new Error('The grid has no blocks to export.');
    const xml = blueprintXml({ name: name(), gridSize: gridSize(), blocks: r.blocks, mirror: r.mirror });
    return { xml, info: r, cells };
  }
  const summary = (n, info) => {
    const sk = Object.entries(info.skipped || {}).map(([k, v]) => `${v} x ${esc(k)}`);
    return `${n} blocks, ${gridSize().toLowerCase()} grid, ${esc(armourLabel())} armour.` +
      (info.other ? `<br><span class="warn">${info.other} blocks have no ${esc(armourLabel())} block on their card: they are light armour (or the card's own block).</span>` : '') +
      (sk.length ? `<br><span class="warn">Left out: ${sk.join(', ')}.</span>` : '') +
      (info.unsure ? `<br><span class="warn">${info.unsure} imported blocks have no recorded turn on their card (imported before 2026-10-11): ` +
        're-run Import from world to record it; until then they may sit turned.</span>' : '');
  };

  // ---- pictures
  // blocks drawn by the tool, as in the 3D view: cells [{ x, y, z, shape, si, rot }] in cell units, seen from
  // direction dir (towards the camera), framed to fit. Returns { canvas, cam }.
  function renderCells(cells, W, H, dir) {
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    r.setSize(W, H); r.setPixelRatio(1);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#16191d');
    scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.5)); const sun = new THREE.DirectionalLight(0xffffff, 1.3); sun.position.set(-5, 10, 3); scene.add(sun);
    const geo = new Map(), lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const c of cells) {
      const k = c.si + ':' + c.rot;
      if (!geo.has(k)) {
        const g = ctx.shapeGeometry(c.shape); if (!g) continue; const R = ROTS[c.rot];
        g.translate(-.5, -.5, -.5);
        g.applyMatrix4(new THREE.Matrix4().set(R[0][0], R[0][1], R[0][2], 0, R[1][0], R[1][1], R[1][2], 0, R[2][0], R[2][1], R[2][2], 0, 0, 0, 0, 1));
        geo.set(k, { g, e: new THREE.EdgesGeometry(g, 20) });
      }
      const { g, e } = geo.get(k);
      const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ color: ctx.shapeColor(c.shape), flatShading: true, side: THREE.DoubleSide }));
      m.position.set(c.x + .5, c.y + .5, c.z + .5); scene.add(m);
      const l = new THREE.LineSegments(e, new THREE.LineBasicMaterial({ color: 0x0d1013 })); l.position.copy(m.position); scene.add(l);
      [c.x, c.y, c.z].forEach((v, i) => { lo[i] = Math.min(lo[i], v); hi[i] = Math.max(hi[i], v + 1); });
    }
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e4, 1e4);
    const centre = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2);
    cam.position.copy(centre).add(dir.clone().normalize().multiplyScalar(100)); cam.up.set(0, 1, 0); cam.lookAt(centre);
    // fit the blocks' box into the view
    cam.updateMatrixWorld(); const inv = cam.matrixWorldInverse;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
      const q = new THREE.Vector3(x, y, z).applyMatrix4(inv); x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); y0 = Math.min(y0, q.y); y1 = Math.max(y1, q.y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2; let hw = (x1 - x0) / 2 * 1.08, hh = (y1 - y0) / 2 * 1.12;
    if (hw / hh > W / H) hh = hw * H / W; else hw = hh * W / H;
    Object.assign(cam, { left: cx - hw, right: cx + hw, top: cy + hh, bottom: cy - hh }); cam.updateProjectionMatrix();
    r.render(scene, cam);
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    out.getContext('2d').drawImage(r.domElement, 0, 0);
    geo.forEach(({ g, e }) => { g.dispose(); e.dispose(); }); r.dispose();
    return { canvas: out, cam };
  }
  // the blueprint's thumbnail: its blocks seen from the 3D view's direction
  function renderThumb(cells) {
    const v = B.view, dir = v ? v.camera.position.clone().sub(v.controls.target) : new THREE.Vector3(-1, 1, 1.5);
    return renderCells(cells, 512, 512, dir.lengthSq() ? dir : new THREE.Vector3(-1, 1, 1.5)).canvas;
  }

  // ---- delivery: straight into Blueprints\local (Chrome, Edge), else a zip download
  async function blueprintsFolder(ask) {
    let h = await DB.get('dir:blueprints');
    if (h) {
      let ok = false;
      try { ok = (await h.queryPermission({ mode: 'readwrite' })) === 'granted' || (await h.requestPermission({ mode: 'readwrite' })) === 'granted'; } catch (e) {}
      if (ok && !ask) return h;
    }
    try { h = await window.showDirectoryPicker({ id: 'sgb-blueprints', mode: 'readwrite' }); } catch (e) { return null; }
    if (h.name.toLowerCase() === 'blueprints') { try { h = await h.getDirectoryHandle('local'); } catch (e) {} }
    if (h.name.toLowerCase() !== 'local' && !confirm(`The game reads blueprints from %APPDATA%\\SpaceEngineers\\Blueprints\\local. The folder you picked is "${h.name}". Write the blueprint there anyway?`)) return null;
    DB.set('dir:blueprints', h).catch(() => {});
    return h;
  }
  async function writeFolder(folderName, files) {
    const root = await blueprintsFolder(false); if (!root) return false;
    let exists = false; try { await root.getDirectoryHandle(folderName); exists = true; } catch (e) {}
    if (exists && !confirm(`A blueprint "${folderName}" already exists in ${root.name}. Replace it?`)) return false;
    const dir = await root.getDirectoryHandle(folderName, { create: true });
    for (const f of files) {
      const fh = await dir.getFileHandle(f.name, { create: true }), w = await fh.createWritable();
      await w.write(f.data); await w.close();
    }
    // the game's binary cache of bp.sbc: it would load the old blueprint instead of the new file (StlToBlueprint does this too)
    try { await dir.removeEntry('bp.sbcB5'); } catch (e) {}
    return root.name;
  }
  async function download(folderName, files) {
    const zf = await Promise.all(files.map(async f => ({ name: folderName + '/' + f.name, data: typeof f.data === 'string' ? f.data : new Uint8Array(await f.data.arrayBuffer()) })));
    const url = URL.createObjectURL(new Blob([makeZip(zf)], { type: 'application/zip' }));
    const a = document.createElement('a'); a.href = url; a.download = folderName + '.zip'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  async function deliver(folderName, files, zip, msg) {
    if (!zip && window.showDirectoryPicker) {
      const where = await writeFolder(folderName, files);
      if (where) { status(`${msg}<br>Written to ${esc(where)}\\${esc(folderName)}. In game: F10 (Blueprints), then Ctrl+V to paste.`); return; }
      status('Not written (no folder chosen).', true); return;
    }
    await download(folderName, files);
    status(`${msg}<br>Downloaded ${esc(folderName)}.zip: unzip it into %APPDATA%\\SpaceEngineers\\Blueprints\\local (the folder ${esc(folderName)} with bp.sbc inside).`);
  }

  async function exportFitted(zip) {
    try {
      const { xml, info, cells } = fittedBlueprint(), folderName = name();
      const thumb = await new Promise(res => renderThumb(cells).toBlob(res, 'image/png'));
      await deliver(folderName, [{ name: 'bp.sbc', data: xml }, { name: 'thumb.png', data: thumb }], zip, summary(info.blocks.length, info));
    } catch (e) { status(esc(e.message), true); }
  }
  el('bpExport').addEventListener('click', () => exportFitted(false));
  el('bpZip').addEventListener('click', () => exportFitted(true));
  el('bpFolder').addEventListener('click', async () => { const h = await blueprintsFolder(true); if (h) status(`Blueprints go to ${esc(h.name)}.`); });
  if (!window.showDirectoryPicker) { el('bpExport').disabled = true; el('bpFolder').disabled = true; el('bpExport').title = 'This browser can\'t write to folders: use Download zip.'; }
  return { refreshArmour };
}
