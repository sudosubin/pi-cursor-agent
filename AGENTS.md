# pi-frontier — read this before you touch anything

**Three pi provider extensions — Cline, Cursor Agent, Kilo Code — that let `pi`/`ronin` drive
frontier coding agents as if they were model providers.**

**Last verified: 2026-08-07.** If this contradicts what you observe on disk, **the disk wins — say
so and fix this file.**

## 1. What this is

- **Package / artefact:** three independent npm packages — `pi-cline`, `pi-cursor-agent`,
  `pi-kilocode`. **There is NO root `package.json`.** `npm` at the top level does nothing.
- **Repo + remote:** `https://github.com/iRonin/pi-frontier.git`.
  ⚠️ **Three names for one thing.** The directory is `pi-kilocode/`, the repo is **`pi-frontier`**,
  and one of the three packages inside is *also* called `pi-kilocode`. **`pi-kilocode/pi-kilocode`
  is not a typo.** Say which you mean.
- **Branch that matters:** **`fix/kilocode-model-registration`**, *not* `main`. Check before you
  assume; a change committed to `main` is not the branch anyone is running.
- **Ships into:** the operator's `pi`/`ronin` install, loaded by absolute path from
  `~/.pi/agent/settings.json`.

## 2. Layout

| Path | What it holds |
|---|---|
| `pi-cline/` | Cline provider |
| `pi-cursor-agent/` | Cursor Agent provider (has a `buf generate` proto step) |
| `pi-kilocode/` | Kilo Code provider — **the only one loaded live** (§4) |
| `biome.json` | the shared lint/format config — Biome, not ESLint/Prettier |

## 3. Build / test / verify — the real commands

**Per package. There is no root runner.**

```bash
cd pi-kilocode          # or pi-cline / pi-cursor-agent
npm run typecheck       # tsc
npm run lint            # biome check
npm test
```

**Name the trap:** `npm test` in **`pi-cline` and `pi-cursor-agent` does NOT strip
`PI_CODING_AGENT_DIR`** — see §4. Strip it yourself:

```bash
TMP=$(mktemp -d); PI_CODING_AGENT_DIR="$TMP" npm test
```

## 4. ⛔ Do NOT touch / what fails silently

**🔴 Editing `pi-cline` or `pi-cursor-agent` changes NOTHING in the running agent.**
`~/.pi/agent/settings.json` loads exactly one path from this repo:

```
/Users/ironin/Work/Pi-Agent/pi-kilocode/pi-kilocode
```

**The other two are not loaded at all.** So you can fix a Cline bug, get a green suite, restart, and
observe no change whatsoever — because that package was never live. **Nothing errors.** Before
believing a fix took effect, confirm the package you edited is actually in `settings.json`.
⚠️ That file is **SINGLE-WRITER** (workspace `AGENTS.md` §6) — propose additions, never edit it.

**🔴 `pi-cline` and `pi-cursor-agent` test runs READ THE OPERATOR'S LIVE CONFIG.**
Their `test` scripts are a bare `tsx --test …`. **`pi-kilocode`'s is not** — it wraps the run in
`TMP_DIR=$(mktemp -d) && PI_CODING_AGENT_DIR="$TMP_DIR" …`. **That asymmetry is the tell: someone
hit this in one package and fixed only that one.** Unstripped, the suite resolves against
`~/.pi/agent`, producing failures that belong to the operator's machine rather than the code — and,
worse, results that pass or fail depending on who runs them. This is the workspace's documented
trap (root `AGENTS.md` §5, *100% hit rate, two agents and the lead, twice each*).

**⛔ Never run a harness binary here without a temp `HOME` either** — `--version` is **not** inert;
it overwrites extensions in `$HOME/.pi/agent/`.

## 5. Where the docs are

| Need | Go to |
|---|---|
| what the three providers are | `README.md`, then each package's `README.md` |
| workspace-wide layout | `/Users/ironin/Work/Pi-Agent/docs/LAYOUT.md` |
| workspace orientation | `/Users/ironin/Work/Pi-Agent/AGENTS.md` |
| task board | `/Users/ironin/Work/Pi-Agent/docs/tasks/PA-*.md` |

## 6. How to report

`ask_user` for decisions; `intercom` to your parent for work coordination. **Paths in messages must
be absolute** — a project-relative path silently resolves against a different cwd, and in this repo
`pi-kilocode/` is ambiguous between two directories.
