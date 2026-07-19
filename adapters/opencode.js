// AGENT_MEMORY_OPENCODE_ADAPTER_V2
// Fail-open semantic event bridge. The Python boundary performs redaction,
// retention, activation, and provider filtering.
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const skillRoot = join(homedir(), ".agents", "skills", "agent-memory")
const script = process.env.AGENT_MEMORY_SCRIPT || join(skillRoot, "scripts", "memory.py")
const python =
  process.env.AGENT_MEMORY_PYTHON ||
  [join(skillRoot, ".venv", "bin", "python"), join(skillRoot, ".venv", "Scripts", "python.exe")].find(existsSync) ||
  "python3"

function invoke(event, payload, timeout = 5000) {
  try {
    const result = spawnSync(
      python,
      [script, "hook", "--harness", "opencode", "--event", event],
      {
        input: JSON.stringify(payload || {}),
        encoding: "utf8",
        timeout,
        maxBuffer: 1024 * 1024,
      },
    )
    if (result.status !== 0 || !result.stdout) return {}
    const value = JSON.parse(result.stdout)
    return value && typeof value === "object" ? value : {}
  } catch {
    return {}
  }
}

function textPrompt(output) {
  return (output?.parts || [])
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

export const AgentMemoryPlugin = async ({ directory }) => ({
  "chat.message": async (input, output) => {
    const prompt = textPrompt(output)
    if (!prompt.trim()) return
    const recalled = invoke("user_prompt", {
      ...input,
      cwd: directory,
      prompt,
      session_id: output?.message?.sessionID || input?.sessionID,
      event_id: output?.message?.id,
    })
    if (!recalled.context) return
    output.parts.push({
      id: `agent-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      sessionID: output.message.sessionID,
      messageID: output.message.id,
      type: "text",
      text: recalled.context,
      synthetic: true,
    })
  },

  "tool.execute.after": async (input, output) => {
    invoke("tool_completed", {
      ...input,
      cwd: directory,
      tool_name: input?.tool || input?.name,
      tool_input: input?.args || input?.input,
      tool_response: output,
      session_id: input?.sessionID,
      event_id: input?.callID || input?.id,
    })
  },

  "message.updated": async (input, output) => {
    const message = output?.message || input?.message || output || input
    if (message?.role && message.role !== "assistant") return
    invoke("assistant_stop", {
      cwd: directory,
      session_id: message?.sessionID || input?.sessionID,
      event_id: message?.id || input?.messageID,
      last_assistant_message: message?.content || message?.text || output?.text || "",
    }, 15000)
  },

  "session.idle": async (input) => {
    invoke("session_end", {
      ...input,
      cwd: directory,
      session_id: input?.sessionID || input?.id,
      event_id: input?.eventID || input?.id,
    }, 15000)
  },
})
