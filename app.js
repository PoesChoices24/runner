/* Runner: library + importer + player */
(() => {
const $ = id => document.getElementById(id);

/* ---------- IndexedDB ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('runner-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) {
        const f = d.createObjectStore('files', { keyPath: ['pid', 'path'] });
        f.createIndex('lpath', 'lpath'); f.createIndex('pid', 'pid');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbp;
}
const rq = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(stores, mode); let out;
    Promise.resolve(fn(t)).then(v => out = v);
    t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted'));
  });
}
const getProject = id => tx('projects', 'readonly', t => rq(t.objectStore('projects').get(id)));
const allProjects = () => tx('projects', 'readonly', t => rq(t.objectStore('projects').getAll()));
const putProject = p => tx('projects', 'readwrite', t => { t.objectStore('projects').put(p); });
async function deleteFiles(pid) {
  await tx('files', 'readwrite', t => {
    const s = t.objectStore('files');
    s.delete(IDBKeyRange.bound([pid, ''], [pid, '\uffff']));
  });
}

/* ---------- UI helpers ---------- */
let toastT;
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, ms); }
function status(msg) { const s = $('status'); s.textContent = msg || ''; s.hidden = !msg; }
function sheet(title, buttons) {
  return new Promise(resolve => {
    $('sheetTitle').textContent = title;
    const body = $('sheetBody'); body.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button');
      el.className = 'sheet-btn' + (b.danger ? ' danger' : ''); el.textContent = b.label;
      el.onclick = () => { close(); b.action && b.action(); resolve(b.value); };
      body.appendChild(el);
    }
    const close = () => { $('sheet').hidden = true; };
    $('sheetCancel').onclick = () => { close(); resolve(null); };
    $('sheet').onclick = e => { if (e.target === $('sheet')) { close(); resolve(null); } };
    $('sheet').hidden = false;
  });
}
const fmtSize = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(0) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
const fmtDate = t => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const newId = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);

/* ---------- unpack ---------- */
const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\._[^/]*)(\/|$)/;
function unzip(u8) {
  const filter = f => !f.name.endsWith('/') && !JUNK.test(f.name);
  return new Promise((res, rej) => {
    try {
      fflate.unzip(u8, { filter }, (err, data) => {
        if (!err) return res(data);
        try { res(fflate.unzipSync(u8, { filter })); } catch (e) { rej(e); }
      });
    } catch (e) { try { res(fflate.unzipSync(u8, { filter })); } catch (e2) { rej(e2); } }
  });
}
const depth = p => p.split('/').length;
const dirOf = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
function pickEntry(paths) {
  const by = arr => arr.sort((a, b) => depth(a) - depth(b) || a.length - b.length)[0];
  return by(paths.filter(p => /(^|\/)index\.html?$/i.test(p))) || by(paths.filter(p => /\.html?$/i.test(p)));
}
function resolveIn(base, href) {
  try {
    const u = new URL(href, 'https://zip.invalid/' + base);
    if (u.origin !== 'https://zip.invalid') return null;
    return decodeURIComponent(u.pathname.slice(1));
  } catch (_) { return null; }
}
function thumb(blob) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(blob); const img = new Image();
    const done = v => { URL.revokeObjectURL(url); resolve(v); };
    img.onload = () => {
      try {
        const c = document.createElement('canvas'); c.width = c.height = 128;
        const x = c.getContext('2d'); const s = Math.max(128 / img.width, 128 / img.height) || 1;
        const w = img.width * s, h = img.height * s; x.drawImage(img, (128 - w) / 2, (128 - h) / 2, w, h);
        done(c.toDataURL('image/png'));
      } catch (_) { done(null); }
    };
    img.onerror = () => done(null);
    setTimeout(() => done(null), 4000);
    img.src = url;
  });
}
const MIMEI = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
async function findIcon(files, entryFull, html) {
  const cands = [];
  let doc;
  try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) {}
  if (doc) {
    const links = Array.from(doc.querySelectorAll('link[rel][href]'));
    const rels = r => links.filter(l => l.rel.toLowerCase().split(/\s+/).includes(r)).map(l => l.getAttribute('href'));
    cands.push(...rels('apple-touch-icon'), ...rels('icon'));
    const man = rels('manifest')[0];
    const mp = man && resolveIn(entryFull, man);
    if (mp && files[mp]) {
      try {
        const m = JSON.parse(new TextDecoder().decode(files[mp]));
        const icons = (m.icons || []).slice().sort((a, b) => parseInt(b.sizes) - parseInt(a.sizes));
        for (const i of icons) { const p = resolveIn(mp, i.src); if (p) cands.push('/' + p); }
      } catch (_) {}
    }
  }
  const root = dirOf(entryFull);
  for (const n of ['apple-touch-icon.png', 'icon.png', 'icon-512.png', 'icon-192.png', 'favicon.png', 'icons/icon-512.png', 'icons/icon-192.png', 'logo.png'])
    cands.push('/' + root + n);
  for (const c of cands) {
    if (!c) continue;
    if (c.startsWith('data:image')) { try { const b = await (await fetch(c)).blob(); const t = await thumb(b); if (t) return t; } catch (_) {} continue; }
    const p = c.startsWith('/') ? c.slice(1) : resolveIn(entryFull, c);
    const data = p && files[p];
    if (!data) continue;
    const e = (p.match(/\.([a-z]+)$/i) || [])[1];
    const t = await thumb(new Blob([data], { type: MIMEI[(e || '').toLowerCase()] || 'image/png' }));
    if (t) return t;
  }
  return null;
}

