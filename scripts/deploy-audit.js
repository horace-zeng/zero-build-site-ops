/* deploy-audit.js — 发布前审计：这个目录发出去会泄露什么（零依赖，只读）
 *
 * 为什么有这个：零构建站的**工作目录就是部署根目录** —— 根目录下的一切都会被传上去。
 * 常见事故：内部决策文档 / 会话草稿 / 日志 / 备份文件被当静态文件发布出去，
 * 其中还含明文联系方式，并可能被搜索引擎收录。
 * 这类问题**没有任何功能探针会红** —— 页面完全正常，只是多送了几百 KB。
 *
 * 用法：
 *   node deploy-audit.js <站点根目录>
 *   node deploy-audit.js <站点根目录> --allow docs/spec.md,papers/*.pdf
 *   node deploy-audit.js <站点根目录> --quiet      # 只报问题
 *
 * 查四类：
 *   ① 不该发布的文件（内部文档 / 日志 / 备份 / 配置 / 密钥）
 *   ② 源码与注释里的**本机绝对路径**（泄露目录结构与用户名）
 *   ③ **明文邮箱**（在注释里也算）
 *   ④ 未在排除清单里登记的可疑文件
 *
 * 退出码：0 = 干净；1 = 有问题；2 = 用法错误。
 */
'use strict';
const fs = require('fs');
const path = require('path');

// 参数解析：显式挑出 flag 与它的值，剩下的第一个位置参数才是目录。
// ⚠ 不要用 `args.find(a => a !== args[args.indexOf('--allow')+1])` 这种写法 ——
//   `--allow` 不存在时 indexOf 返回 -1，args[0] 就被当成「allow 的值」排除掉，
//   结果 ROOT 落到当前工作目录，**扫错整个目录**（实测发生过）。
const args = process.argv.slice(2);
const FLAGS_WITH_VALUE = new Set(['--allow']);
const positional = [];
let allowRaw = '';
for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (FLAGS_WITH_VALUE.has(a)) { allowRaw = args[++i] || ''; continue; }
    if (a.startsWith('--')) continue;          // --quiet 等无值 flag
    positional.push(a);
}
const QUIET = args.includes('--quiet');
const ALLOW = allowRaw.split(',').map(s => s.trim()).filter(Boolean);
const ROOT = path.resolve(positional[0] || '.');
const ALLOW_RX = ALLOW.map(g => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'));

if (!fs.existsSync(ROOT)) {
    console.error('目录不存在: ' + ROOT);
    process.exit(2);
}

// ── ① 按文件名 / 扩展名判定：不该发布的东西 ──────────────────────
// 依据是「这类文件的用途」，不是某个项目的具体文件名。
const BAD_NAMES = [
    // 内部文档：决策记录、会话草稿、待办、导出备份
    /^(README|CHANGELOG|CONTRIBUTING|TODO|NOTES?|AGENTS|SESSION|WORKFLOW|PROJECT_?NOTES|BACKLOG|SCRATCH|DRAFT)([-_.].*)?\.(md|markdown|txt|rst|adoc)$/i,
    /\.(bak|orig|rej|swp|swo|tmp|temp|old|save|copy)$/i,
    /~$/,
    // 配置 / 凭据
    /^\.env(\..*)?$/i,
    /\.(pem|key|p12|pfx|crt|cer|jks|keystore)$/i,
    /^(id_rsa|id_dsa|id_ed25519)$/i,
    /^(\.npmrc|\.netrc|\.git-credentials|credentials|secrets?\.(json|ya?ml|toml))$/i,
    // 编辑器 / 系统垃圾
    /^\.(DS_Store|git|github|gitignore|gitattributes|editorconfig|vscode|idea|vscode-test)$/i,
    /^(Thumbs\.db|desktop\.ini)$/i,
    // 日志 / 转储
    /\.(log|log\.\d+|dump|trace|prof)$/i,
    // 构建产物（静态站通常不该提交）
    /\.(map)$/i,
];

// 这些目录整棵跳过（工具产物 / 版本控制）
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', '.cache', '.next', 'dist', 'build']);

// 这些目录通常是「内部工作区」，若在部署根目录下则应排除
const SUSPECT_DIRS = new Set([
    '.trash', '.probes', '.work', '.backup', '.export', '.scratch', 'scripts_dev',
    '_work', '_notes', '.notes', '.drafts',
]);

// 会被当作「文本」扫描的扩展名
const TEXT_EXT = new Set([
    '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.txt', '.md', '.xml', '.svg',
    '.yml', '.yaml', '.toml', '.ps1', '.sh', '.py', '.bat',
]);

// ── ② ③ 扫描模式 ────────────────────────────────────────────────
const PATTERNS = [
    {
        id: 'abs-path',
        label: '本机绝对路径',
        rx: /(?:[A-Za-z]:\\Users\\[^\\\s"'<>]+)|(?:\/Users\/[^\/\s"'<>]+)|(?:\/home\/[^\/\s"'<>]+)/g,
        why: '泄露本机用户名与目录结构',
    },
    {
        id: 'email',
        label: '明文邮箱',
        rx: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        why: '会被采集；注释里的也算',
    },
    {
        id: 'private-key',
        label: '私钥块',
        rx: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g,
        why: '一旦上线等于泄露凭据',
    },
    {
        id: 'token-ish',
        label: '疑似长期凭据',
        rx: /\b(?:AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|sk-[A-Za-z0-9]{32,})\b/g,
        why: '硬编码的访问密钥',
    },
];

const problems = [];
const notes = [];
const visited = { files: 0, dirs: 0 };

function isAllowed(rel) {
    const norm = rel.split(path.sep).join('/');
    return ALLOW_RX.some(rx => rx.test(norm));
}

function scanFile(abs, rel, size) {
    const ext = path.extname(abs).toLowerCase();
    if (!TEXT_EXT.has(ext)) return;
    if (size > 8 * 1024 * 1024) {         // 大文件跳过，避免拖垮
        notes.push('跳过扫描（>8 MB）: ' + rel);
        return;
    }
    let text;
    try { text = fs.readFileSync(abs, 'utf8'); } catch (_) { return; }

    for (const p of PATTERNS) {
        const hits = [...new Set((text.match(p.rx) || []))];
        if (!hits.length) continue;
        // 邮箱：排除明显的占位符与本地示例域
        const real = hits.filter(h => !/@(example\.(com|org|net)|localhost|test\.(com|local))$/i.test(h));
        if (!real.length) continue;
        problems.push({
            kind: p.label,
            file: rel,
            why: p.why,
            samples: real.slice(0, 3),
            more: Math.max(0, real.length - 3),
        });
    }
}

function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
        const abs = path.join(dir, e.name);
        const rel = path.relative(ROOT, abs);

        if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name)) continue;
            visited.dirs++;

            // 可疑的内部工作目录
            if (SUSPECT_DIRS.has(e.name) && !isAllowed(rel)) {
                let n = 0;
                (function count(d) {
                    try {
                        for (const x of fs.readdirSync(d, { withFileTypes: true })) {
                            if (x.isDirectory()) count(path.join(d, x.name));
                            else n++;
                        }
                    } catch (_) {}
                })(abs);
                problems.push({
                    kind: '内部工作目录',
                    file: rel + '/',
                    why: '含 ' + n + ' 个文件；工作目录 = 部署根目录，它会被整棵上传',
                    samples: [],
                    more: 0,
                });
            }
            walk(abs, depth + 1);
            continue;
        }

        if (!e.isFile()) continue;
        visited.files++;
        if (isAllowed(rel)) continue;

        let size = 0;
        try { size = fs.statSync(abs).size; } catch (_) {}

        // ① 文件名判定
        let bad = false;
        for (const rx of BAD_NAMES) {
            if (rx.test(e.name)) {
                problems.push({
                    kind: '不该发布的文件',
                    file: rel,
                    why: (size / 1024).toFixed(1) + ' KB；内部文档 / 备份 / 配置 / 日志不该对外',
                    samples: [],
                    more: 0,
                });
                bad = true;
                break;
            }
        }
        if (bad) continue;

        // ② ③ 内容扫描
        scanFile(abs, rel, size);
    }
}

