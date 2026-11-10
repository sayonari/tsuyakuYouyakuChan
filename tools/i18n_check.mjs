#!/usr/bin/env node
/*
 * 訳し漏れの検査：HTML の日本語の文字ノード・属性（title / placeholder / aria-label）と，
 * JS の T('…')・I18N.t('…')・L('…') の第 1 引数のうち，辞書（assets/lang/*.en.js）に無いものを一覧する．
 *
 * 使い方：node tools/i18n_check.mjs <html> <js> [辞書 ...]
 *   例：node tools/i18n_check.mjs index.html assets/app.js
 *       node tools/i18n_check.mjs logs.html assets/logs.js
 *   辞書を省くと assets/lang/<JS の名前>.en.js を使う．漏れがあれば終了コード 1．
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [htmlFile, jsFile, ...dictFiles] = process.argv.slice(2);
if (!htmlFile || !jsFile) { console.error('使い方：node tools/i18n_check.mjs <html> <js> [辞書 ...]'); process.exit(2); }
const rd = (f) => fs.readFileSync(path.resolve(root, f), 'utf8');
const JA = /[぀-ヿ㐀-鿿！-｠]/;

// 辞書
const dict = {};
// 辞書の既定：JS と同じ名前の辞書（app.js → app.en.js，logs.js → logs.en.js）
const dicts = dictFiles.length ? dictFiles : ['assets/lang/' + path.basename(jsFile).replace(/\.js$/, '') + '.en.js'];
const fake = { add: (d) => Object.assign(dict, d) };
for (const f of dicts) vm.runInNewContext(rd(f), { I18N: fake, window: { I18N: fake } });

const need = new Map();   // 鍵 → 出どころ
const add = (k, where) => { if (k && JA.test(k) && !(k in dict) && !need.has(k)) need.set(k, where); };
const unent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

// HTML
let html = rd(htmlFile);
html = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
html = html.replace(/<(\w+)([^>]*\sdata-noi18n[^>]*)>[\s\S]*?<\/\1>/g, '');      // data-noi18n の要素は対象外
for (const m of html.matchAll(/<[^>]+>/g)) {
  for (const a of m[0].matchAll(/\s(?:title|placeholder|aria-label)="([^"]*)"/g)) add(unent(a[1]).trim(), htmlFile + ' (属性)');
}
for (const seg of html.replace(/<[^>]+>/g, '\u0000').split('\u0000')) add(unent(seg).trim(), htmlFile);

// JS：T('…')・I18N.t('…')・L('…')
const js = rd(jsFile);
const re = /(?<![\w$.])(?:T|L)\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`)|\bI18N\.t\(\s*('(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g;
for (const m of js.matchAll(re)) {
  const lit = m[1] || m[2];
  let v; try { v = vm.runInNewContext(lit); } catch (e) { continue; }
  add(v, jsFile);
}

console.log(`辞書 ${Object.keys(dict).length} 件（${dicts.join('，')}）`);
if (!need.size) { console.log('訳し漏れ：0'); process.exit(0); }
console.log(`訳し漏れ：${need.size}`);
for (const [k, w] of need) console.log(`  [${w}] ${JSON.stringify(k)}`);
process.exit(1);
