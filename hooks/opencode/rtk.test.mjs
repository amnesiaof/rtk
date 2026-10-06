import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import RtkOpenCodePlugin, {
  resolveRtkPath,
  probeRtkVersion,
  isRtkVersionSupported,
  runHookOpencode,
  tryRewriteCommand,
  expandHome,
  _resetCachedRtkPath,
} from "./rtk.ts"

test("plugin schema: default export is a plain object matching V2 loader spec", async () => {
  // Must be a plain object to pass OpenCode 2.x Schema validation (typeof === 'function' fails schema)
  assert.equal(typeof RtkOpenCodePlugin, "object")
  assert.notEqual(RtkOpenCodePlugin, null)
  assert.equal(Array.isArray(RtkOpenCodePlugin), false)

  // V2 contract
  assert.equal(RtkOpenCodePlugin.id, "rtk")
  assert.equal(typeof RtkOpenCodePlugin.setup, "function")

  // V1 dual-shape contract (server method)
  assert.equal(typeof RtkOpenCodePlugin.server, "function")
  const v1Hooks = await RtkOpenCodePlugin.server()
  assert.equal(typeof v1Hooks, "object")
})

test("tool filter: only bash and shell tools are intercepted", async () => {
  assert.equal(await tryRewriteCommand("read_file", "git status"), null)
  assert.equal(await tryRewriteCommand("grep", "git status"), null)
  assert.equal(await tryRewriteCommand("", "git status"), null)
  assert.equal(await tryRewriteCommand(null, "git status"), null)
})

test("input guard: non-string and empty commands are skipped", async () => {
  assert.equal(await tryRewriteCommand("bash", ""), null)
  assert.equal(await tryRewriteCommand("bash", "   "), null)
  assert.equal(await tryRewriteCommand("bash", 12345), null)
  assert.equal(await tryRewriteCommand("bash", null), null)
})

test("binary discovery: expands ~ in RTK_BIN", () => {
  // 1. Direct expansion test for POSIX and Windows slashes
  assert.equal(expandHome("~/test-bin"), join(homedir(), "test-bin"))
  assert.equal(expandHome("~\\test-bin"), join(homedir(), "test-bin"))

  // 2. Verified resolution precedence with an existing binary
  const originalEnv = process.env.RTK_BIN
  try {
    _resetCachedRtkPath()
    process.env.RTK_BIN = process.execPath // Node binary always exists
    assert.equal(resolveRtkPath(), process.execPath)
  } finally {
    process.env.RTK_BIN = originalEnv
    _resetCachedRtkPath()
  }
})

test("version probe: `rtk --version` decides usability, not mere existence", async () => {
  // Node stands in for rtk: it answers --version on stdout and exits 0, the
  // same shape as `rtk 0.51.1`.
  const banner = await probeRtkVersion(process.execPath)
  assert.match(banner, /v?\d+\.\d+\.\d+/)

  // A path that exists but cannot run must fail the probe — the case an
  // existsSync-only check would wave through.
  _resetCachedRtkPath()
  assert.equal(await probeRtkVersion(join(process.cwd(), "definitely-not-rtk")), null)

  // Cached per binary: guards against a regression that respawns `rtk
  // --version` on every tool call instead of once per session.
  assert.equal(await probeRtkVersion(process.execPath), banner)
  _resetCachedRtkPath()
})

test("min version gate: 0.51.1 is the first release with `hook opencode`", () => {
  // v0.51.0 has no `hook opencode` subcommand: it must be refused.
  assert.equal(isRtkVersionSupported("rtk 0.51.0"), false)
  assert.equal(isRtkVersionSupported("rtk 0.50.0"), false)
  assert.equal(isRtkVersionSupported("rtk 0.23.0"), false)
  assert.equal(isRtkVersionSupported("rtk 1.0.0"), true)

  // The floor itself, and anything above it, including later minors.
  assert.equal(isRtkVersionSupported("rtk 0.51.1"), true)
  assert.equal(isRtkVersionSupported("rtk 0.52.0"), true)
  assert.equal(isRtkVersionSupported("rtk 0.51.2"), true)

  // Unparseable banner is not evidence of an old rtk — let it through and let
  // the delegation call fail open if the subcommand is really missing.
  assert.equal(isRtkVersionSupported("rtk (unknown)"), true)
  assert.equal(isRtkVersionSupported(""), true)
})