async function readInput(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  const isZip = buf[0] === 0x50 && buf[1] === 0x4b;
  if (isZip) return unzip(buf);
  if (/\.html?$/i.test(file.name) || /^\s*</.test(new TextDecoder().decode(buf.slice(0, 200))))
    return { [file.name.replace(/^.*[\\/]/, '') || 'index.html']: buf };
  throw new Error('That file is not a ZIP or HTML file.');
}

async function importFile(file, updateId) {
  status('Unpacking ' + file.name + '…');
  try {
    const raw = await readInput(file);
    const files = {};
    for (const [k, v] of Object.entries(raw)) {
      const p = k.replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '');
      if (p && !p.endsWith('/') && !JUNK.test(p)) files[p] = v;
    }
    const paths = Object.keys(files);
    const entryFull = pickEntry(paths);
    if (!entryFull) throw new Error('No .html file found in ' + file.name);
    const root = dirOf(entryFull), entry = entryFull.slice(root.length);
    const html = new TextDecoder().decode(files[entryFull]);
    const title = ((/<title[^>]*>([^<]*)<\/title>/i.exec(html) || [])[1] || '').trim();
    const icon = await findIcon(files, entryFull, html);
    const old = updateId ? await getProject(updateId) : null;
    const id = old ? old.id : newId();
    const size = paths.reduce((n, p) => n + files[p].byteLength, 0);
    status('Saving ' + paths.length + ' files…');
    if (old) await deleteFiles(id);
    await tx('files', 'readwrite', t => {
      const s = t.objectStore('files');
      for (const p of paths) {
        const u = files[p];
        const data = (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) ? u.buffer : u.slice().buffer;
        s.put({ pid: id, path: p, lpath: id + '\n' + p.toLowerCase(), data });
      }
    });
    const now = Date.now();
    const proj = Object.assign({}, old || {}, {
      id, root, entry, size, fileCount: paths.length, updated: now, created: old ? old.created : now,
      source: file.name, icon: icon || (old && old.icon) || null,
      name: old ? old.name : (title || file.name.replace(/\.(zip|html?)$/i, '') || 'Untitled')
    });
    await putProject(proj);
    status('');
    toast((old ? 'Updated ' : 'Imported ') + proj.name + (old ? ' (saves kept)' : ''));
    askPersist();
    await render();
    return proj;
  } catch (e) {
    status(''); console.error(e); toast('Import failed: ' + (e.message || e), 5000);
    throw e;
  }
}

/* ---------- storage ---------- */
async function askPersist() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch (_) {}
  storageInfo();
}
async function storageInfo() {
  let s = '';
  try {
    if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); s = fmtSize(e.usage || 0) + ' used'; }
    if (navigator.storage && navigator.storage.persisted) s += (await navigator.storage.persisted()) ? ' · persistent' : ' · best-effort storage';
  } catch (_) {}
  $('storageInfo').textContent = s;
}

/* ---------- library ---------- */
function hue(s) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
async function render() {
  const list = (await allProjects()).sort((a, b) => (b.lastPlayed || b.updated) - (a.lastPlayed || a.updated));
  const el = $('list'); el.innerHTML = '';
  $('empty').hidden = list.length > 0;
  for (const p of list) {
    const row = document.createElement('div'); row.className = 'item'; row.dataset.id = p.id;
    const icon = p.icon ? `<img class="icon" src="${p.icon}" alt="">`
      : `<div class="icon" style="background:hsl(${hue(p.name)} 45% 38%)">${esc((p.name[0] || '?').toUpperCase())}</div>`;
    row.innerHTML = `${icon}<div class="meta"><div class="name">${esc(p.name)}</div>
      <div class="sub">${p.lastPlayed ? 'Played ' + fmtDate(p.lastPlayed) : 'Added ' + fmtDate(p.created)} · ${p.fileCount} file${p.fileCount === 1 ? '' : 's'} · ${fmtSize(p.size)}</div></div>
      <button class="more" aria-label="Options">⋯</button>`;
    row.onclick = e => { if (e.target.closest('.more')) projectMenu(p); else launch(p.id); };
    el.appendChild(row);
  }
  storageInfo();
}

