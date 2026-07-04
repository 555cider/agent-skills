# peer-review — report format (step 4 templates)

How to turn the script's machine-readable stdout/stderr into a user-facing
report. Parse stdout for `REVIEW=<reviewer> <path>` lines and stderr for
`ERROR=<reviewer> <msg>` lines, then branch on exit code and reviewer count.

Translate all header labels to the user's language (Korean example labels in
parentheses).

## Exit non-zero (all reviewers failed)

Surface any `WARN=` lines from stdout verbatim, then show stderr inline. Do
not invent a summary. Stop.

## Exit 0, single REVIEW line, content < 1000 bytes (`wc -c < <path>`)

Inline the full review content to chat.

## Exit 0, single REVIEW line, otherwise

Read the review file, extract the 3-5 most critical bullets (numbered/bulleted
issues, severity language). Report as:

```
<reviewer> review complete -> <path relative to repo or cwd> (<source: file|chat>)   ("<reviewer> 리뷰 완료")
[+ EXCLUDE_NOTE if present, on its own line]
[+ for each WARN= on stdout: show the line verbatim]

Key issues:   ("주요 지적")
- <bullet 1>
- <bullet 2>
- <bullet 3-5>
```

## Exit 0, multiple REVIEW lines

For each reviewer's file, extract its 3-5 most critical bullets. Report as:

```
Peer review complete (<source: file|chat>)   ("리뷰 완료")
[+ EXCLUDE_NOTE if present, on its own line]
[+ for each WARN= on stdout: show the line verbatim]
[+ for each ERROR= on stderr: "<reviewer> failed: <msg>" line]   ("<reviewer> 실패")

<reviewer-1> -> <path-1>
- <bullet>
- <bullet>

<reviewer-2> -> <path-2>
- <bullet>
- <bullet>
```

Used from: `SKILL.md` step 4 (Report to the user).
