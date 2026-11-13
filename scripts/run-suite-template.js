/* run-suite-template.js — 回归跑批器模板（串行 + 落盘 + 续跑 + 失败重跑 + 抖动标记）
 *
 * 一次跑一批探针，判整体没坏。要做的只有一件事：**在下面 SUITES 里填你的探针清单**。
 *
 * 用法：
 *   node run-suite-template.js                        # 全量（默认续跑）
 *   node run-suite-template.js --log suite.log        # 指定日志
 *   node run-suite-template.js --fresh                # 忽略已有日志，从头跑
 *   node run-suite-template.js --only a,b             # 只跑某几套
 *
 * 五条来自实战的设计（每一条都对应一次踩坑）：
 *   · **串行**：多套浏览器/重进程同开会互抢 CPU，计时失真且偶发假红；
 *   · **每套跑完立刻 append 落盘**：Node 会缓冲到 64 KB，进程被强制杀掉时日志是空的，
 *     跑了多久、跑到第几套、哪套红了全部丢失；
 *   · **支持续跑**：日志里已记 DONE 的跳过，改完再跑同一路径即增量验证；
 *   · **失败自动重跑一次**：重跑仍红才算真失败；**保留首跑失败行**，
 *     否则「首跑为什么红」就彻底丢了，没法追因；
 *   · **抖动单独标出**：首跑红 + 重跑绿 = 抖动，不藏起来，也不混进真失败里。
 *
 * 判红的坑：不要用 `out.match(/^FAIL/gm)` 去数 —— 它返回的是**匹配串**（全是 "FAIL"）不是行，
 * 对它做行级过滤根本不生效，于是「FAIL = 0」这条汇总行会被算成一条 FAIL。要先 split 再筛。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ╔══════════════════════════════════════════════════════════════╗
// ║  只改这一段：填你的探针清单                                    ║
// ╚══════════════════════════════════════════════════════════════╝
const SITE = path.resolve(__dirname, '..');          // 站点根目录
const SUITES = [
    // ['_probe_static.js',   '静态结构：目录 / 链接 / 孤儿资源'],
    // ['_probe_a11y.js',     '可访问性：键盘路径 / aria'],
    // ['_probe_modal.js',    '模态：开合 / 焦点 / 双协议'],
];

// 每套的超时（毫秒）。超过即判失败，不要让一套挂死拖住整批。
const TIMEOUT_MS = 10 * 60 * 1000;
// ╔══════════════════════════════════════════════════════════════╗
// ║  以下不用改                                                    ║
// ╚══════════════════════════════════════════════════════════════╝

const argv = process.argv.slice(2);
const get = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : dflt;
};
const LOG = path.resolve(get('--log', path.join(__dirname, 'suite.log')));
const FRESH = argv.includes('--fresh');
const ONLY = (get('--only', '') || '').split(',').map(s => s.trim()).filter(Boolean);

if (!SUITES.length) {
    console.error('SUITES 是空的 —— 先在文件顶部填至少一套探针。');
    process.exit(2);
}

// ── 读已有日志，算出要跳过哪些 ────────────────────────────────
function readDone() {
    if (FRESH || !fs.existsSync(LOG)) return new Set();
    const done = new Set();
    for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
        const m = /^(?:DONE|FAIL)\s+(\S+)/.exec(line.trim());
        if (m) done.add(m[1]);
    }
    return done;
}

/** 从一次运行的 stdout 里数真失败行（必须先 split 再筛） */
function countFailLines(out) {
    return out.split('\n').filter(l => /^FAIL/.test(l) && !/^FAIL\s*[=:]\s*\d/.test(l)).length;
}

