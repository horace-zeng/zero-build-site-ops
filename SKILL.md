---
name: zero-build-site-ops
description: |
  Maintain a zero-build static site — no bundler, no backend, no build artifact, files edited in place.
  Covers: HTML/CSS/JS modules, data layers, generated assets, the probe/regression suite, the archive
  document and any in-page reader document. Load this skill whenever the user mentions their static
  site or any of its parts — "作品集站" / "portfolio site" / "个人站" / "官网" — or asks to change a
  module, add data, refresh stale numbers in docs, fix a red probe, harden line endings, or publish
  the domain. Also load it when a diff shows a whole file changed but the user only touched one line
  (line-ending drift), or when a regression went red and nobody knows whether the code or the test is
  wrong. Do NOT use it for sites with a build step (Vite/Next/webpack), for server-rendered apps, for
  framework components, or for generic web-dev questions with no existing site context.
---

# Zero-Build Static Site Ops

A site with no bundler, no backend and no build artifact has **nothing between your edit and production**.
There is no compile step to catch a mistake, and the files are hand-edited in place — so every change's
correctness rests entirely on this chain:

```
snapshot form → patch by script → assert → look at it → regression → sync docs
```

Skip a link and the failure is silent. That is the whole reason this skill is prescriptive.

## 查什么读哪份

**先读的：**

| 你想知道 | 读这个 |
| --- | --- |
| 该怎么一步步做（主流程） | 就是本文件，Step 0–7 |
| 每条规矩防的是什么事故、为什么这么写 | `references/why-it-works.md` |
| 文档怎么分轨、快照章怎么维护、编号怎么定 | `references/doc-contract.md` |
| 探针怎么写、回归怎么跑、怎么判红判抖动、发布前查什么 | `references/probe-and-regression.md` |
| 归档章怎么起头（五段骨架） | `references/archive-chapter-template.md` |

**可直接用的脚手架**（前四个开箱即用，后三个复制出去改）：

| 什么时候用 | 用这个 |
| --- | --- |
| 想知道某个文件的行尾/BOM 是什么、改前后有没有被改坏 | `scripts/lineendings.js` |
| 这个目录发布出去会泄露什么 | `scripts/deploy-audit.js` |
| 线上跑的到底是不是这份代码 | `scripts/deploy-check.js` |
| 本地要预览 / 探针要个 http 服务器 | `scripts/serve.js` |
| 要写静态探针了（引用完整性 / 大小写 / 形态） | `scripts/probe-template.js` |
| 要写浏览器探针了（http + file 双协议） | `scripts/probe-browser-template.js` |
| 要加防退化守卫（计数 + 禁用集合） | `scripts/ratchet-template.js` |
| 要跑一批探针了（串行 / 续跑 / 重跑 / 抖动） | `scripts/run-suite-template.js` |
| 要改文件了，补丁脚本怎么起头 | `scripts/patch-template.js` |

命令速查：

```powershell
$skill = '<你的 skills 目录>\zero-build-site-ops'
node "$skill\scripts\lineendings.js" report $SITE                  # 量全站形态
node "$skill\scripts\lineendings.js" snapshot <文件...> --out .work\forms.json
node "$skill\scripts\lineendings.js" verify   <文件...> --against .work\forms.json
node "$skill\scripts\deploy-audit.js" $SITE                        # 发布前查泄露面
node "$skill\scripts\serve.js" $SITE 8000                          # 本地预览
node "$skill\scripts\deploy-check.js" https://<你的域名> $SITE     # 线上 vs 本地
node "$skill\scripts\probe-template.js" $SITE                      # 静态探针
node "$skill\scripts\ratchet-template.js" baseline $SITE --out .work\ratchet.json
node "$skill\scripts\ratchet-template.js" check    $SITE --against .work\ratchet.json
```

## 占位符约定

本项目无关的六个概念，下文一律用占位符。**第一次使用时先确认它们各自是什么**（读目录、读入口文件头注、
问用户），不要假设名字：

| 占位符 | 是什么 | 常见的实际形态 |
| --- | --- | --- |
| `$SITE` | 站点根目录，**同时就是部署根目录** | 仓库根 / 同步盘里的一个文件夹 |
| `$ENTRY` | 入口 HTML（唯一入口） | `index.html` |
| `$ARCHIVE` | 归档文档：记录「为什么这么改」，维护者读 | 一份 `<归档>.md` |
| `$LOG` | 追加式经验日志：逐轮记录教训 | 一份 `<日志>.md` |
| `$READER` | 页内读者文档：嵌在站点里、访客能读 | 入口 HTML 里的 `<script type="text/plain">` |
| `$PROBE` | 探针脚本目录（一次性脚本不打进站点） | `.trash/` / `.probes/` / `_scripts/` |

