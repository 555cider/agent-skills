---
name: peer-review
description: Use when the user explicitly asks for a peer review or second opinion on a plan, spec, or design choice, including /peer-review in Claude Code or natural-language requests in Codex.
---

# Peer Review

Get a second opinion on an implementation/design plan, or a recommendation
on a set of options/choices, from one or more reviewer CLIs. Supported:
`codex`, `claude`, `gemini`, `qwen`, `opencode`. Multiple reviewers run in
parallel — each writes its own temporary review file under `.peer-review/`.
The shell mechanics live in `scripts/run-peer-review.sh` next to this SKILL.md.

**All user-facing prompts and reports use the user's language** — Korean
if they speak Korean, English otherwise. Examples below are in English;
adapt headers/labels to match.

## Argument shape

**Claude Code (slash command):**
```
/peer-review                                       # review last plan from chat (default reviewer: codex)
/peer-review <path-to-plan>                        # review a plan file
/peer-review --focus=<area>                        # narrow focus
/peer-review --reviewer=<r>[,<r>...]               # pick reviewer(s); multiple → parallel
/peer-review --reviewer=0                          # self-review (host CLI reviews its own plan, fresh context)
/peer-review --reviewer=2                          # 2nd profile from JSON config (1-based)
/peer-review --reviewer=1-3                        # first three profiles
/peer-review --reviewer=1,3,my-claude              # mix indexes, ranges, and names
/peer-review --timeout=90                          # per-reviewer timeout in seconds
/peer-review list                        # show available reviewers + self row (no review run)
/peer-review --help                      # show usage; no review run
/peer-review <path> --focus=<area> --reviewer=...  # combine
```

`--reviewer` values: `codex`, `claude`, `gemini`, `qwen`, `opencode`, `all`,
`0` (self — the host CLI itself), any **profile name** defined in a JSON
config, or — when a config is loaded — a **1-based index** (`2`) or **range**
(`1-3`) into the profile list (default: `codex`). Pass a comma-separated mix
(e.g. `1,3,my-claude`) to run several in parallel. `all` is a shortcut:
from a slash command, the host model is auto-excluded (see step 3).
Run `list` to see the index map.

**Self-review (`0`).** `--reviewer=0` runs the host CLI as a fresh-context
reviewer. Weaker signal than a cross-vendor review when models overlap.
> See: references/cli-adapters.md

**Listing reviewers (`list` subcommand).** Prints a `Special` (self) row
and a `Reviewer CLIs` table, then exits. Always pass `--host=<your-cli>`.
> See: references/list-output.md

When the user asks for the list — `/peer-review list`, `/peer-review 목록`,
"리뷰어 목록 보여줘", "what reviewers do I have", or similar natural-language
requests — invoke the script with the positional `list` subcommand and
**always pass `--host=<your-cli>`** so the Special row shows up. No plan
file, no `--source` flag, and no `--list` flag — only `list` as a positional
argument is accepted.

When the user asks for usage — `/peer-review --help`, `/peer-review help`,
"peer-review 사용법", or similar natural-language requests — invoke the script
with `--help`. Do not look for a plan-shaped message and do not run a review.

**Profiles (optional).** A JSON config (`<repo>/.peer-review.json` or
`~/.config/peer-review/config.json`) names profiles bound to a CLI plus
optional `model` / `effort`. Profile names accepted on `--reviewer=...`.
> See: references/profile-config.md

**Codex CLI (natural language).** User typically says one of:
- "peer-review docs/path/to/plan.md"
- "get a second opinion on this spec"
- "review the plan I just wrote"

`--focus` values: `all` (default), `feasibility`, `correctness`,
`assumptions`, `repo-fit`, `choice`. Use `choice` when the input is a set
of options rather than a single plan — the reviewer recommends one with
reasoning, lists trade-offs per option, and flags any missed option.

`--timeout=<seconds>` bounds each reviewer process. Default is 300 seconds,
or `PEER_REVIEW_TIMEOUT_SECONDS` when set. Forward the user's timeout when
they provide one. Raise it for known-slow reviewers or large plans; lower it
when a reviewer has recently hung or the user asks not to wait long.

## Workflow

### 1. Parse arguments

