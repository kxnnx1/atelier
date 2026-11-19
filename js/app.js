import * as db from './db.js';
import { readNaiMetadata } from './nai.js';
import { extractArtists, formatTag, displayName, keyOfTag } from './tags.js';
import { makeImages } from './thumb.js';
import { buildBackup, parseBackup } from './backup.js';
import { icon } from './icons.js';
import { createTagTab } from './tagtab.js';

const VERSION = '1.6.1';
const $ = (s, r = document) => r.querySelector(s);
const now = () => Date.now();
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : now().toString(36) + Math.random().toString(36).slice(2, 12));

const ls = {
  get(k, d) { try { const v = localStorage.getItem('atelier.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('atelier.' + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

const S = {
  tab: ls.get('tab', 'artists'),
  q: '',
  label: null,
  fav: false,
  sort: ls.get('sort', { artists: 'new', styles: 'new' }),
  styleView: ls.get('styleView', 'text'),
  layout: ls.get('layout', { artists: 'masonry', styles: 'masonry' }),
  artists: [],
  images: [],
  styles: [],
  syncedAt: 0,
  dirtyAt: 0,
  folderOrder: { artists: [], styles: [], updatedAt: 0 },
  itemOrder: { artists: {}, styles: {}, updatedAt: 0 },   // 폴더 안 항목 순서 { 폴더이름: [id, ...] }
  folderSort: ls.get('folderSort', { artists: 'manual', styles: 'manual' }),
  tagSections: [],
  tagItems: [],
};

const isTouch = matchMedia('(pointer: coarse)').matches;
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isStandalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------- DOM 헬퍼 ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const k in props) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
const ib = (name, title, onclick, cls = '') =>
  h('button', { class: 'icon-btn ' + cls, type: 'button', title, 'aria-label': title, html: icon(name), onclick });
const btn = (name, label, onclick, cls = 'btn-ghost') =>
  h('button', { class: 'btn ' + cls, type: 'button', onclick }, name ? h('span', { class: 'i', html: icon(name) }) : null, label);

const fmtDate = t => t ? new Date(t).toLocaleString('ko-KR', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const fmtBytes = b => b == null ? '—' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const isImage = f => f && (f.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|avif)$/i.test(f.name || ''));
const isZip = f => f && (/zip/.test(f.type) || /\.zip$/i.test(f.name || ''));

function hash(str) {
  let h1 = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h1 ^= str.charCodeAt(i); h1 = Math.imul(h1, 0x01000193); }
  return (h1 >>> 0).toString(16) + ':' + str.length;
}

// ---------- 이미지 URL 캐시 ----------
const urls = new Map();
function urlOf(rec, kind) {
  if (!rec || !rec[kind]) return '';
  const key = rec.id + ':' + kind;
  let u = urls.get(key);
  if (!u) { u = URL.createObjectURL(rec[kind]); urls.set(key, u); }
  return u;
}
function dropUrls(id) {
  for (const k of ['thumb', 'image']) {
    const u = urls.get(id + ':' + k);
    if (u) { URL.revokeObjectURL(u); urls.delete(id + ':' + k); }
  }
}
function dropAllUrls() { urls.forEach(u => URL.revokeObjectURL(u)); urls.clear(); }

// ---------- 데이터 도우미 ----------
const imagesOf = id => S.images.filter(i => i.artistId === id).sort((a, b) => a.createdAt - b.createdAt);
const coverOf = (a, imgs = imagesOf(a.id)) => imgs.find(i => i.id === a.coverId) || imgs[0] || null;
const promptTexts = s => (s.sections || []).filter(x => x.kind === 'prompt').map(x => x.body);
const allLabels = () => [...new Set([...S.artists, ...S.styles].flatMap(x => x.labels || []))].sort((a, b) => a.localeCompare(b, 'ko'));

let gver = 0, gcache = null, gcv = -1;
function gallery() {
  if (gcv !== gver) {
    gcache = new Map();
    for (const a of S.artists) { const k = keyOfTag(a.tag); if (k && !gcache.has(k)) gcache.set(k, a); }
    gcv = gver;
  }
  return gcache;
}
const styleArtCache = new Map();
function artistsOfStyle(s) {
  const c = styleArtCache.get(s.id);
  if (c && c.v === gver && c.u === s.updatedAt) return c.list;
  const list = extractArtists(promptTexts(s), gallery());
  styleArtCache.set(s.id, { v: gver, u: s.updatedAt, list });
  return list;
}
const styleTitle = s => s.title || artistsOfStyle(s).slice(0, 3).map(t => displayName(t.text)).join(' · ') || (s.sections?.length ? '제목 없음' : '메타데이터 없음');

// ---------- 저장 ----------
async function markDirty() {
  S.dirtyAt = now();
  await db.setMeta('dirtyAt', S.dirtyAt);
  updateDot();
}
async function saveArtist(a, patch, regallery = false) {
  Object.assign(a, patch, { updatedAt: now() });
  await db.put('artists', a);
  if (regallery) gver++;
  markDirty();
  scheduleRender();
}
async function saveStyle(s, patch) {
  Object.assign(s, patch, { updatedAt: now() });
  await db.put('styles', s);
  markDirty();
  scheduleRender();
}
async function tomb(store, ids) {
  const t = now();
  await db.putMany('tombstones', ids.map(id => ({ id, store, deletedAt: t })));
}
async function persistStorage() {
  try { if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch { /* 무시 */ }
}

// ---------- 토스트 / 다이얼로그 ----------
function toast(msg, { sticky = false, ms = 2200 } = {}) {
  const el = h('div', { class: 'toast', role: 'status' }, msg);
  $('#toasts').append(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); };
  if (!sticky) setTimeout(close, ms);
  return { set: m => { el.textContent = m; }, close };
}

async function copy(text, msg = '복사했어요') {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(msg);
}

function dialog({ title, text, actions }) {
  return new Promise(resolve => {
    const done = v => {
      layer.classList.remove('open');
      setTimeout(() => layer.remove(), 250);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); done(null); } };
    const layer = h('div', { class: 'layer dialog-layer' },
      h('div', { class: 'scrim', onclick: () => done(null) }),
      h('div', { class: 'dialog', role: 'alertdialog', 'aria-modal': 'true' },
        h('h3', { class: 'dialog-title' }, title),
        text ? h('p', { class: 'dialog-text' }, text) : null,
        h('div', { class: 'dialog-actions' },
          actions.map(a => h('button', { class: 'btn ' + (a.kind || 'btn-ghost'), type: 'button', onclick: () => done(a.value) }, a.label)))));
    document.body.append(layer);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('open')));
  });
}
const confirmDialog = (title, text, ok = '삭제') =>
  dialog({ title, text, actions: [{ label: '취소', value: false }, { label: ok, value: true, kind: 'btn-danger' }] });

// 이름 입력 다이얼로그. 취소하면 null
function promptDialog({ title, text, value = '', placeholder = '', ok = '확인' }) {
  return new Promise(resolve => {
    const input = h('input', { class: 'input', value, placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done' });
    const done = v => {
      layer.classList.remove('open');
      setTimeout(() => layer.remove(), 250);
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const submit = () => { const v = cleanFolder(input.value); if (v) done(v); else input.focus(); };
    const onKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); done(null); } };
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) submit(); });
    const layer = h('div', { class: 'layer dialog-layer' },
      h('div', { class: 'scrim', onclick: () => done(null) }),
      h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true' },
        h('h3', { class: 'dialog-title' }, title),
        text ? h('p', { class: 'dialog-text' }, text) : null,
        h('div', { class: 'dialog-field' }, input),
        h('div', { class: 'dialog-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => done(null) }, '취소'),
          h('button', { class: 'btn btn-primary', type: 'button', onclick: submit }, ok))));
    document.body.append(layer);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => requestAnimationFrame(() => { layer.classList.add('open'); input.focus(); input.select(); }));
  });
}
const cleanFolder = s => String(s || '').replace(/^#+/, '').replace(/[,\n]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- 레이어(시트) 스택 ----------
const stack = [];
function makeLayer(cls = '') {
  const body = h('div', { class: 'sheet-body' });
  const sheet = h('section', { class: 'sheet ' + cls, role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    ib('x', '닫기', closeTop, 'sheet-close'),
    body);
  const layer = h('div', { class: 'layer' }, h('div', { class: 'scrim', onclick: closeTop }), sheet);
  layer.body = body;
  return layer;
}
function openLayer(layer) {
  $('#layers').append(layer);
  stack.push(layer);
  history.pushState({ atelier: stack.length }, '');
  document.documentElement.classList.add('locked');
  requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add('open')));
}
function closeTop() { if (stack.length) history.back(); }
window.addEventListener('popstate', () => {
  const layer = stack.pop();
  if (!layer) {
    // 시트가 없으면 '뒤로'는 폴더에서 나가기
    if (S.label) { S.label = null; S.q = ''; $('#search').value = ''; renderAll(); window.scrollTo({ top: 0 }); }
    return;
  }
  layer.classList.remove('open');
  setTimeout(() => layer.remove(), 340);
  if (!stack.length) document.documentElement.classList.remove('locked');
  else stack[stack.length - 1]._refresh?.();
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !document.querySelector('.dialog-layer')) {
    if (stack.length) closeTop();
    else if (S.label && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) leaveFolder();
  }
  if (e.key === '/' && !stack.length && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    e.preventDefault();
    $('#search').focus();
  }
});

// ---------- 공용 편집 컴포넌트 ----------
function field(label, ...kids) {
  return h('div', { class: 'field' }, h('div', { class: 'field-label' }, label), ...kids);
}

// 폴더 지정 (한 항목이 여러 폴더에 들어갈 수 있음). 데이터는 labels 배열에 저장
function labelEditor(initial, onChange, options = allLabels()) {
  let labels = [...(initial || [])];
  const listId = 'dl-' + Math.random().toString(36).slice(2);
  const chips = h('span', { class: 'label-chips' });
  const input = h('input', {
    class: 'label-input', placeholder: '+ 폴더에 넣기', list: listId,
    autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done',
  });
  const dl = h('datalist', { id: listId }, options.map(l => h('option', { value: l })));
  const emit = () => onChange([...labels]);
  const render = () => chips.replaceChildren(...labels.map(l =>
    h('span', { class: 'label-chip' }, h('span', { class: 'i', html: icon('folder') }), l,
      h('button', {
        class: 'label-x', type: 'button', 'aria-label': `${l} 삭제`, html: icon('x'),
        onclick: () => { labels = labels.filter(x => x !== l); render(); emit(); },
      }))));
  const commit = () => {
    const parts = input.value.split(/[,#\n]+/).map(cleanFolder).filter(Boolean);
    input.value = '';
    let changed = false;
    for (const p of parts) if (!labels.includes(p)) { labels.push(p); changed = true; }
    if (changed) { render(); emit(); }
  };
  input.addEventListener('keydown', e => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); commit(); }
    else if (e.key === 'Backspace' && !input.value && labels.length) { labels.pop(); render(); emit(); }
  });
  input.addEventListener('blur', commit);
  render();
  return h('div', { class: 'labels-edit', onclick: e => { if (e.target === e.currentTarget) input.focus(); } }, chips, input, dl);
}

