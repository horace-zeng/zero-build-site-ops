# zero-build-site-ops

A Mavis / agent skill for maintaining **zero-build static sites** — the kind with no bundler, no backend,
and no build artifact to fall back on. Every change is made directly in the source files, so correctness
depends entirely on a discipline chain:

```
snapshot form → patch by script → assert → look at it → regression → sync docs
```

This skill packages that chain, plus the failure modes that actually bite.

## Why this exists

On a site with a build step, a broken change usually fails loudly at build time. On a zero-build site,
**a broken change succeeds silently** — the file is written, the page still renders, and nothing complains
until a deploy or a file-sync client destroys something weeks later.

The three failure classes worth designing against:

| Failure | Why it's invisible |
| --- | --- |
| Line-ending / BOM drift | No runtime probe catches it. It surfaces as a whole-file diff, or as a mysteriously broken page after a sync. |
| A patch script that reports success but changed nothing | The anchor was unique, the replace ran, the text was identical. |
| Assertions that pass because they can't fail | The check compares something that is true regardless of the bug. |

## What's in the box

```
.
├── SKILL.md                      # the procedure: step 0-7      ← skill 本体
├── references/                   #                              ← skill 本体
│   ├── why-it-works.md           #   the rules + the failure each one prevents
│   ├── doc-contract.md           #   dual-track docs, snapshot chapter, numbering
│   ├── probe-and-regression.md   #   probes, ratchet, runners, deploy checks
│   └── archive-chapter-template.md   # copy-and-fill skeleton for a change record
├── scripts/                      #                              ← skill 本体
│   ├── lineendings.js            # measure / snapshot / verify line-ending & BOM form
│   ├── deploy-audit.js           # what would leak if you published this directory
│   ├── deploy-check.js           # live bytes vs local bytes, file by file
│   ├── serve.js                  # minimal static server (correct MIME + CORS)
│   ├── probe-template.js         # static probe: refs, case, duplicates, abs paths
│   ├── probe-browser-template.js # browser probe, same assertions over http:// and file://
│   ├── ratchet-template.js       # count + forbidden-set guard against silent regression
│   ├── run-suite-template.js     # serial runner: resume, retry-once, jitter tagging
│   └── patch-template.js         # copy-and-fill template for in-place patches
├── README.md                     # 给人看的，**不属于 skill 本体**
├── LICENSE
└── .gitignore
```

Five of the scripts work out of the box; four are templates you fill in.
Everything is dependency-free — plain Node, no `npm install`.
Only `probe-browser-template.js` needs Playwright, and it says so instead of failing silently.

## Install

The skill itself is only three things: `SKILL.md`, `references/`, `scripts/`.
Copy exactly those into a folder **named after the skill**, and leave the repo-only files behind:

```powershell
# Windows
$dest = "$env:USERPROFILE\.minimax\skills\zero-build-site-ops"
New-Item -ItemType Directory -Force $dest | Out-Null
Copy-Item SKILL.md, references, scripts $dest -Recurse
```

```bash
# macOS / Linux
dest=~/.minimax/skills/zero-build-site-ops
mkdir -p "$dest"
cp -r SKILL.md references scripts "$dest"/
```

Two rules that matter:

1. **The directory name must equal the `name:` in `SKILL.md` frontmatter** (`zero-build-site-ops`),
   otherwise the skill won't resolve.
2. **Do not copy `README.md` into the skill directory.** Skill linters treat human-facing docs in a
   skill folder as a hard failure — a skill is read by a model, not a person. It lives here for GitHub
   readers; it has no business inside an installed skill.

Verify the install with the skill linter if you have one:

```bash
node <skill-creator>/scripts/lint-skill.js ~/.minimax/skills/zero-build-site-ops
```

Then in a session, ask something like *"this static site's gallery module needs a new data field"* or
*"the probe is red, is my code broken?"* — the skill triggers on that kind of request.

## Adapting it to your site

Nothing is hardcoded to a particular project. The skill refers to your site through six placeholders
(`$SITE`, `$ENTRY`, `$ARCHIVE`, `$LOG`, `$READER`, `$PROBE`) declared at the top of `SKILL.md`.
Fill them once in your project's agent config or just tell the agent where things are.

