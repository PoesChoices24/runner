/* Runner service worker: offline app shell + serves imported projects from IndexedDB under ./run/<id>/... */
const VERSION = 'runner-v1.0.0';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'saves.js', 'vendor/fflate.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
const SCOPE = new URL(self.registration.scope);
const RUN = SCOPE.pathname + 'run/';
const SHARE = SCOPE.pathname + 'share-target';

/* ---------- IndexedDB (same schema as app.js) ---------- */
let dbp;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const r = indexedDB.open('runner-db', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('files')) {
        const f = d.createObjectStore('files', { keyPath: ['pid', 'path'] });
        f.createIndex('lpath', 'lpath');
        f.createIndex('pid', 'pid');
      }
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'k' });
    };
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => { d.close(); dbp = null; }; res(d); };
    r.onerror = () => { dbp = null; rej(r.error); };
  });
  return dbp;
}
async function idbGet(store, key, index) {
  const d = await db();
  return new Promise((res, rej) => {
    const s = d.transaction(store).objectStore(store);
    const q = (index ? s.index(index) : s).get(key);
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
  });
}
async function idbPut(store, val) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, 'readwrite'); t.objectStore(store).put(val);
    t.oncomplete = () => res(); t.onerror = () => rej(t.error);
  });
}

/* ---------- lifecycle ---------- */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('runner-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

/* ---------- routing ---------- */
self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (url.origin !== SCOPE.origin) return;
  if (req.method === 'POST' && url.pathname === SHARE) return e.respondWith(handleShare(req));
  if (req.method !== 'GET' && req.method !== 'HEAD') return;
  if (url.pathname.startsWith(RUN)) return e.respondWith(serveProject(req, url.pathname.slice(RUN.length)));
  // A game used an absolute path like "/img/a.png": map it into the project that asked for it.
  let ref = null;
  try { ref = req.referrer ? new URL(req.referrer) : null; } catch (_) {}
  if (ref && ref.origin === SCOPE.origin && ref.pathname.startsWith(RUN) && url.pathname.startsWith(SCOPE.pathname)) {
    const pid = ref.pathname.slice(RUN.length).split('/')[0];
    const sub = url.pathname.slice(SCOPE.pathname.length);
    return e.respondWith(serveProject(req, pid + '/' + sub, true).then(r => r || shell(req, url)));
  }
  if (url.pathname.startsWith(SCOPE.pathname)) e.respondWith(shell(req, url));
});

async function shell(req, url) {
  const cache = await caches.open(VERSION);
  const isNav = req.mode === 'navigate';
  const key = isNav && (url.pathname === SCOPE.pathname || url.pathname === SCOPE.pathname + 'index.html') ? 'index.html' : req;
  const cached = await cache.match(key, { ignoreSearch: isNav });
  const net = fetch(req).then(r => {
    if (r && r.ok && SHELL.some(s => new URL(s, SCOPE).pathname === url.pathname)) cache.put(key, r.clone());
    return r;
  }).catch(() => null);
  if (cached) { net.catch(() => {}); return cached; }   // stale-while-revalidate
  const r = await net;
  if (r) return r;
  if (isNav) { const idx = await cache.match('index.html'); if (idx) return idx; }
  return new Response('Offline', { status: 503 });
}

async function handleShare(req) {
  try {
    const fd = await req.formData();
    const files = fd.getAll('zip').concat(fd.getAll('file')).filter(f => f && typeof f !== 'string');
    if (files.length) {
      const f = files[0];
      await idbPut('meta', { k: 'pending-share', name: f.name || 'shared.zip', type: f.type, data: await f.arrayBuffer(), t: Date.now() });
    }
  } catch (err) { /* fall through to the app */ }
  return Response.redirect(SCOPE.pathname + '?shared=1', 303);
}

/* ---------- project file server ---------- */
const MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8', cjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8', map: 'application/json', txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8', csv: 'text/csv; charset=utf-8', xml: 'application/xml', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  ico: 'image/x-icon', bmp: 'image/bmp', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', mp4: 'video/mp4', m4v: 'video/mp4',
  webm: 'video/webm', mov: 'video/quicktime', wasm: 'application/wasm', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', glb: 'model/gltf-binary', gltf: 'model/gltf+json',
  webmanifest: 'application/manifest+json', bin: 'application/octet-stream', data: 'application/octet-stream'
};
const ext = p => { const m = /\.([a-z0-9]+)$/i.exec(p); return m ? m[1].toLowerCase() : ''; };

async function findFile(pid, full) {
  const cands = [full];
  if (full === '' || full.endsWith('/')) cands[0] = full + 'index.html';
  else if (!ext(full)) cands.push(full + '/index.html', full + '.html');
  for (const c of cands) {
    const r = await idbGet('files', [pid, c]);
    if (r) return r;
  }
  for (const c of cands) {   // case-insensitive fallback (zips made on Windows/macOS)
    const r = await idbGet('files', pid + '\n' + c.toLowerCase(), 'lpath');
    if (r) return r;
  }
  return null;
}