function memoBox(value, onSave, placeholder = '메모를 남겨 보세요') {
  const ta = h('textarea', { class: 'input memo', rows: 3, placeholder });
  ta.value = value || '';
  let saved = ta.value, t;
  const fit = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, 88) + 'px'; };
  const flush = () => { clearTimeout(t); if (ta.value !== saved) { saved = ta.value; onSave(ta.value); } };
  ta.addEventListener('input', () => { fit(); clearTimeout(t); t = setTimeout(flush, 500); });
  ta.addEventListener('blur', flush);
  requestAnimationFrame(fit);
  return ta;
}

function favBtn(item, save) {
  const inner = on => `${icon(on ? 'starFill' : 'star')}<span>${on ? '즐겨찾기됨' : '즐겨찾기'}</span>`;
  const b = h('button', { class: 'btn btn-ghost fav' + (item.favorite ? ' on' : ''), type: 'button', html: inner(item.favorite) });
  b.addEventListener('click', async () => {
    await save({ favorite: !item.favorite });
    b.classList.toggle('on', item.favorite);
    b.innerHTML = inner(item.favorite);
  });
  return b;
}

function pickFiles(cb, accept = 'image/*', multiple = true) {
  const inp = h('input', { type: 'file', accept, multiple, style: { display: 'none' } });
  inp.addEventListener('change', () => { const fs = [...inp.files]; inp.remove(); if (fs.length) cb(fs); });
  document.body.append(inp);
  inp.click();
}

// ---------- 헤더 / 필터 / 격자 ----------
function renderTabs() {
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === S.tab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', on);
  });
  $('#countArtists').textContent = S.artists.length || '';
  $('#countStyles').textContent = S.styles.length || '';
  $('#countTags').textContent = S.tagItems.length || '';
  $('#search').placeholder = { artists: '작가 태그 · 메모 검색', styles: '프롬프트 · 제목 · 메모 검색', tags: '태그 · 이름 검색' }[S.tab];
  const addLabel = { artists: '작가 등록', styles: '그림체 추가', tags: '카드 추가' }[S.tab];
  $('#addLabel').textContent = addLabel;
  $('#addBtn').title = addLabel;
  $('#addBtn').setAttribute('aria-label', addLabel);
}

// ---------- 폴더 ----------
const UNFILED = '\u0000unfiled';
const FAVS = '\u0000favorites';   // 즐겨찾기 표시한 항목이 자동으로 모이는 폴더
const isSpecial = f => f === UNFILED || f === FAVS;
const tabItems = () => (S.tab === 'artists' ? S.artists : S.styles);
const folderName = f => (f === UNFILED ? '미분류' : f === FAVS ? '즐겨찾기' : f);
const inFolder = (it, f) => !f || (f === FAVS ? !!it.favorite : f === UNFILED ? !(it.labels?.length) : !!it.labels?.includes(f));
const presetFolder = () => (S.label && !isSpecial(S.label) ? [S.label] : []);

function folderList() {
  const map = new Map();
  for (const it of tabItems()) for (const l of it.labels || []) {
    if (!map.has(l)) map.set(l, []);
    map.get(l).push(it);
  }
  const ord = new Map((S.folderOrder[S.tab] || []).map((n, i) => [n, i]));
  const rank = n => (ord.has(n) ? ord.get(n) : 1e9);
  const list = [...map].map(([name, items]) => ({ name, items }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, 'ko'));
  const unfiled = tabItems().filter(it => !it.labels?.length);
  if (unfiled.length && list.length) list.push({ name: UNFILED, items: unfiled });
  const favs = tabItems().filter(it => it.favorite);
  if (favs.length) list.unshift({ name: FAVS, items: favs });
  return list;
}
const currentFolders = () => folderList().map(f => f.name).filter(n => !isSpecial(n));

async function saveFolderOrder(names) {
  S.folderOrder = { ...S.folderOrder, [S.tab]: names, updatedAt: now() };
  await db.setMeta('folderOrder', S.folderOrder);
  markDirty();
}
function patchFolderOrder(fn) {
  const cur = S.folderOrder[S.tab] || [];
  if (cur.length) saveFolderOrder(fn(cur));
}

function enterFolder(name) {
  S.label = name;
  S.q = '';
  $('#search').value = '';
  history.pushState({ folder: name }, '');
  renderAll();
  window.scrollTo({ top: 0 });
}
function leaveFolder() {
  if (!S.label) return;
  if (history.state?.folder != null) history.back();
  else { S.label = null; renderAll(); }
}

async function newFolder() {
  const name = await promptDialog({
    title: '새 폴더',
    text: S.tab === 'artists' ? '폴더를 만든 뒤 그 안에서 작가를 등록하거나, 작가 상세 화면에서 이 폴더를 지정하세요.' : '폴더를 만든 뒤 그 안에서 그림체를 추가하거나, 그림체 상세 화면에서 이 폴더를 지정하세요.',
    placeholder: '예: 반실사',
    ok: '만들기',
  });
  if (name) enterFolder(name);
}

async function renameFolder(old) {
  const name = await promptDialog({ title: '폴더 이름 바꾸기', value: old, ok: '바꾸기' });
  if (!name || name === old) return;
  const changed = tabItems().filter(it => it.labels?.includes(old));
  const t = now();
  for (const it of changed) {
    it.labels = [...new Set(it.labels.map(l => (l === old ? name : l)))];
    patchFolderOrder(list => [...new Set(list.map(l => (l === old ? name : l)))]);
    patchItemOrder(m => { if (m[old]) { m[name] = [...new Set([...(m[name] || []), ...m[old]])]; delete m[old]; } return m; });
    it.updatedAt = t;
  }
  await db.putMany(S.tab === 'artists' ? 'artists' : 'styles', changed);
  markDirty();
  S.label = name;
  history.replaceState({ folder: name }, '');
  renderAll();
  toast('폴더 이름을 바꿨어요');
}

async function deleteFolder(name) {
  const changed = tabItems().filter(it => it.labels?.includes(name));
  const what = S.tab === 'artists' ? `작가 ${changed.length}명` : `그림체 ${changed.length}개`;
  if (!await confirmDialog(`‘${name}’ 폴더를 삭제할까요?`, changed.length ? `폴더만 지워지고 안의 항목(${what})은 그대로 남아요.` : '빈 폴더예요.', '폴더 삭제')) return;
  const t = now();
  for (const it of changed) { it.labels = it.labels.filter(l => l !== name); it.updatedAt = t; }
  patchFolderOrder(list => list.filter(l => l !== name));
  patchItemOrder(m => { delete m[name]; return m; });
  await db.putMany(S.tab === 'artists' ? 'artists' : 'styles', changed);
  markDirty();
  toast('폴더를 삭제했어요');
  leaveFolder();
  renderAll();
}

// 폴더 안 '직접 순서': 저장된 순서대로, 순서가 없는 항목은 뒤에 최신순으로
function manualSort(folder, list) {
  const ord = S.itemOrder[S.tab]?.[folder] || [];
  const idx = new Map(ord.map((id, i) => [id, i]));
  const rank = it => (idx.has(it.id) ? idx.get(it.id) : 1e9);
  return [...list].sort((a, b) => rank(a) - rank(b) || b.createdAt - a.createdAt);
}

// 폴더 썸네일 = 폴더 안 첫 번째 항목 (이미지가 없는 작가는 건너뜀)
function folderThumbs(folder, items) {
  for (const it of manualSort(folder, items)) {
    const rec = S.tab === 'artists' ? coverOf(it) : it;
    if (rec) return [urlOf(rec, 'thumb')];
  }
  return [];
}

async function saveItemOrder(folder, ids) {
  const tab = S.tab;
  S.itemOrder = { ...S.itemOrder, [tab]: { ...(S.itemOrder[tab] || {}), [folder]: ids }, updatedAt: now() };
  await db.setMeta('itemOrder', S.itemOrder);
  markDirty();
}
function patchItemOrder(fn) {
  const tab = S.tab;
  S.itemOrder = { ...S.itemOrder, [tab]: fn({ ...(S.itemOrder[tab] || {}) }), updatedAt: now() };
  db.setMeta('itemOrder', S.itemOrder);
}

function folderCard(f) {
  const thumbs = folderThumbs(f.name, f.items);
  const unit = S.tab === 'artists' ? '명' : '개';
  return h('button', {
    class: 'folder-card' + (f.name === UNFILED ? ' unfiled' : '') + (f.name === FAVS ? ' favs' : ''), type: 'button',
    'data-folder': isSpecial(f.name) ? null : f.name,
    onclick: () => enterFolder(f.name),
  },
    h('div', { class: 'folder-cover n' + thumbs.length },
      thumbs.length ? thumbs.map(u => h('img', { src: u, alt: '', loading: 'lazy', draggable: 'false' })) : h('span', { class: 'folder-empty', html: icon('folder') })),
    h('div', { class: 'folder-cap' },
      h('span', { class: 'folder-name' },
        f.name === FAVS ? h('span', { class: 'folder-star', html: icon('starFill') }) : null,
        folderName(f.name)),
      h('span', { class: 'folder-n' }, `${f.items.length}${unit}`)));
}

// ---------- 폴더 순서 바꾸기 (마우스: 끌기, 터치: 길게 누른 뒤 끌기) ----------
let fdrag = null;
let suppressClickUntil = 0;
const sliding = new Set();

