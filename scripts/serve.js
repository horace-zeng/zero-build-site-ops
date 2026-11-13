/* serve.js — 最小静态服务器（零依赖，for 本地预览与探针）
 *
 * 为什么需要：零构建站的目标是「双击就能开」，但 `file://` 有三个硬限制 ——
 * CSSOM 是 opaque、`fetch()` 被 CORS 挡（Origin=null）、ES Module 不可用。
 * 所以真正验收要跑一个 http 服务器；而现成的 `python -m http.server` 有两个坑：
 * MIME 缺项（`.mjs` 被当 octet-stream、视频被当下载）和没有 CORS 头。
 *
 * 用法：
 *   node serve.js [站点根目录] [端口]
 *   node serve.js . 8000
 *
 * 行为：
 *   /                → index.html（或 index.htm）
 *   /dir/            → dir/index.html
 *   未知扩展名        → application/octet-stream
 *   所有响应         → Access-Control-Allow-Origin: *
 *   OPTIONS          → 204（探针里跨源预检不会挂）
 *
 * ⚠ 长驻服务不要挂在带运行时长上限的后台任务里 —— 到点被回收、服务随之消失。
 *   独立进程启动：Start-Process / nohup / &。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(process.argv[2] || '.');
const PORT = +(process.argv[3] || process.env.PORT || 8000);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.cjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.xml': 'application/xml; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.wasm': 'application/wasm',
    '.zip': 'application/zip',
};

// 少数扩展名在磁盘上不是标准名字，浏览器却要求标准 MIME。
// 例如 Apple Live Photo 导出的 `.MOV` 内容是 H.264，标成 video/quicktime 时
// 部分浏览器不内联播放；标成 video/mp4 才走同一个播放路径。
const MIME_ALIAS = {
    '.mov': 'video/mp4',
};

function contentType(p) {
    const ext = path.extname(p).toLowerCase();
    return MIME_ALIAS[ext] || MIME[ext] || 'application/octet-stream';
}

function safeJoin(root, urlPath) {
    const abs = path.join(root, urlPath);
    // 目录穿越防护：解析后必须仍在 root 之内
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return abs;
}

const server = http.createServer((req, res) => {
    const cors = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': '*',
    };

    if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' }).end('405 method not allowed');
        return;
    }

    let p;
    try { p = decodeURIComponent(req.url.split('?')[0].split('#')[0]); }
    catch (_) { res.writeHead(400, cors).end('400 bad request'); return; }

    let abs = safeJoin(ROOT, p);
    if (!abs) { res.writeHead(403, { ...cors, 'Content-Type': 'text/plain' }).end('403 forbidden'); return; }

    fs.stat(abs, (err, st) => {
        if (!err && st.isDirectory()) {
            for (const idx of ['index.html', 'index.htm']) {
                const cand = path.join(abs, idx);
                if (fs.existsSync(cand)) return send(cand, res, cors, req);
            }
            return res.writeHead(404, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' })
                .end('404 目录下没有 index.html');
        }
        if (err) {
            return res.writeHead(404, { ...cors, 'Content-Type': 'text/plain; charset=utf-8' })
                .end('404 ' + p);
        }
        send(abs, res, cors, req);
    });
});

function send(abs, res, cors, req) {
    fs.readFile(abs, (err, buf) => {
        if (err) { res.writeHead(500, cors).end('500 read error'); return; }
        res.writeHead(200, {
            ...cors,
            'Content-Type': contentType(abs),
            'Content-Length': buf.length,
            // 本地预览不要缓存，否则改了看不出来
            'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') res.end(); else res.end(buf);
    });
}

server.on('error', e => {
    if (e.code === 'EADDRINUSE') {
        console.error('端口 ' + PORT + ' 已被占用 —— 换一个：node serve.js . ' + (PORT + 1));
        process.exit(2);
    }
    console.error('FATAL ' + e.message);
    process.exit(2);
});

server.listen(PORT, '127.0.0.1', () => {
    console.log('静态服务器已启动');
    console.log('  根目录: ' + ROOT);
    console.log('  地址:   http://127.0.0.1:' + PORT + '/');
    console.log('  CORS:   *    缓存: no-store');
    console.log('  Ctrl+C 停止');
});

process.on('SIGINT', () => { console.log('\n已停止'); server.close(() => process.exit(0)); });
