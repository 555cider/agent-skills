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

List every review file, then cluster material issues across reviews. Report as:

```
Peer review complete (<source: file|chat>)   ("리뷰 완료")
[+ EXCLUDE_NOTE if present, on its own line]
[+ for each WARN= on stdout: show the line verbatim]
[+ for each ERROR= on stderr: "<reviewer> failed: <msg>" line]   ("<reviewer> 실패")

Review files:
- <reviewer-1> -> <path-1>
- <reviewer-2> -> <path-2>

Shared findings:   ("공통 지적")
- [adopt|adapt|reject] <issue> — reviewers: <names>; evidence: <verified|unverified>; <host reason>

Disputed findings:   ("의견 충돌")
- [adopt|adapt|reject] <issue> — <reviewer positions>; evidence: <verified|unverified>; <host reason>

Single-reviewer findings:   ("단독 지적")
- [adopt|adapt|reject] <issue> — reviewer: <name>; evidence: <verified|unverified>; <host reason>
```

Render every category; use `none` in the user's language when it is empty so
an empty category is distinguishable from an omitted synthesis. A
`WARN=reviewer_backend_overlap ... reviewers=a,b` line makes `a,b` one signal
when deciding whether a finding is shared. It does not suppress either review.

Before an `adopt` or `adapt` verdict relies on a repository fact, open the
cited source and verify it. If that is impossible, mark the evidence
`unverified` and convert the claim into a verification step. Never infer
cross-CLI model identity that the wrapper did not report, and never treat
agreement by itself as proof.

Used from: `SKILL.md` step 4 (Report to the user).
