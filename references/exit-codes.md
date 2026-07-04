# peer-review — script exit codes

Source of truth: `scripts/run-peer-review.sh` (search for `exit ` lines).
This table mirrors what the script emits; when the script changes, update
both.

| code | meaning | what to tell user |
|---|---|---|
| 0 | ok — at least one reviewer succeeded (partial failures still on `ERROR=` lines) | report the `REVIEW=` lines |
| 2 | usage / invalid argument (incl. bash < 4, empty plan) | show stderr |
| 3 | reviewer CLI not on PATH | "<reviewer> CLI not found — install or check PATH" |
| 4 | filename claim failed | "couldn't claim a unique review filename — concurrent runs?" |
| 5 | (single reviewer) returned empty/whitespace-only output | "<reviewer> returned empty response — try again or check CLI" |
| 6 | (multi reviewer) every reviewer failed | summarize the `ERROR=` lines on stderr |
| 124 | (single reviewer) timed out | "<reviewer> timed out after Ns — try a different reviewer or raise `--timeout`" |
| 130 / 143 | interrupted (SIGINT) / terminated (SIGTERM/SIGHUP) | the run was cancelled; nothing was saved |
| other | (single reviewer) reviewer's own error exit | show stderr |

**Single-reviewer passthrough caveat.** In single-reviewer mode a non-zero
result is the reviewer CLI's *own* exit status (see the last row). If that
status happens to be `2`/`3`/`5`/`6`, it is indistinguishable by number alone
from the script's own codes above. Disambiguate via the stderr text (the
script's own failures print `usage`, `not found on PATH`, `empty/whitespace`,
etc.) rather than trusting the numeric code in this mode.

Used from: `SKILL.md` step 4 (Report to the user).
