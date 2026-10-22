(function () {
'use strict';
const $ = (s) => document.querySelector(s);
const st = { bytes: null, proj: null, name: 'project', photos: [], repl: [], last: null, busy: false };
let nextId = 1;

// ---------- small helpers ----------
function log(msg, cls) { const d = document.createElement('div'); if (cls) d.className = cls; d.textContent = msg; $('#log').appendChild(d); $('#log').scrollTop = 1e9; }
function setStatus(t) { const s = $('#status'); if (t) { s.textContent = t; s.style.display = 'block'; } else s.style.display = 'none'; }
function setBusy(on, text) { st.busy = on; setStatus(on ? text : ''); refresh(); }
const tick = () => new Promise((r) => setTimeout(r, 0));
const chk = (id) => $('#' + id).checked;
const fmtBytes = (n) => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1e3)) + ' KB';
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
function download(name, data, mime) {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 120000);
}
const canvasBlob = (cv, type, q) => new Promise((res) => cv.toBlob(res, type, q));
function el(tag, props, kids) { const e = document.createElement(tag); Object.assign(e, props || {}); (kids || []).forEach((k) => e.append(k)); return e; }
const mode = () => document.querySelector('input[name=mode]:checked').value;

function refresh() {
  const has = !!st.proj, b = st.busy;
  ['b-zip', 'b-flat-png', 'b-flat-jpg'].forEach((id) => { $('#' + id).disabled = b || !has; });
  $('#m-add').disabled = !has; if (!has && $('#m-add').checked) $('#m-new').checked = true;
  $('#b-build').disabled = b || !st.photos.length || (mode() === 'add' && !has);
  $('#b-repl').disabled = b || !has || !st.repl.some((r) => r.ok);
  $('#new-opts').hidden = mode() === 'add';
  $('#s-extract').hidden = !has; $('#s-replace').hidden = !has;
}

