/* ratchet-template.js — 棘轮模板：防退化计数 + 禁用集合双重断言（零依赖）
 *
 * 「棘轮」= 只允许朝一个方向转的断言。它防的不是「现在对不对」，而是「以后悄悄变少 / 变回去」。
 *
 * 用法：
 *   node ratchet-template.js baseline <站点根目录> --out ratchet.json     # 建立基线
 *   node ratchet-template.js check    <站点根目录> --against ratchet.json # 比对
 *   node ratchet-template.js set      <站点根目录>                        # 只跑禁用集合
 *
 * 查两件事：
 *   ① **计数**：按扩展名的文件数与字节数。比基线**变少** = FAIL（东西被删了）。
 *   ② **集合**：禁止出现的模式（本机绝对路径 / 明文邮箱 / 占位符遗留）**一个都不许有**。
 *
 * ⚠ 三条来自实战的注意：
 *   · 基线是**快照**，不追移动目标 —— 并发改动在途时计数自己会变，此时别同步基线，等收工后一次性校准；
 *   · **「用户拍板的锁」不是基线**：例如「某类声明必须为 0」，那是需求不是现状，抬它要用户点头；
 *   · 白名单要**从原始备份自动推导**，手写会漏。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'dist', 'build', '.cache', '.next', '.work', '.trash']);
const COUNT_EXT = ['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.svg', '.json'];
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.xml', '.svg', '.yml', '.yaml']);

// 禁用集合：这些模式出现即 FAIL
const FORBIDDEN = [
    { id: 'abs-path', label: '本机绝对路径', rx: /(?:[A-Za-z]:\\Users\\[^\\\s"'<>]+)|(?:\/Users\/[^\/\s"'<>]+)|(?:\/home\/[^\/\s"'<>]+)/g },
    { id: 'email', label: '明文邮箱', rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
    // 你自己的占位符遗留，按需加：
    // { id: 'todo', label: '未填的占位符', rx: /\b(TODO|FIXME|XXX|待补|待确认)\b/g },
];

// ── 参数 ──────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const mode = argv[0];
let root = '.', out = null, against = null;
for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i] === '--against') against = argv[++i];
    else if (!argv[i].startsWith('--')) root = argv[i];
}
root = path.resolve(root);

let pass = 0, fail = 0;
const ok = (c, m, x) => {
    if (c) { pass++; console.log('  PASS  ' + m); }
    else { fail++; console.log('  FAIL  ' + m + (x !== undefined ? '  <<< ' + x : '')); }
};

function walk(dir, out2) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out2; }
    for (const e of entries) {
        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            walk(path.join(dir, e.name), out2);
        } else {
            out2.push(path.join(dir, e.name));
        }
    }
    return out2;
}

function measure() {
    const files = walk(root, []);
    const counts = {}, bytes = {};
    let totalFiles = 0, totalBytes = 0;
    for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        let size = 0;
        try { size = fs.statSync(f).size; } catch (_) {}
        totalFiles++; totalBytes += size;
        if (!COUNT_EXT.includes(ext)) continue;
        counts[ext] = (counts[ext] || 0) + 1;
        bytes[ext] = (bytes[ext] || 0) + size;
    }
    return { counts, bytes, totalFiles, totalBytes };
}

function checkSet() {
    const files = walk(root, []).filter(f => TEXT_EXT.has(path.extname(f).toLowerCase()));
    let bad = 0;
    for (const p of FORBIDDEN) {
        const hits = [];
        for (const f of files) {
            let text;
            try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
            if (/@(example\.(com|org|net)|localhost)$/i.test('')) { /* noop */ }
            const found = [...new Set(text.match(p.rx) || [])]
                .filter(h => !/@(example\.(com|org|net)|localhost|test\.local)$/i.test(h));
            if (found.length) hits.push({ file: path.relative(root, f), found: found.slice(0, 2) });
        }
        if (hits.length) {
            bad++;
            console.log('  FAIL  [' + p.label + '] ' + hits.length + ' 个文件命中');
            for (const h of hits.slice(0, 5)) console.log('          ' + h.file + ' → ' + h.found.join(' | '));
        } else {
            console.log('  PASS  [' + p.label + '] 0 处');
        }
    }
    return bad;
}

// ── 执行 ──────────────────────────────────────────────────────
if (!fs.existsSync(root)) { console.error('目录不存在: ' + root); process.exit(2); }

if (mode === 'baseline') {
    if (!out) { console.error('用法: node ratchet-template.js baseline <dir> --out <json>'); process.exit(2); }
    const m = measure();
    fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), root, ...m }, null, 1), 'utf8');
    console.log('基线已写入 ' + out);
    console.log('  ' + m.totalFiles + ' 个文件 / ' + m.totalBytes + ' B');
    for (const ext of COUNT_EXT) {
        if (m.counts[ext]) console.log('  ' + ext.padEnd(7) + m.counts[ext] + ' 个 / ' + m.bytes[ext] + ' B');
    }
    process.exit(0);
}

if (mode === 'check') {
    if (!against || !fs.existsSync(against)) {
        console.error('用法: node ratchet-template.js check <dir> --against <json>');
        process.exit(2);
    }
    const base = JSON.parse(fs.readFileSync(against, 'utf8'));
    const now = measure();

    console.log('── 计数棘轮（只许不减少）──');
    ok(now.totalFiles >= base.totalFiles,
        '文件总数未减少（' + base.totalFiles + ' → ' + now.totalFiles + '）',
        now.totalFiles < base.totalFiles ? '少了 ' + (base.totalFiles - now.totalFiles) + ' 个' : undefined);

    for (const ext of COUNT_EXT) {
        const b = base.counts[ext] || 0;
        const n = now.counts[ext] || 0;
        if (b === 0 && n === 0) continue;
        ok(n >= b, ext + ' 数量未减少（' + b + ' → ' + n + '）',
            n < b ? '少了 ' + (b - n) + ' 个' : undefined);
    }

    console.log('\n── 字节（参照，不作判定）──');
    const delta = now.totalBytes - base.totalBytes;
    console.log('  总计 ' + base.totalBytes + ' → ' + now.totalBytes + ' B  (' +
        (delta >= 0 ? '+' : '') + delta + ')');
    for (const ext of COUNT_EXT) {
        if (!base.bytes[ext] && !now.bytes[ext]) continue;
        const d = (now.bytes[ext] || 0) - (base.bytes[ext] || 0);
        console.log('  ' + ext.padEnd(7) + (base.bytes[ext] || 0) + ' → ' + (now.bytes[ext] || 0) + '  (' +
            (d >= 0 ? '+' : '') + d + ')');
    }

    console.log('\n── 禁用集合 ──');
    const bad = checkSet();
    ok(bad === 0, '禁用集合全部为 0', bad + ' 类命中');

    console.log('\n' + '='.repeat(42));
    if (fail) { console.log('FAILED  ' + fail + ' 红 / ' + pass + ' 绿'); process.exit(1); }
    console.log('ALL PASS (' + pass + ')');
    process.exit(0);
}

if (mode === 'set') {
    console.log('── 禁用集合 @ ' + root + ' ──');
    const bad = checkSet();
    ok(bad === 0, '禁用集合全部为 0', bad + ' 类命中');
    console.log('\n' + (fail ? 'FAILED' : 'ALL PASS (' + pass + ')'));
    process.exit(fail ? 1 : 0);
}

console.error('用法: node ratchet-template.js <baseline|check|set> <dir> [--out|--against <json>]');
process.exit(2);
