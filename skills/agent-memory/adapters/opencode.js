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

function messageText(message) {
  if (!message || typeof message !== "object") return ""
  if (typeof message.content === "string") return message.content
  if (typeof message.text === "string") return message.text
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  }
  return ""
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
    // Mutate the parts array in place: OpenCode keeps its own reference, so
    // reassigning output.parts would be silently ignored.
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

  // message.updated and session.idle are event-bus types, not top-level
  // hooks; they only arrive through the generic `event` hook.
  event: async ({ event }) => {
    if (!event || typeof event !== "object") return
    const properties = event.properties || {}
    if (event.type === "message.updated") {
      const message = properties.info || properties.message || properties
      if (message?.role && message.role !== "assistant") return
      // Streaming updates fire repeatedly; capture only the completed state
      // so event-id dedupe does not pin an empty early snapshot.
      if (message?.time && !message.time.completed) return
      invoke(
        "assistant_stop",
        {
          cwd: directory,
          session_id: message?.sessionID || properties?.sessionID,
          event_id: message?.id || properties?.messageID,
          last_assistant_message: messageText(message),
        },
        15000,
      )
      return
    }
    if (event.type === "session.idle") {
      invoke(
        "session_end",
        {
          cwd: directory,
          session_id: properties?.sessionID || properties?.id,
          event_id: properties?.sessionID || properties?.id,
        },
        15000,
      )
    }
  },
})
