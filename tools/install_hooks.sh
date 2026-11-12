#!/bin/sh
# コミットのたびにバージョン（日時）を更新するフックを入れる（clone し直したときに 1 回実行）
cd "$(dirname "$0")/.." || exit 1
cat > .git/hooks/pre-commit <<'EOF'
#!/bin/sh
sh tools/stamp_version.sh >/dev/null && git add assets/version.js
EOF
chmod +x .git/hooks/pre-commit
echo "pre-commit フックを入れました"