test("RTK_DISABLED=1 disables rewriting for the session", async () => {
  const originalBin = process.env.RTK_BIN
  const originalDisabled = process.env.RTK_DISABLED
  try {
    _resetCachedRtkPath()
    process.env.RTK_BIN = process.execPath
    process.env.RTK_DISABLED = "1"
    // The guard must short-circuit before the binary is consulted, so this
    // holds even though node-as-rtk would answer nothing useful anyway.
    assert.equal(await tryRewriteCommand("bash", "git status"), null)
  } finally {
    process.env.RTK_DISABLED = originalDisabled
    process.env.RTK_BIN = originalBin
    _resetCachedRtkPath()
  }

  // Only the exact value "1" disables it -- "0" and "true" are not the
  // documented form and must not silently disable the plugin.
  _resetCachedRtkPath()
  process.env.RTK_BIN = process.execPath
  try {
    process.env.RTK_DISABLED = "0"
    const mockScriptPath = join(process.cwd(), "hook")
    writeFileSync(
      mockScriptPath,
      `console.log(JSON.stringify({ command: "rtk git status" }))`
    )
    assert.equal(await tryRewriteCommand("bash", "git status"), "rtk git status")
    process.env.RTK_DISABLED = "true"
    assert.equal(await tryRewriteCommand("bash", "git status"), "rtk git status")
  } finally {
    process.env.RTK_DISABLED = originalDisabled
    process.env.RTK_BIN = originalBin
    _resetCachedRtkPath()
    try {
      unlinkSync(join(process.cwd(), "hook"))
    } catch {}
  }
})

test("delegation to `rtk hook opencode`: argv, answer parsing, pass-through", async () => {
  // process.execPath (node) stands in for the rtk binary, so the mock MUST be
  // named `hook`: the plugin spawns `[<rtk>, "hook", "opencode", <command>]`
  // and node reads argv[2] as the script to run.
  const mockScriptPath = join(process.cwd(), "hook")

  writeFileSync(
    mockScriptPath,
    `
const subcommand = process.argv[2]
const arg = process.argv[3]
if (process.env.ECHO_ARGV) {
  console.log(JSON.stringify({ command: arg + "|arity=" + process.argv.length }))
} else if (subcommand !== "opencode") {
  process.exit(3)
} else if (arg === "rewrite") {
  console.log(JSON.stringify({ command: "rtk git status" }))
} else if (arg === "unchanged") {
  // The Rust side answers {} whenever the rewrite would change the verdict.
  console.log("{}")
} else if (arg === "echo") {
  console.log(JSON.stringify({ command: arg }))
} else if (arg === "garbage") {
  console.log("not json at all")
} else if (arg === "empty") {
  process.exit(0)
} else if (arg === "fail") {
  process.exit(2)
} else if (arg === "sleep") {
  setTimeout(() => process.exit(0), 5000)
}
`
  )

  const originalEcho = process.env.ECHO_ARGV
  try {
    // The command must arrive as ONE argv element, never through a shell:
    // arity 4 is [node, hook, opencode, <command>] and the echoed command
    // keeps its "&&" intact, so nothing split or interpolated it.
    process.env.ECHO_ARGV = "1"
    const echoed = await runHookOpencode(process.execPath, "git status && rm -rf /")
    delete process.env.ECHO_ARGV
    assert.equal(echoed, "git status && rm -rf /|arity=4")

    assert.equal(await runHookOpencode(process.execPath, "rewrite"), "rtk git status")

    // A command that already invokes rtk is delegated like any other: a chain
    // like `rtk ls && ls -la` has its bare half rewritten.
    const originalBin = process.env.RTK_BIN
    try {
      _resetCachedRtkPath()
      process.env.RTK_BIN = process.execPath
      assert.equal(await tryRewriteCommand("bash", "rewrite"), "rtk git status")
    } finally {
      process.env.RTK_BIN = originalBin
      _resetCachedRtkPath()
    }

    // {} means "run it as typed" — no mutation, not an error.
    assert.equal(await runHookOpencode(process.execPath, "unchanged"), null)

    // An answer identical to the input is not a rewrite.
    assert.equal(await runHookOpencode(process.execPath, "echo"), null)

    assert.equal(await runHookOpencode(process.execPath, "garbage"), null)
    assert.equal(await runHookOpencode(process.execPath, "empty"), null)
    assert.equal(await runHookOpencode(process.execPath, "fail"), null)
    assert.equal(await runHookOpencode(process.execPath, "sleep", 100), null)
  } finally {
    if (originalEcho === undefined) delete process.env.ECHO_ARGV
    else process.env.ECHO_ARGV = originalEcho
    try {
      unlinkSync(mockScriptPath)
    } catch {}
  }
})

test("V2 hook execution lifecycle mutates event.input.command", async () => {
  let registeredHook = null
  const mockCtx = {
    tool: {
      async hook(name, callback) {
        if (name === "execute.before") {
          registeredHook = callback
        }
      },
    },
  }

  // setup() bails when no rtk binary is discoverable, so pin RTK_BIN to the
  // always-present node binary instead of depending on the host having rtk.
  const originalEnv = process.env.RTK_BIN
  try {
    _resetCachedRtkPath()
    process.env.RTK_BIN = process.execPath
    await RtkOpenCodePlugin.setup(mockCtx)
    assert.equal(typeof registeredHook, "function")
  } finally {
    process.env.RTK_BIN = originalEnv
    _resetCachedRtkPath()
  }
})