async function serveProject(req, rest, soft) {
  const slash = rest.indexOf('/');
  if (slash < 0) {
    if (soft) return null;
    return Response.redirect(RUN + rest + '/', 302);
  }
  const pid = rest.slice(0, slash);
  let sub;
  try { sub = decodeURIComponent(rest.slice(slash + 1)); } catch (_) { sub = rest.slice(slash + 1); }
  const proj = await idbGet('projects', pid);
  if (!proj) return soft ? null : new Response('Project not found', { status: 404 });
  const full = (proj.root || '') + (sub === '' ? proj.entry : sub);
  const f = await findFile(pid, full);
  if (!f) return soft ? null : new Response('Not found in project: ' + sub, { status: 404, headers: { 'Content-Type': 'text/plain' } });

  const e = ext(f.path);
  const type = MIME[e] || f.type || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
  let body = f.data;
  if (e === 'html' || e === 'htm') body = new TextEncoder().encode(injectShim(new TextDecoder().decode(body), pid));
  const size = body.byteLength;

  const range = req.headers.get('range');
  const m = range && /bytes=(\d*)-(\d*)/.exec(range);
  if (m && (m[1] || m[2])) {
    let start, end;
    if (m[1] === '') { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    else { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1; }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */' + size } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(req.method === 'HEAD' ? null : body.slice(start, end + 1), { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(req.method === 'HEAD' ? null : body, { status: 200, headers });
}

/* ---------- per-project storage isolation shim (runs before any game script) ---------- */
function runnerShim(PID) {
  var P = 'runner:' + PID + ':';
  window.__RUNNER__ = { projectId: PID, prefix: P };
  function wrapStorage(name) {
    var real;
    try { real = window[name]; } catch (e) { return; }
    if (!real) return;
    var SP = Storage.prototype, g = SP.getItem, s = SP.setItem, r = SP.removeItem, k = SP.key;
    function keys() {
      var out = [];
      for (var i = 0; i < real.length; i++) { var kk = k.call(real, i); if (kk && kk.indexOf(P) === 0) out.push(kk.slice(P.length)); }
      return out;
    }
    var api = {
      getItem: function (x) { return g.call(real, P + x); },
      setItem: function (x, v) { s.call(real, P + x, String(v)); },
      removeItem: function (x) { r.call(real, P + x); },
      clear: function () { keys().forEach(function (x) { r.call(real, P + x); }); },
      key: function (i) { var a = keys(); return i >= 0 && i < a.length ? a[i] : null; }
    };
    var proxy = new Proxy(api, {
      get: function (t, p) {
        if (p === 'length') return keys().length;
        if (typeof p === 'symbol') return p === Symbol.toStringTag ? 'Storage' : undefined;
        if (Object.prototype.hasOwnProperty.call(api, p)) return api[p];
        var v = g.call(real, P + p); return v === null ? undefined : v;
      },
      set: function (t, p, v) { if (typeof p !== 'symbol' && !Object.prototype.hasOwnProperty.call(api, p)) s.call(real, P + p, String(v)); return true; },
      has: function (t, p) { return p in api || p === 'length' || (typeof p === 'string' && g.call(real, P + p) !== null); },
      deleteProperty: function (t, p) { if (typeof p === 'string') r.call(real, P + p); return true; },
      ownKeys: function () { return keys(); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p !== 'string') return undefined;
        var v = g.call(real, P + p);
        return v === null ? undefined : { value: v, writable: true, enumerable: true, configurable: true };
      }
    });
    var ok = false;
    try { Object.defineProperty(window, name, { get: function () { return proxy; }, configurable: true }); ok = window[name] === proxy; } catch (e) {}
    if (!ok) {
      // Fallback: patch Storage methods for this storage object only.
      SP.getItem = function (x) { return this === real ? g.call(this, P + x) : g.call(this, x); };
      SP.setItem = function (x, v) { return this === real ? s.call(this, P + x, v) : s.call(this, x, v); };
      SP.removeItem = function (x) { return this === real ? r.call(this, P + x) : r.call(this, x); };
    }
  }
  wrapStorage('localStorage');
  wrapStorage('sessionStorage');
  try {
    var F = IDBFactory.prototype, open = F.open, del = F.deleteDatabase, dbs = F.databases;
    F.open = function (n, v) { return arguments.length > 1 && v !== undefined ? open.call(this, P + n, v) : open.call(this, P + n); };
    F.deleteDatabase = function (n) { return del.call(this, P + n); };
    if (dbs) F.databases = function () {
      return dbs.call(this).then(function (l) {
        return l.filter(function (x) { return x.name.indexOf(P) === 0; }).map(function (x) { return { name: x.name.slice(P.length), version: x.version }; });
      });
    };
    var nd = Object.getOwnPropertyDescriptor(IDBDatabase.prototype, 'name');
    if (nd && nd.get) Object.defineProperty(IDBDatabase.prototype, 'name', {
      get: function () { var n = nd.get.call(this); return n.indexOf(P) === 0 ? n.slice(P.length) : n; }, configurable: true
    });
  } catch (e) {}
  try {
    var C = CacheStorage.prototype, co = C.open, ch = C.has, cd = C.delete, ck = C.keys;
    C.open = function (n) { return co.call(this, P + n); };
    C.has = function (n) { return ch.call(this, P + n); };
    C.delete = function (n) { return cd.call(this, P + n); };
    C.keys = function () { return ck.call(this).then(function (l) { return l.filter(function (x) { return x.indexOf(P) === 0; }).map(function (x) { return x.slice(P.length); }); }); };
  } catch (e) {}
  try {
    // A game's own service worker would take over /run/<id>/ and break file serving, so it is disabled.
    if (window.ServiceWorkerContainer) ServiceWorkerContainer.prototype.register = function () {
      return Promise.reject(new DOMException('Service workers are disabled inside Runner', 'NotSupportedError'));
    };
  } catch (e) {}
}

function injectShim(html, pid) {
  const tag = '<script>/*runner-shim*/(' + runnerShim.toString() + ')(' + JSON.stringify(pid) + ');</script>';
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length);
  const h = /<html(\s[^>]*)?>/i.exec(html);
  if (h) return html.slice(0, h.index + h[0].length) + tag + html.slice(h.index + h[0].length);
  const dt = /<!doctype[^>]*>/i.exec(html);
  if (dt) return html.slice(0, dt.index + dt[0].length) + tag + html.slice(dt.index + dt[0].length);
  return tag + html;
}
