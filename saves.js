/* Per-project save data: export / import / delete. Mirrors the namespacing done by the shim in sw.js. */
const Saves = (() => {
  const prefix = id => 'runner:' + id + ':';

  const b64 = buf => {
    const u = new Uint8Array(buf); let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  };
  const unb64 = s => { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };

  async function enc(v) {
    if (v === undefined) return { $t: 'u' };
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { $t: 'n', v: String(v) };
    if (typeof v === 'bigint') return { $t: 'big', v: v.toString() };
    if (v instanceof Date) return { $t: 'date', v: v.getTime() };
    if (v instanceof ArrayBuffer) return { $t: 'ab', v: b64(v) };
    if (ArrayBuffer.isView(v)) return { $t: 'ta', c: v.constructor.name, v: b64(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength)) };
    if (typeof Blob !== 'undefined' && v instanceof Blob) return { $t: 'blob', type: v.type, name: v.name, v: b64(await v.arrayBuffer()) };
    if (v instanceof Map) { const a = []; for (const [k, x] of v) a.push([await enc(k), await enc(x)]); return { $t: 'map', v: a }; }
    if (v instanceof Set) { const a = []; for (const x of v) a.push(await enc(x)); return { $t: 'set', v: a }; }
    if (v instanceof RegExp) return { $t: 're', s: v.source, f: v.flags };
    if (Array.isArray(v)) { const a = []; for (const x of v) a.push(await enc(x)); return a; }
    const o = {};
    for (const k of Object.keys(v)) o[k] = await enc(v[k]);
    return '$t' in v ? { $t: 'obj', v: o } : o;
  }
  function dec(v) {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(dec);
    switch (v.$t) {
      case 'u': return undefined;
      case 'n': return Number(v.v);
      case 'big': return BigInt(v.v);
      case 'date': return new Date(v.v);
      case 'ab': return unb64(v.v);
      case 'ta': { const C = globalThis[v.c] || Uint8Array; const ab = unb64(v.v); return C === DataView ? new DataView(ab) : new C(ab); }
      case 'blob': return v.name ? new File([unb64(v.v)], v.name, { type: v.type }) : new Blob([unb64(v.v)], { type: v.type });
      case 'map': return new Map(v.v.map(([k, x]) => [dec(k), dec(x)]));
      case 'set': return new Set(v.v.map(dec));
      case 're': return new RegExp(v.s, v.f);
      case 'obj': { const o = {}; for (const k of Object.keys(v.v)) o[k] = dec(v.v[k]); return o; }
    }
    const o = {}; for (const k of Object.keys(v)) o[k] = dec(v[k]); return o;
  }

  const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  async function listDbs(id) {
    if (!indexedDB.databases) return [];
    const p = prefix(id);
    return (await indexedDB.databases()).filter(d => d.name && d.name.startsWith(p));
  }
  function openDb(name, version, upgrade) {
    return new Promise((res, rej) => {
      const r = version ? indexedDB.open(name, version) : indexedDB.open(name);
      if (upgrade) r.onupgradeneeded = () => upgrade(r.result);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('Database "' + name + '" is in use; close the game and try again.'));
    });
  }
  function deleteDb(name) {
    return new Promise((res, rej) => {
      const r = indexedDB.deleteDatabase(name);
      const t = setTimeout(() => rej(new Error('Save data is in use; close the game and try again.')), 8000);
      r.onsuccess = () => { clearTimeout(t); res(); }; r.onerror = () => { clearTimeout(t); rej(r.error); };
    });
  }

  async function exportSaves(project) {
    const p = prefix(project.id);
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(p)) ls[k.slice(p.length)] = localStorage.getItem(k);
    }
    const dbs = [];
    for (const info of await listDbs(project.id)) {
      const d = await openDb(info.name);
      const out = { name: info.name.slice(p.length), version: d.version, stores: [] };
      for (const sn of Array.from(d.objectStoreNames)) {
        const t = d.transaction(sn); const s = t.objectStore(sn);
        const st = { name: sn, keyPath: s.keyPath, autoIncrement: s.autoIncrement, indexes: [], records: [] };
        for (const ix of Array.from(s.indexNames)) { const x = s.index(ix); st.indexes.push({ name: ix, keyPath: x.keyPath, unique: x.unique, multiEntry: x.multiEntry }); }
        const [keys, vals] = await Promise.all([req(s.getAllKeys()), req(s.getAll())]);
        for (let i = 0; i < keys.length; i++) st.records.push({ k: await enc(keys[i]), v: await enc(vals[i]) });
        out.stores.push(st);
      }
      d.close();
      dbs.push(out);
    }
    return { format: 'runner-saves', version: 1, project: { id: project.id, name: project.name }, exported: new Date().toISOString(), localStorage: ls, indexedDB: dbs };
  }

  async function deleteSaves(id) {
    const p = prefix(id);
    const ks = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(p)) ks.push(k); }
    ks.forEach(k => localStorage.removeItem(k));
    for (const d of await listDbs(id)) await deleteDb(d.name);
  }

  async function importSaves(id, data) {
    if (!data || data.format !== 'runner-saves') throw new Error('Not a Runner save file');
    await deleteSaves(id);
    const p = prefix(id);
    for (const [k, v] of Object.entries(data.localStorage || {})) localStorage.setItem(p + k, v);
    for (const dbd of data.indexedDB || []) {
      await deleteDb(p + dbd.name);
      const d = await openDb(p + dbd.name, dbd.version || 1, db => {
        for (const st of dbd.stores) {
          const opts = { autoIncrement: !!st.autoIncrement };
          if (st.keyPath !== null && st.keyPath !== undefined) opts.keyPath = st.keyPath;
          const s = db.createObjectStore(st.name, opts);
          for (const ix of st.indexes || []) s.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
        }
      });
      for (const st of dbd.stores) {
        if (!st.records.length) continue;
        await new Promise((res, rej) => {
          const t = d.transaction(st.name, 'readwrite'); const s = t.objectStore(st.name);
          for (const r of st.records) { if (s.keyPath === null) s.put(dec(r.v), dec(r.k)); else s.put(dec(r.v)); }
          t.oncomplete = res; t.onerror = () => rej(t.error);
        });
      }
      d.close();
    }
  }

  async function summary(id) {
    const p = prefix(id); let n = 0, bytes = 0;
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(p)) { n++; bytes += k.length + (localStorage.getItem(k) || '').length; } }
    const dbs = await listDbs(id).catch(() => []);
    return { keys: n, bytes: bytes * 2, dbs: dbs.length };
  }

  return { exportSaves, importSaves, deleteSaves, summary, prefix };
})();
