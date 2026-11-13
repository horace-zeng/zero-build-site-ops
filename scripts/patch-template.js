/* patch-template.js — 定点替换模板（复制出去，只改 CONFIG 段即可用）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要模板
 * ══════════════════════════════════════════════════════════════════════
 * 零构建站的每个文件都有**约定的行尾形态**（BOM 序列 / 纯 CRLF / 纯 LF / 混合 / 末尾换行），
 * 这些形态一旦被改坏，**没有任何功能探针会红**，只会在下一次发布或同步时炸。
 * 所以规矩是：**绝不手工编辑行尾敏感文件**，一律写脚本定点替换。
 *
 * 这份模板把「定点替换脚本」必须有的七件事写死了：
 *   ① 二进制读盘 → 先量形态        ② 锚点全局唯一（0 或 >1 立刻中止）
 *   ③ 所有锚点在任何写盘之前预检完  ④ 幂等判据由作者显式声明（already）
 *   ⑤ 每条替换都断言「真的生效了」  ⑥ 写盘后回读校验
 *   ⑦ 形态门禁比净增量，不是「前后相同」
 *
 * ══════════════════════════════════════════════════════════════════════
 * 用法
 * ══════════════════════════════════════════════════════════════════════
 *   1. 复制本文件到你的补丁目录：
 *        cp "<skill>/scripts/patch-template.js" <补丁目录>/<序号>_<动词>_<主题>.js
 *   2. 只改下面的「CONFIG」段：TARGET / EDITS / EXPECT
 *   3. 先干跑看断言，再正式跑：
 *        node <脚本> --dry     # 只验不写
 *        node <脚本>           # 真写
 *
 * ══════════════════════════════════════════════════════════════════════
 * 长文本怎么办
 * ══════════════════════════════════════════════════════════════════════
 * 长文（多行正文 / 含反引号或 ASCII 单引号的中文）**不要塞进 JS 字符串字面量** ——
 * 会被截断。做法是正文写独立 .txt，脚本读文件：
 *
 *   const CH = fs.readFileSync(path.join(__dirname, 'chapter.txt'), 'utf8')
 *       .replace(/\r/g, '').replace(/\n/g, '\r\n');   // 目标文件是 CRLF 就换成 CRLF
 */
'use strict';
const fs = require('fs');
const path = require('path');

// ╔══════════════════════════════════════════════════════════════════╗
// ║  CONFIG —— 只改这一段                                            ║
// ╚══════════════════════════════════════════════════════════════════╝

// 二选一：绝对路径，或相对脚本上一级
const TARGET = process.argv.find(a => a.startsWith('--target='))
    ? process.argv.find(a => a.startsWith('--target=')).slice(9)
    : path.resolve(__dirname, '..', 'index.html');   // ← 改成你的目标文件

/**
 * 每条编辑：{ find, replace, label, count?, already? }
 *   find    必须逐字取自磁盘（从文件里复制粘贴，不要凭记忆打）
 *   replace 替换成的文本；含 \n 时脚本会按目标文件的形态自动转成 \r\n
 *   label   打印用，写清「这处在说什么」
 *   count   省略 = 必须恰好命中 1 次；填 N = 必须恰好命中 N 次
 *   already **幂等判据**：一段能证明「上一次已落盘」的独特文本（要够长、够唯一）。
 *           命中 0 次时，只有它存在才判定为「已落盘」并跳过；不填则直接 FAIL。
 *           ⚠ 不要指望脚本拿 replace 自动去猜 —— 实测 replace 只有 1~2 个字符时
 *             会对原文件**误命中**，把「锚点失配」误判成「已落盘」，静默跳过还写了盘。
 */
const EDITS = [
    // {
    //     find: 'class="old-name"',
    //     replace: 'class="new-name"',
    //     label: '入口卡 class 换名',
    //     already: 'class="new-name" data-role="entry"',   // 够长够唯一的落地形态
    // },
];

