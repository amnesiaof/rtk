# OpenCode Hooks

> Part of [`hooks/`](../README.md) — see also [`src/hooks/`](../../src/hooks/README.md) for installation code

## Specifics

- TypeScript plugin (not a shell hook)
- Supports **OpenCode 2.0** (`execute.before` via `{ id, setup }`) and **OpenCode 1.x >= 1.3.4** (`tool.execute.before`)
- OpenCode **<= 1.3.3** gets [`rtk-legacy.ts`](rtk-legacy.ts) instead: those loaders call every export as `fn(input)`, which the object `rtk.ts` default-exports is not (1.1.4 exits 1 at startup, 1.3.3 logs `failed to load plugin`). `rtk init -g --opencode` picks the file from `opencode --version`; `--opencode-legacy` forces the legacy one, and an absent or unparsable OpenCode gets the current plugin
- Thin delegating shim: calls `rtk hook opencode` as a subprocess, and the Rust side is the single source of truth for rewrite rules
- The Rust side judges the command against OpenCode's own permission rules
  (root and project `opencode.json`/`.jsonc`, last match wins) and answers `{}`
  whenever the rewrite would change the verdict those rules give — OpenCode
  evaluates the final command itself, so RTK never lifts a deny, silences an
  ask, or blocks an allow (#4195)
- Uses standard `node:child_process.execFile` (compatible with OpenCode CLI, OpenCode Desktop/Electron, and Windows; zero Bun/zx dependencies)
- Passes the command as a single argv element, never through a shell
- Resolves rtk from the system `PATH` only (`PATHEXT` on Windows), and skips a PATH entry that is a directory. OpenCode's shell tool runs with OpenCode's own `PATH` and never sources `.profile`/`.bashrc`, so an rtk found outside `PATH` cannot be spawned as a bare `rtk …` — see #4462
- Probes the resolved binary once per session with `rtk hook opencode --help` (cached): exit 0 means the subcommand is there, exit 2 means it predates it, and a broken or wrong-arch binary fails to spawn. Not a version number — a develop build reports `rtk 0.49.0` and so does a release that lacks the subcommand
- Passes OpenCode 2.x's `event.agent` as `rtk hook opencode --agent <name>`, so an `agent.<name>.permission` ask or deny is judged against the agent that runs the command. OpenCode 1.x sends no agent field, so that path stays root-only
- Honours `RTK_DISABLED=1`
- Mutates command in-place (`event.input.command` in v2, `output.args.command` in v1) if the answered rewrite differs from the original
- Any failure — non-zero exit, timeout, non-JSON stdout, missing binary — passes the command through unchanged
- Installed to `~/.config/opencode/plugins/rtk.ts` by `rtk init -g --opencode`
- Tests: `node --test hooks/opencode/rtk.test.mjs`