`$ARCHIVE` / `$LOG` / `$READER` 可以不存在 —— 单文件小站往往没有。存在时它们就是本 skill 里最贵的三份资产。

## Inputs to collect

能从工作区、文档、记忆里读到的**不要问用户**：

- **本轮要动什么**：哪个模块 + 是「加数据」「改行为」还是「改文案」；
- **这一轮算第几章**：章号只取空号，不重编号（见 `references/doc-contract.md`）；
- **用户有没有点名数字或文案**：点名的照抄，没点名的自己实测后写；
- **要不要发布**：默认**只改本地**，上线由用户手动做，除非用户明确说「发上去」。

若用户只说「更新一下站」，先问一句范围 —— 一个站通常有多个模态与多个数据层，猜错模块的代价是改一整套文件。

### ⚠ 动手前先确认：这件事是不是已经做过了

文档写得越勤的项目，越容易发生「用户以为要做，其实上一轮已经做完」。重复实现是最贵的错误 ——
会覆盖已有成果、制造「文件被回退」的假象，还把文档写乱。

三查，顺序固定：

1. **归档文档有没有对应章** —— 按关键词（模块名 / id / 用户提到的名字）搜 `$ARCHIVE`，看有没有已落地的决策章；
2. **数据层是不是已经是目标值** —— 别读注释，读**数据本身**（eval 出来看字段值）；
3. **线上是不是还是旧的** —— 拉线上那一份比对字节数 / 关键标识：

```powershell
node -e "const h=require('https');h.get('https://<你的域名>/<数据文件>.js',r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>console.log(r.statusCode,s.length,s.slice(0,200)))})"
```

**判定为「本地已完成、线上未发布」时，任务的真正内容是「验证 + 列出线上待办」，不是重做一遍。**
这时候该交付的是本地验证结果 + 线上待用户手动做的清单。

## Procedure

### Step 0 · 先定位，再动手

1. 读 `$ENTRY` 的头注，确认**文件结构清单的唯一事实源在哪** —— 多副本并存的项目里，副本会停在不同年份且互相矛盾；
2. 读 `$ARCHIVE` 的目录，找到这个模块**历史上改过哪些章** —— 归档文档记的是「为什么这么改」，
   它记的改法可以当**期望状态的权威**来逐字对照当前的实现；
3. **先搜同类实现** —— 站内往往已有同族实现（另一个模态、另一个数据层的字段约定）。
   先读它、复用它的范式，差异只在新内容。这类项目的模块都是照着上一个模块长出来的，
   新写一套会在几轮内漂移成两套系统。

### Step 1 · 改前快照（比形态，不比行数）

```powershell
node "<skill>\scripts\lineendings.js" report <要改的文件...>     # 先量，别凭记忆
node "<skill>\scripts\lineendings.js" snapshot <要改的文件...> --out .work\forms.json
```

每个文件都有**它自己的**形态：`BOM 序列长度 / CRLF 数 / 裸 LF 数 / 末尾有无换行`。
这些形态是**约定**，不是风格。改坏它通常**没有任何功能探针会红**，只会在下一次发布或同步时炸。

改完立刻比对：

```powershell
node "<skill>\scripts\lineendings.js" verify <文件...> --against .work\forms.json
```

判定只比**形态**，**不比行数、不比字节数** —— 改动本来就会让行数变，把行数写进断言会必然误报。
脚本仍会把行数差值打印出来供人看，但那是参照，不是判据。

**关于 BOM：数「有几个」，不是「有没有」。** 一个文件的开头可能是**多个连续 BOM 三字节组**。
只判 boolean 的守卫，会把「N 个被合并成 1 个」判成 PASS。`lineendings.js` 报 `BOMx<N>`，比的是这个 N。

**关于「混合行尾」：先判它是不是某个工具的确定性产物，再决定要不要动它。**
有一种常见情况：目录生成脚本用 `split('\n')` → 改 → `join('\n')`，每个元素自带尾部 `\r`，
所以正文的 CRLF 被原样还原，而**新生成的目录数组不含 `\r`** ⇒ 文件稳定地呈现「目录区纯 LF + 正文纯 CRLF」。
这不是污染，是结构性不变量。**去「修」它会造成整文件 diff。** 判据：跑一遍那个生成器，看形态是否可复现。