console.log('审计目录: ' + ROOT);
if (ALLOW.length) console.log('白名单: ' + ALLOW.join(', '));
console.log('（工作目录 = 部署根目录 ⇒ 下面每个文件都会上线）\n');

walk(ROOT, 0);

if (!QUIET) {
    console.log('扫描 ' + visited.files + ' 个文件 / ' + visited.dirs + ' 个目录。\n');
}

if (!problems.length) {
    console.log('✓ 没发现明显的泄露面。');
    if (notes.length && !QUIET) console.log('  （' + notes.length + ' 条备注：' + notes.slice(0, 3).join('; ') + '）');
    console.log('\n提醒：这个工具只查「明显该排除的东西」。');
    console.log('      有意义的设计取舍（哪些二进制确实要对外下发）要写进排除清单的白名单注释里。');
    process.exit(0);
}

// 按类别汇总，避免一屏几百行
const byKind = {};
for (const p of problems) (byKind[p.kind] = byKind[p.kind] || []).push(p);

for (const [kind, list] of Object.entries(byKind)) {
    console.log('── ' + kind + ' (' + list.length + ' 处) ──');
    for (const p of list) {
        console.log('  ' + p.file);
        console.log('      原因: ' + p.why);
        if (p.samples.length) {
            console.log('      样本: ' + p.samples.join(' | ') + (p.more ? '  …还有 ' + p.more + ' 个' : ''));
        }
    }
    console.log('');
}

console.log('✗ 共 ' + problems.length + ' 处需要处理。');
console.log('  处理方式：① 移出部署根目录 或 写进排除清单 或 改用占位符');
console.log('           ② 已经传到远端的，要在远端**删除对象** —— 「以后不上传」不等于旧的没了');
console.log('           ③ robots.txt 只是建议不是权限，不能让已被索引的页面消失');
process.exit(1);
