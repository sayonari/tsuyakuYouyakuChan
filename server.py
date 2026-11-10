#!/usr/bin/env python3
"""
学会通訳要約ちゃん（補助プログラム）：講演・会議を Chrome 内蔵の音声認識・翻訳で日本語にしつつ，
要約を Claude Code（claude -p，サブスク枠）またはローカル LLM（Ollama）で作るためのローカルサーバ．

  python3 server.py            → http://127.0.0.1:8765/ を Chrome で開く

画面
- / ・ /logs.html ・ /guide.html   画面（公開ページと同じファイル）
- /assets/*            画面の部品
- /jimakuChan/v2/js/*  音声認識字幕ちゃん v2 の部品（公開ページでは sayonari.github.io の同じパスから読む）

要約
- GET  /api/engines    使える要約エンジン（claude の有無・Ollama のモデル一覧．Ollama は起動しない）
- GET  /api/prompt     要約の指示文と JSON スキーマ（Chrome 内蔵 AI でも同じ指示を使うため）
- POST /api/summarize  {model, prev, elapsed, transcript}
                       model = sonnet|haiku|opus（claude -p）／ollama:<モデル名>（必要なときだけ Ollama を起動）

記録（sessions/<学会>/<セッション>/<ID>.json と <ID>_<題名>.md）
- POST /api/save       {id, data}           data.meta = {event, group, title, editedAt}
- GET  /api/list       記録の一覧（メタ情報のみ）
- GET  /api/session?id=
- GET  /api/search?q=  全文検索（書き起こし・訳・要約）
- POST /api/meta       {id, event, group, title}   分類・題名の変更（ファイルも移動）
- POST /api/delete     {id}                        sessions/.trash/ へ移す（消さない）
- POST /api/reveal     {id?}                       保存先フォルダを Finder で開く

外部へは何も公開しない（127.0.0.1 のみで待ち受け）．
"""
import atexit
import http.server
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urlparse, unquote, parse_qs

ROOT = Path(__file__).resolve().parent
APP = ROOT / 'app'
JC = Path(os.environ.get('JIMAKU_JS') or (ROOT.parent / 'jimakuChan_v2' / 'v2' / 'js'))
SESS = Path(os.environ.get('DTYS_SESSIONS') or (ROOT / 'sessions'))   # 試験用に別の場所を指定できる
TRASH = SESS / '.trash'
WORK = ROOT / '.claude_cwd'          # claude -p を走らせる空フォルダ（プロジェクトの CLAUDE.md 等を読ませない）
PORT = int(os.environ.get('PORT', '8765'))
CLAUDE = os.environ.get('CLAUDE_BIN') or shutil.which('claude') or str(Path.home() / '.local/bin/claude')
CLAUDE_MODELS = {'sonnet', 'haiku', 'opus'}
OLLAMA = shutil.which('ollama') or '/opt/homebrew/bin/ollama'
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://127.0.0.1:11434')
OLLAMA_MANIFESTS = Path(os.environ.get('OLLAMA_MODELS') or (Path.home() / '.ollama' / 'models')) / 'manifests'
OLLAMA_KEEP = '10m'                  # 使わなくなってからモデルをメモリから外すまで
OLLAMA_IDLE_STOP = 15 * 60           # 自分で起動した Ollama を止めるまでの無使用時間（秒）
JC_FILES = {'recognizer.js', 'mic.js'}
PAGES = {'/': 'index.html', '/index.html': 'index.html', '/logs.html': 'logs.html', '/guide.html': 'guide.html', '/guide-en.html': 'guide-en.html'}
# 公開ページ（GitHub Pages）からこの補助プログラムを呼んでよいオリジン．ほかのサイトからの呼び出しは断る
ALLOWED_ORIGINS = {'https://sayonari.github.io'} | {o.strip() for o in os.environ.get('DTYS_ORIGINS', '').split(',') if o.strip()}

SESS.mkdir(exist_ok=True)
WORK.mkdir(exist_ok=True)

# 要約の指示文と JSON スキーマ（ブラウザ側の Gemini Nano と共通．{LANG} に話される言語名が入る）
PROMPT = json.loads((ROOT / 'assets' / 'prompt.json').read_text(encoding='utf-8'))
SCHEMA = PROMPT['schema']


