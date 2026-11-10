/*
 * 学会通訳要約ちゃん：話し言葉 → Chrome 内蔵の音声認識（JimakuRecognizer）→ Chrome 内蔵翻訳（Translator API）
 *                    → 一定間隔で要約（Claude／ローカル LLM（Ollama）＝補助プログラム経由，または Chrome 内蔵 AI（Gemini Nano））
 *
 * 記録の単位は「発表」．停止→開始では切り替えない（同じ発表の続き）．「次の発表へ」で次の記録を始める．
 * 保存先は DtysStore（補助プログラムがあればこの Mac のフォルダ，無ければブラウザ内）．
 */
(() => {
  'use strict';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const Store = window.DtysStore;
  const T = (ja, vars) => I18N.t(ja, vars);     // 画面に出る日本語は T('…')（辞書は assets/lang/app.en.js）
  const L = (ja) => ja;                         // 言語名の目印（表示のときに T() を通す．辞書の検査用）
  const LOC = I18N.lang === 'en' ? 'en-US' : 'ja-JP';
  const LS_SET = 'dtys.settings', LS_LAST = 'dtys.last';
  const RESTORE_WITHIN = 3 * 3600 * 1000;      // 前回の記録がこれより新しければ自動で続きにする
  const STALE_MS = 3 * 60 * 1000;              // 認識中にこれより長く要約が更新されなければ「いま」を灰色に

  // ---------------------------------------------------------------- 言語
  const SRC_LANGS = [
    ['en-US', L('英語（アメリカ）'), 'EN'], ['en-GB', L('英語（イギリス）'), 'EN'], ['en-IN', L('英語（インド）'), 'EN'],
    ['ja-JP', L('日本語'), 'JA'], ['cmn-Hans-CN', L('中国語（普通話）'), 'ZH'], ['cmn-Hant-TW', L('中国語（台湾）'), 'ZH'],
    ['ko-KR', L('韓国語'), 'KO'], ['fr-FR', L('フランス語'), 'FR'], ['de-DE', L('ドイツ語'), 'DE'], ['es-ES', L('スペイン語'), 'ES'],
    ['it-IT', L('イタリア語'), 'IT'], ['pt-BR', L('ポルトガル語（ブラジル）'), 'PT'], ['ru-RU', L('ロシア語'), 'RU'],
    ['hi-IN', L('ヒンディー語'), 'HI'], ['id-ID', L('インドネシア語'), 'ID'], ['vi-VN', L('ベトナム語'), 'VI'], ['th-TH', L('タイ語'), 'TH'],
    ['tr-TR', L('トルコ語'), 'TR'], ['nl-NL', L('オランダ語'), 'NL'], ['pl-PL', L('ポーランド語'), 'PL'], ['ar-SA', L('アラビア語'), 'AR'],
  ];
  const DST_LANGS = [
    ['ja', L('日本語'), 'JA'], ['en', L('英語'), 'EN'], ['zh', L('中国語（簡体字）'), 'ZH'], ['zh-Hant', L('中国語（繁体字）'), 'ZH'],
    ['ko', L('韓国語'), 'KO'], ['fr', L('フランス語'), 'FR'], ['de', L('ドイツ語'), 'DE'], ['es', L('スペイン語'), 'ES'], ['it', L('イタリア語'), 'IT'],
    ['pt', L('ポルトガル語'), 'PT'], ['ru', L('ロシア語'), 'RU'], ['hi', L('ヒンディー語'), 'HI'], ['id', L('インドネシア語'), 'ID'],
    ['vi', L('ベトナム語'), 'VI'], ['th', L('タイ語'), 'TH'], ['tr', L('トルコ語'), 'TR'], ['nl', L('オランダ語'), 'NL'], ['pl', L('ポーランド語'), 'PL'],
    ['', L('翻訳しない'), '—'],
  ];
  /** 言語名（[1]）は日本語のまま．画面には T() を通して出す */
  const srcInfo = (c) => SRC_LANGS.find((x) => x[0] === c) || [c, c, c.slice(0, 2).toUpperCase()];
  const dstInfo = (c) => DST_LANGS.find((x) => x[0] === c) || [c, c, c.slice(0, 2).toUpperCase()];
  const srcName = (c) => T(srcInfo(c)[1]), dstName = (c) => T(dstInfo(c)[1]);
  /** 音声認識の言語コード → 翻訳 API の言語コード */
  const trCode = (asr) => (asr === 'cmn-Hans-CN' ? 'zh' : asr === 'cmn-Hant-TW' ? 'zh-Hant' : asr.split('-')[0]);

  // ---------------------------------------------------------------- 設定
  const settings = Object.assign({
    input: '', recog: 'local', mode: 'continuous', engine: 'sonnet', interval: 40,
    srcLang: 'en-US', dstLang: 'ja',
    show: 'both', font: 22, sumFont: 15, pipFont: 20, pipW: 560, pipH: 320,
    lastEvent: '', lastGroup: '', helper: false,
  }, loadJSON(LS_SET));
  function loadJSON(k) { try { return JSON.parse(localStorage.getItem(k) || '{}') || {}; } catch (e) { return {}; } }
  function saveSettings() { try { localStorage.setItem(LS_SET, JSON.stringify(settings)); } catch (e) {} }
  const translating = () => !!settings.dstLang && trCode(settings.srcLang).split('-')[0] !== settings.dstLang.split('-')[0];
  const isCJK = () => /^(ja|cmn|zh|ko)/.test(settings.srcLang);
  // 短い断片は直前の行につなげて訳し直す（文の途中で確定が切れたとき，訳が細切れにならないように）
  const mergeShort = () => (isCJK() ? 16 : 40);
  const MERGE_GAP_MS = 5000, MERGE_MAX = 420;

  // ---------------------------------------------------------------- 記録（1 発表 = 1 記録）
  function newSession() {
    const d = new Date(), p = (n) => String(n).padStart(2, '0');
    return {
      id: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`,
      startedAt: Date.now(), updatedAt: Date.now(), lines: [], summary: null, nowLog: [], chars: 0,
      drops: [],    // 診断用：途中結果より確定がずっと短かった記録 { t, interim, final }
      lang: { src: settings.srcLang, dst: settings.dstLang },
      meta: { event: settings.lastEvent || '', group: settings.lastGroup || '', title: '', editedAt: 0 },
    };
  }
  let S = newSession(), restored = false;
  const last = loadJSON(LS_LAST);
  if (last && last.lines && last.lines.length && Date.now() - (last.updatedAt || 0) < RESTORE_WITHIN) {
    S = Object.assign(newSession(), last);
    S.meta = Object.assign({ event: '', group: '', title: '', editedAt: 0 }, last.meta || {});
    restored = true;
  }

  const fmt = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    const p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(ss)}` : `${p(m)}:${p(ss)}`;
  };
  const ago = (ms) => (ms < 60000 ? T('{n}秒前', { n: Math.max(1, Math.round(ms / 1000)) }) : T('{n}分前', { n: Math.round(ms / 60000) }));

  // ---------------------------------------------------------------- 要素
  const logEl = $('#log'), interimEl = $('#interim'), imJa = $('#interim .ja'), imEn = $('#interim .en');
  const jumpEl = $('#jump'), jumpCount = $('#jumpCount');
  const meterBars = $$('#meter i');
  const mini = $('#mini'), miniLines = $('.mini-lines', mini), miniInterim = $('.mini-interim-in', mini),
    miniPhase = $('.mini-phase', mini), miniNow = $('.mini-now', mini), miniStateText = $('.mini-state-text', mini),
    miniClock = $('.mini-clock', mini), miniStart = $('.mini-start', mini);

  // ---------------------------------------------------------------- お知らせ（本文を動かさない重ね表示）
  let noticeTimer = null, actionUntil = 0;
  function notice(msg, cls = 'info', ms = 0, action = null) {
    const el = $('#notice'), act = $('.notice-action', el);
    // 「取り消す」などの操作付きのお知らせが出ている間は，ただのお知らせ（info）で上書きしない
    if (msg && !action && cls === 'info' && !el.hidden && Date.now() < actionUntil) return;
    clearTimeout(noticeTimer);
    actionUntil = action ? Date.now() + (ms || 15000) : 0;
    if (!msg) { el.hidden = true; return; }
    el.className = cls;
    $('.notice-text', el).textContent = msg;
    act.hidden = !action;
    act.onclick = action ? () => { notice(''); action.fn(); } : null;
    if (action) act.textContent = action.label;
    el.hidden = false;
    if (ms) noticeTimer = setTimeout(() => { el.hidden = true; }, ms);
  }
  $('.notice-close').addEventListener('click', () => notice(''));

  // ---------------------------------------------------------------- 認識の状態（停止中／準備中／認識中／エラー）
  let recState = 'idle';
  function setRec(state, detail = '') {
    recState = state;
    document.body.dataset.rec = state;
    const text = { idle: T('停止中'), preparing: T('準備中…'), listening: T('認識中') + (detail ? '・' + detail : ''), error: T('エラーで停止') }[state];
    $('#recState .state-text').textContent = text;
    miniStateText.textContent = state === 'listening' ? T('認識中') : text;
    const b = $('#btnStart');
    b.disabled = state === 'preparing';
    const label = state === 'listening' ? T('停止') : state === 'preparing' ? T('準備中') : T('開始');
    $('.rec-label', b).textContent = label;
    b.setAttribute('aria-label', label);
    $('.mini-start-label', mini).textContent = state === 'listening' ? T('停止') : T('開始');
    miniStart.disabled = state === 'preparing';
    renderTopicState();
  }

  // ---------------------------------------------------------------- 書き起こしの表示
  const lineEls = new WeakMap(), lineSeq = new WeakMap();   // 行 → 表示要素／翻訳の世代（JSON に入れないため別管理）
  let latestEl = null, unseen = 0, pendingTr = 0, stuck = true;
  const atBottom = () => logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  /** 末尾に居たかどうかを DOM を変える前に測り，変えた後で追従する */
  function keepBottom(mutate) {
    const stick = stuck || atBottom();
    const r = mutate();
    if (stick) { logEl.scrollTop = logEl.scrollHeight; stuck = true; } else if (r === 'new') { unseen++; showJump(); }
    return r;
  }
  function showJump() { jumpCount.textContent = unseen ? T('（新着 {n}）', { n: unseen }) : ''; jumpEl.hidden = false; }
  logEl.addEventListener('scroll', () => { stuck = atBottom(); if (stuck) { unseen = 0; jumpEl.hidden = true; } });
  jumpEl.addEventListener('click', () => { logEl.scrollTop = logEl.scrollHeight; stuck = true; unseen = 0; jumpEl.hidden = true; });
  new ResizeObserver(() => {
    $('#left').style.setProperty('--interim-h', interimEl.offsetHeight + 'px');
    if (stuck) logEl.scrollTop = logEl.scrollHeight;
  }).observe(interimEl);
  new ResizeObserver(() => { if (stuck) logEl.scrollTop = logEl.scrollHeight; }).observe(logEl);

  function renderLine(line) {
    const div = document.createElement('div');
    div.className = 'line';
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = fmt(line.t);
    meta.title = T('時刻 {s}', { s: new Date(S.startedAt + line.t).toLocaleTimeString(LOC) });
    const ja = document.createElement('div'); ja.className = 'ja'; ja.textContent = line.ja || '';
    const en = document.createElement('div'); en.className = 'en'; en.textContent = line.en;
    div.append(meta, ja, en);
    logEl.appendChild(div);
    if (latestEl) latestEl.classList.remove('is-latest');
    div.classList.add('is-latest'); latestEl = div;
    lineEls.set(line, div);
    return div;
  }
  function applyView() {
    document.body.classList.toggle('show-ja', settings.show === 'ja');
    document.body.classList.toggle('show-en', settings.show === 'en');
    document.body.classList.toggle('no-tr', !translating());
    const root = document.documentElement.style;
    root.setProperty('--tr-size', settings.font + 'px');
    root.setProperty('--sum-size', settings.sumFont + 'px');
    mini.style.setProperty('--pip-size', settings.pipFont + 'px');    // 小窓は別文書なので要素に直接持たせる
    $('#outFont').textContent = settings.font; $('#outSum').textContent = settings.sumFont; $('#outPip').textContent = settings.pipFont;
    $$('input[name="show"]').forEach((r) => { r.checked = r.value === settings.show; });
    renderLang();
  }
  function renderLang() {
    const s = srcInfo(settings.srcLang), d = dstInfo(settings.dstLang);
    const pill = $('#langPill');
    $('.lp-src', pill).textContent = s[2];
    $('.lp-dst', pill).textContent = translating() ? d[2] : T('翻訳なし');
    pill.classList.toggle('no-tr', !translating());
    pill.title = T('話される言語：{s} → 翻訳先：{d}（クリックで変更）', { s: T(s[1]), d: translating() ? T(d[1]) : T('翻訳しない') });
    $('#emptyLang').textContent = translating() ? `${T(s[1])} → ${T(d[1])}` : T('{s}（翻訳なし）', { s: T(s[1]) });
  }
  function updateMini() {
    if (mini.hidden) return;
    const orig = settings.show === 'en' || !translating();
    const ls = S.lines.slice(-6);
    miniLines.replaceChildren(...ls.map((l) => { const d = document.createElement('div'); d.textContent = orig ? l.en : (l.ja || l.en); return d; }));
    miniInterim.textContent = orig ? imEn.textContent : (imJa.textContent || imEn.textContent);
    const s = S.summary || {};
    miniPhase.textContent = s.phase || '';
    miniNow.textContent = s.now || '';
  }

  // ---------------------------------------------------------------- 翻訳（Chrome 内蔵 Translator API）
  let translator = null, trPromise = null, trPair = '';
  function ensureTranslator() {
    if (!translating()) return Promise.resolve(null);
    const src = trCode(settings.srcLang), dst = settings.dstLang, pair = src + '>' + dst;
    if (pair !== trPair) { try { translator && translator.destroy(); } catch (e) {} translator = null; trPromise = null; trPair = pair; }
    if (translator) return Promise.resolve(translator);
    if (trPromise) return trPromise;
    if (!('Translator' in self)) { notice(T('この Chrome では翻訳 API（Translator）が使えないため，原文のみ表示します．'), 'warn'); return Promise.resolve(null); }
    // 取得済みでも進み具合の通知が来ることがあるので，本当に取得が要るときだけ知らせる（create はクリック直後に呼ぶ必要があるので先に呼ぶ）
    let need = false, shown = false;
    Translator.availability({ sourceLanguage: src, targetLanguage: dst }).then((a) => { need = a === 'downloadable' || a === 'downloading'; if (a === 'unavailable') notice(T('この組み合わせ（{src} → {dst}）は Chrome の翻訳に対応していません．', { src, dst }), 'warn'); }).catch(() => {});
    trPromise = Translator.create({
      sourceLanguage: src, targetLanguage: dst,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { if (need && e.loaded < 1) { shown = true; notice(T('翻訳モデル（{src} → {dst}）を取得中… {p}%', { src, dst, p: Math.round(e.loaded * 100) }), 'info'); } }); },
    }).then((t) => { if (trPair !== pair) { t.destroy(); return null; } translator = t; if (shown) notice(T('翻訳モデルの取得が終わりました．'), 'info', 4000); return t; })
      .catch((e) => { console.warn('[translator]', e); notice(T('翻訳モデルを準備できませんでした（もう一度「開始」を押すと取得を試みます）：{m}', { m: e.message }), 'warn'); trPromise = null; return null; });
    return trPromise;
  }
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  async function translate(text) {
    if (!translating()) return '';
    for (let k = 0; k < 2; k++) {
      const t = await ensureTranslator();
      if (!t) return '';
      try { return await withTimeout(t.translate(text), 10000); }
      catch (e) { console.warn('[translate]', e); try { t.destroy(); } catch (_) {} if (translator === t) { translator = null; trPromise = null; } }
    }
    return '';
  }

  // 途中結果の翻訳（最新のものだけを順に）
  let interimText = '', interimDone = '', interimBusy = false, lastInterimSeen = '';
  async function pumpInterim() {
    if (interimBusy || !translator || !translating() || !interimText || interimText === interimDone) return;
    interimBusy = true;
    const src = interimText;
    try { const ja = await withTimeout(translator.translate(src), 4000); if (interimText) { imJa.textContent = ja; updateMini(); } interimDone = src; }
    catch (e) {}
    interimBusy = false;
    setTimeout(pumpInterim, 250);
  }
  function onInterim(text) {
    interimText = text || '';
    if (interimText) lastInterimSeen = interimText;
    imEn.textContent = interimText;
    if (!interimText) imJa.textContent = '';
    interimEl.classList.toggle('active', !!interimText);
    updateMini();
    pumpInterim();
  }

  // ---------------------------------------------------------------- 確定文
  function addLine(text) {
    const sess = S;
    const now = Date.now() - sess.startedAt;
    // 診断：直前の途中結果よりずっと短い確定（＝取りこぼしの疑い）を記録しておく
    if (lastInterimSeen.length > text.length + (isCJK() ? 12 : 30)) {
      sess.drops.push({ t: now, interim: lastInterimSeen, final: text });
      console.warn('[asr] 途中結果より短い確定', { interim: lastInterimSeen, final: text });
    }
    lastInterimSeen = '';
    sess.chars += text.length; sess.updatedAt = Date.now();
    interimText = ''; interimDone = ''; imEn.textContent = ''; imJa.textContent = '';
    interimEl.classList.remove('active');

    const prev = sess.lines[sess.lines.length - 1];
    const joiner = isCJK() ? '' : ' ';
    let line;
    keepBottom(() => {
      if (prev && lineEls.has(prev) && now - (prev.tEnd || prev.t) < MERGE_GAP_MS &&
          (prev.en.length < mergeShort() || text.length < mergeShort()) && prev.en.length + text.length < MERGE_MAX) {
        line = prev;                                   // 短い断片：直前の行につなげる
        line.en = line.en + joiner + text;
        $('.en', lineEls.get(line)).textContent = line.en;
        return 'merge';
      }
      line = { t: now, en: text, ja: '' };
      sess.lines.push(line);
      renderLine(line);
      return 'new';
    });
    line.tEnd = now;
    if (!translating()) { updateMini(); scheduleBackup(); return; }
    const seq = (lineSeq.get(line) || 0) + 1;
    lineSeq.set(line, seq);
    pendingTr++;
    translate(line.en).then((ja) => {
      pendingTr--;
      if (lineSeq.get(line) !== seq) return;         // つなげた後の新しい訳が来るので古い訳は捨てる
      line.ja = ja || '';
      const el = lineEls.get(line);
      if (el && el.isConnected) keepBottom(() => { $('.ja', el).textContent = line.ja; });
      updateMini();
      if (S.lines.includes(line)) scheduleBackup();
    });
    updateMini();
  }

  // ---------------------------------------------------------------- 音声入力・認識
  const mic = new JimakuMic();
  let rec = null;
  mic.addEventListener('level', (e) => {
    const n = Math.round(Math.max(0, Math.min(1, (e.detail.smooth + 66) / 54)) * meterBars.length);
    meterBars.forEach((b, i) => b.classList.toggle('on', i < n));
  });
  mic.addEventListener('devices', (e) => fillDevices(e.detail.devices));
  mic.addEventListener('ended', (e) => {
    if (recState !== 'listening') return;
    notice(e.detail.tab ? T('タブ・画面の共有が終わったので停止しました．') : T('マイクが外れたので停止しました．'), 'warn');
    stop();
  });
  function fillDevices(devs) {
    const sel = $('#selDevice');
    [...sel.options].slice(1).forEach((o) => o.remove());
    devs.forEach((d, i) => { const o = document.createElement('option'); o.value = d.deviceId; o.textContent = d.label || T('マイク {n}', { n: i + 1 }); sel.appendChild(o); });
    sel.value = settings.input === 'tab' ? (settings.lastDevice || '') : settings.input;
    if (sel.selectedIndex < 0) sel.value = '';
    renderInputLabel();
  }
  function renderInputLabel() {
    const sel = $('#selDevice');
    $('#emptyInput').textContent = settings.input === 'tab' ? T('タブ・画面の音声') : (sel.selectedOptions[0] ? sel.selectedOptions[0].textContent : T('既定のマイク'));
  }

  /** 端末内の認識モデルを用意する（未取得なら取得．クリック直後でないと取得できない）．使えるなら true */
  async function prepareLocal() {
    const lang = settings.srcLang;
    const a = await JimakuRecognizer.localAvailability(lang);
    if (a === 'available') return true;
    if (a === 'downloadable' || a === 'downloading') {
      // 取得の完了は待たない（その間はクラウド認識で進める）
      JimakuRecognizer.installLocal(lang, true)
        .then((ok) => { if (ok) notice(T('端末内の音声認識モデルを取得しました．次に「開始」したときから端末内で認識します．'), 'info', 8000); })
        .catch((e) => console.warn('[install]', e));
      notice(T('端末内の音声認識モデルを取得中です（初回のみ）．それまではクラウド認識（Google）で認識します．'), 'warn', 12000);
      return false;
    }
    notice(T('この言語（{l}）は端末内で認識できないので，クラウド認識（Google）で始めます．', { l: srcName(lang) }), 'warn', 10000);
    return false;
  }

  async function start() {
    if (recState === 'preparing' || recState === 'listening') return;
    const isTab = settings.input === 'tab';
    setRec('preparing');
    // 利用者の操作の直後でないと取得できないもの（翻訳モデルのダウンロード・タブ共有・認識モデル）を先に呼ぶ
    ensureTranslator();
    const openP = mic.open(settings.input || null);                  // タブ共有の選択画面はここで出る
    const localP = settings.recog === 'local' ? prepareLocal() : Promise.resolve(false);
    let track = null;
    try {
      await openP;
      if (settings.input) track = mic.track;          // 既定のマイクは start()（Chrome 既定）で認識，メーターだけ使う
    } catch (e) {
      if (isTab) {
        notice(e.name === 'NoAudioError' ? T('音声が共有されていません．共有するタブを選ぶときに「タブの音声も共有する」をオンにしてください．')
          : e.name === 'NotAllowedError' ? T('タブ・画面の共有がキャンセルされました．') : T('タブの音声を取得できませんでした：{m}', { m: e.message }), 'warn');
        setRec('idle');
        return;
      }
      console.warn('[mic]', e);
    }
    const local = await localP;
    const via = (c) => T('{a}・{b}', { a: c, b: isTab ? T('タブの音声') : T('マイク') });

    // 連続：continuous=true の 1 セッション．1文ごと：1 文ごとに作り直す（字幕ちゃん既定）．
    // 1文ごとだと，Chrome が長い発話の途中で確定を出すとそこでセッションが終わり，残りは次のセッションの起動待ちの間に落ちる
    rec = new JimakuRecognizer({ lang: settings.srcLang, processLocally: local, mode: settings.mode, shortPause: 0, audioTrack: track, noStallFallback: isTab });
    rec.addEventListener('interim', (e) => onInterim(e.detail.text));
    rec.addEventListener('final', (e) => { if (e.detail.text) addLine(e.detail.text); });
    rec.addEventListener('fallback', () => { notice(T('端末内の音声認識が使えないため，クラウド認識に切り替えました．'), 'warn', 10000); setRec('listening', via(T('クラウド'))); });
    rec.addEventListener('trackunsupported', () => notice(T('選んだ入力を音声認識に渡せないため，Chrome の既定マイクで認識しています．'), 'warn'));
    rec.addEventListener('noresult', () => notice(T('音は来ていますが認識結果が出ません．設定の「音声認識」をクラウドに切り替えると直ることがあります．'), 'warn'));
    rec.addEventListener('error', (e) => { if (e.detail.fatal) { notice(e.detail.message, 'err'); stop('error'); } });

    if (!S.lines.length) { S.startedAt = Date.now(); S.lang = { src: settings.srcLang, dst: settings.dstLang }; }
    restored = false;
    await rec.start();
    setRec('listening', via(local ? T('端末内') : T('クラウド')));
  }
  function stop(state = 'idle') {
    if (rec) { rec.stop(); rec = null; }
    mic.close();
    onInterim('');
    meterBars.forEach((b) => b.classList.remove('on'));
    setRec(state);
    saveSession();
  }
  const toggleRun = () => (recState === 'listening' ? stop() : start());

  // ---------------------------------------------------------------- 要約
  let sumBusy = false, lastSumAt = 0, lastSumOkAt = 0, lastSumChars = S.chars, sumInfo = '', sumInfoNote = '';
  function setSumState(text, cls = '', title = '') {
    const el = $('#sumState'); el.textContent = text; el.className = 'sum-state ' + cls; el.title = title;
    $('#btnSumNow').disabled = cls === 'busy';
  }
  function buildTranscript(limit) {
    const out = []; let n = 0;
    for (let i = S.lines.length - 1; i >= 0; i--) {
      const s = `[${fmt(S.lines[i].t)}] ${S.lines[i].en}`;
      if (n + s.length > limit) { out.push('（…これより前は省略．「前回の状態」の flow を参照）'); break; }
      out.push(s); n += s.length + 1;
    }
    return out.reverse().join('\n');
  }
  const isOllama = () => String(settings.engine).startsWith('ollama:');
  const needsHelper = (e) => e !== 'nano';
  /** 要約の出力言語（日本語での名前）：翻訳しているなら翻訳先，しないなら表示言語 */
  const outLangName = () => (translating() ? dstInfo(settings.dstLang)[1] : I18N.lang === 'en' ? '英語' : '日本語');
  /** Gemini Nano の出力言語（en・ja・es のどれか） */
  const outLangCode = () => { const c = (translating() ? settings.dstLang : I18N.lang).split('-')[0]; return ['en', 'ja', 'es'].includes(c) ? c : 'en'; };
  async function summarizeServer() {
    if (!Store.api) throw new Error(T('補助プログラムに接続していません（設定 →「補助プログラム」）'));
    const r = await fetch(Store.api + '/api/summarize', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.engine, prev: S.summary, elapsed: fmt(Date.now() - S.startedAt), langName: srcInfo(settings.srcLang)[1], outName: outLangName(),
        transcript: buildTranscript(isOllama() ? 24000 : 60000),
        fallback: !isOllama() && preferredLocal() ? 'ollama:' + preferredLocal() : '',   // Claude がネットにつながらないときの代わり
      }),
    });
    const j = await r.json();
    if (j.busy) return null;
    if (!j.ok) throw new Error(j.error || T('要約に失敗'));
    if (j.fellBack) { sumInfoNote = T('ネットにつながらないため {m} で要約', { m: j.model }); notice(T('Claude に接続できないため，今回はローカル LLM（{m}）で要約しました．', { m: j.model }), 'warn', 10000); }
    else sumInfoNote = '';
    return j.summary;
  }

  // ---- Chrome 内蔵 AI（Gemini Nano）：Prompt API で Claude と同じ項目を作る．無ければ Summarizer API で要点だけ
  let promptSpec = null, nanoBase = null, nanoLang = '', nanoPts = null, nanoTldr = null;
  async function summarizeNano() {
    if ('LanguageModel' in self) {
      if (!promptSpec) promptSpec = await (await fetch('assets/prompt.json')).json();
      const langName = srcInfo(settings.srcLang)[1];
      const outName = outLangName(), nanoKey = langName + '|' + outName;
      if (!nanoBase || nanoLang !== nanoKey) {
        try { nanoBase && nanoBase.destroy(); } catch (e) {}
        nanoBase = await LanguageModel.create({
          initialPrompts: [{ role: 'system', content: promptSpec.system.replace('{LANG}', langName).replace(/\{OUT\}/g, outName) }],
          expectedInputs: [{ type: 'text', languages: ['en', 'ja'] }],
          expectedOutputs: [{ type: 'text', languages: [outLangCode()] }],
        });
        nanoLang = nanoKey;
      }
      const sess = await nanoBase.clone();
      try {
        const quota = sess.inputQuota ?? sess.contextWindow ?? 6000;
        const used = sess.inputUsage ?? sess.contextUsage ?? 0;
        const measure = (sess.measureInputUsage || sess.measureContextUsage || null);
        const prev = S.summary ? JSON.stringify(S.summary) : '（なし．今回が最初）';
        const build = (limit) => {
          const tr = buildTranscript(limit);
          const recent = tr.split('\n').slice(-8).join('\n');
          return `# 前回の状態\n${prev}\n\n# 経過時間\n開始から ${fmt(Date.now() - S.startedAt)}\n\n# 書き起こし（[経過時間] 原文）\n${tr}\n\n# 直近の発言（now と phase はここを基に書く）\n${recent}\n\n上の指示どおり JSON だけを出力してください．`;
        };
        let limit = 9000, msg = build(limit);
        if (measure) {
          for (let k = 0; k < 6; k++) {
            const n = await measure.call(sess, msg);
            if (n <= quota - used - 1500 || limit < 1500) break;
            limit = Math.floor(limit * 0.65); msg = build(limit);
          }
        }
        const out = await sess.prompt(msg, { responseConstraint: promptSpec.schema });
        return JSON.parse(out);
      } finally { try { sess.destroy(); } catch (e) {} }
    }
    if (!('Summarizer' in self)) throw new Error(T('この Chrome では内蔵 AI が使えません'));
    const base = { format: 'plain-text', expectedInputLanguages: [trCode(settings.srcLang).split('-')[0]], outputLanguage: outLangCode(),
      sharedContext: '講演・会議を音声認識した書き起こし（誤認識を含む）' };
    if (!nanoPts) nanoPts = await Summarizer.create(Object.assign({ type: 'key-points', length: 'long' }, base));
    if (!nanoTldr) nanoTldr = await Summarizer.create(Object.assign({ type: 'tldr', length: 'short' }, base));
    const all = S.lines.map((l) => l.en).join(' ');
    const recent = S.lines.slice(-12).map((l) => l.en).join(' ');
    const [pts, now] = await Promise.all([nanoPts.summarize(all.slice(-9000)), nanoTldr.summarize(recent.slice(-2500))]);
    return Object.assign({}, S.summary || {}, { now, points: pts.split('\n').map((s) => s.replace(/^[\s\-*•・]+/, '').trim()).filter(Boolean) });
  }
  async function summarize() {
    if (sumBusy) return;
    if (!S.lines.length) { setSumState(T('まだ書き起こしがありません')); return; }
    if (needsHelper(settings.engine) && !Store.api) { setSumState(T('補助プログラムに未接続'), 'err'); return; }
    sumBusy = true;
    const sess = S;                                          // 要約中に「次の発表へ」が押されても，元の発表に入れる
    const t0 = performance.now(), charsAt = sess.chars;
    const prevState = [$('#sumState').textContent, $('#sumState').title];
    setSumState(isOllama() && !lastSumOkAt ? T('要約を作成中…（初回はモデルの読み込みで時間がかかります）') : T('要約を作成中…'), 'busy');
    try {
      const s = settings.engine === 'nano' ? await summarizeNano() : await summarizeServer();
      if (s && !sess.discarded) {
        sess.summary = s;
        if (s.now) sess.nowLog.push({ t: Date.now() - sess.startedAt, phase: s.phase || '', now: s.now });
        if (sess === S) {
          lastSumChars = charsAt; lastSumOkAt = Date.now();
          sumInfo = T('{e}・{s} 秒', { e: sumInfoNote || engineLabel(), s: ((performance.now() - t0) / 1000).toFixed(1) });
          renderSummary(s, true);
        }
        saveSession(sess);
      } else if (sess === S) {
        setSumState(prevState[0], '', prevState[1]);      // サーバが前の要約を処理中だった：表示は変えない
      }
    } catch (e) {
      console.warn('[summary]', e);
      if (sess === S) setSumState(T('要約に失敗：{m}', { m: e.message }), 'err');
    } finally {
      sumBusy = false; lastSumAt = Date.now();
      renderSumAge();
    }
  }
  function renderSumAge() {
    const el = $('#sumState');
    if (sumBusy || el.classList.contains('err')) return;
    if (lastSumOkAt) setSumState(T('更新 {a}', { a: ago(Date.now() - lastSumOkAt) }), '', sumInfo);
  }
  setInterval(() => {
    if (recState === 'listening') { const e = fmt(Date.now() - S.startedAt); $('#clock').textContent = e; miniClock.textContent = e; }
    renderSumAge();
    renderTopicState();
    if (!settings.interval || sumBusy || recState !== 'listening') return;
    if (needsHelper(settings.engine) && !Store.api) return;
    if (S.chars - lastSumChars < (isCJK() ? 25 : 60)) return;
    if (Date.now() - lastSumAt < settings.interval * 1000) return;
    summarize();
  }, 1000);

  // ---- 要約の描画：変わった項目にだけ「更新」の印を付ける
  const SECTIONS = [
    { id: 'secHow', label: T('説明の仕方'), key: (s) => s.how },
    { id: 'secFlow', label: T('流れ'), key: (s) => s.flow },
    { id: 'secPoints', label: T('要点'), key: (s) => s.points },
    { id: 'secOverall', label: T('全体要約'), key: (s) => s.overall },
    { id: 'secTerms', label: T('用語'), key: (s) => s.terms },
    { id: 'secQuestions', label: T('質問'), key: (s) => s.questions },
  ];
  const lastShown = {};
  function li(text) { const e = document.createElement('li'); e.textContent = text; return e; }
  function arr(v) { return Array.isArray(v) ? v : []; }
  function renderTopicState() {
    const tag = $('#topicTag'), topic = $('#topic');
    const has = !!(S.summary && S.summary.now);
    const listening = recState === 'listening';
    const stale = has && (!listening || (lastSumOkAt && Date.now() - lastSumOkAt > STALE_MS));
    topic.classList.toggle('stale', !!stale);
    const t = !has ? '' : restored && !listening ? T('前回の記録') : !listening ? T('停止中') : stale ? T('要約が古い') : '';
    if (tag.textContent !== t) tag.textContent = t;
  }
  function renderSummary(s, markFresh) {
    s = s || {};
    const nowChanged = markFresh && $('#sNow').textContent !== (s.now || '');
    $('#sNow').textContent = s.now || '';
    $('#sPhase').textContent = s.phase || '';
    if (nowChanged) { const t = $('#topic'); t.classList.remove('flash'); void t.offsetWidth; t.classList.add('flash'); }
    const flow = arr(s.flow);
    $('#flowMini').replaceChildren(...flow.map((f) => li(f.h || '')));
    $('#sKind').textContent = s.kind || '';
    $('#sTitle').textContent = S.meta.title || s.title || '';
    $('#sSpeaker').textContent = s.speaker || '';
    $('#sHow').textContent = s.how || '';
    $('#sOverall').textContent = s.overall || '';
    $('#sFlow').replaceChildren(...flow.map((f, i) => {
      const e = document.createElement('li');
      if (i === flow.length - 1) e.className = 'latest';
      const t = document.createElement('span'); t.className = 't'; t.textContent = f.t || '';
      const h = document.createElement('span'); h.className = 'h'; h.textContent = f.h || '';
      const d = document.createElement('span'); d.className = 's'; d.textContent = f.s || '';
      e.append(t, h, d); return e;
    }));
    $('#sPoints').replaceChildren(...arr(s.points).map(li));
    $('#sQuestions').replaceChildren(...arr(s.questions).map(li));
    $('#sTerms').replaceChildren(...arr(s.terms).map((t) => {
      const w = document.createElement('div'); w.className = 'term';
      const dt = document.createElement('dt'); dt.textContent = t.ja || t.en || '';
      if (t.ja && t.en && t.ja !== t.en) { const en = document.createElement('span'); en.className = 't-en'; en.textContent = t.en; dt.appendChild(en); }
      const dd = document.createElement('dd'); dd.textContent = t.note || '';
      w.append(dt, dd); return w;
    }));
    const toc = [];
    SECTIONS.forEach((sec) => {
      const el = document.getElementById(sec.id);
      const v = sec.key(s);
      const has = Array.isArray(v) ? v.length > 0 : !!v;
      el.classList.toggle('empty', !has);
      const sig = JSON.stringify(v || '');
      const before = lastShown[sec.id];
      const fresh = markFresh && has && before !== undefined && before !== '""' && before !== '[]' && before !== sig;
      lastShown[sec.id] = sig;
      el.classList.remove('fresh');
      if (fresh) { void el.offsetWidth; el.classList.add('fresh'); }
      if (has) {
        const a = document.createElement('a'); a.href = '#' + sec.id; a.textContent = sec.label;
        if (fresh) a.className = 'fresh';
        a.addEventListener('click', (ev) => { ev.preventDefault(); el.scrollIntoView({ block: 'start' }); });
        toc.push(a);
      }
    });
    $('#toc').replaceChildren(...toc);
    renderCrumb();
    renderTopicState();
    updateMini();
  }

  // ---------------------------------------------------------------- 分類（学会・セッション）と題名
  function renderCrumb() {
    const m = S.meta || {};
    const el = $('#crumb');
    $('.crumb-ev', el).textContent = m.event || T('未分類');
    $('.crumb-gr', el).textContent = m.group || '';
    el.classList.toggle('unset', !m.event);
    el.title = T('この発表の記録先：{p}\n題名：{t}\nクリックで変更', { p: [m.event || T('未分類'), m.group].filter(Boolean).join(' › '), t: m.title || (S.summary && S.summary.title) || T('（要約から自動）') });
  }
  function fillMetaForm() {
    $('#mEvent').value = S.meta.event || ''; $('#mGroup').value = S.meta.group || ''; $('#mTitle').value = S.meta.title || '';
    $('#mTitle').placeholder = (S.summary && S.summary.title) ? T('自動：{t}', { t: S.summary.title }) : T('空なら要約から自動で付きます');
    $('#recId').textContent = S.id;
    $('#btnFolder').hidden = Store.mode !== 'server';
    Store.list().then((items) => {
      const evs = [...new Set(items.map((x) => x.event).filter(Boolean))];
      const ev = $('#mEvent').value;
      const grs = [...new Set(items.filter((x) => !ev || x.event === ev).map((x) => x.group).filter(Boolean))];
      const opt = (v) => { const o = document.createElement('option'); o.value = v; return o; };
      $('#dlEvents').replaceChildren(...evs.map(opt)); $('#dlGroups').replaceChildren(...grs.map(opt));
    }).catch(() => {});
  }
  [['#mEvent', 'event'], ['#mGroup', 'group'], ['#mTitle', 'title']].forEach(([id, key]) => {
    $(id).addEventListener('change', () => {
      S.meta[key] = $(id).value.trim(); S.meta.editedAt = Date.now();
      if (key === 'event') settings.lastEvent = S.meta.event;
      if (key === 'group') settings.lastGroup = S.meta.group;
      saveSettings(); renderCrumb();
      if (key === 'title') $('#sTitle').textContent = S.meta.title || (S.summary && S.summary.title) || '';
      saveSession();
    });
  });
  $('#popRecord').addEventListener('toggle', (e) => { $('#crumb').setAttribute('aria-expanded', String(e.newState === 'open')); if (e.newState === 'open') fillMetaForm(); });
  $('#popView').addEventListener('toggle', (e) => { $('#btnView').setAttribute('aria-expanded', String(e.newState === 'open')); });

  // ---------------------------------------------------------------- 次の発表へ（認識は止めない）／取り消し
  function resetView() {
    [...logEl.querySelectorAll('.line')].forEach((n) => n.remove());
    latestEl = null; unseen = 0; jumpEl.hidden = true; stuck = true;
    Object.keys(lastShown).forEach((k) => delete lastShown[k]);
    S.lines.forEach(renderLine);
    logEl.scrollTop = logEl.scrollHeight;
    lastSumChars = S.summary ? S.chars : 0; lastSumAt = 0; lastSumOkAt = S.summary ? Date.now() : 0; sumInfo = '';
    renderSummary(S.summary, false);
    setSumState(S.summary ? T('前回の要約') : T('要約はまだありません'));
    setSaved(T('まだ保存していません'));
    $('#clock').textContent = fmt(Date.now() - S.startedAt);
  }
  async function nextTalk() {
    const prev = S;
    if (!prev.lines.length) { notice(T('この発表はまだ書き起こしがないので，このまま使います．'), 'info', 4000); return; }
    for (let k = 0; k < 30 && pendingTr > 0; k++) await new Promise((r) => setTimeout(r, 100));   // 訳の待ちを少し待つ
    saveSession(prev);
    S = newSession();
    S.meta.event = prev.meta.event || ''; S.meta.group = prev.meta.group || '';
    restored = false;
    try { localStorage.removeItem(LS_LAST); } catch (e) {}
    resetView();
    const label = [S.meta.event || T('未分類'), S.meta.group].filter(Boolean).join(' › ');
    notice(T('次の発表の記録を始めました（{l}）．', { l: label }), 'info', 12000, { label: T('取り消す'), fn: () => undoNext(prev) });
  }
  function undoNext(prev) {
    const cur = S;
    const off = cur.startedAt - prev.startedAt;
    cur.lines.forEach((l) => { l.t += off; l.tEnd = (l.tEnd || l.t) + off; prev.lines.push(l); });   // 同じ行を移すので，訳待ちの行も正しく埋まる
    cur.nowLog.forEach((n) => { n.t += off; prev.nowLog.push(n); });
    prev.chars += cur.chars; prev.drops.push(...cur.drops);
    cur.discarded = true;                                     // 遅れて返ってくる要約などで書き直さない
    if (cur.lines.length) Store.remove(cur.id).catch(() => {});
    S = prev;
    resetView();
    saveSession();
    notice(T('元の発表の記録に戻しました．'), 'info', 4000);
  }

  // ---------------------------------------------------------------- 保存（DtysStore：補助プログラムのフォルダ or ブラウザ内）
  let backupTimer = null;
  function scheduleBackup() {
    try { localStorage.setItem(LS_LAST, JSON.stringify(S)); } catch (e) {}
    if (!backupTimer) backupTimer = setTimeout(() => saveSession(), 20000);
  }
  function setSaved(text, err) { const el = $('#recSaved'); el.textContent = text; el.classList.toggle('err', !!err); }
  async function saveSession(sess = S) {
    if (sess === S) { clearTimeout(backupTimer); backupTimer = null; }
    if (!sess.lines.length || sess.discarded) return true;
    sess.updatedAt = Date.now();
    if (sess === S) { try { localStorage.setItem(LS_LAST, JSON.stringify(sess)); } catch (e) {} }
    try {
      const j = await Store.save(sess);
      if (!j || !j.ok) throw new Error((j && j.error) || T('保存に失敗'));
      if (j.meta && JSON.stringify(j.meta) !== JSON.stringify(sess.meta)) { sess.meta = j.meta; if (sess === S) renderCrumb(); }  // ログ画面で変えた分類を取り込む
      if (sess === S) setSaved(T('{t} に保存（{w}）', { t: new Date().toLocaleTimeString(LOC), w: Store.mode === 'server' ? T('この Mac のフォルダ') : T('このブラウザ内') }));
      return true;
    } catch (e) {
      console.warn('[save]', e);
      if (sess === S) setSaved(T('保存できませんでした．ブラウザ内の控えには残っています．'), true);
      return false;
    }
  }
  window.addEventListener('pagehide', () => {
    if (!S.lines.length) return;
    try { localStorage.setItem(LS_LAST, JSON.stringify(S)); } catch (e) {}
    try { Store.saveOnUnload(S); } catch (e) {}
  });

  // ---------------------------------------------------------------- 小窓（Document Picture-in-Picture）
  let pipWin = null;
  async function togglePip() {
    if (pipWin) { pipWin.close(); return; }
    if (!('documentPictureInPicture' in window)) { notice(T('この Chrome では小窓（Document Picture-in-Picture）が使えません．'), 'warn'); return; }
    pipWin = await documentPictureInPicture.requestWindow({ width: settings.pipW || 560, height: settings.pipH || 320 });
    [...document.styleSheets].forEach((ss) => {
      try { const st = pipWin.document.createElement('style'); st.textContent = [...ss.cssRules].map((r) => r.cssText).join('\n'); pipWin.document.head.appendChild(st); }
      catch (e) { const l = pipWin.document.createElement('link'); l.rel = 'stylesheet'; l.href = ss.href; pipWin.document.head.appendChild(l); }
    });
    // アイコン（<symbol>）も小窓の文書へ写す
    pipWin.document.body.appendChild(document.querySelector('body > svg').cloneNode(true));
    pipWin.document.title = T('学会通訳要約ちゃん');
    pipWin.document.documentElement.lang = I18N.lang;
    pipWin.document.body.className = 'pip';
    pipWin.document.body.dataset.rec = recState;
    mini.hidden = false;
    pipWin.document.body.appendChild(mini);
    $('#btnPip').classList.add('on');
    pipWin.addEventListener('pagehide', () => {
      try { settings.pipW = pipWin.innerWidth; settings.pipH = pipWin.innerHeight; saveSettings(); } catch (e) {}
      mini.hidden = true; document.body.appendChild(mini); pipWin = null; $('#btnPip').classList.remove('on');
    });
    updateMini();
  }
  // 小窓側の状態表示（data-rec）も追従させる
  new MutationObserver(() => { if (pipWin) pipWin.document.body.dataset.rec = recState; }).observe(document.body, { attributes: true, attributeFilter: ['data-rec'] });
  miniStart.addEventListener('click', toggleRun);
  $$('.mini-font', mini).forEach((b) => b.addEventListener('click', () => {
    settings.pipFont = Math.max(14, Math.min(36, settings.pipFont + Number(b.dataset.d)));
    $('#rngPip').value = settings.pipFont; applyView(); saveSettings();
  }));

  // ---------------------------------------------------------------- 要約エンジン（Claude の課金状態・ローカル LLM・内蔵 AI）
  let engines = { claude: null, ollama: [] };
  const preferredLocal = () => engines.ollama.find((m) => /^qwen3:8b/.test(m)) || engines.ollama[0] || '';
  function engineLabel(e = settings.engine) {
    return { sonnet: 'Sonnet', haiku: 'Haiku', opus: 'Opus', nano: 'Gemini Nano' }[e] || String(e).replace(/^ollama:/, '');
  }
  function engineDefs() {
    const cl = engines.claude, helper = !!Store.api;
    const claudeOk = helper && cl && cl.available && cl.loggedIn;
    const cost = !claudeOk ? [] : cl.billing === 'subscription' ? [['free', T('¥0 サブスク枠')]] : cl.billing === 'api' ? [['paid', T('従量課金')]] : [];
    const needHelper = helper ? [] : [['', T('補助プログラムが必要')]];
    const claudeNote = !helper ? '' : !cl ? '' : !cl.available ? T('（claude コマンドが見つかりません）') : !cl.loggedIn ? T('（claude にログインしてください）') : '';
    const defs = [
      { group: T('Claude（ネットが必要）') },
      { v: 'sonnet', name: 'Claude Sonnet', desc: T('標準．高品質で速い（1 回 15 秒前後）') + claudeNote, badges: [...cost, ...needHelper], disabled: !claudeOk },
      { v: 'haiku', name: 'Claude Haiku', desc: T('いちばん速い．要約はやや簡素') + claudeNote, badges: [...cost, ...needHelper], disabled: !claudeOk },
      { v: 'opus', name: 'Claude Opus', desc: T('いちばん丁寧．時間はかかる') + claudeNote, badges: [...cost, ...needHelper], disabled: !claudeOk },
      { group: T('ローカル LLM（オフライン・Ollama）') },
    ];
    if (helper && engines.ollama.length) {
      engines.ollama.forEach((m) => defs.push({ v: 'ollama:' + m, name: m, desc: T('この Mac の中で要約（1 回 1 分前後）'), badges: [['free', '¥0'], ['off', T('オフライン')]] }));
    } else {
      defs.push({ v: '_ollama', name: T('ローカル LLM'), desc: helper ? T('Ollama のモデルが見つかりません') : T('補助プログラムと Ollama があると選べます'), badges: needHelper, disabled: true });
    }
    defs.push({ group: T('Chrome 内蔵 AI') });
    defs.push({ v: 'nano', name: 'Gemini Nano', desc: T('Chrome に入っている小さな AI．インストール不要（1 回 1 分前後）'), badges: [['free', '¥0'], ['off', T('オフライン')]], disabled: !('LanguageModel' in self || 'Summarizer' in self) });
    return defs;
  }
  function renderEngines() {
    const list = $('#engineList');
    list.replaceChildren(...engineDefs().map((d) => {
      if (d.group) { const g = document.createElement('div'); g.className = 'eng-group'; g.textContent = d.group; return g; }
      const lab = document.createElement('label'); lab.className = 'eng';
      const inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'engine'; inp.value = d.v; inp.disabled = !!d.disabled; inp.checked = settings.engine === d.v;
      inp.addEventListener('change', () => { settings.engine = d.v; settings.engineChosen = true; saveSettings(); renderEngineChip(); });
      const radio = document.createElement('span'); radio.className = 'radio';
      const main = document.createElement('span'); main.className = 'eng-main';
      const b = document.createElement('b'); b.textContent = d.name; const sm = document.createElement('small'); sm.textContent = d.desc; main.append(b, sm);
      const bs = document.createElement('span'); bs.className = 'badges';
      (d.badges || []).forEach(([cls, t]) => { const x = document.createElement('span'); x.className = 'badge ' + cls; x.textContent = t; bs.appendChild(x); });
      lab.append(inp, radio, main, bs);
      return lab;
    }));
  }
  function chooseDefaultEngine() {
    const cl = engines.claude;
    const claudeOk = Store.api && cl && cl.available && cl.loggedIn;
    const usable = (e) => (e === 'nano' ? true : e.startsWith('ollama:') ? !!Store.api && engines.ollama.includes(e.slice(7)) : !!claudeOk);
    // まだ選んだことがなければ：Claude が追加料金なし → それ，だめならローカル LLM → 内蔵 AI
    if (!settings.engineChosen) settings.engine = claudeOk && cl.billing !== 'api' ? 'sonnet' : (Store.api && preferredLocal()) ? 'ollama:' + preferredLocal() : 'nano';
    if (!usable(settings.engine)) settings.engine = (Store.api && preferredLocal()) ? 'ollama:' + preferredLocal() : 'nano';
    saveSettings();
  }
  function renderEngineChip() {
    const chip = $('#engineChip');
    const e = settings.engine, cl = engines.claude;
    const free = e === 'nano' || e.startsWith('ollama:') || (cl && cl.billing === 'subscription');
    const paid = !e.startsWith('ollama:') && e !== 'nano' && cl && cl.billing === 'api';
    chip.className = 'chip' + (paid ? ' api' : '');
    chip.replaceChildren(document.createTextNode(engineLabel()));
    if (free || paid) { const y = document.createElement('span'); y.className = 'yen'; y.textContent = paid ? T('従量') : '¥0'; chip.appendChild(y); }
    chip.title = T('要約：{e}{n}．クリックで変更', { e: engineLabel(), n: free ? T('（追加料金なし）') : paid ? T('（従量課金）') : '' });
  }
  async function loadEngines() {
    engines = { claude: null, ollama: [] };
    if (Store.api) {
      try {
        const j = await (await fetch(Store.api + '/api/engines')).json();
        engines = { claude: j.claude || null, ollama: (j.ollama && j.ollama.models) || [] };
      } catch (e) { /* つながらない */ }
    }
    chooseDefaultEngine();
    renderEngines();
    renderEngineChip();
  }
  function renderHelperState(state) {
    const el = $('#helperState');
    el.className = 'helper-state ' + (state === 'ok' ? 'ok' : state === 'busy' ? 'busy' : 'ng');
    $('.hs-text', el).textContent = state === 'ok' ? T('接続中（{h}）', { h: Store.api.replace(/^https?:\/\//, '') }) : state === 'busy' ? T('確認中…') : T('未接続（ブラウザだけで動作中）');
  }
  async function connectHelper(tryHelper) {
    renderHelperState('busy');
    const r = await Store.connect({ tryHelper });
    if (r.mode === 'server' && r.api && r.api !== location.origin) { settings.helper = true; saveSettings(); }
    renderHelperState(r.mode === 'server' ? 'ok' : 'ng');
    await loadEngines();
    return r;
  }

  // ---------------------------------------------------------------- 設定（閉じたときに認識へ反映）
  const dlg = $('#dlgSettings');
  let snap = '';
  const recKey = () => [settings.input, settings.recog, settings.mode, settings.srcLang, settings.dstLang].join('|');
  function openSettings(focusSel) {
    snap = recKey();
    $$('input[name="src"]').forEach((r) => { r.checked = (r.value === 'tab') === (settings.input === 'tab'); });
    $$('input[name="recog"]').forEach((r) => { r.checked = r.value === settings.recog; });
    $$('input[name="mode"]').forEach((r) => { r.checked = r.value === settings.mode; });
    $$('input[name="interval"]').forEach((r) => { r.checked = Number(r.value) === Number(settings.interval); });
    $('#selSrc').value = settings.srcLang; $('#selDst').value = settings.dstLang;
    renderEngines();
    renderHelperState(Store.mode === 'server' ? 'ok' : 'ng');
    dlg.showModal();
    if (focusSel) { const el = $(focusSel); if (el) el.focus(); }
  }
  dlg.addEventListener('close', async () => {
    applyView(); renderEngineChip(); renderInputLabel();
    if (recKey() !== snap) {
      S.lang = S.lines.length ? S.lang : { src: settings.srcLang, dst: settings.dstLang };
      if (recState === 'listening') { stop(); await start(); notice(T('設定を反映して認識を始め直しました．'), 'info', 5000); }
    }
  });
  function fillLangSelects() {
    const mk = (list) => list.map(([v, label]) => { const o = document.createElement('option'); o.value = v; o.textContent = T(label); return o; });
    $('#selSrc').replaceChildren(...mk(SRC_LANGS));
    $('#selDst').replaceChildren(...mk(DST_LANGS));
  }
  $('#selSrc').addEventListener('change', () => { settings.srcLang = $('#selSrc').value; saveSettings(); });
  $('#selDst').addEventListener('change', () => { settings.dstLang = $('#selDst').value; saveSettings(); });
  $$('input[name="src"]').forEach((r) => r.addEventListener('change', () => {
    settings.input = r.value === 'tab' ? 'tab' : $('#selDevice').value; saveSettings(); renderInputLabel();
  }));
  $('#selDevice').addEventListener('change', () => {
    settings.lastDevice = $('#selDevice').value;
    settings.input = $('#selDevice').value;                       // マイクを選んだらマイク入力に
    $$('input[name="src"]').forEach((r) => { r.checked = r.value === 'mic'; });
    saveSettings(); renderInputLabel();
  });
  $$('input[name="recog"]').forEach((r) => r.addEventListener('change', () => { settings.recog = r.value; saveSettings(); }));
  $$('input[name="mode"]').forEach((r) => r.addEventListener('change', () => { settings.mode = r.value; saveSettings(); }));
  $$('input[name="interval"]').forEach((r) => r.addEventListener('change', () => { settings.interval = Number(r.value); saveSettings(); }));
  $('#btnHelper').addEventListener('click', async () => {
    const r = await connectHelper(true);
    if (r.mode !== 'server') notice(T('補助プログラムが見つかりませんでした．説明書の「補助プログラム」の手順で起動してから，もう一度押してください．'), 'warn', 12000);
  });

  // ---------------------------------------------------------------- 操作
  $$('input[name="show"]').forEach((r) => r.addEventListener('change', () => { settings.show = r.value; applyView(); updateMini(); saveSettings(); }));
  [['#rngFont', 'font'], ['#rngSum', 'sumFont'], ['#rngPip', 'pipFont']].forEach(([id, key]) => {
    const el = $(id); el.value = settings[key];
    el.addEventListener('input', () => { settings[key] = Number(el.value); applyView(); saveSettings(); });
  });
  $('#btnStart').addEventListener('click', toggleRun);
  $('#btnNext').addEventListener('click', nextTalk);
  $('#btnSumNow').addEventListener('click', () => summarize());
  $('#btnPip').addEventListener('click', () => togglePip().catch((e) => notice(T('小窓を開けませんでした：{m}', { m: e.message }), 'warn')));
  $('#btnFolder').addEventListener('click', () => Store.reveal(S.id));
  $('#btnSettings').addEventListener('click', () => openSettings());
  $('#emptySettings').addEventListener('click', () => openSettings());
  $('#engineChip').addEventListener('click', () => openSettings());
  $('#langPill').addEventListener('click', () => openSettings('#selSrc'));
  // 幅が狭いときの「書き起こし／要約」切り替え
  $$('#tabs button').forEach((b) => b.addEventListener('click', () => {
    $('main').dataset.pane = b.dataset.pane;
    $$('#tabs button').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
  }));

  // 動作確認用（コンソールから模擬の文を流し込む）
  window.__dtys = { addLine, onInterim, summarize, nextTalk, setRec, notice, get session() { return S; } };

  // ---------------------------------------------------------------- 初期化
  /** 要素の中の日本語の文字ノードを辞書で置き換える（I18N.apply が対象外にする部分用） */
  function transNodes(root) {
    if (I18N.lang === 'ja' || !root) return;
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), ns = [];
    while (w.nextNode()) ns.push(w.currentNode);
    ns.forEach((n) => { const k = n.data.trim(); if (k && /[぀-ヿ㐀-鿿]/.test(k)) n.data = n.data.replace(k, I18N.t(k)); });
  }
  I18N.apply(document.body);
  [...$$('#empty'), ...$$('#right .sec > h2')].forEach(transNodes);      // apply が対象外にしている部分（#log・#right の中の固定の文言）
  if (I18N.lang === 'en') {
    $$('a[href^="guide.html"]').forEach((a) => a.setAttribute('href', a.getAttribute('href').replace('guide.html', 'guide-en.html')));
    const md = document.querySelector('meta[name="description"]');
    if (md) md.content = T('講演・学会発表を，その場で音声認識・翻訳・要約する無料の Web アプリ（Chrome 内蔵 AI を利用）');
  }
  $$('input[name="uilang"]').forEach((r) => { r.checked = r.value === I18N.lang; r.addEventListener('change', () => I18N.set(r.value)); });
  fillLangSelects();
  applyView();
  setRec('idle');
  S.lines.forEach(renderLine);
  logEl.scrollTop = logEl.scrollHeight;
  // 書体の読み込みで行の高さが変わっても，最新の行まで表示しておく
  const toBottom = () => { logEl.scrollTop = logEl.scrollHeight; stuck = true; unseen = 0; jumpEl.hidden = true; };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(toBottom);
  window.addEventListener('load', toBottom, { once: true });
  renderSummary(S.summary, false);
  const lastLine = S.lines[S.lines.length - 1];
  $('#clock').textContent = fmt(lastLine ? (lastLine.tEnd || lastLine.t) : 0);
  if (S.summary) setSumState(T('前回の記録から復元'));
  if (restored) notice(T('前回の記録（{id}）の続きです．別の発表なら「次の発表へ」を押してください．', { id: S.id }), 'info', 15000);
  mic.refreshDevices();
  renderInputLabel();
  renderEngineChip();
  connectHelper(!!settings.helper);
  (() => {
    const notes = [];
    if (!(window.SpeechRecognition || window.webkitSpeechRecognition)) notes.push(T('音声認識が使えません（パソコン版の Google Chrome で開いてください）'));
    if (!('Translator' in self)) notes.push(T('翻訳 API が使えません（Chrome を最新にしてください）'));
    if (notes.length) notice(notes.join(I18N.lang === 'en' ? ' / ' : '／'), 'warn');
  })();
})();
