#!/bin/zsh
# 学会通訳要約ちゃん：補助プログラムを起動して画面を開く（Finder からダブルクリックでも可）．終了はこのウィンドウで Ctrl+C
cd "$(dirname "$0")"
PORT=${PORT:-8765}
if ! lsof -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  python3 server.py &
  SRV=$!
  sleep 0.8
fi
open -a "Google Chrome" "http://127.0.0.1:$PORT/"
[ -n "$SRV" ] && wait $SRV