def system_for(req):
    return PROMPT['system'].replace('{LANG}', str(req.get('langName') or '英語')).replace('{OUT}', str(req.get('outName') or '日本語'))


_lock = threading.Lock()          # 要約は 1 本ずつ
_files = threading.Lock()         # 記録ファイルの読み書き


# ===================================================================== 要約
def build_prompt(req):
    prev = req.get('prev')
    prev_txt = json.dumps(prev, ensure_ascii=False) if prev else '（なし．今回が最初）'
    tr = str(req.get('transcript', ''))
    recent = '\n'.join(tr.strip().split('\n')[-8:])      # 小さいモデルが「いま」を冒頭の話と取り違えないよう，直近を別に示す
    return (
        f"# 前回の状態\n{prev_txt}\n\n"
        f"# 経過時間\n開始から {req.get('elapsed', '?')}\n\n"
        f"# 書き起こし（[経過時間] 原文）\n{tr}\n\n"
        f"# 直近の発言（now と phase はここを基に書く）\n{recent}\n\n"
        "上の指示どおり JSON だけを出力してください．"
    )


def extract_json(text):
    t = text.strip()
    t = re.sub(r'^```(?:json)?\s*', '', t)
    t = re.sub(r'\s*```$', '', t)
    try:
        return json.loads(t)
    except Exception:
        pass
    a, b = t.find('{'), t.rfind('}')
    if a >= 0 and b > a:
        return json.loads(t[a:b + 1])
    raise ValueError('JSON が見つかりません')


def run_claude(req, model):
    args = [CLAUDE, '-p', '--model', model, '--safe-mode', '--tools', '',
            '--strict-mcp-config', '--no-session-persistence',
            '--system-prompt', system_for(req), '--output-format', 'json']
    t0 = time.time()
    p = subprocess.run(args, input=build_prompt(req), capture_output=True, text=True,
                       cwd=str(WORK), timeout=240)
    dt = time.time() - t0
    if p.returncode != 0 and not p.stdout.strip():
        raise RuntimeError((p.stderr or 'claude の実行に失敗').strip()[:400])
    out = json.loads(p.stdout)
    if out.get('is_error'):
        raise RuntimeError(str(out.get('result') or out.get('subtype') or 'claude エラー')[:400])
    return {'summary': extract_json(out.get('result', '')), 'sec': round(dt, 1), 'model': model}


# ---- Ollama（必要なときだけ起動．自分で起動したものは使わなくなったら止める）
_ollama_proc = None
_ollama_last = 0.0


def _http_json(url, body=None, timeout=5):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json'} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def ollama_alive():
    try:
        _http_json(OLLAMA_URL + '/api/version', timeout=1.5)
        return True
    except Exception:
        return False


