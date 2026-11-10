'use strict';
// 記録の保存：補助プログラム（server.py）があればサーバ，無ければブラウザ内（IndexedDB）に保存する．
// どちらでも同じ呼び方で使える．戻り値の形は server.py の API にそろえてある．
(() => {
  const DB_NAME = 'tsuyakuYouyakuChan';
  const HELPER = 'http://127.0.0.1:8765';
  const S = { mode: 'browser', api: null };
  const JSON_HEAD = { 'Content-Type': 'application/json' };

  // ------------------------------------------------------------ 接続の判定
  async function health(base, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(base + 'api/health', { signal: ctl.signal, cache: 'no-store' });
      const j = await r.json();
      return !!(j && j.ok === true);
    } catch (e) {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  async function connect(opt) {
    const tryHelper = !!(opt && opt.tryHelper);
    let mode = 'browser', api = null;
    if (await health('', 2500)) { mode = 'server'; api = location.origin; }
    else if (tryHelper && await health(HELPER + '/', 2500)) { mode = 'server'; api = HELPER; }
    S.mode = mode; S.api = api;
    store.mode = mode; store.api = api;
    return { mode, api };
  }

  // ------------------------------------------------------------ 共通の部品
  const sidOk = (id) => /^[0-9A-Za-z_-]{1,40}$/.test(String(id || ''));
  const talkTitle = (d) => ((d && d.meta && d.meta.title) || (d && d.summary && d.summary.title) || '');
  const safeName = (s) => String(s || '').replace(/[\\/:*?"<>|]/g, '_');

  async function call(path, body) {
    try {
      const r = await fetch(S.api + path, body === undefined ? undefined
        : { method: 'POST', headers: JSON_HEAD, body: JSON.stringify(body) });
      return await r.json();
    } catch (e) {
      return { ok: false };
    }
  }

  // ------------------------------------------------------------ IndexedDB
  let dbp = null;
  function openDb() {
    if (!dbp) {
      dbp = new Promise((resolve, reject) => {
        const rq = indexedDB.open(DB_NAME, 1);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('trash')) db.createObjectStore('trash', { keyPath: 'id' });
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => { dbp = null; reject(rq.error); };
      });
    }
    return dbp;
  }
  const req = (rq) => new Promise((resolve, reject) => { rq.onsuccess = () => resolve(rq.result); rq.onerror = () => reject(rq.error); });
  const txDone = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
  async function idbAll() { const db = await openDb(); return req(db.transaction('sessions').objectStore('sessions').getAll()); }
  async function idbGet(id) { const db = await openDb(); return req(db.transaction('sessions').objectStore('sessions').get(id)); }

  // 保存済みの meta.editedAt が新しければそちらの meta を残す（server.py の write_session と同じ）
  function mergeMeta(data, old) {
    let meta = Object.assign({}, data.meta || {});
    const om = old && old.meta;
    if (om && (om.editedAt || 0) > (meta.editedAt || 0)) meta = om;
    data.meta = meta;
    return meta;
  }
  // 1 つのトランザクションで読んで書く（待たずに投げてもページを閉じる間に完了しやすい）
  function idbPut(db, data) {
    const tx = db.transaction('sessions', 'readwrite');
    const st = tx.objectStore('sessions');
    const g = st.get(data.id);
    g.onsuccess = () => { mergeMeta(data, g.result); st.put(data); };
    return tx;
  }

  // ------------------------------------------------------------ 一覧・検索の項目
  function toItem(d) {
    const s = d.summary || {}, meta = d.meta || {}, lines = d.lines || [];
    const last = lines.length ? lines[lines.length - 1] : null;
    return {
      id: d.id, title: talkTitle(d), kind: s.kind || '', speaker: s.speaker || '',
      event: meta.event || '', group: meta.group || '',
      startedAt: d.startedAt, updatedAt: d.updatedAt,
      duration: last ? (last.tEnd || last.t || 0) : 0,
      lines: lines.length, overall: s.overall || '',
    };
  }
  const byNew = (a, b) => (b.startedAt || 0) - (a.startedAt || 0);

  // ------------------------------------------------------------ 記録の操作
  async function save(data) {
    if (S.mode === 'server') return call('/api/save', { id: data.id, data });
    if (!sidOk(data && data.id)) return { ok: false };
    try {
      const db = await openDb();
      const tx = idbPut(db, data);
      await txDone(tx);
      return { ok: true, meta: data.meta };
    } catch (e) { return { ok: false }; }
  }

  async function list() {
    if (S.mode === 'server') { const j = await call('/api/list'); return j.ok ? j.items : []; }
    try { return (await idbAll()).map(toItem).sort(byNew); } catch (e) { return []; }
  }

  async function get(id) {
    if (S.mode === 'server') {
      const j = await call('/api/session?id=' + encodeURIComponent(id));
      return j.ok ? j.data : null;
    }
    try { return (await idbGet(id)) || null; } catch (e) { return null; }
  }

  async function search(q, per = 8, total = 300) {
    if (S.mode === 'server') { const j = await call('/api/search?q=' + encodeURIComponent(q)); return j.ok ? j.items : []; }
    const k = String(q || '').trim().toLowerCase();
    if (!k) return [];
    const res = [];
    let n = 0;
    let all;
    try { all = (await idbAll()).sort(byNew); } catch (e) { return []; }
    for (const d of all) {
      const item = toItem(d);
      const hits = [];
      (d.lines || []).some((l, i) => {
        if (String(l.en || '').toLowerCase().includes(k) || String(l.ja || '').toLowerCase().includes(k)) {
          hits.push({ i, t: l.t, en: l.en || '', ja: l.ja || '' });
        }
        return hits.length >= per;
      });
      const inSummary = JSON.stringify(d.summary || {}).toLowerCase().includes(k) || item.title.toLowerCase().includes(k);
      if (hits.length || inSummary) {
        res.push(Object.assign(item, { hits, inSummary }));
        n += hits.length;
        if (n >= total) break;
      }
    }
    return res;
  }

  async function setMeta(id, m) {
    if (S.mode === 'server') {
      const j = await call('/api/meta', Object.assign({ id }, m));
      return j.ok ? j.meta : null;
    }
    try {
      const d = await idbGet(id);
      if (!d) return null;
      const meta = Object.assign({}, d.meta || {});
      for (const k of ['event', 'group', 'title']) if (m && k in m) meta[k] = String(m[k] || '').trim();
      meta.editedAt = Date.now();
      d.meta = meta;
      const db = await openDb();
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(d);
      await txDone(tx);
      return meta;
    } catch (e) { return null; }
  }

  async function remove(id) {
    if (S.mode === 'server') { const j = await call('/api/delete', { id }); return { ok: !!j.ok }; }
    try {
      const d = await idbGet(id);
      if (!d) return { ok: false };
      const db = await openDb();
      const tx = db.transaction(['sessions', 'trash'], 'readwrite');
      tx.objectStore('trash').put({ id, deletedAt: Date.now(), data: d });
      tx.objectStore('sessions').delete(id);
      await txDone(tx);
      return { ok: true };
    } catch (e) { return { ok: false }; }
  }

  async function reveal(id) {
    if (S.mode !== 'server') return false;
    const j = await call('/api/reveal', { id });
    return !!j.ok;
  }

  function saveOnUnload(data) {
    if (S.mode === 'server') {
      try {
        fetch(S.api + '/api/save', { method: 'POST', keepalive: true, headers: JSON_HEAD, body: JSON.stringify({ id: data.id, data }) });
      } catch (e) { /* 閉じるときなので無視 */ }
      return;
    }
    if (!sidOk(data && data.id)) return;
    openDb().then((db) => idbPut(db, data)).catch(() => {});
  }

  // ------------------------------------------------------------ Markdown・ファイル保存
  const pad = (n) => String(n).padStart(2, '0');
  function fmtMs(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return h ? `${h}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  }

  // server.py の to_markdown の移植
  function toMarkdown(data) {
    const s = data.summary || {}, meta = data.meta || {};
    const v = (x) => (x == null ? '' : x);
    let L = [`# ${talkTitle(data) || '英語講演・会議の記録'}`, '', `- 記録ID：${v(data.id)}`];
    if (data.startedAt) {
      const d = new Date(data.startedAt);
      L.push(`- 開始：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`);
    }
    if (meta.event) L.push(`- 学会・イベント：${meta.event}`);
    if (meta.group) L.push(`- セッション：${meta.group}`);
    for (const [k, lab] of [['kind', '形式'], ['speaker', '話者']]) if (s[k]) L.push(`- ${lab}：${s[k]}`);
    const lines = data.lines || [];
    if (lines.length) { const l = lines[lines.length - 1]; L.push('- 長さ：' + fmtMs(l.tEnd || l.t)); }
    if (s.overall) L.push('', '## 全体要約', '', s.overall);
    if (s.how) L.push('', '## どのように説明しているか', '', s.how);
    if (s.flow && s.flow.length) L.push('', '## 流れ', '', ...s.flow.map((f) => `- [${v(f.t)}] **${v(f.h)}**：${v(f.s)}`));
    if (data.nowLog && data.nowLog.length) {
      L.push('', '## その時々の話題', '', ...data.nowLog.map((n) => `- [${fmtMs(n.t)}] ${n.phase ? '（' + n.phase + '）' : ''}${v(n.now)}`));
    }
    if (s.points && s.points.length) L.push('', '## 要点', '', ...s.points.map((p) => `- ${p}`));
    if (s.terms && s.terms.length) {
      L.push('', '## 用語', '', '| 英語 | 訳語 | 説明 |', '|---|---|---|', ...s.terms.map((t) => `| ${v(t.en)} | ${v(t.ja)} | ${v(t.note)} |`));
    }
    if (s.questions && s.questions.length) L.push('', '## 質問するなら', '', ...s.questions.map((q) => `- ${q}`));
    L.push('', '## 書き起こし（日本語訳と英語原文）', '');
    for (const l of lines) L.push(`**[${fmtMs(l.t)}]** ${v(l.ja)}`, `> ${v(l.en)}`, '');
    return L.join('\n');
  }

  function saveBlob(text, type, name) {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function download(data, kind) {
    const t = safeName(talkTitle(data));
    const base = t ? `${data.id}_${t}` : String(data.id);
    if (kind === 'json') saveBlob(JSON.stringify(data, null, 1), 'application/json', base + '.json');
    else saveBlob(toMarkdown(data), 'text/markdown;charset=utf-8', base + '.md');
  }

  // ------------------------------------------------------------ 書き出し・読み込み（ブラウザ内の記録）
  async function exportAll() {
    const sessions = (await idbAll()).sort(byNew);
    const d = new Date();
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const body = { app: DB_NAME, version: 1, exportedAt: d.getTime(), sessions };
    saveBlob(JSON.stringify(body), 'application/json', `tsuyakuYouyakuChan_${stamp}.json`);
    return sessions.length;
  }

  // 戻り値：{ ok, added, updated, skipped }．同じ id は updatedAt が新しい方を残す
  async function importAll(file) {
    let j;
    try { j = JSON.parse(await file.text()); } catch (e) { return { ok: false, added: 0, updated: 0, skipped: 0 }; }
    const arr = Array.isArray(j) ? j : (j && Array.isArray(j.sessions) ? j.sessions : null);
    if (!arr) return { ok: false, added: 0, updated: 0, skipped: 0 };
    const db = await openDb();
    let added = 0, updated = 0, skipped = 0;
    for (const d of arr) {
      if (!d || typeof d !== 'object' || !sidOk(d.id)) { skipped++; continue; }
      const old = await idbGet(d.id);
      if (old && (old.updatedAt || 0) >= (d.updatedAt || 0)) { skipped++; continue; }
      const tx = db.transaction('sessions', 'readwrite');
      tx.objectStore('sessions').put(d);
      await txDone(tx);
      if (old) updated++; else added++;
    }
    return { ok: true, added, updated, skipped };
  }

  const store = { mode: 'browser', api: null, connect, save, list, get, search, setMeta, remove, reveal, toMarkdown, download, exportAll, importAll, saveOnUnload };
  window.DtysStore = store;
})();
