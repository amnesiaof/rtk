import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

let cachedRtkPath: string | null = null

function expandHome(filepath: string): string {
  if (filepath === "~" || filepath.startsWith("~/") || filepath.startsWith("~\\")) {
    return join(homedir(), filepath.slice(1))
  }
  return filepath
}

/**
 * Resolves the rtk binary from RTK_BIN, standard PATH, or common installation directories.
 */
export function resolveRtkPath(): string | null {
  if (cachedRtkPath && existsSync(cachedRtkPath)) {
    return cachedRtkPath
  }

  const envBin = process.env.RTK_BIN
  if (envBin) {
    const expanded = expandHome(envBin)
    if (existsSync(expanded)) {
      cachedRtkPath = expanded
      return expanded
    }
  }

  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean)
  const home = homedir()
  const extraDirs = [
    join(home, ".local", "bin"),
    join(home, ".cargo", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]
  const allDirs = [...dirs, ...extraDirs]
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""]

  for (const dir of allDirs) {
    for (const ext of exts) {
      const fullPath = join(dir, `rtk${ext}`)
      if (existsSync(fullPath)) {
        cachedRtkPath = fullPath
        return fullPath
      }
    }
  }

  cachedRtkPath = null
  return null
}

/**
 * Invokes `rtk rewrite <command>`.
 * Handles exit code 0 (Allow) and exit code 3 (Ask/Default).
 * Discards partial stdout if the process was terminated, killed by timeout,
 * or exited with non-rewrite error codes (Deny: 2, Defer: 1).
 */
export function runRtkRewrite(
  rtkBin: string,
  command: string,
  timeoutMs = 3000
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      rtkBin,
      ["rewrite", command],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
      (error, stdout) => {
        // Discard any partial stdout on timeout or kill signals
        if (error) {
          if (error.killed || Boolean(error.signal)) {
            return resolve(null)
          }

          // In Node child_process, error.code can be a number (exit code) or string (e.g. 'ENOENT').
          // rtk returns 3 for valid Ask/Default rewrites. Reject all other non-zero codes (1, 2, etc.).
          const exitCode = (error as unknown as { code?: number | string }).code
          if (exitCode !== 3) {
            return resolve(null)
          }
        }

        const output = String(stdout ?? "").trim()
        if (output && output !== command) {
          resolve(output)
        } else {
          resolve(null)
        }
      }
    )
  })
}

export async function tryRewriteCommand(
  toolName: string,
  command: unknown
): Promise<string | null> {
  const tool = String(toolName ?? "").toLowerCase()
  if (tool !== "bash" && tool !== "shell") return null
  if (typeof command !== "string" || !command.trim()) return null

  const rtkBin = resolveRtkPath()
  if (!rtkBin) return null

  try {
    return await runRtkRewrite(rtkBin, command)
  } catch {
    return null
  }
}

/**
 * Universal OpenCode plugin for RTK.
 * Supports both OpenCode 2.0 (via .id and .setup) and OpenCode 1.x (callable function).
 */
async function RtkOpenCodePlugin(ctx?: any) {
  if (!resolveRtkPath()) {
    console.warn("[rtk] rtk binary not found — plugin disabled")
    return {}
  }

  // OpenCode 1.x hook map
  return {
    "tool.execute.before": async (input: any, output: any) => {
      const args = output?.args
      if (!args || typeof args !== "object") return

      const rewritten = await tryRewriteCommand(input?.tool, args.command)
      if (rewritten) {
        args.command = rewritten
      }
    },
  }
}

// OpenCode 2.0 definition
RtkOpenCodePlugin.id = "rtk"
RtkOpenCodePlugin.setup = async function (ctx: any) {
  if (!resolveRtkPath()) {
    console.warn("[rtk] rtk binary not found — plugin disabled")
    return
  }

  if (ctx?.tool?.hook) {
    await ctx.tool.hook("execute.before", async (event: any) => {
      const input = event?.input
      if (!input || typeof input !== "object") return

      const rewritten = await tryRewriteCommand(event?.tool, input.command)
      if (rewritten) {
        input.command = rewritten
      }
    })
  }
}

export default RtkOpenCodePlugin
export { RtkOpenCodePlugin }