/**
 * 形态门禁：写盘后的**净变化**必须与这里一致。填 null = 不检查该项。
 *   ⚠ 不要用「前后完全相同」当判据 —— 本轮本来就要加行时，那必然误报。
 *   ⚠ 也不要比行数本身，只比**净增量**。
 */
const EXPECT = {
    crlfDelta: null,        // 例：+1 表示本轮净增 1 个 CRLF
    bareDelta: null,        // 例：+1 表示目录区净增 1 个裸 LF
    endsWithNewline: null,  // true / false
};

// ╔══════════════════════════════════════════════════════════════════╗
// ║  机制 —— 以下不用改                                             ║
// ╚══════════════════════════════════════════════════════════════════╝

const DRY = process.argv.includes('--dry');
const GATE = [];
const ok = (cond, msg, extra) => {
    GATE.push(!!cond);
    console.log((cond ? '  PASS  ' : '  FAIL  ') + msg + (!cond && extra !== undefined ? '  <<< ' + extra : ''));
};

function formOf(s) {
    const buf = Buffer.from(s, 'utf8');
    let bomRun = 0;
    for (let i = 0; i + 2 < buf.length; i += 3) {
        if (buf[i] === 0xef && buf[i + 1] === 0xbb && buf[i + 2] === 0xbf) bomRun++;
        else break;
    }
    const crlf = (s.match(/\r\n/g) || []).length;
    const bare = (s.match(/(?<!\r)\n/g) || []).length;
    return {
        bomRun, crlf, bare,
        shape: crlf > 0 && bare > 0 ? 'MIXED' : crlf > 0 ? 'CRLF' : bare > 0 ? 'LF' : 'NONE',
        endsWithNewline: s.length > 0 && (s.endsWith('\n') || s.endsWith('\r')),
        bytes: buf.length,
    };
}
const shapeStr = f => 'BOMx' + f.bomRun + ' ' + f.shape + (f.endsWithNewline ? ' EOL' : ' noEOL');

console.log('目标: ' + TARGET);
console.log('模式: ' + (DRY ? '--dry（只验不写）' : '真写') + '\n');

if (!fs.existsSync(TARGET)) {
    console.error('找不到目标文件: ' + TARGET);
    process.exit(2);
}
if (!EDITS.length) {
    console.error('EDITS 是空的 —— 请先在 CONFIG 段填至少一条编辑。');
    process.exit(2);
}

let s = fs.readFileSync(TARGET, 'utf8');
const before = formOf(s);
const CRLF_DOMINANT = before.crlf > 0;
console.log('改前形态: ' + shapeStr(before) +
    '  (CRLF ' + before.crlf + ' / 裸LF ' + before.bare + ' / ' + before.bytes + ' B)\n');

// 目标文件是 CRLF 时，replace 里的 \n 要转成 \r\n（否则会造出混合行尾）
const fmt = txt => CRLF_DOMINANT ? txt.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : txt;

// ── ③ 所有锚点先全部预检，一行都不写 ────────────────────────────
console.log('── 锚点预检 ──');
const plan = [];
for (const e of EDITS) {
    if (!e || typeof e.find !== 'string' || !e.find) {
        ok(false, '"' + (e && e.label) + '" 的 find 不是非空字符串');
        continue;
    }
    const need = e.count === undefined ? 1 : e.count;
    const hits = s.split(e.find).length - 1;
    const to = fmt(e.replace === undefined ? '' : e.replace);

    if (hits === need) {
        ok(true, '命中 ' + hits + ' 次: ' + e.label);
        plan.push({ find: e.find, to, label: e.label, skip: false });
        continue;
    }

    // ④ 幂等：锚点没了，但**作者声明的** already 文本在（CRLF 与 LF 两种变体都查）
    if (hits === 0 && typeof e.already === 'string' && e.already) {
        if (s.includes(e.already) || s.includes(fmt(e.already))) {
            console.log('  SKIP  ' + e.label + ' —— 上一次已落盘（already 命中），跳过');
            plan.push({ find: e.find, to, label: e.label, skip: true });
            continue;
        }
    }

    const hint = hits === 0 ? '（锚点不在盘上；若上一轮已落盘，请填 already 声明判据）' : '';
    ok(false, '命中 ' + hits + ' 次（应为 ' + need + '）: ' + e.label + hint, JSON.stringify(e.find.slice(0, 60)));
}

