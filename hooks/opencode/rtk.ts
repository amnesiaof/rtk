import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

// RTK OpenCode plugin — rewrites commands to use rtk for token savings.
// Requires: rtk >= 0.51.1, the first release carrying `rtk hook opencode`
// (added in #4349; v0.51.0 and older have no such subcommand).
//
// This is a thin compat shim: all rewrite and permission logic lives in
// `rtk hook opencode`, which is the single source of truth
// (src/discover/registry.rs). It judges the command against OpenCode's own
// permission rules and answers `{}` whenever the rewrite would change what
// those rules decide — OpenCode evaluates the final command itself, so a
// rewrite RTK does return never lifts a deny, silences an ask, or blocks an
// allow (#4195). To add or change rewrite rules, edit the Rust registry — not
// this file.
//
// This file only carries the transport: it must run wherever OpenCode runs, so
// it uses `node:child_process.execFile` and system PATH discovery rather than
// Bun's `$` shell helper (`TypeError: $ is not a function` under OpenCode
// Desktop / Electron) and `which` (absent on Windows).

type Answer = { command?: string }

let cachedRtkPath: string | null = null
let probedBanner: { bin: string; banner: string } | null = null

export function _resetCachedRtkPath(): void {
  cachedRtkPath = null
  probedBanner = null
}

export function expandHome(filepath: string): string {
  return /^~[/\\]?/.test(filepath)
    ? join(homedir(), filepath.replace(/^~[/\\]?/, ""))
    : filepath
}

/**
 * Resolves the rtk binary from RTK_BIN, standard PATH, or common installation directories.
 */
export function resolveRtkPath(): string | null {
  if (cachedRtkPath && existsSync(cachedRtkPath)) return cachedRtkPath

  const envBin = process.env.RTK_BIN
  if (envBin) {
    const expanded = expandHome(envBin)
    if (existsSync(expanded)) return (cachedRtkPath = expanded)
  }

  const dirs = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""]

  for (const dir of dirs) {
    for (const ext of exts) {
      const fullPath = join(dir, `rtk${ext}`)
      if (existsSync(fullPath)) return (cachedRtkPath = fullPath)
    }
  }

  return (cachedRtkPath = null)
}

/**
 * Probes the binary with `rtk --version`.
 *
 * Existence is not enough: a file named `rtk` on PATH proves nothing about
 * whether it runs. Spawning it once and reading its banner is the only check
 * that survives a broken install, a wrong-arch binary, or a stale `RTK_BIN`.
 * The answer is cached per binary — this runs once per OpenCode session, not
 * once per tool call.
 */
export function probeRtkVersion(rtkBin: string): Promise<string | null> {
  if (probedBanner?.bin === rtkBin) return Promise.resolve(probedBanner.banner)
  return new Promise((resolve) => {
    execFile(
      rtkBin,
      ["--version"],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null)
        const banner = String(stdout ?? "").trim()
        probedBanner = { bin: rtkBin, banner }
        resolve(banner)
      }
    )
  })
}

/**
 * Invokes `rtk hook opencode <command>` and returns the answered rewrite.
 *
 * The answer is `{}` whenever the rewrite would change the verdict OpenCode's
 * own permission rules give, and that empty answer means the command runs as
 * typed. Anything unusable — non-zero exit, timeout, non-JSON stdout — also
 * resolves to null, so a broken rtk passes the command through instead of
 * blocking the tool call.
 */
export function runHookOpencode(
  rtkBin: string,
  command: string,
  timeoutMs = 3000
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      rtkBin,
      ["hook", "opencode", command],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null)

        let answer: Answer
        try {
          answer = JSON.parse(String(stdout ?? "").trim() || "{}")
        } catch {
          return resolve(null)
        }

        const rewritten = typeof answer?.command === "string" ? answer.command.trim() : ""
        resolve(rewritten && rewritten !== command ? rewritten : null)
      }
    )
  })
}

/**
 * True when the command already invokes rtk.
 *
 * Rewriting `rtk git status` would ask rtk about itself, and the rewrite can
 * only make such a command longer.
 */
export function isAlreadyRtk(command: string): boolean {
  return /^\s*rtk\s/.test(command)
}

export async function tryRewriteCommand(
  toolName: string,
  command: unknown
): Promise<string | null> {
  const tool = String(toolName ?? "").toLowerCase()
  if ((tool !== "bash" && tool !== "shell") || typeof command !== "string" || !command.trim()) {
    return null
  }
  if (isAlreadyRtk(command)) return null

  const rtkBin = resolveRtkPath()
  if (!rtkBin) return null

  try {
    return await runHookOpencode(rtkBin, command)
  } catch {
    return null
  }
}

async function handleToolHook(tool: unknown, container: any) {
  if (!container || typeof container !== "object") return
  const rewritten = await tryRewriteCommand(String(tool ?? ""), container.command)
  if (rewritten) container.command = rewritten
}

/**
 * First release carrying `rtk hook opencode` (added in #4349). v0.51.0 and
 * older have no such subcommand: every delegation would fail with an unknown
 * subcommand error, so the plugin would silently pass every command through.
 * A develop build reports `0.49.0` because release-please only bumps Cargo.toml
 * on master — the warning is then accurate, since such a build has no release
 * version at all.
 */
const MIN_RTK_VERSION: [number, number, number] = [0, 51, 1]

/**
 * True when `banner` names a release that is at or above MIN_RTK_VERSION.
 *
 * An unparseable banner passes: a future rtk may change the format, and an
 * unknown version is not evidence of an old one. The delegation call still
 * fails open on anything unusable.
 */
export function isRtkVersionSupported(banner: string): boolean {
  const m = banner.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return true
  const found = m.slice(1).map(Number)
  for (let i = 0; i < 3; i++) {
    if (found[i] !== MIN_RTK_VERSION[i]) return found[i] > MIN_RTK_VERSION[i]
  }
  return true
}

/**
 * Registers hooks only against an rtk that runs and is new enough to answer
 * `rtk hook opencode`.
 */
async function ensureRtkUsable(): Promise<boolean> {
  const rtkBin = resolveRtkPath()
  if (!rtkBin) {
    console.warn("[rtk] rtk binary not found — plugin disabled")
    return false
  }

  const banner = await probeRtkVersion(rtkBin)
  if (banner === null) {
    console.warn(`[rtk] ${rtkBin} did not answer \`rtk --version\` — plugin disabled`)
    return false
  }
  if (!isRtkVersionSupported(banner)) {
    const need = MIN_RTK_VERSION.slice(1).join(".")
    console.warn(
      `[rtk] rtk ${banner} has no \`hook opencode\` subcommand (need >= ${need}) — plugin disabled`
    )
    return false
  }
  return true
}

/**
 * Universal OpenCode plugin for RTK.
 * Exports a plain object with `id` and `setup(ctx)` matching OpenCode 2.x Schema validation,
 * with a `server()` method for OpenCode 1.x (1.18.29+) dual-shape compatibility.
 */
const RtkOpenCodePlugin = {
  id: "rtk",

  // OpenCode 2.x entrypoint
  async setup(ctx: any) {
    if (!(await ensureRtkUsable())) return
    await ctx?.tool?.hook?.("execute.before", (e: any) => handleToolHook(e?.tool, e?.input))
  },

  // OpenCode 1.x entrypoint (supported via dual-shape in 1.18.29+)
  async server() {
    if (!(await ensureRtkUsable())) return {}
    return {
      "tool.execute.before": (input: any, output: any) => handleToolHook(input?.tool, output?.args),
    }
  },
}

export default RtkOpenCodePlugin
export { RtkOpenCodePlugin }
