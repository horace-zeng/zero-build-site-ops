/* deploy-check.js — 线上 vs 本地一致性检查器（零依赖）
 *
 * 零构建站最常被误判的一类故障：「本地改了，线上还是旧的」。
 * 常见原因：只传了入口 HTML、CSS 忘了传、CDN 边缘缓存、或者干脆没上传。
 *
 * 这个工具逐文件比对**线上实际返回的字节**与本地磁盘上的字节：
 *   长度一致 + sha256 一致  → SAME
 *   长度不同                 → DIFF
 *   本地有、线上 404         → MISSING（没传上去）
 *   本地没有、线上 200       → EXTRA（该删没删 —— 内部文档泄露常见于此）
 *
 * 用法：
 *   node deploy-check.js <baseUrl> <本地根目录> [选项]
 *
 * 选项：
 *   --only a.js,b.css     只比这几个（相对路径，逗号分隔）
 *   --ext .html,.css,.js  比这些扩展名（默认常见几种）
 *   --skip-dirs assets,media   跳过这些顶层目录
 *   --quiet               只打问题
 *
 * 例：
 *   node deploy-check.js https://example.com . --ext .html,.css,.js
 *
 * 退出码：0 = 全部一致；1 = 有差异；2 = 用法/网络错误。
 *
 * ⚠ 两条纪律：
 *   · 比对线上文件**必须走二进制** —— 文本管道会把 UTF-8 当 Latin-1 解，差分结论全是假的；
 *   · 「文件逐字节相同」≠「浏览器实际拿到的那份相同」 —— 压缩分桶、CDN 边缘、协商缓存
 *     都可能让浏览器拿到的是旧副本。这个工具查的是**源站**，查不了边缘。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const flag = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const QUIET = argv.includes('--quiet');
const positional = [];
for (let i = 0; i < argv.length; i++) {
    if (['--only', '--ext', '--skip-dirs'].includes(argv[i])) { i++; continue; }
    if (argv[i].startsWith('--')) continue;
    positional.push(argv[i]);
}

const BASE = (positional[0] || '').replace(/\/+$/, '');
const ROOT = path.resolve(positional[1] || '.');
const ONLY = (flag('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);
const EXTS = (flag('--ext', '.html,.htm,.css,.js,.mjs,.cjs,.json,.xml,.txt,.svg') || '').split(',').map(s => s.trim().toLowerCase());
const SKIP_DIRS = new Set((flag('--skip-dirs', '') || '').split(',').map(s => s.trim()).filter(Boolean));

if (!BASE || !/^https?:\/\//.test(BASE)) {
    console.error('用法: node deploy-check.js <baseUrl> <本地根目录> [--ext ...] [--only ...]');
    process.exit(2);
}
if (!fs.existsSync(ROOT)) { console.error('本地目录不存在: ' + ROOT); process.exit(2); }

const sha = buf => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);

function fetchBuf(url, redirects = 0) {
    return new Promise(resolve => {
        const mod = url.startsWith('https:') ? https : http;
        const req = mod.get(url, { timeout: 20000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 3) {
                res.resume();
                const next = new URL(res.headers.location, url).href;
                return resolve(fetchBuf(next, redirects + 1));
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks), headers: res.headers }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ status: 0, buf: Buffer.alloc(0), error: 'timeout' }); });
        req.on('error', e => resolve({ status: 0, buf: Buffer.alloc(0), error: e.code || String(e) }));
    });
}

function collect(dir, acc) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name.startsWith('.')) continue;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            collect(abs, acc);
        } else {
            if (!EXTS.includes(path.extname(e.name).toLowerCase())) continue;
            acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
        }
    }
    return acc;
}

(async () => {
    const rel = ONLY.length ? ONLY : collect(ROOT, []);
    rel.sort();

    console.log('线上源: ' + BASE);
    console.log('本地根: ' + ROOT);
    console.log('比对 ' + rel.length + ' 个文件\n');

    const rows = [];
    for (const r of rel) {
        const localAbs = path.join(ROOT, r);
        const localBuf = fs.existsSync(localAbs) ? fs.readFileSync(localAbs) : null;
        const remote = await fetchBuf(BASE + '/' + encodeURI(r));

        let verdict;
        if (!localBuf) verdict = remote.status === 200 ? 'EXTRA' : 'GONE';
        else if (remote.status === 404) verdict = 'MISSING';
        else if (remote.status !== 200) verdict = 'ERROR(' + (remote.error || remote.status) + ')';
        else if (remote.buf.length !== localBuf.length) verdict = 'DIFF(len)';
        else if (sha(remote.buf) !== sha(localBuf)) verdict = 'DIFF(hash)';
        else verdict = 'SAME';

        rows.push({ file: r, verdict, localLen: localBuf ? localBuf.length : 0, remoteLen: remote.buf.length });
        if (!QUIET || verdict !== 'SAME') {
            console.log('  ' + verdict.padEnd(11) + r.padEnd(46) +
                String(rows[rows.length - 1].localLen).padStart(9) + ' → ' + String(remote.buf.length).padStart(9) + ' B');
        }
    }

    const same = rows.filter(r => r.verdict === 'SAME').length;
    const bad = rows.filter(r => r.verdict !== 'SAME');

    console.log('\n' + '='.repeat(56));
    console.log('一致 ' + same + ' / ' + rows.length);

    if (bad.length) {
        const byKind = {};
        for (const b of bad) (byKind[b.verdict] = byKind[b.verdict] || []).push(b.file);
        console.log('\n不一致 ' + bad.length + ' 个：');
        for (const [k, list] of Object.entries(byKind)) {
            console.log('  ' + k + ' (' + list.length + ')');
            for (const f of list.slice(0, 10)) console.log('    · ' + f);
            if (list.length > 10) console.log('    …还有 ' + (list.length - 10) + ' 个');
        }
        console.log('\n处理方向：');
        console.log('  MISSING / DIFF  → 没传或传了旧版。**只传入口 HTML 是不够的**，CSS/JS 要一起传。');
        console.log('  EXTRA           → 线上有、本地没有 ⇒ 该删没删。内部文档常在这里暴露。');
        console.log('  全部一致但仍看到旧页面 → 那是 CDN 边缘缓存，不是源站问题，去做刷新。');
        process.exit(1);
    }

    console.log('全部一致 ✓');
    console.log('提醒：这查的是**源站**。若浏览器仍看到旧内容，问题在 CDN 边缘或协商缓存。');
    process.exit(0);
})();