### Step 2 · 写补丁脚本，不手改行尾敏感文件

改动落成 `$PROBE/<序号>_<动词>_<主题>.js|.py` 脚本，**不要用编辑工具直接改**行尾敏感文件 ——
手工编辑是行尾被破坏的主要来源。

**用模板，不要从零写**：

```powershell
Copy-Item "<skill>\scripts\patch-template.js" $PROBE\_bNNN_<动词>_<主题>.js
```

模板把七件事写死，只需改 CONFIG 段三个常量：

| 常量 | 填什么 |
| --- | --- |
| `TARGET` | 要改的那个文件 |
| `EDITS` | `{ find, replace, label, already? }` 数组；`find` **必须逐字从磁盘复制** |
| `EXPECT` | 形态净增期望 `crlfDelta` / `bareDelta` / `endsWithNewline`（不确定填 `null`） |

```powershell
node $PROBE\_bNNN_xxx.js --dry     # 先干跑，只验不写
node $PROBE\_bNNN_xxx.js           # 断言全过才真写
```

七道闸门：

1. 二进制读盘 → 先量形态；
2. 锚点全局唯一，命中 0 或 >1 **立刻中止**；
3. **所有锚点在任何写盘之前预检完** —— 否则多步脚本前一步已落盘，后面失配不会回滚，磁盘停在半应用状态；
4. **幂等判据由你显式声明**（`already` 字段），不是「拿 replace 去猜」；
5. 每条替换都断言**真的生效了** —— 锚点唯一 ≠ 替换生效；
6. 写盘后回读校验；
7. 形态门禁比**净增量**，不是「前后相同」。

⚠ **`already` 为什么必须显式给**：用「replace 文本是否已存在」自动判幂等看起来省事，实际会在
`replace` 只有一两个字符时**在原文件里误命中**，于是把「锚点失配」误判成「已落盘」，
**静默跳过还写了盘**。不填 `already` 就一律 FAIL 才是对的。

其他要点：

- **编号类替换要带上下文锚点，做整串替换** —— `#186` 在别人的源码里是对方的注释；
- **锚点唯一性断言是恒真的**，它证明不了任何事，必须配「替换真的生效」那条；
- **长文本（中文/多行正文）不要塞进字符串字面量** —— 里面的反引号与 ASCII 单引号会把字面量截断。
  正文写独立 `.txt`，脚本读文件，并按目标文件的形态转换行；
- **正则的替换文本里不得出现 `$`**；替换后跑一次结构自检（关键容器开合标签）+ `node --check`；
- **脚本写盘时不要把 stdout 接进会提前关闭的管道** —— 提前关管道会让脚本收到 EPIPE 中途死亡，目标文件被截断。

### Step 3 · 断言要能对它声称验证的事失败

- **断言的输入必须是当场实测的量**，不是记忆里的现状。人一旦去改过期断言，等于把校验降级成摆设；
- **禁止写死会增长的计数**（条目数 / 场次数 / 照片数），改成关系式判据
  （「底图键数 === 路线场数」而不是「16 场」）；
- **计数用 eval 取数据层**，不要用正则扫文本 —— 正则会把注释里的条目也算进去，口径错了比数字错了更难发现；
- **只改注释/文案时，额外断言「代码区逐字节未变」**；
- **改生成器产出的文件时改生成器，不手改产物** —— 手改会被下一轮覆盖；
- **存在性断言 ≠ 布局断言**：「元素在 DOM 里」不等于「它可见 / 没被挡住 / 没溢出」，后者必须量计算后的几何；
- **探针不许吞异常** —— `try {} catch(e) {}` 会让整套件静默地测十几轮死数据。

### Step 4 · 跑探针，再跑回归

先跑**受影响的那几套**，绿了再跑全量：

```powershell
node $PROBE\<该模块的静态探针>.js     # 不启浏览器，秒级
node $PROBE\<该模块的浏览器探针>.js   # 自带服务器，http + file 双协议
node $PROBE\<跑批器>.js               # 全量，串行
```

**没有现成探针时，从模板起步，不要从空文件写**：

```powershell
Copy-Item "<skill>\scripts\probe-template.js"         $PROBE\_probe_<主题>.js
Copy-Item "<skill>\scripts\probe-browser-template.js" $PROBE\_probe_<主题>_ui.js
Copy-Item "<skill>\scripts\ratchet-template.js"       $PROBE\_ratchet.js
Copy-Item "<skill>\scripts\run-suite-template.js"     $PROBE\_run-suite.js
```