if (GATE.some(x => !x)) {
    console.log('\n*** 锚点预检未通过，不写盘 ***');
    process.exit(1);
}

// ── ⑤ 依次应用，每条都断言「真的生效了」────────────────────────
console.log('\n── 应用替换 ──');
let applied = 0;
for (const p of plan) {
    if (p.skip) continue;
    const lenBefore = s.length;
    const next = s.split(p.find).join(p.to);
    if (next === s) {
        // 锚点唯一命中 ≠ 替换生效（历史上出现过脚本打印三次 ✅ 而文件一字未改）
        ok(false, '替换未生效（文本没变）: ' + p.label);
        break;
    }
    s = next;
    applied++;
    console.log('  OK    ' + p.label + '  (' + (s.length - lenBefore >= 0 ? '+' : '') + (s.length - lenBefore) + ' 字符)');
}
ok(applied > 0 || plan.every(p => p.skip), '至少一条替换真的生效了（或全部已落盘）');

// ── ⑦ 形态门禁：比净增量 ────────────────────────────────────────
const after = formOf(s);
console.log('\n── 形态门禁 ──');
console.log('  改前: ' + shapeStr(before));
console.log('  改后: ' + shapeStr(after));

ok(after.bomRun === before.bomRun,
    'BOM 序列长度不变（' + after.bomRun + ' 个三字节组）', before.bomRun + '→' + after.bomRun);
ok(after.shape === before.shape,
    '行尾形态不变（' + after.shape + '）', before.shape + '→' + after.shape);

const dCrlf = after.crlf - before.crlf;
const dBare = after.bare - before.bare;
if (EXPECT.crlfDelta !== null) {
    ok(dCrlf === EXPECT.crlfDelta, 'CRLF 净增 == ' + (EXPECT.crlfDelta >= 0 ? '+' : '') + EXPECT.crlfDelta, dCrlf);
} else {
    console.log('  ·     CRLF 净增 ' + (dCrlf >= 0 ? '+' : '') + dCrlf + '（未声明期望）');
}
if (EXPECT.bareDelta !== null) {
    ok(dBare === EXPECT.bareDelta, '裸LF 净增 == ' + (EXPECT.bareDelta >= 0 ? '+' : '') + EXPECT.bareDelta, dBare);
} else {
    console.log('  ·     裸LF 净增 ' + (dBare >= 0 ? '+' : '') + dBare + '（未声明期望）');
}
if (EXPECT.endsWithNewline !== null) {
    ok(after.endsWithNewline === EXPECT.endsWithNewline,
        '末尾换行 == ' + EXPECT.endsWithNewline, after.endsWithNewline);
}

if (GATE.some(x => !x)) {
    console.log('\n*** 有断言未过，不写盘 ***');
    process.exit(1);
}

// ── 写盘 + ⑥ 回读校验 ──────────────────────────────────────────
if (DRY) {
    console.log('\n--dry：断言全过，未写盘。');
    process.exit(0);
}
fs.writeFileSync(TARGET, s, 'utf8');
const back = fs.readFileSync(TARGET, 'utf8');
ok(back === s, '写盘后回读与内存副本一致');
if (back !== s) {
    console.log('\n*** 回读校验失败 ***');
    process.exit(1);
}
console.log('\n已写入 ' + TARGET + '  (' + formOf(back).bytes + ' B)');
process.exit(0);
