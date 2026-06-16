# peer-review — profile config (`.peer-review.json`)

A JSON config can name multiple "profiles" — each binds a label to a CLI
plus optional `model` / `effort`. This lets the same CLI run with different
settings in one review.

## Schema

```json
{
  "reviewers": {
    "codex-deep":  { "cli": "codex",   "model": "gpt-5",        "effort": "high" },
    "codex-fast":  { "cli": "codex",   "model": "gpt-5-mini",   "effort": "low"  },
    "claude-opus": { "cli": "claude",  "model": "claude-opus-4-7" }
  }
}
```

- `cli` — required unless the profile name itself is one of the known CLI
  names (`codex`, `claude`, `opencode`, `agy`).
- `model` — optional. Forwarded to the CLI's model flag. Omit to let the
  CLI use whatever it defaults to.
- `effort` — optional. Applied where supported (currently codex and
  opencode); silently ignored elsewhere.
- An empty profile entry (`"opencode": { "cli": "opencode" }`) is
  equivalent to `--reviewer=opencode` with no config at all.

Exact flag spellings for `model` and `effort` live in `build_cmd()` in
`scripts/run-peer-review.sh` — do not duplicate them here.

## Search order

1. `<repo>/.peer-review.json` (project-local override)
2. `${XDG_CONFIG_HOME:-~/.config}/peer-review/config.json` (global)
3. none

Requires `python3` to parse. Without it, the script logs a warning and
falls back to the no-config behavior.

## Profile-name rules

- `[A-Za-z0-9._-]+`.
- The same `cli` may back several profiles (`codex-deep` + `codex-fast`).
  Each profile gets its own review file.
- Names matching `^[0-9]+$` or `^[0-9]+-[0-9]+$` (e.g. `"3"`, `"1-2"`) are
  rejected to avoid clashing with index/range notation.
- Profiles are listed in JSON-file order; `--reviewer=N` refers to the
  N-th entry (1-based), `--reviewer=L-H` to a contiguous range. Use the
  `list` subcommand to see the current index map.

Used from: `SKILL.md` step 1 (Parse arguments) when resolving
`--reviewer=<profile|index|range>`.