- Positional non-flag arg → plan file path
- `--focus=<v>` → focus value (the script validates and errors out on unknowns)
- `--timeout=<seconds>` → forward to the script when present
- `--help` / `help` usage request → run script `--help`, report the output, stop
- No focus given → omit the flag (script defaults to `all`)

### 2. Resolve the plan input

If a file path was given:
- Pass it to the script as the positional arg, with `--source=file`.

If no file path:
- Look back through this conversation for plan-shaped or choice-shaped messages — yours or the user's, excluding the slash-command invocation itself.
  - **Plan-shaped:** an ExitPlanMode block, a numbered design proposal, or a clearly-marked plan/spec section (headers like `## Plan`, `## Design`, `## 설계`).
  - **Choice-shaped:** a recent message presenting alternatives — `Option A / B / C`, `선택지 1 / 2 / 3`, headers like `## Options` / `## 선택지` / `## Choices`, or any "여기 N가지 방법이 있습니다" listing. If `--focus=choice` was passed and no plan-shape candidate exists, prefer the most recent choice-shape candidate.
- **Confidence check:** if the candidate is unambiguous (single recent block, clearly plan- or choice-shaped, no competing candidates), proceed silently. Otherwise show a 5-line preview and ask the user to confirm or supply a different path. Wait for confirmation.
- If confirmed, pass the plan content to the script over stdin using
  `--stdin-plan`. The script implies `--source=chat`, owns repo-local temp
  file creation and cleanup, and validates reviewer arguments before consuming
  stdin. Never create a chat temp file yourself unless the script lacks
  `--stdin-plan`.
- If no candidate at all: tell the user no plan was found in chat and ask for a file path. Stop.

### 3. Invoke the script

```bash
~/.agents/skills/peer-review/scripts/run-peer-review.sh <plan-file> [--reviewer=<list>] [--focus=<v>] [--timeout=<seconds>] --source=file --host=<cli>
```

For chat-sourced input, pipe the exact plan content to:

```bash
~/.agents/skills/peer-review/scripts/run-peer-review.sh --stdin-plan [--reviewer=<list>] [--focus=<v>] [--timeout=<seconds>] --host=<cli>
```

Pass `--host=<your-cli>` (`--host=claude` from Claude Code,
`--host=codex` from Codex CLI) **whenever `--reviewer=0` is in the list** —
the script needs it to resolve `0` to the host CLI and exits with an error
if it's missing. For `all`-expansion you still pass `--exclude-cli=<host>`
(see below) — `--host` does not double as that filter today. Passing
`--host` in other cases is harmless and recommended for consistency.

Reviewer defaults to `codex`, except the script avoids an omitted-reviewer
default that would match `--host` when another reviewer is available.
**Avoid accidental self-review** — exclude the host model from the list unless
the user explicitly opts in via `0` or by name:
- Inside Claude Code: keep `codex` (default), exclude `claude`. Add others
  freely (`--reviewer=codex,gemini,opencode`).
- Inside Codex CLI: pass `--host=codex`; omit `--reviewer` for the script's
  best non-host default, or prefer `--reviewer=claude` when available.
- Reviewers sharing a backing model give weaker signal when paired
  (e.g. `codex` + `opencode` if opencode is configured to a GPT-family model).
  Mix vendors when in doubt.

**Self-review opt-in.** If the user passes `--reviewer=0` (or names the
host CLI directly, e.g. `--reviewer=claude` from Claude Code), forward it
verbatim — do not strip it. Self-review is a deliberate choice.

**Handling `all`:** when the user passes `--reviewer=all` from a slash
command (or natural language equivalent), pass `--exclude-cli=<host>` to
the script along with `--reviewer=all` so the script filters by backing
CLI (works correctly whether or not a config defines profiles):
- Claude Code → `--reviewer=all --exclude-cli=claude`
- Codex CLI   → `--reviewer=all --exclude-cli=codex`

If the user explicitly says they want self-review included (e.g. "all 5",
"claude 포함해서"), omit `--exclude-cli` — the script then expands `all`
without filtering.

The script writes machine-readable lines to stdout — one `REVIEW=` line per
successful reviewer:

```
REVIEW=<reviewer-name> <absolute-path-to-saved-review>
REVIEW=<reviewer-name> <absolute-path-to-saved-review>
EXCLUDE_NOTE=<optional one-line message about .git/info/exclude update>
WARN=<optional machine-readable warning>
```