let updateTarget = null, savesTarget = null;
async function projectMenu(p) {
  const s = await Saves.summary(p.id).catch(() => ({ keys: 0, dbs: 0 }));
  sheet(`${p.name} · saves: ${s.keys} key${s.keys === 1 ? '' : 's'}${s.dbs ? ', ' + s.dbs + ' DB' : ''}`, [
    { label: '▶︎  Play', action: () => launch(p.id) },
    { label: '✎  Rename', action: () => rename(p) },
    { label: '⟳  Update from file (keeps saves)', action: () => { updateTarget = p.id; $('updateIn').click(); } },
    { label: '⇩  Export saves (JSON)', action: () => exportSaves(p) },
    { label: '⇧  Import saves (JSON)', action: () => { savesTarget = p.id; $('savesIn').click(); } },
    { label: '⌫  Reset saves', danger: true, action: () => resetSaves(p) },
    { label: '🗑  Delete project', danger: true, action: () => del(p) }
  ]);
}
async function rename(p) {
  const n = prompt('Rename project', p.name);
  if (n && n.trim()) { p.name = n.trim(); await putProject(p); render(); }
}
async function del(p) {
  if (!confirm(`Delete “${p.name}”?`)) return;
  const alsoSaves = confirm('Also delete its save data?\n\nOK = delete saves too. Cancel = keep them in storage (export them first if you might want them back).');
  await deleteFiles(p.id);
  await tx('projects', 'readwrite', t => { t.objectStore('projects').delete(p.id); });
  if (alsoSaves) await Saves.deleteSaves(p.id).catch(() => {});
  toast('Deleted ' + p.name); render();
}
async function resetSaves(p) {
  if (!confirm(`Erase all save data for “${p.name}”? Export first if you want a backup.`)) return;
  await Saves.deleteSaves(p.id); toast('Saves reset');
}
async function exportSaves(p) {
  try {
    const data = await Saves.exportSaves(p);
    const fname = p.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '-saves-' + new Date().toISOString().slice(0, 10) + '.json';
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const file = new File([blob], fname, { type: 'application/json' });
    const download = () => {
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fname;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
    };
    window.__lastExport = data;   // used by tests
    const btns = [];
    if (navigator.canShare && navigator.canShare({ files: [file] }))
      btns.push({ label: '⇪  Share / Save to Files', action: () => navigator.share({ files: [file], title: fname }).catch(() => {}) });
    btns.push({ label: '⇩  Download ' + fname, action: download });
    sheet('Save backup ready (' + fmtSize(blob.size) + ')', btns);
  } catch (e) { toast('Export failed: ' + e.message, 5000); }
}

/* ---------- player ---------- */
let current = null;
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
async function launch(id, fromHistory) {
  const p = await getProject(id);
  if (!p) { toast('Project not found'); return; }
  if ('serviceWorker' in navigator) { await swReady; }
  current = p; $('toast').hidden = true;
  p.lastPlayed = Date.now(); putProject(p);
  // A fresh iframe per launch: removing it on close fully stops the game (audio, timers, DB connections)
  // and never adds entries to the joint session history.
  const old = $('frame'); if (old) old.remove();
  const f = document.createElement('iframe');
  f.id = 'frame'; f.title = p.name;
  f.allow = 'autoplay; fullscreen; gamepad; accelerometer; gyroscope; clipboard-read; clipboard-write; screen-wake-lock';
  f.src = 'run/' + id + '/' + encPath(p.entry);
  $('player').insertBefore(f, $('handle'));
  $('player').hidden = false; $('library').hidden = true;
  document.title = p.name;
  if (!fromHistory) history.pushState({ play: id }, '', '#play/' + id);
  $('frame').onload = () => { try { $('frame').contentWindow.focus(); } catch (_) {} };
}
function closePlayer(fromHistory) {
  if (!current) return;
  current = null;
  const f = $('frame'); if (f) f.remove();
  $('player').hidden = true; $('library').hidden = false;
  document.title = 'Runner';
  if (!fromHistory && history.state && history.state.play) history.back();
  render();
}
window.addEventListener('popstate', () => {
  const m = /^#play\/(.+)$/.exec(location.hash);
  if (m && !current) launch(m[1], true); else if (!m && current) closePlayer(true);
});