The scripts work immediately with no configuration:

```bash
node scripts/lineendings.js report .                    # survey every file's form
node scripts/patch-template.js --dry                    # refuses to run unconfigured
node scripts/deploy-audit.js .                          # what would leak on publish
```

## The scripts

**`lineendings.js`** — reasons about form, not line counts.

```bash
node lineendings.js report   <dir|file...>
node lineendings.js snapshot <file...> --out forms.json
node lineendings.js verify   <file...> --against forms.json
```

It counts **BOM run length**, not just presence. That distinction matters: a file with 139 consecutive
BOM sequences is not the same file as one with 1, and a boolean check calls both "has BOM".

**`deploy-audit.js`** — because on a zero-build site **your working directory is your deploy directory**.
Everything in it goes public. This flags internal docs, logs, backup files, absolute local paths,
and email addresses that would ship.

```bash
node deploy-audit.js . --allow "docs/spec.md,papers/*.pdf"
```

**`probe-template.js`** — a runnable static probe, not a stub. Out of the box it checks what every
zero-build site should check: the entry exists, every local `href`/`src` resolves **case-sensitively**
(the classic Windows-passes / Linux-404s bug), nothing is included twice, and no file leaks an absolute
local path. Add your own assertions below the marked line.

```bash
node probe-template.js .
```

**`probe-browser-template.js`** — the same assertions over `http://` **and** `file://`, then compares the
two error counts. That last check is the point: a site can look fine over http and go blank on `file://`
because CSSOM is opaque there, `fetch()` is blocked by CORS, and ES modules don't load. Needs Playwright.

```bash
node probe-browser-template.js . --shots ./shots
```

It deliberately filters "Failed to load resource" console noise — a missing favicon logs an error over
http and nothing over file://, which would otherwise make the cross-protocol check fail forever for
reasons unrelated to your code.

**`serve.js`** — a minimal static server with a complete MIME table and CORS. `python -m http.server`
serves `.mjs` as `application/octet-stream` and won't inline-play video; this does, and adds
`Cache-Control: no-store` so a refresh always shows your last edit.

```bash
node serve.js . 8000
```

**`deploy-check.js`** — compares what your server actually returns against what's on disk, file by file,
by length and sha256. `MISSING`/`DIFF` means it was never uploaded or is stale; `EXTRA` means something
is live that you no longer have locally — which is where internal docs tend to surface.

```bash
node deploy-check.js https://example.com . --ext .html,.css,.js
```

**`ratchet-template.js`** — a ratchet stops silent regression: counts may not go *down*, and a forbidden
set (absolute paths, plaintext emails, leftover placeholders) must stay at zero.

```bash
node ratchet-template.js baseline . --out ratchet.json
node ratchet-template.js check    . --against ratchet.json
```

**`run-suite-template.js`** — runs a batch of probes serially, appends each result to the log *as it
finishes* (Node buffers to 64 KB, so a killed process leaves an empty log), resumes from that log, retries
a failure once, and reports jitter separately from real failures. Fill in the `SUITES` array; everything
else is done.

```bash
node run-suite-template.js --log suite.log
```

**`patch-template.js`** — the seven gates every in-place patch script needs. Copy it, fill three
constants in the CONFIG block, run with `--dry` first.

## Design notes

- **This repo root doubles as the skill root.** `SKILL.md` + `references/` + `scripts/` are the skill;
  `README.md`, `LICENSE` and `.gitignore` are repo furniture. When installing, copy only the first three
  (see [Install](#install)) — a `README.md` inside a skill directory is a hard lint failure, because a
  skill is read by a model, not a person.
- **No project names, domains, or paths** anywhere in `SKILL.md` / `references/` / `scripts/`.
  See the placeholder table at the top of `SKILL.md`.
- The guidance is deliberately prescriptive. Vague advice ("be careful with line endings") has never
  prevented a single incident; "assert the BOM run length is unchanged" has.
- **`deploy-audit.js` is meant to be run on a deploy root, not on this repo.** It will flag `README.md`
  here — correctly, since a static site's root is public. Point it at your site, not at this codebase.

## License

MIT — see [LICENSE](LICENSE).
