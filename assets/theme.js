/* 配色（自動・ライト・ダーク）．全ページの <head> で最初に読む（読み込み中に色がちらつかないように）
 *  自動：OS の設定に合わせる（CSS の prefers-color-scheme）
 *  ライト・ダーク：<html data-theme="light|dark"> で固定する．選択は localStorage（dtys.theme）に保存し，ほかのタブにも反映する */
(() => {
  'use strict';
  const KEY = 'dtys.theme';
  const get = () => { try { const t = localStorage.getItem(KEY); return t === 'light' || t === 'dark' ? t : 'auto'; } catch (e) { return 'auto'; } };
  const apply = (t, doc = document) => { if (t === 'light' || t === 'dark') doc.documentElement.dataset.theme = t; else delete doc.documentElement.dataset.theme; };
  const listeners = new Set();
  const emit = (t) => listeners.forEach((f) => { try { f(t); } catch (e) {} });
  window.Theme = {
    get, apply,
    set(t) {
      try { if (t === 'light' || t === 'dark') localStorage.setItem(KEY, t); else localStorage.removeItem(KEY); } catch (e) {}
      apply(t); emit(t);
    },
    onChange(f) { listeners.add(f); },
  };
  apply(get());
  addEventListener('storage', (e) => { if (e.key === KEY) { const t = get(); apply(t); emit(t); } });
})();
