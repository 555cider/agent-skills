# OKF-Compatible Topics

Use OKF-style Markdown frontmatter for manually maintained topic concept files
in `topics/` when metadata helps agents search, exchange, or cite longer
knowledge documents. This does not change the skill's own `SKILL.md`
frontmatter contract.

Recommended topic shape:

```markdown
---
type: AgentMemoryTopic
title: Verification Policy
description: How to scope checks for documentation and small edits.
resource: repo://agent-skills/verification-policy
tags: [verification, docs]
timestamp: 2026-07-01T00:00:00Z
---

# Verification Policy
...
```

Only `type` is required for OKF compatibility. Prefer `title`, `description`,
`resource`, `tags`, and `timestamp` when known; `tags` may use inline YAML
list syntax or a simple block list. Keep the Markdown body as the source of
truth; frontmatter is for discovery and exchange. Use `index.md` for a local
table of contents and `log.md` for chronological notes when a topic directory
needs them; treat those names as reserved support files, not concept files.

Topics are loaded by `find` only when a query matches them or `--include-topics`
is passed, so a bare `find` never dumps the entire topic corpus.
