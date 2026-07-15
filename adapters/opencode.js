// AGENT_MEMORY_OPENCODE_ADAPTER
// Shared, fail-open prompt recall for OpenCode. No npm dependencies required.
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { join } from "node:path"

const script =
  process.env.AGENT_MEMORY_SCRIPT ||
  join(homedir(), ".agents", "skills", "agent-memory", "scripts", "memory.py")

export const AgentMemoryPlugin = async ({ directory }) => ({
  "chat.message": async (_input, output) => {
    try {
      const prompt = (output.parts || [])
        .filter((part) => part && part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n")
      if (!prompt.trim()) return

      const result = spawnSync(
        "python3",
        [script, "recall", "--harness", "opencode", "--cwd", directory, "--prompt", prompt, "--format", "json"],
        { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 }
      )
      if (result.status !== 0 || !result.stdout) return
      const recalled = JSON.parse(result.stdout)
      if (!recalled.context) return
      output.parts.push({
        id: `agent-memory-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        sessionID: output.message.sessionID,
        messageID: output.message.id,
        type: "text",
        text: recalled.context,
        synthetic: true,
      })
    } catch {
      // Memory must never block or replace the user's prompt.
    }
  },
})