// ---------- 1. open ----------
async function openProject(file) {
  setBusy(true, 'Reading ' + file.name + ' …'); await tick();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer()), proj = IPV.readProject(bytes);
    st.bytes = bytes; st.proj = proj; st.name = IPV.safeName(file.name.replace(/\.ipv$/i, '')) || 'project';
    showProject(file); $('#m-add').disabled = false; $('#m-add').checked = true; $('#x-orig').checked = proj.embedded.length > 0;
    log('Opened ' + file.name + ' (' + fmtBytes(file.size) + '): canvas ' + proj.canvas.w + '×' + proj.canvas.h + ', ' + proj.stack.length + ' layers.');
    await makeThumbs();
  } catch (e) { st.proj = null; st.bytes = null; $('#summary').hidden = true; log('Cannot read this file: ' + e.message, 'err'); }
  setBusy(false);
}
function showProject(file) {
  const p = st.proj, s = $('#summary'); s.hidden = false; s.textContent = '';
  const lines = [['File', file.name + ' (' + fmtBytes(file.size) + ')'], ['Title', p.title], ['Canvas', p.canvas.w + ' × ' + p.canvas.h + (p.origW !== p.canvas.w || p.origH !== p.canvas.h ? '  (created as ' + p.origW + ' × ' + p.origH + ')' : '')],
    ['Layers', String(p.stack.length) + ' (' + p.stack.filter((l) => l.hasPixels).length + ' with pixels)'], ['Made with', p.app ? p.app.name + ' ' + p.app.version + ', ' + p.app.device : 'unknown'],
    ['History', p.sessions + ' sessions, ' + p.records.length + ' records, ' + p.embedded.length + ' photo(s) stored']];
  lines.forEach(([k, v]) => s.append(el('div', {}, [el('b', { textContent: k + ': ' }), document.createTextNode(v)])));
  const ul = $('#layer-list'); ul.textContent = '';
  p.stack.forEach((L, i) => {
    const cv = el('canvas', { width: 128, height: 128, className: 'thumb' });
    const tags = el('div', { className: 'meta' });
    [L.kind === 'folder' ? 'folder' : (L.hasPixels ? 'pixels' : 'empty'), L.visible ? 'visible' : 'hidden', Math.round(L.opacity * 100) + '%'].forEach((t) => tags.append(el('span', { className: 'tag', textContent: t })));
    if (L.blend) tags.append(el('span', { className: 'tag', textContent: 'blend ' + L.blend }));
    if (L.parent !== -5 && L.parent !== -2147483648) tags.append(el('span', { className: 'tag', textContent: 'in folder ' + L.parent }));
    const btns = el('div', { className: 'row' });
    if (L.hasPixels) {
      btns.append(el('button', { className: 'btn small sec', textContent: 'PNG', onclick: () => saveLayer(L, false) }), el('button', { className: 'btn small sec', textContent: 'Cropped', onclick: () => saveLayer(L, true) }));
    }
    ul.append(el('li', { id: 'lay-' + L.id }, [cv, el('div', { className: 'grow' }, [el('div', { className: 'name', textContent: (i + 1) + '.  ' + (L.name || (L.kind === 'folder' ? 'Folder' : 'Layer') + ' ' + L.id) }), tags, btns])]));
  });
  const ol = $('#orig-list'); ol.textContent = '';
  if (p.embedded.length) {
    ol.append(el('h2', { textContent: 'Original photos in the history', style: 'margin-top:14px' }));
    p.embedded.forEach((e, k) => ol.append(el('div', { className: 'row' }, [el('span', { textContent: 'Photo ' + (k + 1) + ' (' + fmtBytes(e.png.length) + ')' }), el('button', { className: 'btn small sec', textContent: 'Download PNG', onclick: () => download(st.name + '_original_' + (k + 1) + '.png', e.png, 'image/png') })])));
  }
  refresh();
}
async function makeThumbs() {
  const layers = st.proj.stack.filter((L) => L.hasPixels);
  await IPV.mapLimit(layers, IPV.concurrency, async (L) => {
    const li = $('#lay-' + L.id); if (!li) return;
    try { drawThumb(li.querySelector('canvas'), await IPV.runTask('layerThumb', [IPV.own(L.image.data), 128])); } catch (e) { log('Layer ' + L.id + ': ' + e.message, 'err'); }
  });
}
function drawThumb(cv, px) {
  const tmp = el('canvas', { width: px.width, height: px.height });
  tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.data.buffer, px.data.byteOffset, px.data.length), px.width, px.height), 0, 0);
  const s = Math.min(cv.width / px.width, cv.height / px.height), w = px.width * s, h = px.height * s, c = cv.getContext('2d'); c.imageSmoothingQuality = 'high';
  c.clearRect(0, 0, cv.width, cv.height); c.drawImage(tmp, (cv.width - w) / 2, (cv.height - h) / 2, w, h);
}

// ---------- 2. extract ----------
async function saveLayer(L, cropped) {
  setBusy(true, 'Saving layer ' + L.id + ' …'); await tick();
  try {
    const r = await IPV.runTask('layerToPng', [IPV.own(L.image.data), { full: !cropped, cropped }]);
    const png = cropped ? r.cropped : r.full, nm = st.name + '_layer' + L.id + (cropped ? '_x' + r.bbox.x + '_y' + r.bbox.y : '') + '.png';
    download(nm, png, 'image/png'); log('Saved ' + nm + ' (' + fmtBytes(png.length) + ')');
  } catch (e) { log('Could not save layer: ' + e.message, 'err'); }
  setBusy(false);
}
$('#b-zip').onclick = async () => {
  const o = { layers: chk('x-layers'), trimmed: chk('x-trim'), flattened: chk('x-flat'), appPreview: chk('x-prev'), originals: chk('x-orig'), manifest: chk('x-man'), includeHidden: chk('x-hidden') };
  if (!Object.values(o).some(Boolean)) { log('Choose at least one thing to export.', 'err'); return; }
  setBusy(true, 'Preparing ZIP …'); await tick();
  try {
    o.onProgress = (m, i, n) => setStatus(m + '  (' + i + '/' + n + ')');
    const files = await IPV.extractFiles(st.proj, o); setStatus('Packing ZIP …'); await tick();
    const zip = IPV.zipStore(files); download(st.name + '_extract.zip', zip, 'application/zip');
    log('ZIP saved: ' + files.length + ' files, ' + fmtBytes(zip.length) + '.'); (st.proj.warnings || []).forEach((w) => log('Note: ' + w));
  } catch (e) { log('ZIP failed: ' + e.message, 'err'); }
  setBusy(false);
};
async function flattened(type) {
  setBusy(true, 'Flattening …'); await tick();
  try {
    const r = await IPV.flatten(st.proj, { includeHidden: false, raw: type === 'jpg' });
    if (type === 'png') { download(st.name + '_flattened.png', r.png, 'image/png'); log('Saved flattened PNG (' + fmtBytes(r.png.length) + ').'); }
    else { const cv = el('canvas', { width: r.width, height: r.height }); cv.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.data.buffer, r.data.byteOffset, r.data.length), r.width, r.height), 0, 0); const b = await canvasBlob(cv, 'image/jpeg', 0.93); download(st.name + '_flattened.jpg', b); log('Saved flattened JPG (' + fmtBytes(b.size) + ').'); }
  } catch (e) { log('Could not flatten: ' + e.message, 'err'); }
  setBusy(false);
}
$('#b-flat-png').onclick = () => flattened('png');
$('#b-flat-jpg').onclick = () => flattened('jpg');

