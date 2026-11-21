# peer-review — CLI adapter notes

**Source of truth for invocation:** the `build_cmd()` function in
`scripts/run-peer-review.sh`. Do NOT duplicate command-line arguments here —
they drift. This file holds only the per-CLI characteristics a reviewer
needs to know when picking or troubleshooting.

| CLI | sandbox posture | notes |
|---|---|---|
| `codex` | sandbox-enforced read-only | Default reviewer. |
| `claude` | plan mode, read-only tools | Headless `-p` in `plan` permission mode with only `Read`, `Glob`, `Grep` and an empty strict MCP config — no edit, shell, or MCP tools. |
| `opencode` | temporary read-only agent | Runs headlessly with a generated `peer-review-readonly-*` agent (written to `<repo>/.opencode/agent/`, removed after the run) that denies edit/shell/network/delegation tools. 1.x: `opencode --pure run --agent <agent>`, effort as `--variant`; the agent denies those tools by name. 2.x (no `--pure`): `opencode run --standalone --archived --agent <agent>`, a private server started in the repo root so the agent file is loaded; the agent denies every tool (`"*": deny`) and allows only `read` (except `.env` files), `grep`, `glob`, `list`, because 2.x adds tools a name list misses (code-mode `execute`, `opencode_worktree_create`, `opencode_session_move`, image generation); effort as the model's `#<effort>` suffix (dropped when no model is set). A 2.x build without `--standalone` is refused rather than run on the shared background service. Model names without a slash are automatically prefixed with `opencode/`. ANSI color codes are stripped from output. |
| `agy` | sandbox-restricted | Runs headlessly via `agy -p` with `--sandbox` in plan mode. Forward model flag if configured. |

The wrapper feeds the prompt over stdin where the CLI supports it; `agy`
receives the prompt through `-p` (its headless prompt interface). Because the
whole prompt is passed as an `agy` argv value, the command-line limit applies
to `agy` alone; the other CLIs read the prompt from stdin and are unaffected.
On Windows (Git Bash/MSYS) the whole command line is capped at 32,767
characters, roughly a 30k-character plan once the review instructions are
added; the wrapper estimates the line and reports
`ERROR=<reviewer> prompt too large ...` (exit 2 when it is the only reviewer)
without starting `agy`. On macOS/Linux the cap is `ARG_MAX` (~1–2 MB, `E2BIG`).
Prefer a stdin-capable reviewer for large plans. Exact flag spellings, model selection, and
effort plumbing live in `build_cmd()` — read the function, do not mirror its
argv here.

## Reviewer-selection guidance

- Reviewers sharing a backing model give weaker signal when paired
  (e.g. `codex` + `opencode` if opencode is configured to a GPT-family
  model). Mix vendors when in doubt.
- The wrapper detects only exact effective overlap: same CLI plus the same
  model after adapter normalization, or same CLI with both models omitted. It emits
  `reviewer_backend_overlap`; effort variants in that group count as one
  signal during synthesis. It deliberately does not infer cross-CLI model
  families.
- Self-review (`--reviewer=0` or naming the host CLI) is a deliberate
  fresh-context pass against the same CLI. Signal is weaker than a
  cross-vendor review when models overlap — treat it like any other
  review, do not weight it as if from an independent reviewer.

Used from: `SKILL.md` step 3 (Invoke the script) and step 4 (Report to
the user).
