import type { Plugin } from "@opencode-ai/plugin"

// RTK OpenCode plugin, LEGACY variant — for OpenCode <= 1.3.3 only.
//
// Install it with `rtk init -g --opencode --opencode-legacy`, which
// `rtk init -g --opencode` does automatically for those versions. On
// OpenCode >= 1.3.4 and 2.x use rtk.ts instead: those loaders call every
// export as `fn(input)`, so the object rtk.ts default-exports is not callable
// (OpenCode 1.1.4 exits 1 at startup, 1.3.3 logs "failed to load plugin").
// The two cannot be one file — the 2.x loader rejects a function default, and
// these loaders reject an object default.
//
// This is the plugin develop shipped, kept as-is: it delegates to
// `rtk hook opencode` (the single source of truth, src/discover/registry.rs),
// which judges the command against OpenCode's own permission rules and answers
// `{}` whenever the rewrite would change what those rules decide (#4195).
//
// It needs Bun's `$` shell helper and `which`, so it only works on OpenCode
// CLI, not Desktop/Electron or Windows. That is fine: those need 1.3.4+ or 2.x
// anyway, and rtk.ts is the file for them.

type Answer = { command?: string }

export const RtkOpenCodePlugin: Plugin = async ({ $ }) => {
  try {
    await $`which rtk`.quiet()
  } catch {
    console.warn("[rtk] rtk binary not found in PATH — plugin disabled")
    return {}
  }

  return {
    "tool.execute.before": async (input, output) => {
      const tool = String(input?.tool ?? "").toLowerCase()
      if (tool !== "bash" && tool !== "shell") return
      const args = output?.args
      if (!args || typeof args !== "object") return

      const command = (args as Record<string, unknown>).command
      if (typeof command !== "string" || !command) return

      try {
        const result = await $`rtk hook opencode ${command}`.quiet().nothrow()
        const answer = JSON.parse(String(result.stdout).trim() || "{}") as Answer
        if (answer.command && answer.command !== command) {
          ;(args as Record<string, unknown>).command = answer.command
        }
      } catch {
        // rtk hook opencode failed or answered nothing — pass through unchanged
      }
    },
  }
}

export default RtkOpenCodePlugin
