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
skills/zero-build-site-ops/
├── SKILL.md                          # the procedure: step 0-7
├── references/
│   ├── why-it-works.md               # the rules, each with the failure it prevents
│   ├── doc-contract.md               # dual-track docs, snapshot chapter, numbering
│   └── probe-and-regression.md       # probes, ratchet, runners, deploy checks
└── scripts/
    ├── lineendings.js                # measure / snapshot / verify line-ending & BOM form
    ├── patch-template.js             # copy-and-fill template for in-place patches
    └── deploy-audit.js               # what would leak if you published this directory
```

The skill directory is named to match its frontmatter `name:`, so it lints and installs as-is.

## Install

Copy `skills/zero-build-site-ops/` into your skills folder, keeping the directory name:

```powershell
# Windows
Copy-Item -Recurse skills\zero-build-site-ops "$env:USERPROFILE\.minimax\skills\zero-build-site-ops"
```

```bash
# macOS / Linux
cp -r skills/zero-build-site-ops ~/.minimax/skills/zero-build-site-ops
```

The directory name must equal the `name:` in `SKILL.md` frontmatter, otherwise the skill won't resolve.

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

**`patch-template.js`** — the seven gates every in-place patch script needs. Copy it, fill three
constants in the CONFIG block, run with `--dry` first.

**`deploy-audit.js`** — because on a zero-build site **your working directory is your deploy directory**.
Everything in it goes public. This flags internal docs, logs, backup files, absolute local paths,
and email addresses that would ship.

## Design notes

- **No README inside `skill/`.** Skill linters reject human-facing docs in the skill directory
  (`README.md`, `CHANGELOG.md`, `INSTALLATION.md`, `QUICK_REFERENCE.md` are hard failures — a skill is
  read by a model, not a person). This README lives one level up, for humans on GitHub.
- **No project names, domains, or paths** anywhere in the skill. See `skill/SKILL.md` placeholders.
- The guidance is deliberately prescriptive. Vague advice ("be careful with line endings") has never
  prevented a single incident; "assert the BOM run length is unchanged" has.

## License

MIT — see [LICENSE](LICENSE).