def ensure_ollama():
    global _ollama_proc
    if ollama_alive():
        return
    if not Path(OLLAMA).exists():
        raise RuntimeError('Ollama が入っていません（brew install ollama）')
    print('[ollama] 起動します')
    _ollama_proc = subprocess.Popen([OLLAMA, 'serve'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(60):
        time.sleep(0.5)
        if ollama_alive():
            return
    raise RuntimeError('Ollama を起動できませんでした')


def stop_own_ollama():
    global _ollama_proc
    if _ollama_proc and _ollama_proc.poll() is None:
        print('[ollama] 使っていないので止めます')
        _ollama_proc.terminate()
        try:
            _ollama_proc.wait(timeout=10)
        except Exception:
            _ollama_proc.kill()
    _ollama_proc = None


def _idle_watch():
    while True:
        time.sleep(60)
        if _ollama_proc and time.time() - _ollama_last > OLLAMA_IDLE_STOP:
            stop_own_ollama()


threading.Thread(target=_idle_watch, daemon=True).start()
atexit.register(stop_own_ollama)


def ollama_models():
    names = []
    if ollama_alive():
        try:
            names = [m['name'] for m in _http_json(OLLAMA_URL + '/api/tags').get('models', [])]
        except Exception:
            names = []
    if not names:                     # 起動していなくても，入っているモデルはファイルから分かる
        lib = OLLAMA_MANIFESTS / 'registry.ollama.ai' / 'library'
        if lib.is_dir():
            for d in sorted(lib.iterdir()):
                if d.is_dir():
                    names += [f'{d.name}:{t.name}' for t in sorted(d.iterdir()) if t.is_file()]
    return [n for n in names if 'embed' not in n.lower()]


def run_ollama(req, model):
    global _ollama_last
    ensure_ollama()
    _ollama_last = time.time()
    body = {
        'model': model, 'stream': False, 'format': SCHEMA, 'keep_alive': OLLAMA_KEEP,
        'messages': [{'role': 'system', 'content': system_for(req)}, {'role': 'user', 'content': build_prompt(req)}],
        'options': {'num_ctx': 16384, 'temperature': 0.2},
    }
    if re.match(r'(qwen3|deepseek-r1|magistral)', model):
        body['think'] = False         # 考える過程は出さずに答えだけ（速さ優先）
    t0 = time.time()
    try:
        out = _http_json(OLLAMA_URL + '/api/chat', body, timeout=600)
    except urllib.error.HTTPError as e:
        msg = e.read().decode('utf-8', 'replace')
        if 'think' in msg and 'think' in body:
            body.pop('think')
            out = _http_json(OLLAMA_URL + '/api/chat', body, timeout=600)
        else:
            raise RuntimeError(f'Ollama: {msg[:300]}')
    _ollama_last = time.time()
    return {'summary': extract_json(out.get('message', {}).get('content', '')),
            'sec': round(time.time() - t0, 1), 'model': model}


NET_ERR = re.compile(r"ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|reach the API|network|connection|getaddrinfo|offline", re.I)


def summarize(req):
    """要約する．Claude がネットにつながらないときは，fallback に指定されたローカル LLM で代わりに作る"""
    m = str(req.get('model') or 'sonnet')
    if m.startswith('ollama:'):
        return run_ollama(req, m[len('ollama:'):])
    try:
        return run_claude(req, m if m in CLAUDE_MODELS else 'sonnet')
    except Exception as e:
        fb = str(req.get('fallback') or '')
        if fb.startswith('ollama:') and (NET_ERR.search(str(e)) or isinstance(e, subprocess.TimeoutExpired)):
            r = run_ollama(req, fb[len('ollama:'):])
            r['fellBack'] = True
            r['reason'] = str(e)[:200]
            return r
        raise


# ---- claude のログイン状態（サブスク＝追加料金なし／API キー＝従量課金）
_auth = {'at': 0.0, 'info': None}


def claude_auth():
    if _auth['info'] is not None and time.time() - _auth['at'] < 600:
        return _auth['info']
    info = {'available': bool(shutil.which(CLAUDE) or Path(CLAUDE).exists()), 'loggedIn': False, 'authMethod': '', 'billing': 'unknown'}
    if info['available']:
        try:
            p = subprocess.run([CLAUDE, 'auth', 'status'], capture_output=True, text=True, timeout=15, cwd=str(WORK))
            st = json.loads(p.stdout)
            info['loggedIn'] = bool(st.get('loggedIn'))
            info['authMethod'] = str(st.get('authMethod') or '')
        except Exception:
            pass
        api_key = bool(os.environ.get('ANTHROPIC_API_KEY') or os.environ.get('ANTHROPIC_AUTH_TOKEN'))
        if api_key or 'api' in info['authMethod'].lower() or 'key' in info['authMethod'].lower():
            info['billing'] = 'api'                  # 従量課金
        elif info['loggedIn'] and info['authMethod'] == 'claude.ai':
            info['billing'] = 'subscription'         # サブスクの枠内（追加料金なし）
    _auth.update(at=time.time(), info=info)
    return info


# ===================================================================== 記録
def safe_name(s, default=''):
    s = re.sub(r'[\\/:*?"<>|\x00-\x1f]', '_', str(s or '')).strip().strip('.')
    return s[:60] or default


def sid_ok(sid):
    return bool(re.fullmatch(r'[0-9A-Za-z_-]{1,40}', str(sid or '')))


def find_json(sid):
    for p in SESS.rglob(f'{sid}.json'):
        if '.trash' not in p.parts:
            return p
    return None


def related_files(sid):
    out = []
    for p in SESS.rglob(f'{sid}*'):
        if p.is_file() and '.trash' not in p.parts and (p.name == f'{sid}.json' or p.name == f'{sid}.md' or p.name.startswith(f'{sid}_')):
            out.append(p)
    return out


def target_dir(meta):
    ev = safe_name(meta.get('event'), '未分類')
    gr = safe_name(meta.get('group'))
    return SESS / ev / gr if gr else SESS / ev


def fmt_ms(ms):
    s = max(0, int((ms or 0) // 1000))
    h, m, ss = s // 3600, s // 60 % 60, s % 60
    return f'{h}:{m:02d}:{ss:02d}' if h else f'{m:02d}:{ss:02d}'


def talk_title(data):
    meta = data.get('meta') or {}
    return meta.get('title') or (data.get('summary') or {}).get('title') or ''


def to_markdown(data):
    s = data.get('summary') or {}
    meta = data.get('meta') or {}
    L = [f"# {talk_title(data) or '英語講演・会議の記録'}", '', f"- 記録ID：{data.get('id', '')}"]
    if data.get('startedAt'):
        L.append('- 開始：' + time.strftime('%Y-%m-%d %H:%M', time.localtime(data['startedAt'] / 1000)))
    if meta.get('event'):
        L.append(f"- 学会・イベント：{meta['event']}")
    if meta.get('group'):
        L.append(f"- セッション：{meta['group']}")
    for k, lab in (('kind', '形式'), ('speaker', '話者')):
        if s.get(k):
            L.append(f'- {lab}：{s[k]}')
    lines = data.get('lines') or []
    if lines:
        L.append('- 長さ：' + fmt_ms(lines[-1].get('tEnd') or lines[-1].get('t')))
    if s.get('overall'):
        L += ['', '## 全体要約', '', s['overall']]
    if s.get('how'):
        L += ['', '## どのように説明しているか', '', s['how']]
    if s.get('flow'):
        L += ['', '## 流れ', ''] + [f"- [{f.get('t', '')}] **{f.get('h', '')}**：{f.get('s', '')}" for f in s['flow']]
    if data.get('nowLog'):
        L += ['', '## その時々の話題', ''] + [f"- [{fmt_ms(n.get('t'))}] {('（' + n['phase'] + '）') if n.get('phase') else ''}{n.get('now', '')}" for n in data['nowLog']]
    if s.get('points'):
        L += ['', '## 要点', ''] + [f'- {p}' for p in s['points']]
    if s.get('terms'):
        L += ['', '## 用語', '', '| 英語 | 訳語 | 説明 |', '|---|---|---|'] + \
             [f"| {t.get('en', '')} | {t.get('ja', '')} | {t.get('note', '')} |" for t in s['terms']]
    if s.get('questions'):
        L += ['', '## 質問するなら', ''] + [f'- {q}' for q in s['questions']]
    L += ['', '## 書き起こし（訳と原文）', '']
    for l in lines:
        L += [f"**[{fmt_ms(l.get('t'))}]** {l.get('ja', '')}", f"> {l.get('en', '')}", '']
    return '\n'.join(L)


def write_session(sid, data):
    """data を分類どおりのフォルダに書く．ログ画面で分類・題名を変えていた（editedAt が新しい）ならそちらを残す．返り値：採用した meta"""
    with _files:
        meta = dict(data.get('meta') or {})
        old = find_json(sid)
        if old:
            try:
                om = json.loads(old.read_text(encoding='utf-8')).get('meta') or {}
                if (om.get('editedAt') or 0) > (meta.get('editedAt') or 0):
                    meta = om
            except Exception:
                pass
        data['meta'] = meta
        d = target_dir(meta)
        d.mkdir(parents=True, exist_ok=True)
        title = safe_name(talk_title(data))[:40]
        for p in related_files(sid):
            p.unlink()
        (d / f'{sid}.json').write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
        (d / (f'{sid}_{title}.md' if title else f'{sid}.md')).write_text(to_markdown(data), encoding='utf-8')
        return meta


def load_session(sid):
    p = find_json(sid)
    return json.loads(p.read_text(encoding='utf-8')) if p else None


def list_sessions():
    out = []
    for p in SESS.rglob('*.json'):
        if '.trash' in p.parts:
            continue
        try:
            d = json.loads(p.read_text(encoding='utf-8'))
        except Exception:
            continue
        s = d.get('summary') or {}
        meta = d.get('meta') or {}
        lines = d.get('lines') or []
        out.append({
            'id': d.get('id') or p.stem, 'title': talk_title(d), 'kind': s.get('kind', ''), 'speaker': s.get('speaker', ''),
            'event': meta.get('event') or '', 'group': meta.get('group') or '',
            'startedAt': d.get('startedAt'), 'updatedAt': d.get('updatedAt'),
            'duration': (lines[-1].get('tEnd') or lines[-1].get('t') or 0) if lines else 0,
            'lines': len(lines), 'overall': s.get('overall', ''),
            'path': str(p.relative_to(SESS)),
        })
    out.sort(key=lambda x: x.get('startedAt') or 0, reverse=True)
    return out


def search_sessions(q, per=8, total=300):
    q = (q or '').strip().casefold()
    if not q:
        return []
    res, n = [], 0
    for item in list_sessions():
        d = load_session(item['id']) or {}
        hits = []
        for i, l in enumerate(d.get('lines') or []):
            if q in (l.get('en') or '').casefold() or q in (l.get('ja') or '').casefold():
                hits.append({'i': i, 't': l.get('t'), 'en': l.get('en', ''), 'ja': l.get('ja', '')})
                if len(hits) >= per:
                    break
        in_sum = q in json.dumps(d.get('summary') or {}, ensure_ascii=False).casefold() or q in item['title'].casefold()
        if hits or in_sum:
            res.append(dict(item, hits=hits, inSummary=in_sum))
            n += len(hits)
            if n >= total:
                break
    return res


# ===================================================================== HTTP
class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt, *a):
        if '/api/' in (a[0] if a else '') and '/api/save' not in (a[0] if a else ''):
            super().log_message(fmt, *a)

    def _origin_ok(self):
        """Origin が無い（同じページ・curl）か，自分自身か，許可した公開ページなら True"""
        o = self.headers.get('Origin')
        if not o:
            return True
        host = self.headers.get('Host', '')
        return o in ALLOWED_ORIGINS or o in (f'http://{host}', f'http://127.0.0.1:{PORT}', f'http://localhost:{PORT}')

    def _cors(self):
        o = self.headers.get('Origin')
        if o and o in ALLOWED_ORIGINS:
            self.send_header('Access-Control-Allow-Origin', o)
            self.send_header('Vary', 'Origin')

    def _send(self, code, body, ctype='application/json; charset=utf-8'):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._send(403, {'ok': False, 'error': 'origin not allowed'})
        self.send_response(204)
        self._cors()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Access-Control-Allow-Private-Network', 'true')   # 公開ページ → 手元（127.0.0.1）への呼び出しを許す
        self.send_header('Access-Control-Max-Age', '600')
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _file(self, path):
        if not path.is_file():
            return self._send(404, {'error': 'not found'})
        ctype = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
                 '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
                 '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon',
                 '.webp': 'image/webp', '.jpg': 'image/jpeg'}.get(path.suffix, 'application/octet-stream')
        self._send(200, path.read_bytes(), ctype)

    def do_GET(self):
        u = urlparse(self.path)
        path, qs = unquote(u.path), parse_qs(u.query)
        if path in PAGES:
            return self._file(ROOT / PAGES[path])
        if path.startswith('/assets/'):
            name = path[len('/assets/'):]
            if '..' in name or name.startswith('/'):
                return self._send(403, {'error': 'forbidden'})
            return self._file(ROOT / 'assets' / name)
        if path.startswith('/jimakuChan/v2/js/'):          # 公開ページと同じパスで字幕ちゃん v2 の部品を出す
            name = path[len('/jimakuChan/v2/js/'):]
            if name not in JC_FILES:
                return self._send(404, {'error': 'not found'})
            return self._file(JC / name)
        if path.startswith('/app/'):                       # 旧画面（移行が済んだら消す）
            name = path[5:]
            if '..' in name or name.startswith('/'):
                return self._send(403, {'error': 'forbidden'})
            return self._file(APP / name)
        if path.startswith('/jc/'):
            name = path[4:]
            if name not in JC_FILES:
                return self._send(404, {'error': 'not found'})
            return self._file(JC / name)
        if path == '/api/health':
            return self._send(200, {'ok': True, 'claude': bool(shutil.which(CLAUDE) or Path(CLAUDE).exists()),
                                    'jimaku': (JC / 'recognizer.js').is_file()})
        if path == '/api/engines':
            return self._send(200, {'ok': True, 'claude': claude_auth(),
                                    'ollama': {'installed': Path(OLLAMA).exists(), 'running': ollama_alive(), 'models': ollama_models()}})
        if path == '/api/prompt':
            return self._send(200, dict(ok=True, **PROMPT))
        if path == '/api/list':
            return self._send(200, {'ok': True, 'items': list_sessions()})
        if path == '/api/session':
            sid = (qs.get('id') or [''])[0]
            d = load_session(sid) if sid_ok(sid) else None
            return self._send(200 if d else 404, {'ok': bool(d), 'data': d})
        if path == '/api/search':
            return self._send(200, {'ok': True, 'items': search_sessions((qs.get('q') or [''])[0])})
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        u = urlparse(self.path).path
        # 他のサイトから勝手に要約（claude の実行）や保存・削除をさせない
        if not self._origin_ok():
            return self._send(403, {'ok': False, 'error': 'origin not allowed'})
        if self.headers.get('Origin') and 'application/json' not in (self.headers.get('Content-Type') or ''):
            return self._send(415, {'ok': False, 'error': 'application/json only'})
        n = int(self.headers.get('Content-Length') or 0)
        try:
            req = json.loads(self.rfile.read(n) or b'{}')
        except Exception:
            return self._send(400, {'ok': False, 'error': 'bad json'})
        if u == '/api/summarize':
            if not _lock.acquire(blocking=False):
                return self._send(200, {'ok': False, 'busy': True, 'error': '前の要約を処理中'})
            try:
                return self._send(200, dict(ok=True, **summarize(req)))
            except subprocess.TimeoutExpired:
                return self._send(200, {'ok': False, 'error': '要約が時間内に返ってきませんでした'})
            except Exception as e:
                return self._send(200, {'ok': False, 'error': str(e)})
            finally:
                _lock.release()
        if u == '/api/save':
            sid = str(req.get('id', ''))
            data = req.get('data')
            if not sid_ok(sid) or not isinstance(data, dict):
                return self._send(400, {'ok': False, 'error': 'bad id'})
            meta = write_session(sid, data)
            return self._send(200, {'ok': True, 'meta': meta})
        if u == '/api/meta':
            sid = str(req.get('id', ''))
            d = load_session(sid) if sid_ok(sid) else None
            if not d:
                return self._send(404, {'ok': False, 'error': 'not found'})
            meta = dict(d.get('meta') or {})
            for k in ('event', 'group', 'title'):
                if k in req:
                    meta[k] = str(req[k] or '').strip()
            meta['editedAt'] = int(time.time() * 1000)
            d['meta'] = meta
            return self._send(200, {'ok': True, 'meta': write_session(sid, d)})
        if u == '/api/delete':
            sid = str(req.get('id', ''))
            if not sid_ok(sid):
                return self._send(400, {'ok': False, 'error': 'bad id'})
            with _files:
                TRASH.mkdir(exist_ok=True)
                for p in related_files(sid):
                    shutil.move(str(p), str(TRASH / p.name))
            return self._send(200, {'ok': True})
        if u == '/api/reveal':
            sid = str(req.get('id', ''))
            p = find_json(sid) if sid_ok(sid) else None
            subprocess.Popen(['open', '-R', str(p)] if p else ['open', str(SESS)])
            return self._send(200, {'ok': True})
        return self._send(404, {'ok': False, 'error': 'not found'})


if __name__ == '__main__':
    if not (JC / 'recognizer.js').is_file():
        print(f'⚠ 字幕ちゃん v2 の部品が見つかりません: {JC}（環境変数 JIMAKU_JS で指定可）')
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print(f'学会通訳要約ちゃん（補助プログラム）: http://127.0.0.1:{PORT}/  （Ctrl+C で終了）')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_own_ollama()
