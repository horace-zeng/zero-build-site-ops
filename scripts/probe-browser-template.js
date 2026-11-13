/* probe-browser-template.js — 浏览器探针模板（同一套断言跑 http:// 与 file:// 两遍）
 *
 * 为什么必须两遍：零构建静态站要在 `file://` 下也能双击打开。
 * `file://` 里 CSSOM 是 opaque、`fetch()` 被 CORS 挡（Origin=null）、ES Module 不可用 ——
 * 很多在 http 下过得去的写法，在 file 下直接白屏。只测 http 等于没测这个前提。
 *
 * 用法：
 *   set NODE_PATH=<全局 node_modules>        # Windows PowerShell
 *   node probe-browser-template.js [站点根目录] [--shots <目录>]
 *
 * 依赖 Playwright（`require('playwright')`）。没有就装：`npm i -g playwright`。
 *
 * 退出码：0 = 全绿；1 = 有断言红；2 = 脚本自身崩了（区别于断言红，很重要）。
 *
 * ⚠ 五条纪律：
 *   · 不许吞异常 —— `try{}catch{}` 会让整套件静默地测十几轮死数据；
 *   · 等状态，不用固定 sleep —— 固定 sleep 在负载高时必假红；
 *   · 测量前先确认元素有非零宽度；零宽优先判为**探针**问题，不是源码问题；
 *   · 存在性 ≠ 可见性 —— 「在 DOM 里」不等于「没被 clip-path 裁掉」，后者要量几何；
 *   · 探针不采信页面自报的数，每个断言从原始数据独立重算。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const argv = process.argv.slice(2);
const SHOTS = (() => { const i = argv.indexOf('--shots'); return i >= 0 ? argv[i + 1] : null; })();
const SITE = path.resolve(argv.find((a, i) => !a.startsWith('--') && a !== SHOTS) || '.');
const ENTRY = ['index.html', 'index.htm'].find(n => fs.existsSync(path.join(SITE, n)));

// ╔══════════════════════════════════════════════════════════════╗
// ║  只改这一段：填你要断言的目标                                  ║
// ╚══════════════════════════════════════════════════════════════╝
const TARGETS = [
    // { name: '站点标题', selector: 'header h1' },
    // { name: '主内容区', selector: 'main' },
    // { name: '入口卡', selector: '[data-card]' },
];
// ╔══════════════════════════════════════════════════════════════╗
// ║  以下不用改                                                    ║
// ╚══════════════════════════════════════════════════════════════╝

const MIME = {
    '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
    '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
    '.mp4': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
};

const toFileUrl = abs => 'file:///' + abs.replace(/\\/g, '/').replace(/^\/+/, '');

function startServer(port) {
    const srv = http.createServer((rq, rs) => {
        let p = decodeURIComponent(rq.url.split('?')[0].split('#')[0]);
        if (p === '/') p = '/' + ENTRY;
        const abs = path.join(SITE, p);
        if (!abs.startsWith(SITE)) { rs.writeHead(403).end('forbidden'); return; }
        fs.readFile(abs, (err, buf) => {
            if (err) { rs.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 ' + p); return; }
            rs.writeHead(200, {
                'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream',
                'Content-Length': buf.length,
                'Access-Control-Allow-Origin': '*',
            });
            rs.end(buf);
        });
    });
    return new Promise((res, rej) => {
        srv.once('error', rej);
        srv.listen(port, '127.0.0.1', () => res(srv));
    });
}

async function main() {
    if (!ENTRY) { console.error('FATAL 找不到入口 HTML（index.html / index.htm）'); process.exit(2); }

    let chromium;
    try { ({ chromium } = require('playwright')); }
    catch (e) {
        console.error('FATAL 需要 Playwright：npm i -g playwright');
        console.error('如有全局安装，先设 NODE_PATH。原始错误: ' + e.message.split('\n')[0]);
        process.exit(2);
    }

    const PORT = 8801;
    const srv = await startServer(PORT);
    const baseHttp = 'http://127.0.0.1:' + PORT + '/' + ENTRY;
    const baseFile = toFileUrl(path.join(SITE, ENTRY));

    const browser = await chromium.launch({ channel: 'chrome' }).catch(() => chromium.launch());
    const results = [];
    let pass = 0, fail = 0;

    for (const proto of ['http', 'file']) {
        const url = proto === 'http' ? baseHttp : baseFile;
        const tag = '[' + proto + ']';
        console.log('\n── ' + proto + ' ──  ' + url);

        const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const page = await ctx.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push('pageerror: ' + String(e)));
        page.on('console', m => {
            if (m.type() !== 'error') return;
            const txt = m.text();
            // ⚠ 资源加载失败（404 的 favicon / 图片 / 字体、外部 CDN 超时）**不是 JS 运行时错误**。
            //   实测：http 下缺 favicon 会打一条 "Failed to load resource"，
            //   而 file:// 下不会 —— 不滤掉的话「双协议一致性」这条会稳定假红，
            //   而且它跟实现对错完全无关。站内**脚本**的报错仍然照收（那不是这个前缀）。
            if (/Failed to load resource|net::ERR_|ERR_FILE_NOT_FOUND|ERR_CONNECTION_/i.test(txt)) return;
            errors.push('console: ' + txt);
        });

        const ok = (cond, msg, extra) => {
            if (cond) { pass++; console.log('  PASS  ' + tag + ' ' + msg); }
            else { fail++; console.log('  FAIL  ' + tag + ' ' + msg + (extra !== undefined ? '  <<< ' + extra : '')); }
        };

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

            // A. 加载完成
            const ready = await page.evaluate(() => document.readyState);
            ok(ready === 'interactive' || ready === 'complete', '文档加载完成（readyState=' + ready + '）');

            // B. 没有运行时错误（这是最能抓到「file:// 下白屏」的一条）
            ok(errors.length === 0, '没有 JS 运行时错误', errors.slice(0, 3).join(' | '));

            // C. 目标存在且**有非零几何**（存在性 ≠ 可见性）
            for (const t of TARGETS) {
                const box = await page.evaluate(sel => {
                    const el = document.querySelector(sel);
                    if (!el) return null;
                    const r = el.getBoundingClientRect();
                    const cs = getComputedStyle(el);
                    return { w: r.width, h: r.height, display: cs.display, visibility: cs.visibility, opacity: cs.opacity };
                }, t.selector);

                if (!box) { ok(false, t.name + ' 存在（' + t.selector + '）', 'DOM 里找不到'); continue; }
                ok(box.w > 0 && box.h > 0,
                    t.name + ' 有非零几何（' + Math.round(box.w) + '×' + Math.round(box.h) + '）',
                    box.w + '×' + box.h);
                ok(box.display !== 'none' && box.visibility !== 'hidden' && +box.opacity > 0,
                    t.name + ' 未被隐藏（display/visibility/opacity）',
                    JSON.stringify(box));
            }

            // D. 截图留档
            if (SHOTS) {
                fs.mkdirSync(SHOTS, { recursive: true });
                const f = path.join(SHOTS, proto + '-viewport.png');
                await page.screenshot({ path: f });
                console.log('  截图: ' + f);
            }

            results.push({ proto, errors: errors.length, ok: true });
        } catch (e) {
            fail++;
            console.log('  FAIL  ' + tag + ' 页面处理异常: ' + String(e).split('\n')[0]);
            results.push({ proto, errors: -1, ok: false });
        } finally {
            await ctx.close();   // 不关会泄漏上下文，多轮之后浏览器会卡
        }
    }

    await browser.close();
    await new Promise(r => srv.close(r));

    // E. 双协议结果必须一致 —— 一红一绿说明差异在协议/环境，不在实现
    const httpR = results.find(r => r.proto === 'http');
    const fileR = results.find(r => r.proto === 'file');
    console.log('\n── 双协议一致性 ──');
    if (httpR && fileR) {
        const same = httpR.errors === fileR.errors;
        if (same) { pass++; console.log('  PASS  两个协议的错误数一致（各 ' + httpR.errors + '）'); }
        else {
            fail++;
            console.log('  FAIL  错误数不一致：http=' + httpR.errors + ' file=' + fileR.errors);
            console.log('        ⇒ 差异在**协议/环境**，不在实现。先按这个方向查，别去改源码。');
        }
    }

    console.log('\n' + '='.repeat(44));
    if (fail) { console.log('FAILED  ' + fail + ' 红 / ' + pass + ' 绿'); process.exit(1); }
    console.log('ALL PASS (' + pass + ')');
    process.exit(0);
}

main().catch(e => { console.error('FATAL', e); process.exit(2); });
