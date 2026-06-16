# peer-review — CLI adapter notes

**Source of truth for invocation:** the `build_cmd()` function in
`scripts/run-peer-review.sh`. Do NOT duplicate command-line arguments here —
they drift. This file holds only the per-CLI characteristics a reviewer
needs to know when picking or troubleshooting.

| CLI | sandbox posture | notes |
|---|---|---|
| `codex` | sandbox-enforced read-only | Default reviewer. |
| `claude` | permission-system gated | Relies on the CLI's interactive permission grants. |
| `qwen` | plan-mode (read-only) | |
| `opencode` | permission-default gated | ANSI color codes are stripped from saved output. |

All supported reviewers accept the prompt over stdin. Exact flag spellings,
model selection, and effort plumbing live in `build_cmd()` — read the
function, do not mirror its argv here.

## Reviewer-selection guidance

- Reviewers sharing a backing model give weaker signal when paired
  (e.g. `codex` + `opencode` if opencode is configured to a GPT-family
  model). Mix vendors when in doubt.
- Self-review (`--reviewer=0` or naming the host CLI) is a deliberate
  fresh-context pass against the same CLI. Signal is weaker than a
  cross-vendor review when models overlap — treat it like any other
  review, do not weight it as if from an independent reviewer.

Used from: `SKILL.md` step 3 (Invoke the script) and step 4 (Report to
the user).