/* draggable handle: tap = menu, drag = move (snaps to a side, position remembered) */
(() => {
  const h = $('handle');
  let sx, sy, ox, oy, moved = false, dragging = false;
  const place = pos => {
    if (!pos) return;
    h.style.top = Math.max(0, Math.min(innerHeight - 52, pos.y)) + 'px';
    h.style.left = pos.side === 'left' ? 'var(--sl)' : 'auto';
    h.style.right = pos.side === 'left' ? 'auto' : 'var(--sr)';
    h.classList.toggle('left', pos.side === 'left');
  };
  try { place(JSON.parse(localStorage.getItem('runner.handle'))); } catch (_) {}
  h.addEventListener('pointerdown', e => { dragging = true; moved = false; sx = e.clientX; sy = e.clientY; const r = h.getBoundingClientRect(); ox = r.left; oy = r.top; h.setPointerCapture(e.pointerId); });
  h.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (!moved && Math.hypot(dx, dy) < 8) return;
    moved = true; h.style.left = (ox + dx) + 'px'; h.style.right = 'auto'; h.style.top = (oy + dy) + 'px';
  });
  h.addEventListener('pointerup', e => {
    dragging = false;
    if (!moved) return playerMenu();
    const pos = { side: e.clientX < innerWidth / 2 ? 'left' : 'right', y: oy + e.clientY - sy };
    localStorage.setItem('runner.handle', JSON.stringify(pos)); place(pos);
  });
})();
function playerMenu() {
  const p = current; if (!p) return;
  sheet(p.name, [
    { label: '←  Back to library', action: () => closePlayer() },
    { label: '⟳  Reload game', action: () => { try { $('frame').contentWindow.location.reload(); } catch (_) { launch(p.id, true); } } },
    { label: '⇩  Export saves (JSON)', action: () => exportSaves(p) }
  ]);
}

/* ---------- wiring ---------- */
$('importBtn').onclick = () => $('fileIn').click();
$('fileIn').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f).catch(() => {}); };
$('updateIn').onchange = async e => { const f = e.target.files[0]; e.target.value = ''; if (f && updateTarget) importFile(f, updateTarget).catch(() => {}); updateTarget = null; };
$('savesIn').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f || !savesTarget) return;
  const id = savesTarget; savesTarget = null;
  try {
    const data = JSON.parse(await f.text());
    if (data.project && data.project.id !== id && !confirm(`This backup is from “${data.project.name}”. Load it into this project anyway?`)) return;
    await Saves.importSaves(id, data); toast('Saves restored');
  } catch (err) { toast('Import failed: ' + err.message, 5000); }
};
$('urlBtn').onclick = async () => {
  const u = prompt('Link to a .zip or .html file (the server must allow cross-origin downloads, e.g. GitHub raw / release links):');
  if (!u) return;
  try {
    status('Downloading…');
    const r = await fetch(u); if (!r.ok) throw new Error('HTTP ' + r.status);
    const name = decodeURIComponent(new URL(u).pathname.split('/').pop() || 'project.zip');
    await importFile(new File([await r.blob()], name));
  } catch (e) { status(''); toast('Download failed: ' + e.message + ' (download the file and use Import instead)', 6000); }
};
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) importFile(f).catch(() => {}); });

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
if (isIOS && !standalone && !localStorage.getItem('runner.hideHint')) $('installHint').hidden = false;
$('hideHint').onclick = () => { $('installHint').hidden = true; localStorage.setItem('runner.hideHint', '1'); };

let swReady = Promise.resolve();
if ('serviceWorker' in navigator) {
  swReady = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(e => { console.error(e); toast('Offline/serving unavailable: ' + e.message, 6000); });
} else {
  toast('This browser has no service worker support; projects cannot run.', 6000);
}

async function checkShared() {
  const rec = await tx('meta', 'readonly', t => rq(t.objectStore('meta').get('pending-share'))).catch(() => null);
  if (!rec) return;
  await tx('meta', 'readwrite', t => { t.objectStore('meta').delete('pending-share'); });
  await importFile(new File([rec.data], rec.name, { type: rec.type || '' })).catch(() => {});
  if (location.search) history.replaceState(null, '', location.pathname + location.hash);
}

window.Runner = { importFile, launch, closePlayer, exportSaves: p => Saves.exportSaves(p), getProject, allProjects };
render().then(checkShared).then(() => {
  const m = /^#play\/(.+)$/.exec(location.hash);
  if (m) { history.replaceState({ play: m[1] }, '', location.hash); launch(m[1], true); }
});
})();