- `probe-template.js` 开箱就查四件事：入口在不在、本地引用是否**大小写敏感**地存在、
  有没有重复引入、文本里有没有本机绝对路径。要加自己的断言就往「自定义断言区」里写；
- `probe-browser-template.js` 自带服务器，**同一套断言跑 `http://` 与 `file://` 两遍**，
  最后比对两个协议的错误数是否一致。缺 Playwright 会明确报错退出（不是静默跳过）；
- `ratchet-template.js` 是**计数 + 禁用集合**双断言，防「以后悄悄变少 / 变回去」；
- `run-suite-template.js` 把串行、落盘、续跑、失败重跑一次、抖动标记都做好了，
  你只要填 `SUITES` 数组。

⚠ **浏览器探针必须滤掉「资源加载失败」**。缺 favicon 时 http 下会打一条
`Failed to load resource`，而 `file://` 下不会 —— 不滤掉的话「双协议一致性」会稳定假红，
且与实现对错完全无关。模板已经滤了（只放行真正的 `pageerror` 与脚本 console error）。

**回归红了的第一反应，是问「这条断言的前提过期了，还是实现坏了」—— 不是去改实现。**

判据：实现现在做的事，和这条断言写下的那一刻，是同一件事吗？

- 确属探针过期 → **只改探针，实现一行不动**，并先读实现的判据确认实现是对的；
- 双协议一红一绿 → 差异在**协议/环境**（外部 CDN 超时的典型签名），不是实现；
- 每轮红的套件不同 + 复跑绿 = **抖动**；红的套件相同 + 复跑仍红 = **真回归**；
- 全量跑批**必须串行**；失败自动重跑一次，抖动的那几套在汇总里**单独标出**并保留首跑失败行。

详见 `references/probe-and-regression.md`。

### Step 5 · 目视（探针全绿不算验收）

**内容替换类改动（文案 / 素材 / 模板 / 断句）收尾时，截一张关键渲染点的图再看一眼。**

断言只证明「被断言的那几条」正确。排版、断句、空白这类风险，断言天然查不出来 ——
一个只替换首个换行的 `replace('\n','')` 能把三行文案压成一行并多出一个空格，
而配套的上百条断言全绿，因为**没有任何一条覆盖这一项**。抓到它的是截图。

几何 / 像素类改动更要留一张**肉眼可看的对比图**：像素断言全绿而图是糊的，只差视觉对账这一步。

### Step 6 · 文档同步（三处，缺一处就留下过期的那半）

| 落点 | 改什么 | 注意 |
| --- | --- | --- |
| `$ARCHIVE` | 追加一章归档 + **改「当前状态」快照章**（索引表 + 模块表 + 开放项）| 章号只取空号；目录表用脚本重生成；**骨架见 `references/archive-chapter-template.md`** |
| `$LOG` | 追加一条单行记录 + 刷末尾的条数行 | 本轮没新增就明写「无新增」 |
| `$READER` | 改内容或加小节（优先在已有章里加小节，而不是新造一章）| 它与 `$ARCHIVE` 若共用一份头注，改一边要 grep 另一边 |

归档章照**五段骨架**写：现象 → 根因（量出来的数字，不是感觉）→ 改法 → 验证 → 教训。
`references/archive-chapter-template.md` 里有可复制的成品模板，以及四条常见写法错误的提醒。

**当前态 vs 历史引用**：描述现在的数字要刷，记录当时的要留。
把历史章也改成今天的数等于销毁证据。判据是一句话：**「这句话会不会随今天的文件变」。**

这条判断还有个陷阱：同一串旧名称，在代码注释里是历史流水（不动），在数据层是漏改（必清）。
所以**探针的判据要落在元素 / 字段上，不要全文扫** —— 全文扫会把历史引用判成漏改。

### Step 7 · 交付时明确「本地做完」与「线上还要用户做」

本地做不到的部分（上传 / 删远端对象 / CDN 刷新 / 搜索引擎移除请求 / 备案与账号自查）
要在回复里**逐条列出来**，不要含糊成「已上线」。

⚠ 列清单前**先量一次线上欠账**，否则清单是抄旧文档的：

```powershell
node "<skill>\scripts\deploy-check.js" https://<你的域名> $SITE
```

它逐文件比**线上实际返回的字节**与本地磁盘：长度 + sha256 一致才算 SAME。
四类结论各有处理方向：

