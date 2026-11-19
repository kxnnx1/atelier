// 태그 탭: 구역(폴더) · 카드 · 세트 · 변형 태그 · 트레이
//
// 데이터
//   tagSections: { id, name, order, createdAt, updatedAt }
//   tagItems:    { id, type: 'card' | 'set', sectionId, name, tag, variants: [{id, name, tag}],
//                  options: [{id, name, tag}], thumb, w, h, order, createdAt, updatedAt }
// 트레이는 저장하지 않는다 (앱을 다시 열면 비어 있음)

export function createTagTab(ctx) {
  const {
    S, h, ib, btn, icon, toast, copy, db, uid, now, markDirty, tomb,
    promptDialog, confirmDialog, makeLayer, openLayer, closeTop,
    pickFiles, makeImages, urlOf, dropUrls, isTouch, isImage, persistStorage,
  } = ctx;
  const $ = s => document.querySelector(s);

  const T = {
    mode: (() => { try { return localStorage.getItem('atelier.tagMode') === 'edit' ? 'edit' : 'use'; } catch { return 'use'; } })(),
    open: new Set(),   // 펼친 아코디언
    tray: [],          // { id, tag, name, w10 }  (w10 = 가중치 × 10)
    pop: null,
  };
  const setMode = m => {
    T.mode = m;
    try { localStorage.setItem('atelier.tagMode', m); } catch { /* 무시 */ }
  };

  // ---------- 데이터 도우미 ----------
  const sections = () => [...S.tagSections].sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt);
  const secId = it => (it.sectionId && S.tagSections.some(s => s.id === it.sectionId) ? it.sectionId : null);
  const itemsIn = sid => S.tagItems.filter(i => secId(i) === sid).sort((a, b) => (a.order || 0) - (b.order || 0) || a.createdAt - b.createdAt);
  const nextOrder = sid => Math.max(0, ...itemsIn(sid).map(i => i.order || 0)) + 1;
  const label = it => it.name || it.tag || '이름 없음';
  const groups = () => {
    const g = sections().map(sec => ({ sec, items: itemsIn(sec.id) }));
    const un = itemsIn(null);
    if (un.length || !g.length) g.push({ sec: null, items: un });
    return g;
  };
  const match = (it, q) => !q || [
    it.name, it.tag,
    ...(it.variants || []).flatMap(v => [v.name, v.tag]),
    ...(it.options || []).flatMap(o => [o.name, o.tag]),
  ].join(' ').toLowerCase().includes(q);

  async function saveItem(it, patch = {}) {
    Object.assign(it, patch, { updatedAt: now() });
    await db.put('tagItems', it);
    markDirty();
  }
  async function saveSection(sec, patch = {}) {
    Object.assign(sec, patch, { updatedAt: now() });
    await db.put('tagSections', sec);
    markDirty();
  }

  // ---------- 누르기 (클릭 / 우클릭 / 길게 누르기) ----------
  // tap: 클릭·탭, secondary: 우클릭·길게 누르기
  function attachPress(el, { tap, secondary }) {
    let timer = 0, fired = false, touch = false, sx = 0, sy = 0, skipUntil = 0;
    el.addEventListener('pointerdown', e => {
      touch = e.pointerType !== 'mouse';
      if (!touch || !secondary) return;
      fired = false;
      sx = e.clientX; sy = e.clientY;
      clearTimeout(timer);
      timer = setTimeout(() => { fired = true; navigator.vibrate?.(10); secondary({ clientX: sx, clientY: sy }); }, 450);
    });
    el.addEventListener('pointermove', e => { if (touch && Math.hypot(e.clientX - sx, e.clientY - sy) > 10) clearTimeout(timer); });
    el.addEventListener('pointerup', () => { clearTimeout(timer); if (touch && fired) skipUntil = Date.now() + 700; });
    el.addEventListener('pointercancel', () => clearTimeout(timer));
    el.addEventListener('click', e => {
      if (Date.now() < skipUntil) { e.preventDefault(); e.stopPropagation(); return; }
      tap?.(e);
    });
    el.addEventListener('contextmenu', e => {
      if (!secondary) return;
      e.preventDefault();
      if (!touch) secondary(e);
    });
    el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); tap?.(e); } });
  }

  // ---------- 트레이 ----------
  const fmtW = w10 => String(+(w10 / 10).toFixed(1));
  const weighted = t => (t.w10 === 10 ? t.tag : `${fmtW(t.w10)}::${t.tag}::`);

  // 반환값: 새로 담겼으면 true
  function trayAdd(tag, name) {
    tag = String(tag || '').trim();
    if (!tag) { toast('태그가 비어 있어요'); return false; }
    const ex = T.tray.find(t => t.tag === tag);
    if (ex) { renderTray(ex.id); return false; }
    const t = { id: uid(), tag, name: name || tag, w10: 10 };
    T.tray.push(t);
    renderTray(t.id);
    return true;
  }

  function copyTray() {
    if (!T.tray.length) return;
    copy(T.tray.map(weighted).join(', '), `트레이 ${T.tray.length}개를 복사했어요`);
  }

  function chipEl(t, flashId) {
    const cls = 'tchip' + (t.w10 > 10 ? ' up' : t.w10 < 10 ? ' down' : '') + (t.id === flashId ? ' flash' : '');
    const el = h('div', { class: cls, role: 'button', tabindex: 0, title: weighted(t), 'aria-label': `${t.name} 가중치 ${fmtW(t.w10)}` },
      h('span', { class: 'tchip-name' }, t.name),
      t.w10 !== 10 ? h('span', { class: 'tchip-w' }, fmtW(t.w10)) : null,
      h('button', {
        class: 'tchip-x', type: 'button', 'aria-label': `${t.name} 빼기`, html: icon('x'),
        onpointerdown: e => e.stopPropagation(),
        onclick: e => { e.stopPropagation(); T.tray = T.tray.filter(x => x !== t); renderTray(); },
      }));
    const bump = d => {
      t.w10 = Math.min(30, Math.max(1, t.w10 + d));
      renderTray(t.id);
    };
    attachPress(el, { tap: () => bump(-1), secondary: () => bump(+1) });
    return el;
  }

  function renderTray(flashId) {
    const el = $('#tray');
    const on = S.tab === 'tags';
    el.hidden = !on;
    document.body.classList.toggle('has-tray', on);
    if (!on) return;
    const n = T.tray.length;
    const copyBtn = btn('copy', '복사', copyTray, 'btn-primary sm');
    const clearBtn = btn(null, '비우기', () => { T.tray = []; renderTray(); }, 'btn-ghost sm');
    if (!n) { copyBtn.disabled = true; clearBtn.disabled = true; }
    el.replaceChildren(h('div', { class: 'tray-inner' },
      h('div', { class: 'tray-head' },
        h('span', { class: 'tray-title' }, '트레이'),
        n ? h('span', { class: 'tray-n' }, n) : null,
        n ? h('span', { class: 'tray-hint' }, isTouch ? '탭 −0.1 · 길게 눌러 +0.1' : '클릭 −0.1 · 우클릭 +0.1') : null),
      h('div', { class: 'tray-chips' },
        n ? T.tray.map(t => chipEl(t, flashId)) : h('span', { class: 'tray-empty' }, '카드의 + 를 눌러 태그를 담아 보세요')),
      h('div', { class: 'tray-actions' }, clearBtn, copyBtn)));
    if (flashId) el.querySelector('.tchip.flash')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ---------- 변형 태그 메뉴 ----------
  function closePop() {
    if (!T.pop) return;
    T.pop.remove();
    T.pop = null;
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', popKey, true);
    window.removeEventListener('scroll', closePop, true);
  }
  const outside = e => { if (T.pop && !T.pop.contains(e.target)) closePop(); };
  const popKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); closePop(); } };

  function openVariants(it, pt) {
    closePop();
    const rows = [{ name: label(it), tag: it.tag, base: true }, ...(it.variants || []).filter(v => v.tag || v.name)];
    const pop = h('div', { class: 'vpop' + (isTouch ? ' sheetlike' : ''), role: 'menu' },
      h('div', { class: 'vpop-head' }, h('span', {}, label(it)), h('span', { class: 'vpop-sub' }, '변형 태그')),
      rows.map(v => h('div', { class: 'vpop-row' + (v.base ? ' base' : '') },
        h('button', {
          class: 'vpop-main', type: 'button', role: 'menuitem',
          onclick: () => { if (!v.tag) { toast('태그가 비어 있어요'); return; } copy(v.tag, `‘${v.name || v.tag}’ 복사했어요`); closePop(); },
        }, h('span', { class: 'vpop-name' }, v.name || v.tag), v.base ? h('span', { class: 'vpop-badge' }, '기본') : null),
        ib('plus', '트레이에 담기', () => { if (trayAdd(v.tag, v.name || v.tag)) toast(`‘${v.name || v.tag}’ 담았어요`); closePop(); }, 'sm'))));
    document.body.append(pop);
    T.pop = pop;
    if (!pop.classList.contains('sheetlike')) {
      const r = pop.getBoundingClientRect();
      pop.style.left = Math.max(8, Math.min(pt.clientX, innerWidth - r.width - 8)) + 'px';
      pop.style.top = Math.max(8, Math.min(pt.clientY, innerHeight - r.height - 8)) + 'px';
    }
    requestAnimationFrame(() => pop.classList.add('open'));
    setTimeout(() => {
      document.addEventListener('pointerdown', outside, true);
      document.addEventListener('keydown', popKey, true);
      window.addEventListener('scroll', closePop, true);
    }, 0);
  }

  // ---------- 세트 팝업 ----------
  function openSet(it) {
    const layer = makeLayer('narrow');
    let sel = [];
    const render = () => {
      const opts = (it.options || []).filter(o => o.tag || o.name);
      const chosen = sel.map(id => opts.find(o => o.id === id)).filter(Boolean);
      const out = chosen.map(o => o.tag).filter(Boolean).join(', ');
      const put = btn('plus', '트레이에 담기', () => {
        let n = 0;
        chosen.forEach(o => { if (trayAdd(o.tag, o.name || o.tag)) n++; });
        closeTop();
        toast(n ? `${n}개를 트레이에 담았어요` : '이미 트레이에 있어요');
      }, 'btn-ghost');
      const cp = btn('copy', '복사', () => { copy(out, `${chosen.length}개를 합쳐서 복사했어요`); closeTop(); }, 'btn-primary');
      if (!chosen.length) { put.disabled = true; cp.disabled = true; }
      layer.body.replaceChildren(h('div', { class: 'detail set-detail' },
        h('div', { class: 'eyebrow' }, 'Set'),
        h('h2', { class: 'detail-title' }, label(it)),
        h('p', { class: 'lead' }, '원하는 선택지를 눌러 고르세요. 고른 순서대로 이어 붙여요.'),
        opts.length
          ? h('div', { class: 'opt-list' }, opts.map(o => {
            const k = sel.indexOf(o.id);
            return h('button', {
              class: 'opt' + (k >= 0 ? ' on' : ''), type: 'button', 'aria-pressed': k >= 0,
              onclick: () => { if (k >= 0) sel.splice(k, 1); else sel.push(o.id); render(); },
            }, h('span', { class: 'opt-check' }, k >= 0 ? String(k + 1) : ''), h('span', { class: 'opt-name' }, o.name || o.tag));
          }))
          : h('div', { class: 'notice' }, '선택지가 없어요. 편집 모드에서 이 세트의 ▸를 눌러 선택지를 추가하세요.'),
        h('div', { class: 'set-foot' },
          h('button', { class: 'btn-text', type: 'button', onclick: () => { sel = []; render(); } }, chosen.length ? `선택 해제 (${chosen.length})` : ' '),
          h('div', { class: 'set-foot-actions' }, put, cp))));
    };
    layer._refresh = render;
    render();
    openLayer(layer);
  }

  // ---------- 실사용 모드 ----------
  function cardEl(it) {
    const isSet = it.type === 'set';
    const vn = (it.variants || []).filter(v => v.tag || v.name).length;
    const on = (it.options || []).filter(o => o.tag || o.name).length;
    const name = label(it);
    const el = h('div', { class: 'tcard' + (isSet ? ' is-set' : ''), role: 'button', tabindex: 0, 'aria-label': name },
      h('div', { class: 'tcard-media' },
        it.thumb
          ? h('img', { src: urlOf(it, 'thumb'), alt: '', draggable: 'false', loading: 'lazy' })
          : h('span', { class: 'tcard-ph' }, name.trim().slice(0, 1))),
      h('div', { class: 'tcard-cap' },
        h('span', { class: 'tcard-name' }, name),
        isSet ? h('span', { class: 'tcard-badge set' }, h('span', { class: 'i', html: icon('chevron') }), on)
          : vn ? h('span', { class: 'tcard-badge', title: isTouch ? '길게 누르면 변형 태그' : '우클릭하면 변형 태그' }, `+${vn}`) : null),
      !isSet ? h('button', {
        class: 'tcard-add', type: 'button', title: '트레이에 담기', 'aria-label': `${name} 트레이에 담기`, html: icon('plus'),
        onpointerdown: e => e.stopPropagation(),
        onclick: e => { e.stopPropagation(); trayAdd(it.tag, name); },
      }) : null);
    attachPress(el, {
      tap: () => {
        if (isSet) openSet(it);
        else if (it.tag) copy(it.tag, `‘${name}’ 복사했어요`);
        else toast('태그가 비어 있어요. 편집 모드에서 태그를 입력하세요.');
      },
      secondary: !isSet && vn ? pt => openVariants(it, pt) : null,
    });
    return el;
  }

  function renderUse(root) {
    const q = S.q.trim().toLowerCase();
    if (!S.tagItems.length) {
      root.append(h('div', { class: 'empty' },
        h('div', { class: 'empty-mark' }, 'Tags'),
        h('h2', {}, '자주 쓰는 태그를 정리해 보세요'),
        h('p', {}, '편집 모드에서 구역(예: 구도, 표정)을 만들고 카드와 세트를 추가하세요. 카드를 누르면 바로 복사돼요.'),
        btn('edit', '편집 모드로', () => { setMode('edit'); ctx.renderAll(); }, 'btn-primary')));
      return;
    }
    const hasSecs = S.tagSections.length > 0;
    let shown = 0;
    for (const g of groups()) {
      const items = g.items.filter(it => match(it, q));
      if (q && !items.length) continue;
      if (!g.sec && !items.length) continue;
      shown += items.length;
      root.append(h('section', { class: 'tblock' },
        hasSecs ? h('div', { class: 'tblock-head' },
          h('h2', {}, g.sec ? g.sec.name : '미분류'),
          h('span', { class: 'n' }, items.length || '')) : null,
        items.length
          ? h('div', { class: 'tgrid' }, items.map(cardEl))
          : h('p', { class: 'tblock-empty' }, '비어 있는 구역이에요')));
    }
    if (q && !shown) root.append(h('div', { class: 'empty' }, h('h2', {}, '찾는 태그가 없어요'), h('p', {}, '다른 검색어를 입력해 보세요.')));
  }

  // ---------- 편집 모드 ----------
  function field(value, placeholder, onSave, cls = '') {
    const el = h('input', { class: 'input tin ' + cls, value: value || '', placeholder, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    let saved = el.value, t;
    const flush = () => { clearTimeout(t); const v = el.value.trim(); if (v !== saved) { saved = v; onSave(v); } };
    el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(flush, 450); });
    el.addEventListener('blur', flush);
    el.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) el.blur(); });
    return el;
  }

  async function setImage(it, f) {
    if (!f) return;
    try {
      const im = await makeImages(f);
      dropUrls(it.id);
      await saveItem(it, { thumb: im.thumb, w: im.w, h: im.h });
      persistStorage();
      rerender();
    } catch (e) {
      console.error(e);
      toast('이미지를 읽지 못했어요');
    }
  }

  function imageSlot(it) {
    const slot = h('button', {
      class: 'trow-img' + (it.thumb ? ' has' : ''), type: 'button',
      title: it.thumb ? '이미지 바꾸기' : '이미지 넣기 (끌어다 놓아도 돼요)',
      onclick: () => pickFiles(fs => setImage(it, fs[0]), 'image/*', false),
    }, it.thumb ? h('img', { src: urlOf(it, 'thumb'), alt: '', draggable: 'false' }) : h('span', { class: 'i', html: icon('image') }));
    slot.addEventListener('dragover', e => { e.preventDefault(); e.stopPropagation(); slot.classList.add('over'); });
    slot.addEventListener('dragleave', () => slot.classList.remove('over'));
    slot.addEventListener('drop', e => {
      e.preventDefault();
      e.stopPropagation();
      slot.classList.remove('over');
      document.getElementById('dropzone').hidden = true;
      setImage(it, [...e.dataTransfer.files].find(isImage));
    });
    return h('div', { class: 'trow-imgwrap' }, slot,
      it.thumb ? h('button', {
        class: 'trow-img-x', type: 'button', 'aria-label': '이미지 지우기', html: icon('x'),
        onclick: async () => { dropUrls(it.id); await saveItem(it, { thumb: null, w: 0, h: 0 }); rerender(); },
      }) : null);
  }

  function accBody(it, list, isSet) {
    return h('div', { class: 'trow-acc-body' },
      h('div', { class: 'acc-title' },
        h('span', {}, isSet ? '선택지' : '변형 태그'),
        h('span', { class: 'acc-sub' }, isSet
          ? '실사용 모드에서 세트를 누르면 이 목록에서 골라 조합해요'
          : (isTouch ? '실사용 모드에서 카드를 길게 누르면 이 목록이 열려요' : '실사용 모드에서 카드를 우클릭하면 이 목록이 열려요'))),
      list.map(v => h('div', { class: 'vrow' },
        field(v.name, isSet ? '선택지 이름' : '변형 이름', val => { v.name = val; saveItem(it); }),
        field(v.tag, '태그', val => { v.tag = val; saveItem(it); }, 'mono'),
        ib('x', '삭제', async () => { list.splice(list.indexOf(v), 1); await saveItem(it); rerender(); }, 'sm'))),
      h('button', {
        class: 'acc-add', type: 'button',
        onclick: async () => {
          const v = { id: uid(), name: '', tag: '' };
          list.push(v);
          await saveItem(it);
          rerender();
          document.querySelector(`.trow[data-id="${it.id}"] .vrow:last-of-type input`)?.focus();
        },
      }, h('span', { class: 'i', html: icon('plus') }), isSet ? '선택지 추가' : '변형 추가'));
  }

  function rowEl(it) {
    const isSet = it.type === 'set';
    const open = T.open.has(it.id);
    const list = isSet ? (it.options ||= []) : (it.variants ||= []);
    const filled = list.filter(v => v.tag || v.name).length;
    const sel = h('select', { class: 'trow-sec', 'aria-label': '구역' },
      h('option', { value: '' }, '미분류'),
      sections().map(s => h('option', { value: s.id }, s.name)));
    sel.value = secId(it) || '';
    sel.addEventListener('change', async () => {
      const sid = sel.value || null;
      await saveItem(it, { sectionId: sid, order: nextOrder(sid) });
      rerender();
    });
    const row = h('div', { class: 'trow' + (open ? ' open' : '') + (isSet ? ' is-set' : ''), 'data-id': it.id },
      h('div', { class: 'trow-main' },
        h('span', { class: 'trow-handle', title: '끌어서 순서 바꾸기', html: icon('grip'), onpointerdown: e => rowDragStart(e, row) }),
        h('button', {
          class: 'trow-acc', type: 'button', 'aria-expanded': open,
          title: isSet ? '선택지 펼치기' : '변형 태그 펼치기',
          onclick: () => { if (open) T.open.delete(it.id); else T.open.add(it.id); rerender(); },
        }, h('span', { class: 'i', html: icon('chevron') }), filled ? h('span', { class: 'trow-acc-n' }, filled) : null),
        imageSlot(it),
        field(it.name, isSet ? '세트 이름' : '이름', v => saveItem(it, { name: v }), 'tname'),
        isSet
          ? h('div', { class: 'trow-setinfo' }, h('span', { class: 'tcard-badge set' }, '세트'), `선택지 ${filled}개`)
          : field(it.tag, '태그 (예: smile)', v => saveItem(it, { tag: v }), 'mono ttag'),
        sel,
        ib('trash', '삭제', () => deleteItem(it), 'sm trow-del')),
      open ? accBody(it, list, isSet) : null);
    return row;
  }

  function rowDragStart(e, row) {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    const list = row.parentElement;
    row.classList.add('dragging');
    let frame = 0, px = 0, py = 0;
    const step = () => {
      frame = 0;
      const over = document.elementFromPoint(px, py)?.closest('.trow');
      // 미끄러지는 중인 줄은 원래 자리에 그려져 있으니 건너뛴다
      if (!over || over === row || over.parentElement !== list || over.getAnimations().length) return;
      const r = over.getBoundingClientRect();
      const before = py < r.top + r.height / 2;
      if (before ? over.previousElementSibling === row : over.nextElementSibling === row) return;
      // 줄을 옮기고, 자리가 바뀐 줄들이 부드럽게 미끄러지게 (FLIP)
      const rows = [...list.querySelectorAll(':scope > .trow')];
      const was = new Map(rows.map(x => [x, x.getBoundingClientRect().top]));
      rows.forEach(x => x.getAnimations().forEach(a => a.cancel()));
      if (before) over.before(row); else over.after(row);
      for (const x of rows) {
        if (x === row) continue;
        const dy = was.get(x) - x.getBoundingClientRect().top;
        if (Math.abs(dy) > 0.5) x.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 220, easing: 'cubic-bezier(.22,.8,.24,1)' });
      }
    };
    const move = ev => {
      ev.preventDefault();
      px = ev.clientX;
      py = ev.clientY;
      if (!frame) frame = requestAnimationFrame(step);
    };
    const up = async () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      row.classList.remove('dragging');
      const t = now(), changed = [];
      [...list.querySelectorAll(':scope > .trow')].forEach((r, i) => {
        const it = S.tagItems.find(x => x.id === r.dataset.id);
        if (it && it.order !== i + 1) { it.order = i + 1; it.updatedAt = t; changed.push(it); }
      });
      if (changed.length) { await db.putMany('tagItems', changed); markDirty(); }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  async function addItem(type, sid) {
    const it = {
      id: uid(), type, sectionId: sid, name: '', tag: '', variants: [],
      options: type === 'set' ? [{ id: uid(), name: '', tag: '' }, { id: uid(), name: '', tag: '' }] : [],
      thumb: null, w: 0, h: 0, order: nextOrder(sid), createdAt: now(), updatedAt: now(),
    };
    await db.put('tagItems', it);
    S.tagItems.push(it);
    if (type === 'set') T.open.add(it.id);
    markDirty();
    ctx.renderAll();
    const row = document.querySelector(`.trow[data-id="${it.id}"]`);
    row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row?.querySelector('.tname')?.focus({ preventScroll: true });
  }

  async function deleteItem(it) {
    const named = it.name || it.tag;
    if (named && !await confirmDialog(`‘${label(it)}’을(를) 삭제할까요?`, '삭제하면 되돌릴 수 없어요.')) return;
    await db.del('tagItems', it.id);
    await tomb('tagItems', [it.id]);
    dropUrls(it.id);
    S.tagItems = S.tagItems.filter(x => x !== it);
    T.open.delete(it.id);
    markDirty();
    ctx.renderAll();
  }

  async function addSection() {
    const name = await promptDialog({
      title: '새 구역',
      text: '구역은 카드를 묶는 제목이에요. 예: 구도, 표정, 조명',
      placeholder: '예: 표정',
      ok: '만들기',
    });
    if (!name) return;
    const sec = { id: uid(), name, order: Math.max(0, ...S.tagSections.map(s => s.order || 0)) + 1, createdAt: now(), updatedAt: now() };
    await db.put('tagSections', sec);
    S.tagSections.push(sec);
    markDirty();
    rerender();
  }

  async function renameSection(sec) {
    const name = await promptDialog({ title: '구역 이름 바꾸기', value: sec.name, ok: '바꾸기' });
    if (!name || name === sec.name) return;
    await saveSection(sec, { name });
    ctx.renderAll();
  }

  async function moveSection(sec, dir) {
    const list = sections();
    const i = list.indexOf(sec), j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const t = now(), changed = [];
    list.forEach((s, k) => { if (s.order !== k + 1) { s.order = k + 1; s.updatedAt = t; changed.push(s); } });
    await db.putMany('tagSections', changed);
    markDirty();
    rerender();
  }

  async function deleteSection(sec) {
    const items = itemsIn(sec.id);
    if (!await confirmDialog(`‘${sec.name}’ 구역을 삭제할까요?`, items.length ? `구역만 지워지고 안의 항목(${items.length}개)은 미분류로 옮겨져요.` : '빈 구역이에요.', '구역 삭제')) return;
    const t = now();
    items.forEach(it => { it.sectionId = null; it.updatedAt = t; });
    await db.putMany('tagItems', items);
    await db.del('tagSections', sec.id);
    await tomb('tagSections', [sec.id]);
    S.tagSections = S.tagSections.filter(s => s !== sec);
    markDirty();
    ctx.renderAll();
  }

  function renderEdit(root) {
    const list = sections();
    for (const g of groups()) {
      const sec = g.sec;
      const idx = sec ? list.indexOf(sec) : -1;
      root.append(h('section', { class: 'tblock edit' },
        h('div', { class: 'tblock-head' },
          h('h2', {}, sec ? sec.name : '미분류'),
          h('span', { class: 'n' }, g.items.length || ''),
          sec ? h('div', { class: 'tblock-tools' },
            ib('up', '위로', () => moveSection(sec, -1), 'sm' + (idx === 0 ? ' off' : '')),
            ib('down', '아래로', () => moveSection(sec, +1), 'sm' + (idx === list.length - 1 ? ' off' : '')),
            ib('edit', '구역 이름 바꾸기', () => renameSection(sec), 'sm'),
            ib('trash', '구역 삭제', () => deleteSection(sec), 'sm')) : null),
        h('div', { class: 'trows' }, g.items.map(rowEl)),
        h('div', { class: 'tblock-foot' },
          btn('plus', '카드', () => addItem('card', sec?.id || null), 'btn-ghost sm'),
          btn('plus', '세트', () => addItem('set', sec?.id || null), 'btn-ghost sm'))));
    }
    root.append(h('button', { class: 'add-section', type: 'button', onclick: addSection },
      h('span', { class: 'i', html: icon('folderPlus') }), '구역 추가'));
  }

  // ---------- 공개 ----------
  function render() {
    const root = $('#tagView');
    // 입력 중인 칸이 있으면 먼저 저장되도록 (blur 시 저장)
    if (root.contains(document.activeElement)) document.activeElement.blur();
    root.hidden = false;
    root.classList.toggle('editing', T.mode === 'edit');
    root.replaceChildren();
    if (T.mode === 'edit') renderEdit(root); else renderUse(root);
    renderTray();
  }
  const rerender = () => render();

  function hide() {
    closePop();
    $('#tagView').hidden = true;
    renderTray();
  }

  function renderFilters() {
    const seg = h('div', { class: 'seg mode-seg', role: 'tablist' },
      [['use', '실사용', 'book'], ['edit', '편집', 'edit']].map(([v, l, ic]) => h('button', {
        type: 'button', role: 'tab', class: T.mode === v ? 'active' : '', 'aria-selected': T.mode === v,
        title: `${l} 모드`, 'aria-label': `${l} 모드`, html: icon(ic),
        onclick: () => { if (T.mode === v) return; setMode(v); closePop(); ctx.renderAll(); },
      })));
    $('#filters').replaceChildren(...[
      h('div', { class: 'chips' }, seg),
      T.mode === 'edit' ? btn('folderPlus', '구역 추가', addSection, 'btn-ghost sm') : null,
    ].filter(Boolean));
  }

  function addFromHeader() {
    if (T.mode !== 'edit') setMode('edit');
    const first = sections()[0];
    addItem('card', first ? first.id : null);
  }

  return { render, hide, renderFilters, addFromHeader, closePop, get mode() { return T.mode; } };
}
