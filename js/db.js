// IndexedDB 래퍼
let _db;

export function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('atelier', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      const has = n => d.objectStoreNames.contains(n);
      if (!has('artists')) d.createObjectStore('artists', { keyPath: 'id' });
      if (!has('artistImages')) d.createObjectStore('artistImages', { keyPath: 'id' }).createIndex('artistId', 'artistId');
      if (!has('styles')) d.createObjectStore('styles', { keyPath: 'id' });
      if (!has('tombstones')) d.createObjectStore('tombstones', { keyPath: 'id' });
      if (!has('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      // v2: 태그 탭
      if (!has('tagSections')) d.createObjectStore('tagSections', { keyPath: 'id' });
      if (!has('tagItems')) d.createObjectStore('tagItems', { keyPath: 'id' });
    };
    r.onsuccess = () => { _db = r.result; resolve(_db); };
    r.onerror = () => reject(r.error);
  });
}

const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function tx(stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = _db.transaction(stores, mode);
    let out;
    Promise.resolve(fn(t)).then(v => { out = v; }, reject);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('transaction aborted'));
  });
}

export const all = s => tx([s], 'readonly', t => req(t.objectStore(s).getAll()));
export const get = (s, id) => tx([s], 'readonly', t => req(t.objectStore(s).get(id)));
export const put = (s, v) => tx([s], 'readwrite', t => { t.objectStore(s).put(v); });
export const putMany = (s, arr) => arr.length ? tx([s], 'readwrite', t => { const o = t.objectStore(s); arr.forEach(v => o.put(v)); }) : Promise.resolve();
export const del = (s, id) => tx([s], 'readwrite', t => { t.objectStore(s).delete(id); });
export const delMany = (s, ids) => ids.length ? tx([s], 'readwrite', t => { const o = t.objectStore(s); ids.forEach(id => o.delete(id)); }) : Promise.resolve();
export const clear = stores => tx(stores, 'readwrite', t => { stores.forEach(s => t.objectStore(s).clear()); });

export async function getMeta(key, d = null) {
  const r = await get('meta', key);
  return r ? r.value : d;
}
export const setMeta = (key, value) => put('meta', { key, value });