// ---------- 3. photos ----------
async function bitmapOf(file) { try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { return createImageBitmap(file); } }
async function addPhoto(f) {
  try {
    const bmp = await bitmapOf(f), s = Math.min(1, 128 / Math.max(bmp.width, bmp.height)), cv = el('canvas', { width: Math.max(1, Math.round(bmp.width * s)), height: Math.max(1, Math.round(bmp.height * s)) });
    cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
    st.photos.push({ id: nextId++, file: f, name: f.name, w: bmp.width, h: bmp.height, thumb: cv.toDataURL('image/png') }); if (bmp.close) bmp.close();
  } catch (e) { log('Cannot read image "' + f.name + '" (' + (f.type || 'unknown type') + '). Phones often save HEIC photos – convert them to JPG or PNG first.', 'err'); }
}
function renderPhotos() {
  const ul = $('#photo-list'); ul.textContent = '';
  st.photos.forEach((p, i) => {
    const move = (d) => () => { const j = i + d; if (j < 0 || j >= st.photos.length) return; [st.photos[i], st.photos[j]] = [st.photos[j], st.photos[i]]; renderPhotos(); };
    ul.append(el('li', {}, [el('img', { className: 'thumb', src: p.thumb, alt: '' }), el('div', { className: 'grow' }, [el('div', { className: 'name', textContent: (i + 1) + '.  ' + p.name }), el('div', { className: 'meta', textContent: p.w + ' × ' + p.h + ' px, ' + fmtBytes(p.file.size) })]),
      el('div', { className: 'row' }, [el('button', { className: 'btn small sec', textContent: '↑', title: 'Move up', onclick: move(-1) }), el('button', { className: 'btn small sec', textContent: '↓', title: 'Move down', onclick: move(1) }),
        el('button', { className: 'btn small sec', textContent: '✕', title: 'Remove', onclick: () => { st.photos.splice(i, 1); renderPhotos(); } })])]));
  });
  refresh();
}
$('#file-photos').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files); e.target.value = ''; if (!files.length) return;
  setBusy(true, 'Reading photos …'); await tick();
  for (const f of files) await addPhoto(f);
  setBusy(false); renderPhotos();
});
function orderedPhotos() {
  const a = st.photos.slice(), o = $('#o-order').value;
  if (o === 'name') a.sort((x, y) => natural(x.name, y.name)); else if (o === 'rev') a.reverse();
  return a;
}
function targetCanvas(list) {
  const sel = $('#o-size').value; let W, H;
  if (sel === 'custom') return { W: Math.max(16, Math.min(8192, Math.round(+$('#o-w').value) || 1080)), H: Math.max(16, Math.min(8192, Math.round(+$('#o-h').value) || 1920)) };
  const pick = sel === 'first' ? list[0] : list.reduce((a, b) => (a.w * a.h >= b.w * b.h ? a : b)); W = pick.w; H = pick.h;
  const max = +$('#o-max').value;
  if (max && Math.max(W, H) > max) { const k = max / Math.max(W, H); W = Math.max(16, Math.round(W * k)); H = Math.max(16, Math.round(H * k)); }
  return { W, H };
}
// returns RGBA (W*H*4) with the image placed on a transparent canvas
async function fitToCanvas(file, W, H, fit, pos) {
  if (/png/i.test(file.type) || /\.png$/i.test(file.name)) {   // exact path for PNG files that already have the right size
    try { const png = await IPV.pngDecode(new Uint8Array(await file.arrayBuffer())); if (png.width === W && png.height === H) return png.data; } catch (e) { /* use the canvas path */ }
  }
  const bmp = await bitmapOf(file), bw = bmp.width, bh = bmp.height; let dw, dh, dx, dy;
  if (pos) { dw = bw; dh = bh; dx = pos.x; dy = pos.y; }
  else if (fit === 'stretch') { dw = W; dh = H; dx = 0; dy = 0; }
  else if (fit === 'center') { dw = bw; dh = bh; dx = Math.round((W - bw) / 2); dy = Math.round((H - bh) / 2); }
  else { const s = fit === 'cover' ? Math.max(W / bw, H / bh) : Math.min(W / bw, H / bh); dw = Math.round(bw * s); dh = Math.round(bh * s); dx = Math.round((W - dw) / 2); dy = Math.round((H - dh) / 2); }
  const cv = el('canvas', { width: W, height: H }), c = cv.getContext('2d', { willReadFrequently: true });
  c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high'; c.drawImage(bmp, dx, dy, dw, dh); if (bmp.close) bmp.close();
  const d = c.getImageData(0, 0, W, H).data; return new Uint8Array(d.buffer, d.byteOffset, d.length);
}
async function build() {
  const list = orderedPhotos(); if (!list.length) return;
  const md = mode(); let W, H;
  if (md === 'add') { if (!st.proj) { log('Open an .ipv file first (step 1).', 'err'); return; } W = st.proj.canvas.w; H = st.proj.canvas.h; } else ({ W, H } = targetCanvas(list));
  const mb = (W * H * 4 * (list.length + 5 * IPV.concurrency)) / 1e6;
  if (mb > 700 && !confirm('This needs about ' + Math.round(mb) + ' MB of memory and may crash a phone browser. Continue?')) return;
  setBusy(true, 'Preparing photos …'); await tick();
  try {
    const images = [], fit = $('#o-fit').value;
    for (let i = 0; i < list.length; i++) { setStatus('Preparing photo ' + (i + 1) + ' of ' + list.length + ' …'); await tick(); images.push({ name: list[i].name, data: await fitToCanvas(list[i].file, W, H, fit) }); }
    const opts = { embedHistory: chk('o-hist'), nameLayers: chk('o-names'), newIdentity: chk('o-copy'), onProgress: (m, i, n) => setStatus(m + '  (' + (i + 1) + '/' + n + ')') };
    let out, fname;
    setStatus('Building the project …'); await tick();
    if (md === 'add') { out = await IPV.addLayers(st.bytes, images, opts); fname = st.name + '_plus_photos.ipv'; }
    else { const title = ($('#o-title').value || 'Photos').trim().slice(0, 40) || 'Photos'; out = await IPV.buildNew(images, Object.assign({ width: W, height: H, title }, opts)); fname = (IPV.safeName(title) || 'Photos') + '.ipv'; }
    st.last = { name: fname, data: out }; download(fname, out, 'application/octet-stream'); $('#b-again').hidden = false;
    log('Built ' + fname + ': ' + list.length + ' layer(s), canvas ' + W + '×' + H + ', ' + fmtBytes(out.length) + '.');
  } catch (e) { log('Build failed: ' + e.message, 'err'); console.error(e); }
  setBusy(false);
}
$('#b-build').onclick = build;
$('#b-again').onclick = () => { if (st.last) download(st.last.name, st.last.data, 'application/octet-stream'); };

