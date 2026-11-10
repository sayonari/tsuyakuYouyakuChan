/*
 * 表示言語（日本語／英語）の切り替え
 *
 * - 日本語の文言そのものを鍵にして，英語の辞書から引く（日本語のときは何もしない）
 * - 辞書は画面ごとのファイル（assets/lang/*.en.js）が I18N.add({ '日本語': 'English', ... }) で足す
 * - 画面の固定の文言：I18N.apply(root) が文字ノードと title / placeholder / aria-label を辞書で置き換える
 *   （HTML 側は日本語のまま書けばよい．置き換えたくない要素には data-noi18n を付ける）
 * - JS で作る文言：I18N.t('認識中・{d}', { d }) のように書く．{名前} は vars で埋める
 * - 言語は localStorage 'dtys.settings' の uiLang（'ja' | 'en'）．無ければブラウザの言語（日本語以外は英語）
 * - 切り替えは I18N.set(lang) → 設定を保存して再読み込み
 */
(() => {
  'use strict';
  const DICT = {};
  const loadSettings = () => { try { return JSON.parse(localStorage.getItem('dtys.settings') || '{}') || {}; } catch (e) { return {}; } };
  const st = loadSettings();
  const auto = /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en';
  const lang = st.uiLang === 'ja' || st.uiLang === 'en' ? st.uiLang : auto;
  document.documentElement.lang = lang;

  const fill = (s, vars) => (vars ? String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? vars[k] : m)) : s);
  function t(ja, vars) {
    if (lang === 'ja') return fill(ja, vars);
    const en = DICT[ja];
    if (en == null && window.__i18nMissing) window.__i18nMissing.add(ja);   // 開発用：訳し漏れを集める
    return fill(en != null ? en : ja, vars);
  }
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const JA = /[぀-ヿ㐀-鿿！-｠]/;
  /** 画面の固定の文言を置き換える（日本語のときは何もしない） */
  function apply(root = document.body) {
    if (lang === 'ja' || !root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const p = n.parentElement;
      if (!p || p.closest('[data-noi18n], script, style, #log, #right .sec, #sNow, #flowMini, #sTitle, #sSpeaker, #sKind')) continue;
      const raw = n.data, key = raw.trim();
      if (!key || !JA.test(key)) continue;
      const en = DICT[key];
      if (en != null) n.data = raw.replace(key, en);
      else if (window.__i18nMissing) window.__i18nMissing.add(key);
    }
    root.querySelectorAll('*').forEach((el) => {
      if (el.closest('[data-noi18n]')) return;
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && JA.test(v)) { const en = DICT[v.trim()]; if (en != null) el.setAttribute(a, en); else if (window.__i18nMissing) window.__i18nMissing.add(v.trim()); }
      }
    });
    const ti = document.title; if (DICT[ti]) document.title = DICT[ti];
  }
  function set(l) {
    const s = loadSettings(); s.uiLang = l;
    try { localStorage.setItem('dtys.settings', JSON.stringify(s)); } catch (e) {}
    location.reload();
  }
  window.I18N = { lang, t, apply, set, add: (d) => Object.assign(DICT, d), dict: DICT };
})();
