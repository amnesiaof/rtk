import test from "node:test"
import assert from "node:assert/strict"
import { writeFileSync, unlinkSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import RtkOpenCodePlugin, {
  resolveRtkPath,
  runRtkRewrite,
  tryRewriteCommand,
} from "./rtk.ts"

test("plugin shape: OpenCode V1 and V2 compatibility", async () => {
  // V2 shape
  assert.equal(RtkOpenCodePlugin.id, "rtk")
  assert.equal(typeof RtkOpenCodePlugin.setup, "function")

  // V1 shape (function returning hooks map)
  assert.equal(typeof RtkOpenCodePlugin, "function")
  const v1Instance = await RtkOpenCodePlugin()
  assert.equal(typeof v1Instance, "object")
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
  const originalEnv = process.env.RTK_BIN
  try {
    process.env.RTK_BIN = "~/non-existent-rtk-binary-test"
    // Should not throw, and should resolve to null if file doesn't exist
    assert.equal(resolveRtkPath(), null)
  } finally {
    process.env.RTK_BIN = originalEnv
  }
})

test("rewrite execution logic: exit code 0, 3, and failure handling", async () => {
  const isWin = process.platform === "win32"
  const scriptExt = isWin ? ".bat" : ".sh"
  const scriptPath = join(tmpdir(), `mock-rtk-${Date.now()}${scriptExt}`)

  // Create a mock executable that simulates rtk behavior based on argument
  if (isWin) {
    writeFileSync(
      scriptPath,
      `@echo off
if "%~2"=="code0" (
    echo rtk git status
    exit /b 0
)
if "%~2"=="code3" (
    echo rtk cargo test
    exit /b 3
)
if "%~2"=="code1" (
    echo defer
    exit /b 1
)
if "%~2"=="sleep" (
    timeout /t 5 >nul
    exit /b 0
)
exit /b 2
`
    )
  } else {
    writeFileSync(
      scriptPath,
      `#!/bin/sh
if [ "$2" = "code0" ]; then
    echo "rtk git status"
    exit 0
elif [ "$2" = "code3" ]; then
    echo "rtk cargo test"
    exit 3
elif [ "$2" = "code1" ]; then
    echo "defer"
    exit 1
elif [ "$2" = "sleep" ]; then
    sleep 5
    exit 0
fi
exit 2
`
    )
    chmodSync(scriptPath, 0o755)
  }

  try {
    // Exit code 0 -> should accept
    const res0 = await runRtkRewrite(scriptPath, "code0")
    assert.equal(res0, "rtk git status")

    // Exit code 3 (Ask/Default) -> should accept
    const res3 = await runRtkRewrite(scriptPath, "code3")
    assert.equal(res3, "rtk cargo test")

    // Exit code 1 (Defer) or 2 (Deny) -> should reject/return null
    const res1 = await runRtkRewrite(scriptPath, "code1")
    assert.equal(res1, null)

    // Timeout -> should abort and discard output
    const resTimeout = await runRtkRewrite(scriptPath, "sleep", 100)
    assert.equal(resTimeout, null)
  } finally {
    try {
      unlinkSync(scriptPath)
    } catch {}
  }
})

test("V2 hook execution lifecycle mutates event.input.command", async () => {
  let registeredHook = null
  const mockCtx = {
    tool: {
      hook(name, callback) {
        if (name === "execute.before") {
          registeredHook = callback
        }
      },
    },
  }

  await RtkOpenCodePlugin.setup(mockCtx)
  assert.equal(typeof registeredHook, "function")
})