// ---------- 4. replace ----------
$('#file-repl').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files); e.target.value = ''; st.repl = [];
  const ids = new Set(st.proj ? st.proj.stack.filter((l) => l.kind !== 'folder').map((l) => l.id) : []);
  files.forEach((f) => { const m = /layer\s*(\d+)/i.exec(f.name), id = m ? parseInt(m[1], 10) : null, pm = /_x(\d+)_y(\d+)/i.exec(f.name); st.repl.push({ file: f, id, ok: id !== null && ids.has(id), pos: pm ? { x: +pm[1], y: +pm[2] } : null }); });
  const ul = $('#repl-list'); ul.textContent = '';
  st.repl.forEach((r) => ul.append(el('li', {}, [el('div', { className: 'grow' }, [el('div', { className: 'name', textContent: r.file.name }), el('div', { className: 'meta', textContent: r.ok ? 'replaces layer ' + r.id + (r.pos ? ' at x=' + r.pos.x + ', y=' + r.pos.y : '') : 'no layer number found in the name – will be skipped' })])])));
  refresh();
});
$('#b-repl').onclick = async () => {
  setBusy(true, 'Replacing …'); await tick();
  try {
    const W = st.proj.canvas.w, H = st.proj.canvas.h, map = new Map();
    for (const r of st.repl.filter((x) => x.ok)) { setStatus('Preparing layer ' + r.id + ' …'); await tick(); map.set(r.id, await fitToCanvas(r.file, W, H, 'contain', r.pos)); }
    const out = await IPV.replaceLayers(st.bytes, map, { newIdentity: chk('o-copy') }), nm = st.name + '_edited.ipv';
    st.last = { name: nm, data: out }; download(nm, out, 'application/octet-stream'); $('#b-again').hidden = false; log('Built ' + nm + ' with ' + map.size + ' replaced layer(s), ' + fmtBytes(out.length) + '.');
  } catch (e) { log('Replace failed: ' + e.message, 'err'); console.error(e); }
  setBusy(false);
};

