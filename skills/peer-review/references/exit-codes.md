# peer-review — script exit codes

Source of truth: `scripts/run-peer-review.sh` (search for `exit ` lines).
This table mirrors what the script emits; when the script changes, update
both.

| code | meaning | what to tell user |
|---|---|---|
| 2 | usage / invalid argument | show stderr |
| 3 | reviewer CLI not on PATH | "<reviewer> CLI not found — install or check PATH" |
| 4 | filename claim failed | "couldn't claim a unique review filename — concurrent runs?" |
| 5 | (single reviewer) returned empty/whitespace-only output | "<reviewer> returned empty response — try again or check CLI" |
| 6 | (multi reviewer) every reviewer failed | summarize the `ERROR=` lines on stderr |
| 124 | (single reviewer) timed out | "<reviewer> timed out after Ns — try a different reviewer or raise `--timeout`" |
| other | (single reviewer) reviewer's own error exit | show stderr |

Used from: `SKILL.md` step 4 (Report to the user).
