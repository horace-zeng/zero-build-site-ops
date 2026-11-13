/* lineendings.js — 行尾 / BOM / 编码形态的快照与比对（零依赖）
 *
 * 为什么有这个：零构建静态站最常见的自伤是「改一个文件顺手把行尾改了」。
 * 每个文件的形态是**约定**，不是风格；一旦被改坏，通常没有任何功能探针会红，
 * 只会在下一次发布或同步时炸。所以流程固定成：**改前快照 → 改 → 比对形态**。
 *
 * 用法：
 *   node lineendings.js report   <dir|file...>              列形态
 *   node lineendings.js snapshot <file...> --out <json>     记录形态（改前）
 *   node lineendings.js verify   <file...> --against <json> 比对形态（改后）
 *
 * 可选参数：
 *   --ext .html,.css,.js     只扫这些扩展名（report 用于目录时）
 *   --strict-counts          连行数差也算失败（少数「只允许增减固定行数」的场景）
 *
 * 判定口径（重要）：
 *   · 只比「形态」：BOM 序列长度 / 纯 CRLF / 纯 LF / 混合 / 末尾有无换行。
 *   · **不比行数、不比字节数** —— 改动本来就会让行数变，把行数写进断言会必然误报。
 *     行数差值照常打印出来供人看，但默认不作判定依据。
 *
 * 关于 BOM：这里数的是**连续 BOM 三字节组的个数**，不是「有没有 BOM」。
 *   一个文件的开头可能是 N 个连续 BOM。只判 boolean 的守卫，会把「N 个被合并成 1 个」判成 PASS。
 *
 * 退出码：0 = 形态一致；1 = 形态被改坏；2 = 用法错误。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
    '.git', 'node_modules', 'vendor', 'dist', 'build', '.cache', '.next',
    '.trash', '.probes', '.work', '.backup', '.export',
]);
const DEFAULT_EXTS = ['.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.xml', '.svg'];

function formOf(file) {
    const buf = fs.readFileSync(file);

    // BOM 序列长度（不是 boolean）
    let bomRun = 0;
    for (let i = 0; i + 2 < buf.length; i += 3) {
        if (buf[i] === 0xef && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf) bomRun++;
        else break;
    }
    const bom = bomRun > 0;

    const s = buf.toString('utf8');
    const crlf = (s.match(/\r\n/g) || []).length;
    const bareLF = (s.match(/(?<!\r)\n/g) || []).length;
    const endsWithNewline = s.length > 0 && (s.endsWith('\n') || s.endsWith('\r'));
    const shape = crlf > 0 && bareLF > 0 ? 'MIXED' : crlf > 0 ? 'CRLF' : bareLF > 0 ? 'LF' : 'NONE';

    // 编码合法性（不是 UTF-8 的话，上面所有计数都不可信）
    let utf8 = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) { utf8 = false; }

    return { bom, bomRun, crlf, bareLF, shape, endsWithNewline, utf8, bytes: buf.length, lines: s.split('\n').length };
}

function walk(target, exts, out) {
    const st = fs.statSync(target);
    if (st.isFile()) {
        if (!exts.length || exts.includes(path.extname(target).toLowerCase())) out.push(target);
        return;
    }
    for (const e of fs.readdirSync(target, { withFileTypes: true })) {
        if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue;
        walk(path.join(target, e.name), exts, out);
    }
}

function parseArgs(argv) {
    const out = { mode: argv[0], targets: [], exts: [], out: null, against: null, strict: false };
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') out.out = argv[++i];
        else if (a === '--against') out.against = argv[++i];
        else if (a === '--strict-counts') out.strict = true;
        else if (a === '--ext') out.exts = argv[++i].split(',').map(s => s.trim().toLowerCase());
        else out.targets.push(a);
    }
    if (!out.exts.length) out.exts = DEFAULT_EXTS;
    return out;
}

const shortShape = f =>
    (f.bomRun ? 'BOMx' + f.bomRun + ' ' : '--- ') +
    f.shape.padEnd(5) +
    (f.endsWithNewline ? ' EOL' : ' noEOL') +
    (f.utf8 ? '' : ' NOT-UTF8');

const a = parseArgs(process.argv.slice(2));

if (a.mode === 'report') {
    if (!a.targets.length) { console.error('用法: node lineendings.js report <dir|file...>'); process.exit(2); }
    const files = [];
    for (const t of a.targets) walk(t, a.exts, files);
    files.sort();
    console.log('文件'.padEnd(42) + '形态'.padEnd(26) + 'CRLF'.padStart(7) + '裸LF'.padStart(7) + '字节'.padStart(11));
    console.log('-'.repeat(93));
    for (const f of files) {
        const g = formOf(f);
        console.log(path.basename(f).padEnd(42) + shortShape(g).padEnd(26) +
            String(g.crlf).padStart(7) + String(g.bareLF).padStart(7) + String(g.bytes).padStart(11));
    }
    const tally = {};
    for (const f of files) { const g = formOf(f); tally[g.shape] = (tally[g.shape] || 0) + 1; }
    console.log('\n共 ' + files.length + ' 个文件。  ' +
        Object.entries(tally).map(([k, v]) => k + '=' + v).join(' / '));
    const noEol = files.filter(f => !formOf(f).endsWithNewline).length;
    const bommed = files.filter(f => formOf(f).bomRun > 0).length;
    console.log('末尾无换行 ' + noEol + ' 个 / 带 BOM ' + bommed + ' 个');
    process.exit(0);
}

if (a.mode === 'snapshot') {
    if (!a.targets.length || !a.out) {
        console.error('用法: node lineendings.js snapshot <file...> --out <json>');
        process.exit(2);
    }
    const files = {};
    for (const t of a.targets) files[path.resolve(t)] = formOf(t);
    fs.writeFileSync(a.out, JSON.stringify(files, null, 1), 'utf8');
    console.log('已记录 ' + Object.keys(files).length + ' 个文件的形态 → ' + a.out);
    process.exit(0);
}

if (a.mode === 'verify') {
    if (!a.targets.length || !a.against) {
        console.error('用法: node lineendings.js verify <file...> --against <json>');
        process.exit(2);
    }
    const snap = JSON.parse(fs.readFileSync(a.against, 'utf8'));
    let bad = 0;
    for (const t of a.targets) {
        const key = path.resolve(t);
        const before = snap[key];
        if (!before) { console.log('  SKIP  ' + t + ' (不在快照里)'); continue; }
        const after = formOf(t);
        const diffs = [];

        if (after.bomRun !== before.bomRun) {
            diffs.push('BOM 序列长度 ' + before.bomRun + '→' + after.bomRun + ' 个三字节组');
        }
        if (after.shape !== before.shape) diffs.push('形态 ' + before.shape + '→' + after.shape);
        if (after.endsWithNewline !== before.endsWithNewline) {
            diffs.push('末尾换行 ' + before.endsWithNewline + '→' + after.endsWithNewline);
        }
        if (!after.utf8) diffs.push('不再是合法 UTF-8');

        const dCrlf = after.crlf - before.crlf;
        const dBare = after.bareLF - before.bareLF;
        if (a.strict) {
            if (dCrlf !== 0) diffs.push('CRLF 行数 ' + (dCrlf > 0 ? '+' : '') + dCrlf);
            if (dBare !== 0) diffs.push('裸LF 行数 ' + (dBare > 0 ? '+' : '') + dBare);
        }

        const tag = diffs.length ? '  FAIL  ' : '  PASS  ';
        if (diffs.length) bad++;
        console.log(tag + path.basename(t) +
            (diffs.length
                ? ' :: ' + diffs.join('; ')
                : ' :: ' + shortShape(after) +
                  ' (CRLF ' + (dCrlf > 0 ? '+' : '') + dCrlf +
                  ' / 裸LF ' + (dBare > 0 ? '+' : '') + dBare + '，仅供参照)'));
    }
    console.log('\n' + (bad ? '✗ ' + bad + ' 个文件的形态被改坏' : '✓ 形态一致'));
    process.exit(bad ? 1 : 0);
}

console.error('用法: node lineendings.js <report|snapshot|verify> ...');
process.exit(2);