// ---------- wiring ----------
$('#file-ipv').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) openProject(f); });
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', refresh));
$('#o-size').addEventListener('change', () => { $('#custom-size').hidden = $('#o-size').value !== 'custom'; });

// ---------- background workers (several image jobs at once; falls back to this thread when workers are not available) ----------
function startPool() {
  if (!window.Worker) return null;
  const n = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1)); let workers;
  try { workers = Array.from({ length: n }, () => new Worker('worker.js?v=1')); } catch (e) { return null; }
  const pool = { n, workers, free: workers.slice(), queue: [] };
  const pump = () => {
    while (pool.free.length && pool.queue.length) {
      const w = pool.free.pop(), job = pool.queue.shift(), seen = new Set(), tr = []; w.job = job;
      job.args.forEach((a) => { if (a && ArrayBuffer.isView(a) && a.buffer instanceof ArrayBuffer && !seen.has(a.buffer)) { seen.add(a.buffer); tr.push(a.buffer); } });
      w.postMessage({ name: job.name, args: job.args }, tr);
    }
  };
  workers.forEach((w) => {
    w.onmessage = (e) => { const job = w.job; w.job = null; pool.free.push(w); if (e.data.ok) job.res(e.data.res); else job.rej(new Error(e.data.err)); pump(); };
    w.onerror = (e) => { const job = w.job; w.job = null; if (job) job.rej(new Error(e.message || 'worker error')); };
  });
  pool.run = (name, args) => new Promise((res, rej) => { pool.queue.push({ name, args, res, rej }); pump(); });
  return pool;
}
async function initPool() {
  const pool = startPool(); if (!pool) return;
  try {
    const r = await Promise.race([pool.run('pngEncode', [1, 1, new Uint8Array(4)]), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))]);
    if (!r || !r.length) throw new Error('bad reply');
  } catch (e) { pool.workers.forEach((w) => w.terminate()); return; }      // stay on this thread
  IPV.executor = (name, args) => pool.run(name, args); IPV.concurrency = pool.n; st.pool = pool;
  log('Fast mode on: ' + pool.n + ' background workers.');
}
window.IPVTOOL = { state: st };      // for testing
if (typeof CompressionStream === 'undefined' || typeof DecompressionStream === 'undefined') log('This browser is too old (no CompressionStream). Please use a current Chrome, Edge, Firefox or Safari.', 'err');
refresh();
initPool();
})();
