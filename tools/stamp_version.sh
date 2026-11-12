#!/bin/sh
# バージョン（＝プログラムを最後に変更した日時．日本時間）を assets/version.js に書く．
# コミットのたびに .git/hooks/pre-commit から呼ばれる（フックの入れ方：tools/install_hooks.sh）
cd "$(dirname "$0")/.." || exit 1
V=$(TZ=Asia/Tokyo date "+%Y.%m.%d %H:%M")
cat > assets/version.js <<EOF
/* 自動生成（tools/stamp_version.sh）．手で書き換えない．バージョン＝最後に変更をコミットした日時（日本時間） */
(() => {
  const V = '$V';
  window.DTYS_VERSION = V;
  const fill = () => {
    document.querySelectorAll('[data-version]').forEach((e) => { e.textContent = V; });
    document.querySelectorAll('.brand, [data-version-title]').forEach((e) => { e.title = (e.title ? e.title + '　' : '') + 'ver. ' + V; });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
})();
EOF
echo "$V"
