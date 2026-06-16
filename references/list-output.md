# peer-review — `list` subcommand output

The `list` positional subcommand prints two sections and exits without
running a review. Output shape depends on whether a profile config is
loaded.

## With a config loaded

```
config: <repo>/.peer-review.json

Special:
  #    token        cli        status
  0    self         claude     on PATH

Reviewer CLIs (from config — index callable as --reviewer=N):
  #    profile              cli        model                     effort   status
  1    codex-deep           codex      gpt-5                     high    on PATH
  2    qwen-test            qwen       qwen-3                            not found
  3    claude-opus          claude     claude-opus-4-7                   on PATH
```

## Without a config

```
config: <none>

Special:
  #    token        cli        status
  0    self         claude     on PATH

Reviewer CLIs (no config — on-PATH numbers callable as --reviewer=N):
  #    cli        status
  1         codex      on PATH
  2         claude     on PATH
  3         gemini     on PATH
  -         qwen       not found
  4         opencode   on PATH
```

## Rules

- The `Special` row only renders when `--host=<cli>` is passed. The slash
  command auto-forwards it; from natural-language Codex invocation, the
  caller should pass `--host=codex` too.
- Without a config, numbered selection maps to the on-PATH CLI rows shown
  by `list`; unavailable CLIs render as `-` and cannot be selected by
  number. Named selection (`--reviewer=claude`) is portable across machines.
- `list --help` / `list -h` print the general script help.

Used from: `SKILL.md` step 1 (Parse arguments) when handling list-shaped
requests.
