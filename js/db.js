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

// ---------- 이미지 저장 방식 ----------
// Safari는 IndexedDB에 넣은 Blob을 나중에 읽지 못하는 경우가 있다(WebKitBlobResource 오류 → '?' 이미지).
// 그래서 Blob은 바이트(ArrayBuffer)로 바꿔 저장하고, 읽을 때 메모리 Blob으로 되살린다.
const PACKED = '__bytes';
const isPacked = v => v && typeof v === 'object' && v[PACKED] instanceof ArrayBuffer;

async function pack(rec) {
  if (!rec || typeof rec !== 'object') return rec;
  let out = rec;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (v instanceof Blob) {
      if (out === rec) out = { ...rec };
      out[k] = { [PACKED]: await v.arrayBuffer(), type: v.type };
    }
  }
  return out;
}

// 반환: [되살린 레코드, 예전 Blob 방식이었는지, 읽지 못한 칸이 있는지]
async function unpack(rec) {
  let legacy = false, broken = false;
  for (const k of Object.keys(rec)) {
    const v = rec[k];
    if (isPacked(v)) rec[k] = new Blob([v[PACKED]], { type: v.type });
    else if (v instanceof Blob) {
      legacy = true;
      try {
        rec[k] = new Blob([await v.arrayBuffer()], { type: v.type });
      } catch (e) {
        console.warn('이미지를 읽지 못했어요', rec.id, k, e);
        rec[k] = null;
        broken = true;
      }
    }
  }
  if (broken) rec._broken = true;
  return [rec, legacy, broken];
}

export async function all(s) {
  const rows = await tx([s], 'readonly', t => req(t.objectStore(s).getAll()));
  const migrate = [];
  for (const r of rows) {
    const [, legacy, broken] = await unpack(r);
    if (legacy && !broken) migrate.push(r);
  }
  // 예전 방식으로 저장된 이미지는 읽을 수 있을 때 바이트 방식으로 다시 저장해 둔다
  if (migrate.length) putMany(s, migrate).catch(e => console.warn('migrate', e));
  return rows;
}
export async function get(s, id) {
  const r = await tx([s], 'readonly', t => req(t.objectStore(s).get(id)));
  if (r) await unpack(r);
  return r;
}
const strip = v => { if (v && v._broken !== undefined) { const { _broken, ...rest } = v; return rest; } return v; };
export async function put(s, v) {
  const p = await pack(strip(v));
  return tx([s], 'readwrite', t => { t.objectStore(s).put(p); });
}
export async function putMany(s, arr) {
  if (!arr.length) return;
  const ps = [];
  for (const v of arr) ps.push(await pack(strip(v)));
  return tx([s], 'readwrite', t => { const o = t.objectStore(s); ps.forEach(v => o.put(v)); });
}
export const del = (s, id) => tx([s], 'readwrite', t => { t.objectStore(s).delete(id); });
export const delMany = (s, ids) => ids.length ? tx([s], 'readwrite', t => { const o = t.objectStore(s); ids.forEach(id => o.delete(id)); }) : Promise.resolve();
export const clear = stores => tx(stores, 'readwrite', t => { stores.forEach(s => t.objectStore(s).clear()); });

export async function getMeta(key, d = null) {
  const r = await get('meta', key);
  return r ? r.value : d;
}
export const setMeta = (key, value) => put('meta', { key, value });
