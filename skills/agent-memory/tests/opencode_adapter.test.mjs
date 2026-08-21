// Regression guard for the OpenCode adapter: a recall part must carry an id
// OpenCode accepts. A hand-made id fails schema decode and throws while the
// user message is saved, killing the turn instead of failing open.
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PART_ID = /^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/

const workdir = mkdtempSync(join(tmpdir(), "agent-memory-opencode-"))
const stub = join(workdir, "stub.py")
writeFileSync(
  stub,
  [
    "import json, os, sys",
    "sys.stdin.read()",
    'print(json.dumps({"context": os.environ.get("STUB_CONTEXT", "")}))',
  ].join("\n"),
)

process.env.AGENT_MEMORY_PYTHON = "python3"
process.env.AGENT_MEMORY_SCRIPT = stub
process.env.STUB_CONTEXT = "<agent-memory>recalled</agent-memory>"

// The adapter reads its env at module load, so import after setting it.
const { AgentMemoryPlugin } = await import("../adapters/opencode.js")
const hooks = await AgentMemoryPlugin({ directory: workdir })

async function chat() {
  const output = {
    message: { sessionID: "ses_test", id: "msg_test" },
    parts: [{ id: "prt_000000000000abcdefghijklmn", type: "text", text: "hi" }],
  }
  await hooks["chat.message"]({ sessionID: "ses_test" }, output)
  return output.parts
}

const first = await chat()
assert.equal(first.length, 2, "recall part was not injected")
const injected = first[1]
assert.match(injected.id, PART_ID, `invalid OpenCode part id: ${injected.id}`)
assert.equal(injected.id.length, 30)
assert.equal(injected.type, "text")
assert.equal(injected.synthetic, true)
assert.equal(injected.sessionID, "ses_test")
assert.equal(injected.messageID, "msg_test")
assert.equal(injected.text, process.env.STUB_CONTEXT)

const second = await chat()
assert.match(second[1].id, PART_ID)
assert.notEqual(second[1].id, injected.id, "part ids must be unique")
assert.ok(second[1].id > injected.id, "part ids must sort ascending")

process.env.STUB_CONTEXT = ""
const empty = await chat()
assert.equal(empty.length, 1, "no part may be injected without recall context")

console.log("opencode adapter: ok")
