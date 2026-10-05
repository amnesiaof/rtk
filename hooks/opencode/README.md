# OpenCode Hooks

> Part of [`hooks/`](../README.md) — see also [`src/hooks/`](../../src/hooks/README.md) for installation code

## Specifics

- TypeScript plugin (not a shell hook)
- Supports both **OpenCode 2.0** (`execute.before` via `{ id, setup }`) and legacy **OpenCode 1.x** (`tool.execute.before`)
- Thin delegating shim: calls `rtk hook opencode` as a subprocess, and the Rust side is the single source of truth for rewrite rules
- The Rust side judges the command against OpenCode's own permission rules
  (root and project `opencode.json`/`.jsonc`, last match wins) and answers `{}`
  whenever the rewrite would change the verdict those rules give — OpenCode
  evaluates the final command itself, so RTK never lifts a deny, silences an
  ask, or blocks an allow (#4195)
- Uses standard `node:child_process.execFile` (compatible with OpenCode CLI, OpenCode Desktop/Electron, and Windows; zero Bun/zx dependencies)
- Passes the command as a single argv element, never through a shell
- Robust binary discovery via `RTK_BIN`, system `PATH`, `~/.cargo/bin`, `~/.local/bin`, and Homebrew
- Probes the resolved binary with `rtk --version` once per session (cached); a binary that will not answer is treated as absent
- Requires **rtk >= 0.51.1**, the first release carrying `rtk hook opencode`. Older rtk versions have no such subcommand, so the plugin disables itself with a warning rather than silently passing every command through
- Skips commands that already invoke `rtk`, and honours `RTK_DISABLED=1`
- Mutates command in-place (`event.input.command` in v2, `output.args.command` in v1) if the answered rewrite differs from the original
- Any failure — non-zero exit, timeout, non-JSON stdout, missing binary — passes the command through unchanged
- Installed to `~/.config/opencode/plugins/rtk.ts` by `rtk init -g --opencode`
