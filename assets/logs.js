'use strict';
// ログ画面：記録の一覧・検索・閲覧．データ由来の文字列は必ず textContent / テキストノードで入れる．
(() => {
  const $ = (id) => document.getElementById(id);
  const S = { items: [], sel: '', data: null, q: '', results: null, mode: 'both', line: null };
  try { S.mode = localStorage.getItem('dtys.logs.mode') || 'both'; } catch (e) { /* 記憶できなくてもよい */ }
  if (!['both', 'ja', 'en'].includes(S.mode)) S.mode = 'both';
  let searchTimer = 0, searchSeq = 0, loadSeq = 0;

  // ------------------------------------------------------------ 部品
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }
  // 一致部分を <mark> にして DOM で組み立てる（大文字小文字は区別しない）
  function marked(text, q) {
    text = String(text == null ? '' : text);
    const f = document.createDocumentFragment();
    if (!q) { f.append(text); return f; }
    const low = text.toLowerCase(), ql = q.toLowerCase();
    let p = 0, i;
    while ((i = low.indexOf(ql, p)) >= 0 && ql) {
      if (i > p) f.append(text.slice(p, i));
      f.append(h('mark', { text: text.slice(i, i + ql.length) }));
      p = i + ql.length;
    }
    if (p < text.length) f.append(text.slice(p));
    return f;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const mmss = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return pad(Math.floor(s / 60)) + ':' + pad(s % 60); };
  const EN = I18N.lang !== 'ja';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const when = (ms) => {
    const d = new Date(ms), hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return EN ? `${MON[d.getMonth()]} ${d.getDate()}, ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };
  const whenFull = (ms) => { const d = new Date(ms); return EN ? `${MON[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getFullYear()}/${when(ms)}`; };
  const mins = (ms) => { const m = Math.round((ms || 0) / 60000); return (m < 1 ? I18N.t('1分未満') : I18N.t('{n}分', { n: m })); };
  const count = (n) => I18N.t(n === 1 ? '1件' : '{n}件', { n });
  const sep = EN ? '  ·  ' : '　';
  const titleOf = (it) => it.title || I18N.t('（題名なし）');
  const evOf = (it) => it.event || I18N.t('未分類');
  const grOf = (it) => it.group || I18N.t('（セッションなし）');
  // 要約の "mm:ss" を ms に
  const parseT = (t) => { const m = /^(?:(\d+):)?(\d+):(\d+)$/.exec(String(t || '').trim()); return m ? (((+m[1] || 0) * 60 + +m[2]) * 60 + +m[3]) * 1000 : null; };

  // ------------------------------------------------------------ ハッシュ
  function readHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    const l = p.get('line');
    return { id: p.get('id') || '', line: l != null && l !== '' && !isNaN(+l) ? +l : null };
  }
  function setHash(id, line) {
    const p = new URLSearchParams();
    if (id) p.set('id', id);
    if (line != null) p.set('line', line);
    const s = p.toString();
    location.hash = s;   // hashchange で route() が呼ばれる
  }

  // ------------------------------------------------------------ 一覧
  async function loadList() {
    S.items = await DtysStore.list();
    renderList();
  }

  function itemButton(it, extra) {
    return h('button', {
      class: 'item' + (it.id === S.sel ? ' sel' : ''), type: 'button', 'data-id': it.id,
      'aria-current': it.id === S.sel ? 'true' : null, onclick: () => setHash(it.id),
    },
      h('span', { class: 'ttl', text: titleOf(it) }),
      h('span', { class: 'sub' },
        h('span', { text: when(it.startedAt) }), h('span', { text: mins(it.duration) }),
        it.kind ? h('span', { class: 'badge', text: it.kind }) : null, extra));
  }

  function renderList() {
    const box = $('list');
    box.replaceChildren();
    if (S.results) return renderResults(box);
    if (!S.items.length) { box.append(h('div', { class: 'empty', text: I18N.t('記録はまだありません．') })); return; }
    const evs = new Map();
    for (const it of S.items) {          // /api/list は新しい順
      const e = evOf(it), g = grOf(it);
      if (!evs.has(e)) evs.set(e, new Map());
      const gm = evs.get(e);
      if (!gm.has(g)) gm.set(g, []);
      gm.get(g).push(it);
    }
    const key = (e) => { for (const it of S.items) if (evOf(it) === e) return it.startedAt; return 0; };
    const evList = [...evs.keys()].sort((a, b) => key(b) - key(a));
    for (const e of evList) {
      const gm = evs.get(e);
      const total = [...gm.values()].reduce((n, a) => n + a.length, 0);
      const ed = h('details', { class: 'ev', open: true }, h('summary', {}, h('span', { text: e }), h('span', { class: 'cnt', text: count(total) })));
      for (const [g, arr] of gm) {
        const gd = h('details', { class: 'grp', open: true }, h('summary', {}, h('span', { text: g }), h('span', { class: 'cnt', text: count(arr.length) })));
        for (const it of arr) gd.append(itemButton(it));
        ed.append(gd);
      }
      box.append(ed);
    }
  }

  function renderResults(box) {
    const r = S.results;
    if (!r.length) { box.append(h('div', { class: 'empty', text: I18N.t('「{q}」に一致する記録はありません．', { q: S.q }) })); return; }
    box.append(h('div', { class: 'empty', text: I18N.t('一致した発表：{n}件', { n: r.length }) }));
    for (const it of r) {
      const hits = it.hits || [];
      const res = h('div', { class: 'res' },
        itemButton(it, it.inSummary ? h('span', { class: 'badge hit', text: I18N.t('要約に一致') }) : null),
        h('div', { class: 'where', text: evOf(it) + ' › ' + grOf(it) }));
      for (const x of hits.slice(0, 3)) {
        res.append(h('button', { class: 'hit-line', type: 'button', onclick: () => setHash(it.id, x.i) },
          h('span', { class: 'j' }, h('span', { class: 'tm', text: mmss(x.t) }), marked(x.ja, S.q)),
          h('span', { class: 'e' }, marked(x.en, S.q))));
      }
      if (hits.length > 3) res.append(h('div', { class: 'more', text: I18N.t('ほか {n} 行', { n: hits.length - 3 }) }));
      box.append(res);
    }
  }

  function markSelected() {
    for (const b of document.querySelectorAll('#list .item')) {
      const on = b.dataset.id === S.sel;
      b.classList.toggle('sel', on);
      if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
  }

  function onSearchInput() {
    const v = $('q').value.trim();
    $('qClear').hidden = !$('q').value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(v), 300);
  }
  async function runSearch(v) {
    const seq = ++searchSeq;
    S.q = v;
    if (!v) { S.results = null; renderList(); if (S.data) renderDetail(); return; }
    const items = await DtysStore.search(v);
    if (seq !== searchSeq) return;
    S.results = items;
    renderList();
    if (S.data) renderDetail(true);
  }

  // ------------------------------------------------------------ 詳細
  async function route() {
    const { id, line } = readHash();
    S.line = line;
    if (!id) { S.sel = ''; S.data = null; markSelected(); renderDetail(); return; }
    if (id !== S.sel || !S.data || S.data.id !== id) {
      S.sel = id; markSelected();
      const seq = ++loadSeq;
      const data = await DtysStore.get(id);
      if (seq !== loadSeq) return;
      S.data = data;
      if (!S.data) { $('detail').replaceChildren(h('div', { class: 'placeholder', text: I18N.t('この記録を読み込めませんでした．') })); return; }
      renderDetail();
    }
    if (S.line != null) scrollToLine(S.line);
  }

  function itemMeta(id) { return S.items.find((x) => x.id === id) || {}; }

  function renderDetail(keepScroll) {
    const box = $('detail');
    const top = box.scrollTop;
    const d = S.data;
    if (!d) { box.replaceChildren(h('div', { class: 'placeholder', text: I18N.t('左から発表を選んでください．') })); return; }
    const sm = d.summary || {}, meta = d.meta || {};
    const last = d.lines && d.lines.length ? d.lines[d.lines.length - 1] : null;
    const dur = last ? (last.tEnd || last.t) : 0;
    const title = meta.title || sm.title || I18N.t('（題名なし）');
    const w = h('div', { class: 'wrap' });
    w.append(
      h('div', { class: 'crumb', text: (meta.event || I18N.t('未分類')) + ' › ' + (meta.group || I18N.t('（セッションなし）')) }),
      h('h1', { text: title }),
      h('div', { class: 'meta' },
        sm.kind || sm.speaker ? h('span', { text: [sm.kind, sm.speaker].filter(Boolean).join('　') }) : null,
        h('span', { text: whenFull(d.startedAt) + sep + mins(dur) + sep + I18N.t((d.lines || []).length === 1 ? '1行' : '{n}行', { n: (d.lines || []).length }) })),
      h('div', { class: 'actions' },
        h('button', { class: 'btn small', type: 'button', id: 'btnEdit', onclick: () => toggleEdit(true) }, I18N.t('分類・題名を変更')),
        h('button', { class: 'btn small', type: 'button', onclick: () => DtysStore.download(S.data, 'md') }, I18N.t('Markdown で保存')),
        h('button', { class: 'btn small', type: 'button', onclick: () => DtysStore.download(S.data, 'json') }, I18N.t('JSON で保存')),
        DtysStore.mode === 'server' ? h('button', { class: 'btn small', type: 'button', onclick: reveal }, I18N.t('Finder で表示')) : null,
        h('button', { class: 'btn small danger', type: 'button', onclick: del }, I18N.t('削除'))),
      h('div', { id: 'editSlot' }),
      h('div', { id: 'status', class: 'status', role: 'status' }));

    // 要約
    const sec = (name, ...body) => w.append(h('section', { class: 'sec' }, h('h2', { text: name }), body));
    if (sm.overall) sec(I18N.t('全体要約'), h('p', { text: sm.overall }));
    if (sm.how) sec(I18N.t('どのように説明しているか'), h('p', { text: sm.how }));
    if (sm.flow && sm.flow.length) {
      sec(I18N.t('流れ'), h('ol', { class: 'flow', style: 'list-style:none;padding:0;margin:0' }, sm.flow.map((f) => h('li', {},
        timeLink(f.t, parseT(f.t)),
        h('div', {}, h('div', { class: 'h', text: f.h || '' }), f.s ? h('div', { class: 's', text: f.s }) : null)))));
    }
    if (sm.points && sm.points.length) sec(I18N.t('要点'), h('ul', { class: 'points' }, sm.points.map((p) => h('li', { text: p }))));
    if (sm.terms && sm.terms.length) {
      sec(I18N.t('用語'), h('ul', { class: 'terms' }, sm.terms.map((t) => h('li', {},
        h('div', {}, h('span', { class: 'ja', text: t.ja || t.en || '' }), t.ja && t.en ? h('span', { class: 'en', text: t.en }) : null),
        t.note ? h('div', { class: 'note', text: t.note }) : null))));
    }
    if (sm.questions && sm.questions.length) sec(I18N.t('質問するなら'), h('ul', { class: 'qs' }, sm.questions.map((p) => h('li', { text: p }))));
    if (d.nowLog && d.nowLog.length) {
      w.append(h('section', { class: 'sec' }, h('details', { class: 'now' },
        h('summary', { text: I18N.t('その時々の話題（{n}件）', { n: d.nowLog.length }) }),
        h('ul', {}, d.nowLog.map((n) => h('li', {},
          timeLink(mmss(n.t), n.t),
          h('div', {}, n.phase ? h('span', { class: 'phase', text: n.phase }) : null, n.now || ''))))
      )));
    }

    // 書き起こし
    const tr = h('div', { id: 'tr', class: 'm-' + S.mode });
    (d.lines || []).forEach((l, i) => {
      tr.append(h('div', { class: 'line', id: 'L' + i },
        h('div', { class: 'tm', text: mmss(l.t) }),
        h('div', {}, h('div', { class: 'ja', text: '' }, marked(l.ja, S.q)), h('div', { class: 'en' }, marked(l.en, S.q)))));
    });
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': I18N.t('表示する言語') },
      [['both', '訳＋原文'], ['ja', '訳のみ'], ['en', '原文のみ']].map(([k, label]) => [k, I18N.t(label)]).map(([k, label]) =>
        h('button', { type: 'button', 'data-m': k, 'aria-pressed': String(S.mode === k), text: label, onclick: () => setMode(k) })));
    w.append(h('section', { class: 'sec' },
      h('h2', {}, h('span', { text: I18N.t('書き起こし') }), h('span', { class: 'spacer' }), seg),
      (d.lines || []).length ? tr : h('p', { class: 'empty', text: I18N.t('書き起こしはありません．') })));

    box.replaceChildren(w);
    box.scrollTop = keepScroll ? top : 0;
  }

  function timeLink(label, ms) {
    if (ms == null) return h('span', { class: 'tm', text: label || '' });
    return h('button', { class: 'link', type: 'button', text: label, title: I18N.t('書き起こしのこの時刻へ'), onclick: () => gotoTime(ms) });
  }
  function gotoTime(ms) {
    const ls = (S.data && S.data.lines) || [];
    let k = 0;
    for (let i = 0; i < ls.length; i++) { if (ls[i].t <= ms) k = i; else break; }
    if (!ls.length) return;
    scrollToLine(k, true);
  }
  function scrollToLine(i, noHash) {
    const e = $('L' + i);
    if (!e) return;
    e.scrollIntoView({ block: 'center', behavior: 'smooth' });
    e.classList.remove('flash'); void e.offsetWidth; e.classList.add('flash');
  }

  function setMode(k) {
    S.mode = k;
    try { localStorage.setItem('dtys.logs.mode', k); } catch (e) { /* 無視 */ }
    const tr = $('tr');
    if (tr) tr.className = 'm-' + k;
    for (const b of document.querySelectorAll('.seg button')) b.setAttribute('aria-pressed', String(b.dataset.m === k));
  }

  // ------------------------------------------------------------ 操作
  function status(msg, err) { const s = $('status'); if (s) { s.textContent = msg; s.classList.toggle('err', !!err); } }

  function toggleEdit(on) {
    const slot = $('editSlot');
    if (!on) { slot.replaceChildren(); return; }
    if (slot.firstChild) return;
    const meta = (S.data && S.data.meta) || {}, sm = (S.data && S.data.summary) || {};
    const evs = [...new Set(S.items.map((x) => x.event).filter(Boolean))];
    const grs = [...new Set(S.items.map((x) => x.group).filter(Boolean))];
    const f = (label, id, val, list) => h('label', {}, label, h('input', { id, type: 'text', value: val || '', list: list || null, autocomplete: 'off' }));
    slot.append(h('form', { class: 'editform', onsubmit: (e) => { e.preventDefault(); saveMeta(); } },
      f(I18N.t('学会・イベント'), 'fEvent', meta.event, 'dlEvent'),
      f(I18N.t('セッション'), 'fGroup', meta.group, 'dlGroup'),
      f(I18N.t('題名'), 'fTitle', meta.title || sm.title || ''),
      h('datalist', { id: 'dlEvent' }, evs.map((v) => h('option', { value: v }))),
      h('datalist', { id: 'dlGroup' }, grs.map((v) => h('option', { value: v }))),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', type: 'submit' }, I18N.t('保存')),
        h('button', { class: 'btn small', type: 'button', onclick: () => toggleEdit(false) }, I18N.t('キャンセル')))));
    $('fEvent').focus();
  }

  async function saveMeta() {
    const id = S.sel;
    const meta = await DtysStore.setMeta(id, { event: $('fEvent').value, group: $('fGroup').value, title: $('fTitle').value });
    if (!meta) { status(I18N.t('保存できませんでした．'), true); return; }
    S.data.meta = meta;
    await loadList();
    renderDetail(true);
    status(I18N.t('保存しました．'));
  }

  async function reveal() { const ok = await DtysStore.reveal(S.sel); status(I18N.t(ok ? 'Finder で表示しました．' : 'Finder で表示できませんでした．'), !ok); }

  async function del() {
    if (!S.data) return;
    const name = (S.data.meta && S.data.meta.title) || (S.data.summary && S.data.summary.title) || I18N.t('（題名なし）');
    const trash = I18N.t(DtysStore.mode === 'server' ? 'ゴミ箱（sessions/.trash）' : 'ブラウザ内のごみ箱');
    if (!confirm(I18N.t('「{name}」を削除しますか？\n（{trash}へ移すだけで，完全には消えません）', { name, trash }))) return;
    const j = await DtysStore.remove(S.sel);
    if (!j.ok) { status(I18N.t('削除できませんでした．'), true); return; }
    S.sel = ''; S.data = null;
    history.replaceState(null, '', location.pathname + location.search);
    await loadList();
    const box = $('detail');
    box.replaceChildren(h('div', { class: 'placeholder' }, h('p', { class: 'status', role: 'status', text: I18N.t('{trash}へ移しました．', { trash }) }), h('p', { text: I18N.t('左から発表を選んでください．') })));
    if (S.q) runSearch(S.q);
  }

  // ------------------------------------------------------------ 起動
  $('q').addEventListener('input', onSearchInput);
  $('q').addEventListener('keydown', (e) => { if (e.key === 'Escape') { $('q').value = ''; onSearchInput(); } });
  $('qClear').addEventListener('click', () => { $('q').value = ''; onSearchInput(); $('q').focus(); });
  $('btnSide').addEventListener('click', () => {
    const closed = $('app').classList.toggle('side-closed');
    $('btnSide').setAttribute('aria-expanded', String(!closed));
  });
  // 狭い画面では，発表を選んだら一覧を畳む
  $('list').addEventListener('click', (e) => {
    if (innerWidth < 800 && e.target.closest('.item, .hit-line')) {
      $('app').classList.add('side-closed'); $('btnSide').setAttribute('aria-expanded', 'false');
    }
  });
  window.addEventListener('hashchange', route);
  function backupMsg(t, err) { const m = $('backupMsg'); m.textContent = t; m.classList.toggle('err', !!err); }
  $('btnExport').addEventListener('click', async () => {
    try { backupMsg(I18N.t('{n}件を書き出しました．', { n: await DtysStore.exportAll() })); } catch (e) { backupMsg(I18N.t('書き出せませんでした．'), true); }
  });
  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', async () => {
    const f = $('fileImport').files[0];
    $('fileImport').value = '';
    if (!f) return;
    const r = await DtysStore.importAll(f);
    if (!r.ok) { backupMsg(I18N.t('読み込めませんでした（書き出した JSON を選んでください）．'), true); return; }
    backupMsg(I18N.t('追加 {a}件，更新 {u}件，そのまま {s}件．', { a: r.added, u: r.updated, s: r.skipped }));
    await loadList();
    if (S.q) runSearch(S.q);
  });
  I18N.apply(document.body);
  (async () => {
    let helper = false;
    try { helper = !!JSON.parse(localStorage.getItem('dtys.settings') || '{}').helper; } catch (e) { /* 設定なし */ }
    await DtysStore.connect({ tryHelper: helper });
    const server = DtysStore.mode === 'server';
    $('where').textContent = I18N.t(server ? '保存場所：この Mac のフォルダ（補助プログラム）' : '保存場所：このブラウザ内');
    $('backup').hidden = server;
    await loadList();
    await route();
  })();
})();