function folderDragStart(e) {
  const card = e.target.closest('.folder-card[data-folder]');
  if (!card || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const grid = card.parentElement;
  fdrag = { card, grid, id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, touch: e.pointerType !== 'mouse', active: false, timer: 0, raf: 0 };
  if (fdrag.touch) fdrag.timer = setTimeout(() => fdrag && activateDrag(), 380);
  window.addEventListener('pointermove', folderDragMove, { passive: false });
  window.addEventListener('pointerup', folderDragEnd);
  window.addEventListener('pointercancel', folderDragEnd);
}

function activateDrag() {
  const d = fdrag;
  const r = d.card.getBoundingClientRect();
  d.active = true;
  d.dx = d.x - r.left;
  d.dy = d.y - r.top;
  d.ghost = d.card.cloneNode(true);
  d.ghost.classList.add('folder-ghost');
  Object.assign(d.ghost.style, { width: r.width + 'px', height: r.height + 'px', left: '0px', top: '0px' });
  document.body.append(d.ghost);
  d.card.classList.add('drag-src');
  document.documentElement.classList.add('folder-dragging');
  positionGhost();
  navigator.vibrate?.(12);
  const tick = () => {
    if (!fdrag?.active) return;
    const edge = 70;
    if (d.y < edge) window.scrollBy(0, -Math.ceil((edge - d.y) / 6));
    else if (d.y > innerHeight - edge) window.scrollBy(0, Math.ceil((d.y - innerHeight + edge) / 6));
    d.raf = requestAnimationFrame(tick);
  };
  d.raf = requestAnimationFrame(tick);
}

function positionGhost() {
  const d = fdrag;
  d.ghost.style.transform = `translate(${d.x - d.dx}px, ${d.y - d.dy}px) scale(1.04)`;
}

function folderDragMove(e) {
  const d = fdrag;
  if (!d || e.pointerId !== d.id) return;
  d.x = e.clientX;
  d.y = e.clientY;
  const moved = Math.hypot(d.x - d.x0, d.y - d.y0);
  if (!d.active) {
    if (d.touch) { if (moved > 10) folderDragEnd(); return; }   // 길게 누르기 전에 움직이면 스크롤로 본다
    if (moved <= 6) return;
    activateDrag();
  }
  e.preventDefault();
  positionGhost();
  const over = document.elementFromPoint(d.x, d.y)?.closest('.folder-card[data-folder]');
  if (!over || over === d.card || over.parentElement !== d.grid || sliding.has(over)) return;
  const cards = [...d.grid.querySelectorAll('.folder-card[data-folder]')];
  const from = cards.indexOf(d.card), to = cards.indexOf(over);
  const before = new Map(cards.map(c => [c, c.getBoundingClientRect()]));
  if (from < to) over.after(d.card); else over.before(d.card);
  // 자리를 옮긴 카드들이 부드럽게 미끄러지도록 (FLIP)
  for (const c of cards) {
    const a = before.get(c), b = c.getBoundingClientRect();
    const tx = a.left - b.left, ty = a.top - b.top;
    if (!tx && !ty) continue;
    // 미끄러지는 중인 카드는 원래 자리에 그려져 있으므로, 끝날 때까지 교체 대상으로 보지 않는다
    sliding.add(c);
    c.animate([{ transform: `translate(${tx}px, ${ty}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' })
      .finished.finally(() => sliding.delete(c));
  }
}

function folderDragEnd() {
  const d = fdrag;
  if (!d) return;
  fdrag = null;
  clearTimeout(d.timer);
  window.removeEventListener('pointermove', folderDragMove);
  window.removeEventListener('pointerup', folderDragEnd);
  window.removeEventListener('pointercancel', folderDragEnd);
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  suppressClickUntil = Date.now() + 500;
  const r = d.card.getBoundingClientRect();
  const g = d.ghost;
  g.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1), box-shadow .22s';
  g.style.transform = `translate(${r.left}px, ${r.top}px)`;
  setTimeout(() => { g.remove(); d.card.classList.remove('drag-src'); }, 230);
  document.documentElement.classList.remove('folder-dragging');
  const names = [...d.grid.querySelectorAll('.folder-card[data-folder]')].map(c => c.dataset.folder);
  const prev = folderList().map(f => f.name).filter(n => !isSpecial(n));
  if (names.join('\u0000') !== prev.join('\u0000')) saveFolderOrder(names);
}

// 끌기를 마친 직후의 클릭은 폴더 열기로 처리하지 않는다
document.addEventListener('click', e => {
  if (Date.now() < suppressClickUntil && e.target.closest?.('.folder-card, #grid .card')) { e.preventDefault(); e.stopPropagation(); }
}, true);
// 끄는 중에는 화면이 같이 스크롤되지 않게 한다 (iOS)
document.addEventListener('touchmove', e => { if (fdrag?.active || idrag?.active) e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => { if (S.label && e.target.closest?.('#grid .card')) e.preventDefault(); });

// ---------- 폴더 안 항목 순서 바꾸기 ----------
let idrag = null;
const gridCard = id => document.querySelector(`#grid .card[data-id="${CSS.escape(id)}"]`);

function itemDragStart(e) {
  if (!S.label || S.q.trim() || S.fav || S.tab === 'tags') return;
  const card = e.target.closest('#grid .card[data-id]');
  if (!card || e.target.closest('button') || (e.pointerType === 'mouse' && e.button !== 0)) return;
  idrag = { id: card.dataset.id, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, pid: e.pointerId, touch: e.pointerType !== 'mouse', active: false, timer: 0, lock: 0, raf: 0 };
  if (idrag.touch) idrag.timer = setTimeout(() => idrag && itemActivate(), 380);
  window.addEventListener('pointermove', itemDragMove, { passive: false });
  window.addEventListener('pointerup', itemDragEnd);
  window.addEventListener('pointercancel', itemDragEnd);
}

function itemActivate() {
  const d = idrag;
  // 다른 정렬로 보고 있었다면 지금 보이는 순서를 그대로 '직접 순서'로 삼는다
  d.order = visibleItems().map(it => it.id);
  S.itemOrder = { ...S.itemOrder, [S.tab]: { ...(S.itemOrder[S.tab] || {}), [S.label]: d.order } };
  if ((S.folderSort[S.tab] || 'manual') !== 'manual') {
    S.folderSort = { ...S.folderSort, [S.tab]: 'manual' };
    ls.set('folderSort', S.folderSort);
    renderFilters();
    renderGrid();
  }
  const card = gridCard(d.id);
  if (!card) { idrag = null; return; }
  const r = card.getBoundingClientRect();
  d.active = true;
  d.dx = d.x - r.left;
  d.dy = d.y - r.top;
  d.ghost = card.cloneNode(true);
  d.ghost.classList.add('card-ghost');
  Object.assign(d.ghost.style, { width: r.width + 'px', height: r.height + 'px' });
  // 격자의 배열 클래스(작게/제목만)를 그대로 받도록 감싸서 붙인다
  d.ghostWrap = h('div', { class: $('#grid').className + ' ghost-wrap' }, d.ghost);
  document.body.append(d.ghostWrap);
  card.classList.add('drag-src');
  document.documentElement.classList.add('folder-dragging');
  placeItemGhost();
  const tick = () => {
    if (!idrag?.active) return;
    const edge = 70;
    if (d.y < edge) window.scrollBy(0, -Math.ceil((edge - d.y) / 6));
    else if (d.y > innerHeight - edge) window.scrollBy(0, Math.ceil((d.y - innerHeight + edge) / 6));
    d.raf = requestAnimationFrame(tick);
  };
  d.raf = requestAnimationFrame(tick);
}

function placeItemGhost() {
  const d = idrag;
  d.ghost.style.transform = `translate(${d.x - d.dx}px, ${d.y - d.dy}px) scale(1.03)`;
}

function itemDragMove(e) {
  const d = idrag;
  if (!d || e.pointerId !== d.pid) return;
  d.x = e.clientX;
  d.y = e.clientY;
  if (!d.active) {
    const moved = Math.hypot(d.x - d.x0, d.y - d.y0);
    if (d.touch) { if (moved > 10) itemDragEnd(); return; }
    if (moved <= 6) return;
    itemActivate();
    if (!idrag?.active) return;
  }
  e.preventDefault();
  placeItemGhost();
  if (Date.now() < d.lock) return;
  // 크기가 다른 카드끼리 바뀐 직후 포인터 아래에 다른 카드가 와서 되돌아가는 것을 막는다
  if (d.sx != null && Math.hypot(d.x - d.sx, d.y - d.sy) < 28) return;
  const over = document.elementFromPoint(d.x, d.y)?.closest('#grid .card[data-id]');
  if (!over || over.dataset.id === d.id) return;
  const from = d.order.indexOf(d.id), to = d.order.indexOf(over.dataset.id);
  if (from < 0 || to < 0) return;
  d.order.splice(from, 1);
  d.order.splice(to, 0, d.id);
  S.itemOrder[S.tab][S.label] = d.order;
  // 다시 배치하고, 자리를 옮긴 카드들이 미끄러지게 (FLIP)
  const before = new Map([...document.querySelectorAll('#grid .card[data-id]')].map(c => [c.dataset.id, c.getBoundingClientRect()]));
  renderGrid();
  for (const c of document.querySelectorAll('#grid .card[data-id]')) {
    if (c.dataset.id === d.id) { c.classList.add('drag-src'); continue; }
    const a = before.get(c.dataset.id), b = c.getBoundingClientRect();
    if (!a) continue;
    const tx = a.left - b.left, ty = a.top - b.top;
    if (tx || ty) c.animate([{ transform: `translate(${tx}px, ${ty}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
  d.lock = Date.now() + 230;
  d.sx = d.x;
  d.sy = d.y;
}

function itemDragEnd() {
  const d = idrag;
  if (!d) return;
  idrag = null;
  clearTimeout(d.timer);
  window.removeEventListener('pointermove', itemDragMove);
  window.removeEventListener('pointerup', itemDragEnd);
  window.removeEventListener('pointercancel', itemDragEnd);
  if (!d.active) return;
  cancelAnimationFrame(d.raf);
  suppressClickUntil = Date.now() + 500;
  document.documentElement.classList.remove('folder-dragging');
  const card = gridCard(d.id);
  const g = d.ghost, gw = d.ghostWrap;
  if (card) {
    const r = card.getBoundingClientRect();
    g.style.transition = 'transform .22s cubic-bezier(.2,.8,.2,1)';
    g.style.transform = `translate(${r.left}px, ${r.top}px)`;
  }
  setTimeout(() => { gw.remove(); gridCard(d.id)?.classList.remove('drag-src'); }, 230);
  saveItemOrder(S.label, d.order);
}
// 길게 눌렀을 때 뜨는 메뉴 막기
document.addEventListener('contextmenu', e => { if (e.target.closest?.('.folder-card[data-folder]')) e.preventDefault(); });

function renderFolders() {
  const el = $('#folders');
  const head = $('#gridHead');
  const atRoot = !S.label && !S.q.trim();
  const total = tabItems().length;
  if (!atRoot || !total) {
    el.hidden = true;
    head.hidden = true;
    return;
  }
  const list = folderList();
  el.hidden = false;
  el.style.setProperty('--fcols', colCount($('#grid').clientWidth || window.innerWidth) + 1);
  el.replaceChildren(
    h('div', { class: 'block-head' },
      h('h2', {}, '폴더'),
      h('span', { class: 'n' }, list.filter(f => !isSpecial(f.name)).length || ''),
      list.filter(f => !isSpecial(f.name)).length > 1 ? h('span', { class: 'block-hint' }, isTouch ? '길게 눌러 순서 바꾸기' : '끌어서 순서 바꾸기') : null),
    h('div', { class: 'folder-grid', onpointerdown: folderDragStart },
      list.map(folderCard),
      h('button', { class: 'folder-card add', type: 'button', onclick: newFolder },
        h('div', { class: 'folder-cover n0' }, h('span', { class: 'folder-empty', html: icon('folderPlus') })),
        h('div', { class: 'folder-cap' }, h('span', { class: 'folder-name' }, '새 폴더')))));
  head.hidden = false;
  head.replaceChildren(h('div', { class: 'block-head' }, h('h2', {}, S.tab === 'artists' ? '모든 작가' : '모든 그림체'), h('span', { class: 'n' }, total)));
}

function renderFilters() {
  const items = tabItems();
  const scope = items.filter(it => inFolder(it, S.label));
  const favN = scope.filter(x => x.favorite).length;
  const opts = S.tab === 'artists'
    ? [['new', '최신순'], ['old', '오래된순'], ['name', '이름순'], ['count', '이미지 많은순']]
    : [['new', '최신순'], ['old', '오래된순'], ['name', '제목순']];
  const inFolderView = !!S.label;
  const sel = h('select', { class: 'sort', 'aria-label': '정렬' },
    (inFolderView ? [['manual', '직접 순서'], ...opts] : opts).map(([v, t]) => h('option', { value: v }, t)));
  sel.value = inFolderView ? (S.folderSort[S.tab] || 'manual') : (S.sort[S.tab] || 'new');
  sel.addEventListener('change', () => {
    if (inFolderView) { S.folderSort = { ...S.folderSort, [S.tab]: sel.value }; ls.set('folderSort', S.folderSort); }
    else { S.sort[S.tab] = sel.value; ls.set('sort', S.sort); }
    renderFilters();
    renderGrid();
  });
  const fav = h('button', {
    class: 'chip chip-icon' + (S.fav ? ' active' : ''), type: 'button',
    title: S.fav ? '즐겨찾기만 보는 중' : '즐겨찾기만 보기', 'aria-label': '즐겨찾기만 보기', 'aria-pressed': S.fav,
    onclick: () => { S.fav = !S.fav; renderAll(); },
  }, h('span', { class: 'i', html: icon(S.fav ? 'starFill' : 'star') }));

  if (S.label) {
    const unit = S.tab === 'artists' ? '명' : '개';
    const real = !isSpecial(S.label);
    $('#filters').replaceChildren(
      h('div', { class: 'crumb' },
        ib('back', '폴더 목록으로', leaveFolder, 'crumb-back'),
        h('div', { class: 'crumb-text' },
          h('span', { class: 'crumb-parent' }, S.tab === 'artists' ? '작가 폴더' : '그림체 폴더',
            scope.length > 1 ? h('span', { class: 'crumb-hint' }, isTouch ? ' · 길게 눌러 순서 바꾸기' : ' · 끌어서 순서 바꾸기') : null),
          h('span', { class: 'crumb-title' }, folderName(S.label), h('span', { class: 'n' }, `${scope.length}${unit}`)))),
      h('div', { class: 'filter-tools' },
        fav, sel,
        real ? ib('edit', '폴더 이름 바꾸기', () => renameFolder(S.label), 'sm') : null,
        real ? ib('trash', '폴더 삭제', () => deleteFolder(S.label), 'sm') : null));
    return;
  }
  $('#filters').replaceChildren(h('div', { class: 'chips' }, fav), sel);
}

function visibleItems() {
  const q = S.q.trim().toLowerCase();
  const sort = S.label ? (S.folderSort[S.tab] || 'manual') : (S.sort[S.tab] || 'new');
  if (S.label && sort === 'manual') {
    return manualSort(S.label, tabItems().filter(it => inFolder(it, S.label) && (!S.fav || it.favorite) && (!q || itemText(it).includes(q))));
  }
  if (S.tab === 'artists') {
    let list = S.artists.filter(a =>
      inFolder(a, S.label) && (!S.fav || a.favorite) &&
      (!q || [a.tag, a.memo, ...(a.labels || [])].join(' ').toLowerCase().includes(q)));
    const cnt = new Map();
    S.images.forEach(i => cnt.set(i.artistId, (cnt.get(i.artistId) || 0) + 1));
    const by = {
      new: (a, b) => b.createdAt - a.createdAt,
      old: (a, b) => a.createdAt - b.createdAt,
      name: (a, b) => displayName(a.tag).localeCompare(displayName(b.tag), 'ko'),
      count: (a, b) => (cnt.get(b.id) || 0) - (cnt.get(a.id) || 0) || b.createdAt - a.createdAt,
    };
    return list.sort(by[sort] || by.new);
  }
  let list = S.styles.filter(s =>
    inFolder(s, S.label) && (!S.fav || s.favorite) &&
    (!q || [s.title, s.memo, ...(s.labels || []), ...(s.sections || []).map(x => x.body)].join(' ').toLowerCase().includes(q)));
  const by = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    name: (a, b) => styleTitle(a).localeCompare(styleTitle(b), 'ko'),
  };
  return list.sort(by[sort] || by.new);
}

function itemText(it) {
  return (S.tab === 'artists'
    ? [it.tag, it.memo, ...(it.labels || [])]
    : [it.title, it.memo, ...(it.labels || []), ...(it.sections || []).map(x => x.body)]).join(' ').toLowerCase();
}

function colCount(w) { return w < 520 ? 2 : w < 860 ? 3 : w < 1240 ? 4 : 5; }

function artistCard(a, colW) {
  const imgs = imagesOf(a.id);
  const cover = coverOf(a, imgs);
  const name = displayName(a.tag) || a.tag;
  const card = h('article', { class: 'card', tabindex: 0, 'data-id': a.id, onclick: () => openArtist(a.id), onkeydown: e => { if (e.key === 'Enter') openArtist(a.id); } });
  let est;
  if (cover) {
    card.append(h('div', { class: 'card-media', style: { aspectRatio: `${cover.w} / ${cover.h}` } },
      h('img', { src: urlOf(cover, 'thumb'), alt: name, loading: 'lazy', decoding: 'async', draggable: 'false' })));
    est = colW * cover.h / cover.w;
  } else {
    card.append(h('div', { class: 'card-text' }, h('span', { class: 'pre' }, 'artist'), h('span', { class: 'nm' }, name)));
    est = colW * 0.75;
  }
  const sub = [(a.labels || []).join(' · '), imgs.length ? `${imgs.length}장` : ''].filter(Boolean).join(' · ');
  card.append(h('div', { class: 'card-cap' },
    h('div', { class: 'card-meta' },
      h('div', { class: 'card-title' }, name),
      h('div', { class: 'card-sub' }, sub || '이미지 없음')),
    ib('copy', '태그 복사', e => { e.stopPropagation(); copy(a.tag, '태그를 복사했어요'); }, 'sm')));
  if (a.favorite) card.append(h('span', { class: 'card-fav', html: icon('starFill') }));
  return [card, est + 58];
}

function styleCard(s, colW) {
  const card = h('article', { class: 'card', tabindex: 0, 'data-id': s.id, onclick: () => openStyle(s.id), onkeydown: e => { if (e.key === 'Enter') openStyle(s.id); } });
  card.append(h('div', { class: 'card-media', style: { aspectRatio: `${s.w} / ${s.h}` } },
    h('img', { src: urlOf(s, 'thumb'), alt: styleTitle(s), loading: 'lazy', decoding: 'async', draggable: 'false' })));
  const arts = artistsOfStyle(s);
  // 제목 아래에는 메모를 한 줄로 보여준다
  const memo = (s.memo || '').replace(/\s+/g, ' ').trim();
  card.append(h('div', { class: 'card-cap' },
    h('div', { class: 'card-meta' },
      h('div', { class: 'card-title' }, styleTitle(s)),
      h('div', { class: 'card-sub', title: s.memo || null }, memo || ' ')),
    arts.length ? ib('copy', '작가 태그 복사', e => { e.stopPropagation(); copy(arts.map(formatTag).join(', '), '작가 태그를 복사했어요'); }, 'sm') : null));
  if (s.favorite) card.append(h('span', { class: 'card-fav', html: icon('starFill') }));
  if (!s.sections?.length) card.append(h('span', { class: 'card-badge' }, '메타데이터 없음'));
  return [card, colW * s.h / s.w + 58];
}

let lastCols = 0;
const LAYOUTS = [['masonry', '기본'], ['compact', '작게'], ['title', '제목만']];

function renderGrid() {
  const grid = $('#grid');
  const items = visibleItems();
  const layout = S.layout[S.tab] || 'masonry';
  grid.className = 'grid' + (layout === 'masonry' ? '' : ' layout-' + layout);
  if (layout !== 'masonry') {
    // 작게: 태그 탭처럼 정사각형 격자 / 제목만: 이미지 없이 이름만
    grid.replaceChildren(...items.map(it => (S.tab === 'artists' ? artistCard(it, 0) : styleCard(it, 0))[0]));
    renderEmpty(items.length);
    return;
  }
  const width = grid.clientWidth || window.innerWidth;
  const n = colCount(width);
  lastCols = n;
  const gap = parseFloat(getComputedStyle(grid).columnGap) || 16;
  const colW = (width - gap * (n - 1)) / n;
  const cols = Array.from({ length: n }, () => h('div', { class: 'col' }));
  const heights = new Array(n).fill(0);
  for (const it of items) {
    const [el, est] = S.tab === 'artists' ? artistCard(it, colW) : styleCard(it, colW);
    const k = heights.indexOf(Math.min(...heights));
    cols[k].append(el);
    heights[k] += est + gap;
  }
  grid.replaceChildren(...cols);
  renderEmpty(items.length);
}

function renderEmpty(n) {
  const el = $('#empty');
  const total = S.tab === 'artists' ? S.artists.length : S.styles.length;
  if (n) { el.hidden = true; return; }
  el.hidden = false;
  if (S.label === FAVS && !S.q.trim()) {
    el.replaceChildren(
      h('div', { class: 'empty-mark', html: icon('star') }),
      h('h2', {}, '즐겨찾기한 항목이 없어요'),
      h('p', {}, '항목 화면에서 ‘즐겨찾기’를 누르면 이 폴더에 자동으로 모여요.'));
    return;
  }
  if (S.label && !S.q.trim() && !S.fav) {
    const artists = S.tab === 'artists';
    el.replaceChildren(
      h('div', { class: 'empty-mark', html: icon('folder') }),
      h('h2', {}, '비어 있는 폴더예요'),
      h('p', {}, artists
        ? '여기서 작가를 등록하면 이 폴더에 들어가요. 이미 등록한 작가는 작가 화면의 ‘폴더’에서 이 폴더를 지정하세요.'
        : '여기서 그림체를 추가하면 이 폴더에 들어가요. 이미 추가한 그림체는 그림체 화면의 ‘폴더’에서 이 폴더를 지정하세요.'),
      !isSpecial(S.label) ? btn('plus', artists ? '작가 등록' : '그림체 추가', () => artists ? openNewArtist([]) : pickFiles(importStyles), 'btn-primary') : null);
    return;
  }
  if (total) {
    el.replaceChildren(h('h2', {}, '조건에 맞는 항목이 없어요'), h('p', {}, '검색어나 즐겨찾기 필터를 바꿔 보세요.'));
    return;
  }
  if (S.tab === 'artists') {
    el.replaceChildren(
      h('div', { class: 'empty-mark' }, 'Artists'),
      h('h2', {}, '작가 태그를 모아 보세요'),
      h('p', {}, isTouch ? '작가 태그와 화풍 예시 이미지를 함께 등록할 수 있어요.' : '작가 태그와 화풍 예시 이미지를 등록하세요. 이미지를 창에 끌어다 놓아도 돼요.'),
      btn('plus', '작가 등록', () => openNewArtist([]), 'btn-primary'));
  } else {
    el.replaceChildren(
      h('div', { class: 'empty-mark' }, 'Styles'),
      h('h2', {}, '그림체를 모아 보세요'),
      h('p', {}, 'NovelAI 원본 PNG를 넣으면 프롬프트와 UC 프롬프트를 자동으로 읽어 와요.'),
      btn('plus', '그림체 추가', () => pickFiles(importStyles), 'btn-primary'));
  }
}

function renderBanner() {
  const el = $('#banner');
  if (!isIOS || isStandalone || ls.get('bannerDismissed', false)) { el.hidden = true; return; }
  el.hidden = false;
  el.replaceChildren(
    h('span', {}, '공유 버튼 → ‘홈 화면에 추가’로 설치하면 데이터가 지워지지 않고 앱처럼 쓸 수 있어요.'),
    ib('x', '닫기', () => { ls.set('bannerDismissed', true); el.hidden = true; }, 'sm'));
}

function updateDot() {
  const has = S.artists.length || S.styles.length || S.tagItems.length || S.tagSections.length;
  $('#settingsBtn').classList.toggle('dot', !!has && S.dirtyAt > S.syncedAt);
}

function renderAll() {
  renderTabs();
  const tags = S.tab === 'tags';
  for (const id of ['folders', 'gridHead', 'grid', 'empty']) if (tags) $('#' + id).hidden = true;
  $('#grid').hidden = tags;
  if (tags) {
    tagTab.renderFilters();
    tagTab.render();
  } else {
    tagTab.hide();
    renderFilters();
    renderFolders();
    renderGrid();
  }
  updateDot();
}
let renderT;
function scheduleRender() { clearTimeout(renderT); renderT = setTimeout(renderAll, 150); }

// ---------- 작가 상세 ----------
function openArtist(id) {
  const layer = makeLayer('narrow');
  mountArtist(layer, id);
  openLayer(layer);
}

function mountArtist(layer, id) {
  layer._newArtist = false;
  layer._artistId = id;
  const render = () => {
    const a = S.artists.find(x => x.id === id);
    if (!a) { layer.body.replaceChildren(h('div', { class: 'detail' }, h('p', {}, '삭제된 작가예요.'))); return; }
    const top = layer.body.scrollTop;
    layer.body.replaceChildren(artistView(a, render));
    layer.body.scrollTop = top;
  };
  layer._refresh = render;
  render();
}

function artistView(a, rerender) {
  const imgs = imagesOf(a.id);
  const cover = coverOf(a, imgs);
  const usedIn = S.styles.filter(s => artistsOfStyle(s).some(t => t.artist?.id === a.id));

  const titleRow = h('div', { class: 'title-row' });
  const showTitle = () => titleRow.replaceChildren(
    h('h2', { class: 'detail-title' }, displayName(a.tag) || a.tag),
    ib('edit', '태그 원문 수정', editTitle, 'sm'));
  const editTitle = () => {
    const inp = h('input', { class: 'input title-input', value: a.tag, autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false' });
    let done = false;
    const finish = async ok => {
      if (done) return;
      done = true;
      const v = inp.value.trim();
      if (ok && v && v !== a.tag) {
        const ex = gallery().get(keyOfTag(v));
        if (ex && ex.id !== a.id) { toast('이미 같은 태그의 작가가 있어요'); done = false; inp.focus(); return; }
        await saveArtist(a, { tag: v }, true);
      }
      rerender();
    };
    inp.addEventListener('keydown', e => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    inp.addEventListener('blur', () => finish(true));
    titleRow.replaceChildren(inp);
    inp.focus();
    inp.select();
  };
  showTitle();

  const addTile = h('button', { class: 'add-tile', type: 'button', onclick: () => pickFiles(fs => addImagesTo(a, fs).then(rerender)) },
    h('span', { class: 'i', html: icon('plus') }), '이미지 추가',
    isTouch ? null : h('small', {}, '또는 끌어다 놓기'));

  const tiles = imgs.map(im => {
    const isCover = cover && cover.id === im.id;
    return h('div', { class: 'img-tile', onclick: () => openViewer(im) },
      h('img', { src: urlOf(im, 'thumb'), alt: '', loading: 'lazy', style: { aspectRatio: `${im.w} / ${im.h}` } }),
      isCover && imgs.length > 1 ? h('span', { class: 'cover-badge' }, '대표') : null,
      h('div', { class: 'tile-tools' },
        imgs.length > 1 && !isCover ? ib('bookmark', '대표 이미지로 지정', async e => { e.stopPropagation(); await saveArtist(a, { coverId: im.id }); rerender(); }, 'sm') : null,
        ib('trash', '이미지 삭제', async e => {
          e.stopPropagation();
          if (!await confirmDialog('이 이미지를 삭제할까요?', '삭제한 이미지는 되돌릴 수 없어요.')) return;
          await db.del('artistImages', im.id);
          await tomb('artistImages', [im.id]);
          dropUrls(im.id);
          S.images = S.images.filter(x => x.id !== im.id);
          if (a.coverId === im.id) await saveArtist(a, { coverId: null });
          markDirty();
          scheduleRender();
          rerender();
        }, 'sm')));
  });

  return h('div', { class: 'detail' },
    h('div', { class: 'eyebrow' }, 'Artist', a.favorite ? h('span', { class: 'eyebrow-star', html: icon('starFill') }) : null),
    titleRow,
    h('div', { class: 'detail-actions' },
      btn('copy', '태그 복사', () => copy(a.tag, '태그를 복사했어요'), 'btn-primary'),
      favBtn(a, p => saveArtist(a, p))),
    field('폴더', labelEditor(a.labels, labels => saveArtist(a, { labels }), [...new Set(S.artists.flatMap(x => x.labels || []))])),
    field('메모', memoBox(a.memo, memo => saveArtist(a, { memo }))),
    h('div', { class: 'section-h' }, h('h3', {}, '화풍 이미지'), h('span', { class: 'n' }, `${imgs.length}장`)),
    h('div', { class: 'img-grid' }, tiles, addTile),
    usedIn.length ? [
      h('div', { class: 'section-h' }, h('h3', {}, '이 작가가 쓰인 그림체'), h('span', { class: 'n' }, `${usedIn.length}개`)),
      h('div', { class: 'mini-row' }, usedIn.map(s => h('button', { class: 'mini', type: 'button', title: styleTitle(s), onclick: () => openStyle(s.id) },
        h('img', { src: urlOf(s, 'thumb'), alt: '', loading: 'lazy' })))),
    ] : null,
    h('div', { class: 'detail-foot' },
      h('span', {}, `등록 ${fmtDate(a.createdAt)}`),
      h('button', { class: 'btn-text danger', type: 'button', onclick: () => deleteArtist(a) }, '작가 삭제')));
}

async function deleteArtist(a) {
  const imgs = imagesOf(a.id);
  if (!await confirmDialog(`‘${displayName(a.tag)}’ 작가를 삭제할까요?`, imgs.length ? `화풍 이미지 ${imgs.length}장도 함께 삭제돼요.` : '삭제하면 되돌릴 수 없어요.')) return;
  await db.del('artists', a.id);
  await db.delMany('artistImages', imgs.map(i => i.id));
  await tomb('artists', [a.id]);
  await tomb('artistImages', imgs.map(i => i.id));
  imgs.forEach(i => dropUrls(i.id));
  S.artists = S.artists.filter(x => x.id !== a.id);
  S.images = S.images.filter(i => i.artistId !== a.id);
  gver++;
  markDirty();
  closeTop();
  renderAll();
  toast('삭제했어요');
}

async function addImagesTo(a, files) {
  const list = files.filter(f => f.prep || isImage(f));
  if (!list.length) return 0;
  const t = list.length > 2 ? toast(`이미지 처리 중… 0/${list.length}`, { sticky: true }) : null;
  let n = 0;
  for (const f of list) {
    try {
      const im = await (f.prep || makeImages(f));
      const rec = { id: uid(), artistId: a.id, thumb: im.thumb, image: im.image, w: im.w, h: im.h, createdAt: now(), updatedAt: now() };
      await db.put('artistImages', rec);
      S.images.push(rec);
      n++;
      t?.set(`이미지 처리 중… ${n}/${list.length}`);
    } catch (e) { console.error(e); }
  }
  t?.close();
  if (n) { markDirty(); scheduleRender(); persistStorage(); }
  if (n < list.length) toast(`${list.length - n}장은 읽지 못했어요`);
  return n;
}

// ---------- 작가 등록 ----------
function openNewArtist(files = [], presetTag = '') {
  const layer = makeLayer('narrow');
  layer._newArtist = true;
  const pending = [];
  const detected = new Map();
  let labels = S.tab === 'artists' ? presetFolder() : [];

  const tagInput = h('input', { class: 'input input-lg', placeholder: 'artist:이름', autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'done' });
  tagInput.value = presetTag;
  const hint = h('div', { class: 'hint' });
  const suggest = h('div', { class: 'suggest' });
  const thumbs = h('div', { class: 'pending-grid' });
  const memo = h('textarea', { class: 'input memo', rows: 3, placeholder: '메모를 남겨 보세요' });

  const checkDup = () => {
    const k = keyOfTag(tagInput.value);
    const ex = k ? gallery().get(k) : null;
    hint.textContent = ex ? '이미 등록된 작가예요. 저장하면 이미지가 기존 작가에 추가돼요.' : '';
    return ex;
  };
  tagInput.addEventListener('input', checkDup);
  const renderSuggest = () => suggest.replaceChildren(...(detected.size ? [
    h('span', { class: 'suggest-label' }, '이미지에서 찾은 작가 태그'),
    ...[...detected.values()].map(t => h('button', { class: 'chip', type: 'button', onclick: () => { tagInput.value = t.text; checkDup(); } }, displayName(t.text))),
  ] : []));
  const renderThumbs = () => thumbs.replaceChildren(
    ...pending.map(p => h('div', { class: 'pending' },
      h('img', { src: p.url, alt: '' }),
      ib('x', '빼기', () => { URL.revokeObjectURL(p.url); pending.splice(pending.indexOf(p), 1); renderThumbs(); }, 'xs pending-x'))),
    h('button', { class: 'pending-add', type: 'button', onclick: () => pickFiles(addFiles) }, h('span', { class: 'i', html: icon('plus') }), '이미지'));
  const addFiles = fs => {
    for (const f of fs.filter(isImage)) {
      const p = { url: URL.createObjectURL(f), prep: makeImages(f) };
      p.prep.catch(() => {});
      pending.push(p);
      readNaiMetadata(f).then(m => {
        if (!m) return;
        for (const t of extractArtists(promptTexts(m), gallery())) if (!detected.has(t.key)) detected.set(t.key, t);
        renderSuggest();
        if (!tagInput.value && detected.size === 1) { tagInput.value = [...detected.values()][0].text; checkDup(); }
      }).catch(() => {});
    }
    renderThumbs();
  };
  layer._addFiles = addFiles;

  const saveBtn = h('button', { class: 'btn btn-primary', type: 'button' }, '등록');
  const save = async () => {
    const tag = tagInput.value.trim();
    if (!tag) { tagInput.focus(); toast('태그 원문을 입력해 주세요'); return; }
    saveBtn.disabled = true;
    try {
      let a = checkDup();
      if (!a) {
        a = { id: uid(), tag, memo: memo.value.trim(), favorite: S.tab === 'artists' && S.label === FAVS, labels, coverId: null, createdAt: now(), updatedAt: now() };
        await db.put('artists', a);
        S.artists.push(a);
        gver++;
      } else if (labels.length || memo.value.trim()) {
        const merged = [...new Set([...(a.labels || []), ...labels])];
        await saveArtist(a, { labels: merged, memo: [a.memo, memo.value.trim()].filter(Boolean).join('\n') });
      }
      await addImagesTo(a, pending);
      pending.forEach(p => URL.revokeObjectURL(p.url));
      markDirty();
      persistStorage();
      mountArtist(layer, a.id);
      renderAll();
      toast('작가를 등록했어요');
    } catch (e) {
      console.error(e);
      toast('저장하지 못했어요');
      saveBtn.disabled = false;
    }
  };
  saveBtn.addEventListener('click', save);
  tagInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) save(); });

  layer.body.append(h('div', { class: 'detail' },
    h('div', { class: 'eyebrow' }, 'New Artist'),
    h('h2', { class: 'detail-title' }, '작가 태그 등록'),
    field('태그 원문', tagInput, hint, suggest),
    field('화풍 이미지', thumbs),
    field('폴더', labelEditor(labels, v => { labels = v; }, [...new Set(S.artists.flatMap(x => x.labels || []))])),
    field('메모', memo),
    h('div', { class: 'form-actions' }, btn(null, '취소', closeTop), saveBtn)));
  openLayer(layer);
  addFiles(files);
  renderThumbs();
  if (presetTag) checkDup();
  if (!files.length && !isTouch) setTimeout(() => tagInput.focus(), 260);
}

async function createArtistFromTag(text) {
  const ex = gallery().get(keyOfTag(text));
  if (ex) return ex;
  const a = { id: uid(), tag: text, memo: '', favorite: false, labels: [], coverId: null, createdAt: now(), updatedAt: now() };
  await db.put('artists', a);
  S.artists.push(a);
  gver++;
  markDirty();
  scheduleRender();
  toast(`‘${displayName(text)}’을(를) 작가 갤러리에 추가했어요`);
  return a;
}

// ---------- 그림체 ----------
async function importStyles(files) {
  const imgs = files.filter(isImage);
  if (!imgs.length) return;
  const t = toast(`그림체 읽는 중… 0/${imgs.length}`, { sticky: true });
  let added = 0, dup = 0, nometa = 0, failed = 0, lastId = null;
  const presetLabels = S.tab === 'styles' ? presetFolder() : [];
  const presetFav = S.tab === 'styles' && S.label === FAVS;
  for (const f of imgs) {
    try {
      const meta = await readNaiMetadata(f);
      const sig = meta ? hash(meta.raw) : null;
      if (sig && S.styles.some(s => s.sig === sig)) { dup++; continue; }
      const im = await makeImages(f);
      const s = {
        id: uid(), title: '', thumb: im.thumb, image: im.image, w: im.w, h: im.h,
        sections: meta?.sections || [], raw: meta?.raw || '', source: meta?.source || 'none', sig,
        fileName: f.name || '', memo: '', favorite: presetFav, labels: [...presetLabels],
        createdAt: now(), updatedAt: now(),
      };
      await db.put('styles', s);
      S.styles.push(s);
      added++;
      lastId = s.id;
      if (!meta) nometa++;
    } catch (e) { console.error(e); failed++; }
    t.set(`그림체 읽는 중… ${added + dup + failed}/${imgs.length}`);
  }
  t.close();
  if (added) { markDirty(); persistStorage(); }
  if (S.tab !== 'styles') { S.tab = 'styles'; ls.set('tab', S.tab); S.label = null; }
  renderAll();
  const parts = [];
  if (added) parts.push(`${added}개 추가`);
  if (dup) parts.push(`중복 ${dup}개 건너뜀`);
  if (nometa) parts.push(`메타데이터 없음 ${nometa}개`);
  if (failed) parts.push(`실패 ${failed}개`);
  toast(parts.join(' · ') || '추가된 항목이 없어요', { ms: 3200 });
  if (added === 1 && imgs.length === 1) openStyle(lastId);
}

function openStyle(id) {
  const layer = makeLayer('wide');
  const render = () => {
    const s = S.styles.find(x => x.id === id);
    if (!s) { layer.body.replaceChildren(h('div', { class: 'detail' }, h('p', {}, '삭제된 그림체예요.'))); return; }
    const top = layer.body.scrollTop;
    layer.body.replaceChildren(styleView(s, render));
    layer.body.scrollTop = top;
  };
  layer._refresh = render;
  render();
  openLayer(layer);
}

function noMetaNotice() {
  return h('div', { class: 'notice' },
    h('strong', {}, '이 이미지에서 메타데이터를 찾지 못했어요.'), h('br'),
    '사진 앱에 저장하거나 메신저로 보내면 이미지가 JPEG로 바뀌면서 메타데이터가 지워질 수 있어요. NovelAI에서 받은 원본 PNG 파일을 사용해 주세요.');
}

function textPane(s) {
  const secs = s.sections || [];
  if (!secs.length) return noMetaNotice();
  const full = secs.map(x => `[${x.title}]\n${x.body}`).join('\n\n');
  return h('div', { class: 'pane' },
    h('div', { class: 'pane-tools' }, btn('copy', '전체 복사', () => copy(full, '전체 텍스트를 복사했어요'))),
    secs.map(x => h('div', { class: 'tsec tsec-' + x.kind },
      h('div', { class: 'tsec-head' },
        h('span', { class: 'tsec-title' }, x.title),
        ib('copy', `${x.title} 복사`, () => copy(x.body, `${x.title}를 복사했어요`), 'sm')),
      h('pre', { class: 'tsec-body' }, x.body))),
    s.raw ? h('details', { class: 'raw' }, h('summary', {}, '원본 메타데이터 (JSON)'), h('pre', {}, s.raw)) : null);
}

function artistPane(s, rerender) {
  if (!s.sections?.length) return noMetaNotice();
  const list = artistsOfStyle(s);
  if (!list.length) {
    return h('div', { class: 'notice' },
      h('strong', {}, '프롬프트에서 작가 태그를 찾지 못했어요.'), h('br'),
      h('small', {}, '‘artist:’가 붙은 태그와, 작가 갤러리에 등록된 태그를 찾아요.'));
  }
  const all = list.map(formatTag).join(', ');
  return h('div', { class: 'pane' },
    h('div', { class: 'pane-tools' },
      btn('copy', '작가 태그 모두 복사', () => copy(all, '작가 태그를 복사했어요'), 'btn-primary'),
      h('span', { class: 'pane-note' }, '태그를 누르면 하나씩 복사돼요')),
    h('div', { class: 'artist-list' }, list.map(t => {
      const a = t.artist;
      const cover = a && coverOf(a);
      const name = displayName(t.text);
      return h('div', { class: 'artist-row' },
        h('button', { class: 'ar-thumb', type: 'button', tabindex: a ? null : -1, onclick: a ? () => openArtist(a.id) : null, 'aria-label': a ? `${name} 보기` : null },
          cover ? h('img', { src: urlOf(cover, 'thumb'), alt: '' }) : h('span', {}, (name[0] || '?').toUpperCase())),
        h('button', { class: 'ar-main', type: 'button', title: '눌러서 복사', onclick: () => copy(formatTag(t), `‘${name}’ 복사했어요`) },
          h('span', { class: 'ar-name' }, name)),
        t.weight !== 1 ? h('span', { class: 'ar-weight' + (t.weight < 1 ? ' down' : '') }, `×${t.weight}`) : null,
        a
          ? h('button', { class: 'btn btn-ghost sm', type: 'button', onclick: () => openArtist(a.id) }, '보기')
          : ib('plus', '작가 갤러리에 추가', async () => { await createArtistFromTag(t.text); rerender(); }, 'sm add-art'));
    })));
}

function styleView(s, rerender) {
  const arts = artistsOfStyle(s);
  const titleIn = h('input', { class: 'title-input inline', placeholder: '제목 없음', value: s.title || '', 'aria-label': '제목' });
  let tt;
  titleIn.addEventListener('input', () => { clearTimeout(tt); tt = setTimeout(() => saveStyle(s, { title: titleIn.value.trim() }), 500); });
  titleIn.addEventListener('blur', () => { clearTimeout(tt); if ((s.title || '') !== titleIn.value.trim()) saveStyle(s, { title: titleIn.value.trim() }); });
  titleIn.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) titleIn.blur(); });

  const pane = h('div');
  const segBtns = [['text', '전체 텍스트', null], ['artists', '작가 태그', arts.length]];
  const seg = h('div', { class: 'seg', role: 'tablist' });
  const showPane = () => {
    seg.replaceChildren(...segBtns.map(([v, label, n]) => h('button', {
      class: S.styleView === v ? 'active' : '', type: 'button', role: 'tab', 'aria-selected': S.styleView === v,
      onclick: () => { S.styleView = v; ls.set('styleView', v); showPane(); },
    }, label, n ? h('span', { class: 'n' }, n) : null)));
    pane.replaceChildren(S.styleView === 'artists' ? artistPane(s, rerender) : textPane(s));
  };
  showPane();

  const srcBadge = { png: 'PNG 메타데이터', stealth: '스텔스 메타데이터', none: '메타데이터 없음' }[s.source] || '';
  return h('div', { class: 'style-detail' },
    h('div', { class: 'detail-media' },
      h('button', { class: 'media-btn', type: 'button', onclick: () => openViewer(s), 'aria-label': '크게 보기' },
        h('img', { src: urlOf(s, 'image'), alt: '', style: { aspectRatio: `${s.w} / ${s.h}` } }))),
    h('div', { class: 'detail-info' },
      h('div', { class: 'eyebrow' }, 'Style', srcBadge ? h('span', { class: 'badge' + (s.source === 'none' ? ' warn' : '') }, srcBadge) : null),
      titleIn,
      h('div', { class: 'detail-actions' },
        arts.length ? btn('copy', '작가 태그 복사', () => copy(arts.map(formatTag).join(', '), '작가 태그를 복사했어요'), 'btn-primary') : null,
        favBtn(s, p => saveStyle(s, p))),
      field('폴더', labelEditor(s.labels, labels => saveStyle(s, { labels }), [...new Set(S.styles.flatMap(x => x.labels || []))])),
      field('메모', memoBox(s.memo, memo => saveStyle(s, { memo }))),
      seg,
      pane,
      h('div', { class: 'detail-foot' },
        h('span', {}, `추가 ${fmtDate(s.createdAt)}`, s.fileName ? ` · ${s.fileName}` : '', ` · ${s.w}×${s.h}`),
        h('button', { class: 'btn-text danger', type: 'button', onclick: () => deleteStyle(s) }, '그림체 삭제'))));
}

async function deleteStyle(s) {
  if (!await confirmDialog('이 그림체를 삭제할까요?', '삭제하면 되돌릴 수 없어요.')) return;
  await db.del('styles', s.id);
  await tomb('styles', [s.id]);
  dropUrls(s.id);
  S.styles = S.styles.filter(x => x.id !== s.id);
  markDirty();
  closeTop();
  renderAll();
  toast('삭제했어요');
}

function openViewer(rec) {
  const layer = h('div', { class: 'layer viewer-layer', onclick: closeTop },
    h('div', { class: 'scrim' }),
    h('img', { class: 'viewer-img', src: urlOf(rec, 'image'), alt: '' }),
    ib('x', '닫기', closeTop, 'viewer-close'));
  openLayer(layer);
}

// ---------- 설정 / 백업 ----------
function openSettings() {
  const layer = makeLayer('narrow');
  const render = async () => { layer.body.replaceChildren(await settingsView(render)); };
  layer._refresh = render;
  render();
  openLayer(layer);
}

async function storageInfo() {
  try {
    const e = await navigator.storage?.estimate?.();
    const p = await navigator.storage?.persisted?.();
    return { usage: e?.usage, persisted: p };
  } catch { return {}; }
}

async function settingsView(rerender) {
  const st = await storageInfo();
  const bytes = [...S.images, ...S.styles, ...S.tagItems].reduce((n, r) => n + (r.thumb?.size || 0) + (r.image?.size || 0), 0);
  const dirty = S.dirtyAt > S.syncedAt && (S.artists.length || S.styles.length || S.tagItems.length || S.tagSections.length);
  const exportBtn = btn('download', '백업 파일 만들기', e => doExport(e.currentTarget).then(rerender), 'btn-primary');
  return h('div', { class: 'detail' },
    h('div', { class: 'eyebrow' }, 'Settings'),
    h('h2', { class: 'detail-title' }, '설정'),
    h('div', { class: 'set-card' },
      h('h3', {}, '카드 배열'),
      h('p', {}, '작가와 그림체 목록을 어떻게 보여줄지 골라요. 이 기기에만 적용돼요.'),
      h('div', { class: 'layout-rows' }, [['artists', '작가'], ['styles', '그림체']].map(([tab, name]) => h('div', { class: 'layout-row' },
        h('span', { class: 'layout-name' }, name),
        h('div', { class: 'seg layout-seg', role: 'radiogroup', 'aria-label': `${name} 카드 배열` },
          LAYOUTS.map(([v, label]) => h('button', {
            type: 'button', role: 'radio', class: (S.layout[tab] || 'masonry') === v ? 'active' : '', 'aria-checked': (S.layout[tab] || 'masonry') === v,
            onclick: () => { S.layout = { ...S.layout, [tab]: v }; ls.set('layout', S.layout); renderAll(); rerender(); },
          }, h('span', { class: 'layout-ico ' + v }, h('i'), h('i'), h('i'), h('i')), label))))))),
    h('h3', { class: 'set-section' }, '백업 · 동기화'),
    h('p', { class: 'lead' }, '데이터는 이 기기의 브라우저 안에만 저장돼요. 맥에서 백업 파일을 만들어 iCloud Drive에 저장하고, 아이폰에서 그 파일을 불러오면 같은 내용이 돼요.'),
    h('div', { class: 'set-card' },
      h('h3', {}, '내보내기'),
      h('div', { class: 'stat-row' },
        h('span', {}, '작가 ', h('b', {}, S.artists.length)),
        h('span', {}, '화풍 이미지 ', h('b', {}, S.images.length)),
        h('span', {}, '그림체 ', h('b', {}, S.styles.length)),
        h('span', {}, '태그 카드 ', h('b', {}, S.tagItems.length)),
        h('span', {}, '예상 크기 ', h('b', {}, fmtBytes(bytes)))),
      h('p', {}, isTouch ? '만든 뒤 공유 시트에서 ‘파일에 저장’ → iCloud Drive를 고르세요.' : '저장 위치로 iCloud Drive를 고르면 아이폰 ‘파일’ 앱에서 바로 보여요.'),
      exportBtn),
    h('div', { class: 'set-card' },
      h('h3', {}, '불러오기'),
      h('p', {}, '백업 파일(.zip)을 고르면 ‘전체 교체’나 ‘합치기’ 중에서 선택할 수 있어요.'),
      btn('upload', '백업 파일 선택', () => pickFiles(fs => doImport(fs[0]).then(rerender), '.zip,application/zip', false))),
    h('div', { class: 'set-card' },
      h('h3', {}, '이 기기'),
      h('dl', { class: 'kv' },
        h('dt', {}, '마지막 백업·불러오기'), h('dd', {}, fmtDate(S.syncedAt)),
        h('dt', {}, '그 이후 변경'), h('dd', { class: dirty ? 'warn' : '' }, dirty ? '있음 — 백업을 권장해요' : '없음'),
        h('dt', {}, '사용 중인 저장 공간'), h('dd', {}, fmtBytes(st.usage)),
        h('dt', {}, '영구 저장'), h('dd', {}, st.persisted ? '허용됨' : isIOS && !isStandalone ? '홈 화면에 추가하면 안전해요' : '브라우저가 결정함'))),
    h('div', { class: 'detail-foot' },
      h('span', {}, `Atelier ${VERSION}`),
      h('button', { class: 'btn-text danger', type: 'button', onclick: () => wipeAll().then(rerender) }, '이 기기의 데이터 모두 지우기')));
}

const stamp = () => {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};

async function saveFile(blob, name) {
  const file = new File([blob], name, { type: 'application/zip' });
  if ('showSaveFilePicker' in window) {
    try {
      const fh = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Atelier 백업', accept: { 'application/zip': ['.zip'] } }] });
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) { if (e.name === 'AbortError') return false; }
  }
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    const go = await dialog({
      title: '백업 파일이 준비됐어요',
      text: `${name}\n${fmtBytes(blob.size)}\n\n공유 시트에서 ‘파일에 저장’을 눌러 iCloud Drive에 저장하세요.`,
      actions: [{ label: '취소', value: false }, { label: '공유 · 저장', value: true, kind: 'btn-primary' }],
    });
    if (!go) return false;
    try { await navigator.share({ files: [file] }); return true; }
    catch (e) { if (e.name === 'AbortError') return false; }
  }
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  return true;
}

async function doExport(button) {
  if (!S.artists.length && !S.styles.length && !S.tagItems.length && !S.tagSections.length) { toast('내보낼 데이터가 없어요'); return; }
  button.disabled = true;
  const t = toast('백업 파일을 만드는 중…', { sticky: true });
  try {
    const tombstones = await db.all('tombstones');
    const blob = await buildBackup({ artists: S.artists, images: S.images, styles: S.styles, tombstones, folderOrder: S.folderOrder, itemOrder: S.itemOrder, tagSections: S.tagSections, tagItems: S.tagItems });
    t.close();
    const ok = await saveFile(blob, `atelier-backup-${stamp()}.zip`);
    if (ok) {
      S.syncedAt = now();
      await db.setMeta('syncedAt', S.syncedAt);
      updateDot();
      toast(`백업 완료 · ${fmtBytes(blob.size)}`);
    }
  } catch (e) {
    console.error(e);
    t.close();
    toast('백업하지 못했어요: ' + e.message, { ms: 4000 });
  } finally { button.disabled = false; }
}

async function doImport(file) {
  if (!file) return;
  const t = toast('백업 파일을 읽는 중…', { sticky: true });
  let data;
  try { data = await parseBackup(file); }
  catch (e) { t.close(); toast('불러오지 못했어요: ' + e.message, { ms: 4000 }); return; }
  t.close();
  const mode = await dialog({
    title: '백업을 불러올까요?',
    text: `작가 ${data.artists.length} · 화풍 이미지 ${data.artistImages.length} · 그림체 ${data.styles.length} · 태그 ${data.tagItems.length}\n${fmtDate(data.exportedAt)}에 만든 백업이에요.\n\n전체 교체 — 이 기기의 데이터를 백업 내용으로 바꿔요. (권장)\n합치기 — 양쪽 중 더 최근에 수정된 항목을 남겨요.`,
    actions: [{ label: '취소', value: null }, { label: '합치기', value: 'merge' }, { label: '전체 교체', value: 'replace', kind: 'btn-primary' }],
  });
  if (!mode) return;
  const t2 = toast('불러오는 중…', { sticky: true });
  try {
    const localNewer = await applyBackup(data, mode);
    await reloadState();
    S.syncedAt = now();
    S.dirtyAt = localNewer ? S.syncedAt + 1 : S.syncedAt;
    await db.setMeta('syncedAt', S.syncedAt);
    await db.setMeta('dirtyAt', S.dirtyAt);
    persistStorage();
    S.label = null;
    renderAll();
    t2.close();
    toast(mode === 'replace' ? '백업 내용으로 바꿨어요' : '백업을 합쳤어요');
  } catch (e) {
    console.error(e);
    t2.close();
    toast('불러오지 못했어요: ' + e.message, { ms: 4000 });
  }
}

// 반환값: 합치기 후 이 기기에만 있는(또는 더 최신인) 항목이 있는지
async function applyBackup(data, mode) {
  const stores = ['artists', 'artistImages', 'styles', 'tagSections', 'tagItems'];
  const incoming = { artists: data.artists, artistImages: data.artistImages, styles: data.styles, tagSections: data.tagSections, tagItems: data.tagItems };
  if (mode === 'replace') {
    await db.clear([...stores, 'tombstones']);
    for (const s of stores) await db.putMany(s, incoming[s]);
    await db.putMany('tombstones', data.tombstones);
    if (data.folderOrder) await db.setMeta('folderOrder', data.folderOrder);
    if (data.itemOrder) await db.setMeta('itemOrder', data.itemOrder);
    return false;
  }
  let localNewer = false;
  const lo = await db.getMeta('folderOrder', null);
  const io = data.folderOrder;
  if (io && (!lo || (io.updatedAt || 0) > (lo.updatedAt || 0))) await db.setMeta('folderOrder', io);
  else if (lo && (!io || (lo.updatedAt || 0) > (io.updatedAt || 0))) localNewer = true;
  const lio = await db.getMeta('itemOrder', null);
  const iio = data.itemOrder;
  if (iio && (!lio || (iio.updatedAt || 0) > (lio.updatedAt || 0))) await db.setMeta('itemOrder', iio);
  else if (lio && (!iio || (lio.updatedAt || 0) > (iio.updatedAt || 0))) localNewer = true;
  const tombs = new Map((await db.all('tombstones')).map(t => [t.id, t]));
  const inTombIds = new Set(data.tombstones.map(t => t.id));
  for (const t of data.tombstones) {
    const ex = tombs.get(t.id);
    if (!ex || ex.deletedAt < t.deletedAt) tombs.set(t.id, t);
  }
  for (const [id] of tombs) if (!inTombIds.has(id)) localNewer = true;
  for (const s of stores) {
    const local = new Map((await db.all(s)).map(r => [r.id, r]));
    const inc = new Map(incoming[s].map(r => [r.id, r]));
    const put = [], del = [];
    for (const r of incoming[s]) {
      const t = tombs.get(r.id);
      if (t && t.deletedAt >= (r.updatedAt || 0)) continue;
      const l = local.get(r.id);
      if (!l || (r.updatedAt || 0) > (l.updatedAt || 0)) put.push(r);
    }
    for (const [id, l] of local) {
      const t = tombs.get(id);
      if (t && t.deletedAt >= (l.updatedAt || 0)) { del.push(id); continue; }
      const r = inc.get(id);
      if (!r || (l.updatedAt || 0) > (r.updatedAt || 0)) localNewer = true;
    }
    await db.putMany(s, put);
    await db.delMany(s, del);
  }
  await db.putMany('tombstones', [...tombs.values()]);
  return localNewer;
}

async function wipeAll() {
  if (!await confirmDialog('이 기기의 데이터를 모두 지울까요?', '작가, 화풍 이미지, 그림체, 태그가 모두 삭제돼요. 백업 파일이 없다면 되돌릴 수 없어요.', '모두 지우기')) return;
  await db.clear(['artists', 'artistImages', 'styles', 'tagSections', 'tagItems', 'tombstones']);
  await db.setMeta('folderOrder', { artists: [], styles: [], updatedAt: 0 });
  await db.setMeta('itemOrder', { artists: {}, styles: {}, updatedAt: 0 });
  await reloadState();
  S.syncedAt = S.dirtyAt = 0;
  await db.setMeta('syncedAt', 0);
  await db.setMeta('dirtyAt', 0);
  renderAll();
  toast('모두 지웠어요');
}

async function reloadState() {
  dropAllUrls();
  styleArtCache.clear();
  [S.artists, S.images, S.styles, S.tagSections, S.tagItems] = await Promise.all(
    ['artists', 'artistImages', 'styles', 'tagSections', 'tagItems'].map(s => db.all(s)));
  const ids = new Set(S.artists.map(a => a.id));
  S.images = S.images.filter(i => ids.has(i.artistId));
  S.folderOrder = await db.getMeta('folderOrder', { artists: [], styles: [], updatedAt: 0 });
  S.itemOrder = await db.getMeta('itemOrder', { artists: {}, styles: {}, updatedAt: 0 });
  gver++;
}

// ---------- 파일 끌어다 놓기 ----------
function dropContext() {
  const top = stack[stack.length - 1];
  if (top?._newArtist) return { label: '이미지 추가', sub: '등록 중인 작가에 넣어요', run: fs => top._addFiles(fs) };
  if (top?._artistId) {
    const a = S.artists.find(x => x.id === top._artistId);
    if (a) return { label: `‘${displayName(a.tag)}’에 이미지 추가`, sub: '화풍 이미지로 저장돼요', run: fs => addImagesTo(a, fs).then(() => top._refresh?.()) };
  }
  if (stack.length || S.tab === 'tags') return null;
  if (S.tab === 'artists') return { label: '새 작가 등록', sub: '이미지에서 작가 태그를 찾아 채워요', run: fs => openNewArtist(fs) };
  return { label: '그림체로 추가', sub: '프롬프트와 UC 프롬프트를 읽어 와요', run: fs => importStyles(fs) };
}

function setupDrop() {
  const dz = $('#dropzone');
  let depth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    const ctx = dropContext();
    if (!ctx) return;
    dz.querySelector('.t').textContent = ctx.label;
    dz.querySelector('.s').textContent = ctx.sub;
    dz.hidden = false;
  });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('dragleave', e => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) dz.hidden = true; });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    dz.hidden = true;
    const files = [...e.dataTransfer.files];
    const zip = files.find(isZip);
    if (zip) { doImport(zip); return; }
    const imgs = files.filter(isImage);
    if (!imgs.length) return;
    dropContext()?.run(imgs);
  });
}

// ---------- 태그 탭 ----------
const tagTab = createTagTab({
  S, h, ib, btn, icon, toast, copy, db, uid, now, markDirty, tomb,
  promptDialog, confirmDialog, makeLayer, openLayer, closeTop,
  pickFiles, makeImages, urlOf, dropUrls, isTouch, isImage, persistStorage,
  renderAll: () => renderAll(),
});

// ---------- 시작 ----------
async function init() {
  $('#searchIcon').innerHTML = icon('search');
  $('#addIcon').innerHTML = icon('plus');
  $('#settingsBtn').innerHTML = icon('settings');

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => {
    if (S.tab === b.dataset.tab) return;
    S.tab = b.dataset.tab;
    S.label = null;
    S.fav = false;
    ls.set('tab', S.tab);
    renderAll();
    window.scrollTo({ top: 0 });
  }));
  let qt;
  $('#search').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { S.q = e.target.value; if (S.tab === 'tags') tagTab.render(); else { renderFolders(); renderGrid(); } }, 90); });
  $('#addBtn').addEventListener('click', () => {
    if (S.tab === 'artists') openNewArtist([]);
    else if (S.tab === 'styles') pickFiles(importStyles);
    else tagTab.addFromHeader();
  });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#grid').addEventListener('pointerdown', itemDragStart);

  let rt;
  let lastW = window.innerWidth;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      if (S.tab !== 'tags') { renderFolders(); renderGrid(); }
    }, 140);
  });
  setupDrop();

  try {
    await db.open();
    await reloadState();
    S.syncedAt = await db.getMeta('syncedAt', 0);
    S.dirtyAt = await db.getMeta('dirtyAt', 0);
    S.folderOrder = await db.getMeta('folderOrder', S.folderOrder);
  } catch (e) {
    console.error(e);
    toast('저장소를 열지 못했어요. 개인정보 보호 모드에서는 저장이 안 될 수 있어요.', { ms: 6000 });
  }
  renderBanner();
  // 세리프 폰트가 준비된 뒤에 화면을 보여줘서 글꼴이 바뀌며 깜빡이지 않게 한다
  try {
    await Promise.race([
      document.fonts.load('500 20px "Atelier Serif"', '가A'),
      new Promise(r => setTimeout(r, 3000)),
    ]);
  } catch { /* 무시 */ }
  renderAll();
  document.body.classList.add('ready');

  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if ('serviceWorker' in navigator && !local) navigator.serviceWorker.register('sw.js').catch(console.warn);
}

init();
