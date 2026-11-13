/* probe-template.js — 静态探针模板（开箱即用，也可以当起点改）
 *
 * 这是「静态探针」的骨架：不启浏览器，直接读磁盘，秒级，退出码 0 = 绿。
 *
 * 用法：
 *   node probe-template.js <站点根目录>
 *
 * 开箱就查四件**任何零构建静态站都该查**的事：
 *   ① 入口 HTML 在不在（自动找 index.html，找不到就报错）
 *   ② 所有本地 <link href> / <script src> 指向的文件确实存在 —— **大小写敏感**比对
 *      （Windows 通过、Linux 线上 404 是经典事故）
 *   ③ 同一个资源没有被重复引入
 *   ④ 文本文件里没有本机绝对路径（会连带泄露用户名）
 *
 * 要加自己的断言，就在「自定义断言区」照 ok(...) 的样子往下写。
 *
 * ⚠ 三条纪律（写探针时最容易违反的）：
 *   · 断言必须能对**它声称验证的事**失败 —— 比较的东西与 bug 无关就是仪式；
 *   · 禁止写死会增长的计数，改关系式（「底图键数 === 路线场数」而不是「16 场」）；
 *   · 探针不采信页面自报的数，每个断言从原始数据独立重算。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(process.argv[2] || '.');

// ── 断言骨架 ──────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(cond, msg, extra) {
    if (cond) { pass++; console.log('  PASS  ' + msg); }
    else { fail++; console.log('  FAIL  ' + msg + (extra !== undefined ? '  <<< ' + extra : '')); }
}
function fatal(msg) { console.error('FATAL ' + msg); process.exit(2); }

const read = p => fs.readFileSync(p, 'utf8');
const exists = p => { try { fs.accessSync(p); return true; } catch (_) { return false; } };

/** 大小写敏感的存在性检查：逐字比对目录项，而不是交给不敏感的文件系统 */
function existsExact(absPath) {
    const dir = path.dirname(absPath);
    const base = path.basename(absPath);
    try {
        return fs.readdirSync(dir).includes(base);
    } catch (_) {
        return false;
    }
}

function walk(dir, out, skip) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (skip.has(e.name) || e.name.startsWith('.')) continue;
            walk(path.join(dir, e.name), out, skip);
        } else {
            out.push(path.join(dir, e.name));
        }
    }
    return out;
}

// ── 开始 ──────────────────────────────────────────────────────
console.log('静态探针 @ ' + ROOT + '\n');

if (!exists(ROOT)) fatal('目录不存在: ' + ROOT);

// ① 入口
const ENTRY = ['index.html', 'index.htm'].find(n => exists(path.join(ROOT, n)));
if (!ENTRY) fatal('找不到入口 HTML（index.html / index.htm）');
console.log('入口: ' + ENTRY);
ok(true, '入口 HTML 存在');

const html = read(path.join(ROOT, ENTRY));

// ② 本地引用完整性 + ③ 重复引入
console.log('\n── 引用完整性 ──');
const refs = [];
for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) refs.push(['script', m[1]]);
for (const m of html.matchAll(/<link[^>]*\shref="([^"]+)"/g)) refs.push(['link', m[1]]);

const local = refs.filter(([, u]) => !/^(https?:)?\/\//.test(u) && !u.startsWith('data:'));
ok(local.length > 0, '至少有一条本地引用（共 ' + local.length + ' 条）', local.length);

let missing = 0;
for (const [tag, u] of local) {
    const clean = u.split('?')[0].split('#')[0];
    const abs = path.join(ROOT, clean);
    if (!existsExact(abs)) {
        missing++;
        console.log('  FAIL  [' + tag + '] 找不到（大小写敏感）: ' + u);
    }
}
ok(missing === 0, '全部本地引用在磁盘上存在（大小写敏感）', missing + ' 条缺失');

const seen = new Map();
let dup = 0;
for (const [, u] of local) {
    seen.set(u, (seen.get(u) || 0) + 1);
}
for (const [u, n] of seen) if (n > 1) { dup++; console.log('  FAIL  重复引入 ' + n + ' 次: ' + u); }
ok(dup === 0, '没有重复引入同一资源', dup + ' 处重复');

// ④ 本机绝对路径
console.log('\n── 泄露面 ──');
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.xml', '.svg']);
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'assets_img']);
const files = walk(ROOT, [], SKIP).filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()));

const ABS_RX = /(?:[A-Za-z]:\\Users\\[^\\\s"'<>]+)|(?:\/Users\/[^\/\s"'<>]+)|(?:\/home\/[^\/\s"'<>]+)/g;
let absHits = 0;
for (const f of files) {
    const hits = [...new Set((read(f).match(ABS_RX) || []))];
    if (!hits.length) continue;
    absHits++;
    console.log('  FAIL  ' + path.relative(ROOT, f) + ' 含本机绝对路径: ' + hits.slice(0, 2).join(' | '));
}
ok(absHits === 0, '没有文件泄露本机绝对路径', absHits + ' 个文件');

// ── 自定义断言区 ──────────────────────────────────────────────
// 在这里加你这个站点特有的断言。示例：
//
// const data = read(path.join(ROOT, 'data.js'));
// ok(/^var DATA\s*=/.test(data), 'data.js 以 var DATA = 开头');
// ok(!/\bTODO\b/.test(data), 'data.js 里没有遗留 TODO');
//
// ⚠ 别写 ok(data.length > 0, '数据非空') 这种 —— 它对几乎所有 bug 都恒真。

// ── 汇总 ──────────────────────────────────────────────────────
console.log('\n' + '='.repeat(42));
if (fail) {
    console.log('FAILED  ' + fail + ' 红 / ' + pass + ' 绿');
    process.exit(1);
}
console.log('ALL PASS (' + pass + ')');
process.exit(0);