| 结论 | 含义 | 怎么办 |
| --- | --- | --- |
| `MISSING` / `DIFF` | 没传，或传了旧版 | 重传（**只传入口 HTML 是不够的**）|
| `EXTRA` | 线上有、本地没有 | 该删没删 —— 内部文档常在这里暴露 |
| 全 SAME 但页面仍旧 | CDN 边缘缓存 | 去做刷新，不是源站问题 |

实测出来的欠账常常超出文档记的范围 —— 文档只记了最后一轮那一簇，实际可能还差十几个文件。

⚠ **本地全绿不能替代线上已发布。** 这两件事要分开说：
「本地探针全绿 + 线上还是旧版」是常态，不要因为本地绿了就把线上说成已完成。

## Output contract

- **代码改动**：落盘的源文件 + 落盘的补丁脚本（脚本是回滚保险，别删）；
- **验证结论**：跑了哪些探针、各多少 PASS/FAIL、全量回归几套几红、抖动几套；
- **文档同步**：新章号 + 快照章改了哪几处 + 日志第几次扩展 + `$READER` 是否动过；
- **线上待办**：逐条列出需要用户手动做的动作（能列的给出确切路径 / URL）；
- 产物有可视化部分时，附关键渲染点的截图。

## Failure handling

- **锚点命中 0 次或 >1 次** → 立即中止、**不写盘**，回到源文件逐字取锚点（多半是上一轮改动让锚点过期了）；
- **断言红了** → 先判「前提过期」还是「实现坏了」；两遍都判不出就停下问用户，不要「改到绿为止」；
- **形态（行尾/BOM）被改坏** → 从补丁脚本的备份或探针目录里的副本还原，**别手工修**；
- **回归红且找不到归因** → 把红项与归因如实报给用户，不要掩盖；
- **文件被同步盘 / 云盘静默回退成旧版** → 本类项目最隐蔽的故障形态：不报错、不留痕、页面不白屏，
  只是某个模态悄悄退回旧样子。识别线索 —— **mtime 早于改动日**、**「只坏一个文件」**、
  **文档记过改法但实现里没有**。还原走副本或原补丁脚本重放，**不要重新发明一遍**；
- **想删文件** → 走可恢复删除通道（移入探针目录或回收站），不要用不可逆的删除命令。

## Examples

**Input**：把站内某个内容模块的作品整本换掉。

关键动作序列：换资产（新文件进资源目录，旧文件移入可恢复目录，**复制要带 mtime** 因为「生成时间 = 文件时间」）
→ 改生成器重生成机器层（人写层与机器层分家：**计数一律渲染时现算，不手写**）
→ 入口卡代表**类目**所以卡面不动（只改数据层）
→ 探针断言跟着新前提走（条数、id、结尾标记、关键句）→ 双协议浏览器探针 → 全量回归
→ **截图目视** → 归档新章 + 快照章 + 日志条目 + 刷当前态数字。

**Input**：跑一下回归。

先确认是**全量**还是只跑某几套；长驻本地服务器要起**独立进程**（挂在工具后台任务里会被时长上限回收）。
全量必须串行，日志每套跑完立刻落盘（Node 会缓冲，进程被杀时日志会是空的）。

**Input**：这个 diff 为什么整个文件都变了？我只改了一行。

这是行尾漂移。先 `lineendings.js report` 量当前形态，再从备份还原，然后用 `patch-template.js` 重做一遍。
**不要试图「改回去」** —— 混合行尾一旦被抹平就不可重建，只能从备份恢复。

## Platform notes

- **Windows / PowerShell 5.1**：`.ps1` 必须存成 UTF-8 **with BOM**，否则按本地代码页解析，
  中文变乱码吃掉引号、报语法错、进程秒退；`0x80000000` 这类字面量要写成 `[uint32]2147483648`；
  `-Encoding UTF8` 写出的文件**带 BOM**，需要无 BOM 时用 `[System.IO.File]::WriteAllText(..., New-Object System.Text.UTF8Encoding($false))`；
  读文件判编码一律用字节 API 或 node，`Get-Content` 会按 ANSI 解码而给出假乱码；
- **复制 / 删除**：某些受管环境会拦 `Copy-Item` / `Remove-Item`，改用 node 的 `fs.copyFileSync`
  （**它不保 mtime**，需要时补 `fs.utimesSync`），删除走可恢复通道；
- **比对线上文件必须走二进制** —— 文本管道会把 UTF-8 当 Latin-1 解，差分结论全是假的；
- **工具后台任务通常有运行时长上限**（常见 1 小时）⇒ 长驻服务（静态服务器、watcher）必须
  用独立进程启动，否则到点被回收、服务随之消失。
