/* 自動生成（tools/stamp_version.sh）．手で書き換えない．バージョン＝最後に変更をコミットした日時（日本時間） */
(() => {
  const V = '2026.11.12 16:53';
  window.DTYS_VERSION = V;
  const fill = () => {
    document.querySelectorAll('[data-version]').forEach((e) => { e.textContent = V; });
    document.querySelectorAll('.brand, [data-version-title]').forEach((e) => { e.title = (e.title ? e.title + '　' : '') + 'ver. ' + V; });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
})();