Failures (per reviewer) go to stderr as `ERROR=<reviewer> <message>`.
Timeouts are reported as `timed out after Ns`; surface that directly instead
of waiting, retrying silently, or summarizing it as an ordinary reviewer error.
The script exits 0 if **at least one** reviewer succeeded; non-zero only
when all failed.

### 4. Report to the user

Capture the script's stdout, stderr, and exit code. Parse stdout for
`REVIEW=<reviewer> <path>` lines; parse stderr for `ERROR=<reviewer> <msg>`
lines. Then:

- **Exit non-zero (all reviewers failed):** surface any `WARN=` lines from stdout verbatim, then show stderr inline. Do not invent a summary. Stop.
- **Exit 0, single REVIEW line, review content size < 200 bytes (`wc -c < <path>`):** inline the full content to chat.
- **Exit 0, single REVIEW line, otherwise:** read the review file, extract 3-5 most critical bullets (numbered/bulleted issues, severity language). Report as:

```
<reviewer> review complete → <path relative to repo or cwd> (<source: file|chat>)
[+ EXCLUDE_NOTE if present, on its own line]
[+ for each WARN= on stdout: show the line verbatim]

Key issues:
- <bullet 1>
- <bullet 2>
- <bullet 3-5>
```

- **Exit 0, multiple REVIEW lines:** for each reviewer's file, extract its 3-5 most critical bullets. Report as:

```
Peer review complete (<source: file|chat>)
[+ EXCLUDE_NOTE if present, on its own line]
[+ for each WARN= on stdout: show the line verbatim]
[+ for each ERROR= on stderr: "<reviewer> failed: <msg>" line]

<reviewer-1> → <path-1>
- <bullet>
- <bullet>

<reviewer-2> → <path-2>
- <bullet>
- <bullet>
```

Translate the header labels to the user's language (e.g. for Korean:
"리뷰 완료", "주요 지적", "<reviewer> 실패").

### 5. Add your own judgment

The review is a second opinion, not a verdict. After the bullets above,
append your own evaluation in the same response.

For each major point: do you agree, partially agree, or disagree, and why?
Cite the specific assumption you accept or reject. The reviewer is a peer,
not an authority — push back on points that overweight a constraint,
misread the repo, or assume more than warranted.

**With multiple reviewers:** call out where they agree (shared concerns are
stronger signal) and where they disagree (the divergence is often the most
informative part — name what each got right and wrong). Don't just average
the takes; weigh each point on its merit.

If you had a prior take on this plan (you wrote it, or you'd recommended
a direction): say whether your position holds or shifted, and why. If you
had no prior stake (the plan came from the user or a third party): focus
on which review points are strongest and which are weakest, with
verification where claims can be checked.

**Red flag in yourself:** the urge to immediately say "설득력 있다" / "the
review is convincing" and pivot to the reviewer's recommendation without
checking each claim. That is agreement-shape behavior, not analysis — slow
down and evaluate point by point before changing position.

### 6. Clean up after follow-up work

Review files are temporary working artifacts. If the same session continues
into implementation or edits based on the review, keep only the needed findings
in your task notes or final summary, then remove the saved review file(s) after
they are no longer needed. Never move review outputs into docs or another
repo-visible path just to preserve them.

## Failure modes

The script's exit codes drive how step 4 reports failure to the user.
> See: references/exit-codes.md

## When to self-invoke

Operator-invoked only by default. Claude Code via `/peer-review` is strictly
operator-invoked — never self-trigger on your own plans.

Codex CLI authorizes narrow proactive self-invocation:
- ✅ After writing a new spec or multi-step plan, before handing off for approval.
- ✅ When the user says "this is a big change, double-check it" or similar.
- ❌ Bug fixes, 1-2 file refactors, doc edits, simple parameter tweaks.
- ❌ When the user already gave a clear plan (review what they wrote only if asked).
- ❌ If the user said "skip review" or similar.

## Boundaries

- Do not auto-trigger on plans you propose (see "When to self-invoke").
- Do not review git diffs (use `codex review` or equivalent directly).
- Do not grant the reviewer CLI write access.
- Do not stream reviewer output; report from the saved review file.