function runOne(name) {
    const file = path.join(__dirname, name);
    if (!fs.existsSync(file)) {
        return { name, exit: 127, secs: 0, out: 'FATAL 找不到 ' + file, missing: true };
    }
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [file], {
        cwd: SITE,
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
        env: process.env,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const out = (r.stdout || '') + (r.stderr || '');
    // timeout 时 status 为 null 且 signal 为 SIGTERM
    const exit = r.status === null ? (r.signal === 'SIGTERM' ? 124 : 125) : r.status;
    return { name, exit, secs, out };
}

const isRed = r => r.exit !== 0 || countFailLines(r.out) > 0;

function append(line) {
    // 立刻落盘：不要攒着，进程被杀时缓冲全丢
    fs.appendFileSync(LOG, line + '\n', 'utf8');
}

// ── 主流程 ────────────────────────────────────────────────────
const done = readDone();
const todo = SUITES.filter(([name]) => (ONLY.length ? ONLY.includes(name.replace(/\.js$/, '')) || ONLY.includes(name) : true))
    .filter(([name]) => !done.has(name));

console.log('站点: ' + SITE);
console.log('日志: ' + LOG + (FRESH ? '  (--fresh，已清空)' : ''));
if (FRESH && fs.existsSync(LOG)) fs.writeFileSync(LOG, '', 'utf8');
console.log('套件 ' + SUITES.length + ' 套，本次要跑 ' + todo.length + ' 套（跳过已跑 ' + (SUITES.length - todo.length) + '）\n');

append('# START ' + new Date().toISOString() + ' · 套件 ' + SUITES.length + ' · 跳过已跑 ' + done.size);

const results = [];
for (let i = 0; i < todo.length; i++) {
    const [name, desc] = todo[i];
    process.stdout.write('[' + (i + 1) + '/' + todo.length + '] ' + name.padEnd(34));

    let r = runOne(name);
    let jitter = false;

    if (isRed(r) && !r.missing) {
        // 失败重跑一次：重跑绿 = 抖动；仍红 = 真失败
        process.stdout.write(' 红 → 重跑 ');
        const first = r;
        r = runOne(name);
        if (!isRed(r)) jitter = true;
        else { r.firstFail = first; }
    }

    const tag = r.exit === 124 ? 'TIMEOUT' : (r.missing ? 'MISSING' : (isRed(r) ? 'FAIL' : 'DONE'));
    console.log(tag + '  ' + r.secs + 's' + (jitter ? '  (抖动：首跑红、重跑绿)' : ''));

    append(tag + ' ' + name + ' exit=' + r.exit + ' ' + r.secs + 's' + (jitter ? ' JITTER' : ''));
    if (isRed(r) || jitter) {
        const src = jitter ? (r.firstFail || r).out : r.out;
        const fails = src.split('\n').filter(l => /^FAIL/.test(l) && !/^FAIL\s*[=:]\s*\d/.test(l));
        for (const l of fails.slice(0, 12)) append('   | ' + l.trim());
        const tail = src.split('\n').filter(Boolean).slice(-6);
        for (const l of tail) append('   # ' + l.trim());
    }

    results.push({ name, desc, ...r, jitter, red: isRed(r) });
}

const realFail = results.filter(r => r.red && !r.jitter);
const jitters = results.filter(r => r.jitter);

append('# END ' + new Date().toISOString() + ' · 失败 ' + realFail.length + ' / ' + todo.length);

// ── 汇总 ──────────────────────────────────────────────────────
console.log('\n' + '='.repeat(52));
if (realFail.length) {
    console.log('真失败 ' + realFail.length + ' 套：');
    for (const r of realFail) console.log('  ✗ ' + r.name + ' (exit=' + r.exit + ') — ' + r.desc);
}
if (jitters.length) {
    console.log('抖动 ' + jitters.length + ' 套（首跑红 / 重跑绿，不是回归）：');
    for (const r of jitters) console.log('  ~ ' + r.name + ' — ' + r.desc);
}
if (!realFail.length && !jitters.length) console.log('全绿 ' + results.length + ' 套');
else if (!realFail.length) console.log('\n没有真失败，只有抖动。日志保留了两轮的失败行供追因。');

process.exit(realFail.length ? 1 : 0);
