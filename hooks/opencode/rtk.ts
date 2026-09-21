import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"

let cachedRtkPath: string | null | undefined

/**
 * Resolves the rtk binary from RTK_BIN, standard PATH, or common installation directories.
 */
function resolveRtkPath(): string | null {
  if (cachedRtkPath !== undefined) return cachedRtkPath

  const envBin = process.env.RTK_BIN
  if (envBin && existsSync(envBin)) {
    return (cachedRtkPath = envBin)
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
        return (cachedRtkPath = fullPath)
      }
    }
  }

  return (cachedRtkPath = null)
}

/**
 * Invokes `rtk rewrite <command>`.
 * Note: rtk rewrite can exit with code 0 or 3 on success, so we inspect stdout
 * regardless of whether child_process emitted a non-zero exit error.
 */
function runRtkRewrite(rtkBin: string, command: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      rtkBin,
      ["rewrite", command],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
      (_error, stdout) => {
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

async function tryRewriteCommand(
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
 * Supports both OpenCode V2 (via .id and .setup) and OpenCode V1 (via function call).
 */
async function RtkOpenCodePlugin(ctx?: any) {
  // OpenCode V1 fallback (function invocation returning hook map)
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

// OpenCode V2 definition
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