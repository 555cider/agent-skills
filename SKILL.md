---
name: step-back
description: "Reassess before declaring a task or plan complete, before the third repeated check, or after more than 15 tool calls on one subgoal. Check requested coverage, evidence, and whether the next action adds useful information. Do not use to narrow the user's requested scope or replace required verification."
license: MIT
compatibility: Prompt only. No scripts, no dependencies, no network.
---

# Step Back

Catch both incomplete delivery and investigation that has stopped teaching anything.
Use the user's language. Report the reassessment in one useful line when it changes
the course or when handing over the completed result; do not substitute a status
announcement for the actual decision.

## Tripwires

- **T1:** Before declaring implementation, review, or a plan complete.
- **T2:** Before the **third** occurrence of the same failure or repeated check.
- **T3:** After more than **15** tool calls on one subgoal, counted **per subgoal**.

These are checkpoints, not automatic stop commands. A long, explicitly thorough
review still deserves reassessment; its size alone is not a reason to interrupt it.

## T1: Is the requested result actually covered?

Re-read the original request and accepted steering. Ask:

> If I threw this away and did it again, what would I do differently?

Classify the answer before acting:

- A missing requested item, wrong behavior, unsupported conclusion, or missing
  necessary evidence means finish that work before claiming completion.
- An optional refactor, new feature, or style preference is not a new completion
  gate. Leave it out or name it as optional when it matters.
- A real blocker means complete independent authorized work and report precisely
  what remains and why.

For a review of multiple components, account for each requested component. Reading
two deeply does not justify a conclusion about the rest. Distinguish verified
findings, inspection-based concerns, and untested hypotheses. Passing packaging or
text checks is not evidence of model behavior or a rendered outcome.

Before handing over, identify what is left. Do not say "nothing" when required
coverage is unexamined. An honest limitation is useful, but does not excuse skipping
work that is still feasible and in scope.

## T2/T3: Is the next action informative?

Ask:

> What exactly am I trying to learn by continuing? One sentence.

Name the evidence or changed hypothesis the next action will test. Repeating after
a relevant code change, a controlled fixture change, or a new observation can be
useful. Repeating an unchanged check without new information is not.

On repeated firing, reassess the evidence gained since the previous checkpoint:
change the hypothesis or method when it taught nothing. Continue autonomously
when there is a concrete, authorized next step. Ask the user only when a missing
choice, authority, or inaccessible resource prevents meaningful progress; state
that dependency rather than citing the tool count as the reason.

The number of failures alone does not prove the hypothesis false: distinguish an
unchanged assertion failure from a transient environment problem and from a test
that now fails differently. Do not restart successful tests without a new reason.

## Scope and effort

- Preserve the user's requested scope. Reduce redundant investigation, not the
  deliverable. Explicit thoroughness requests justify more work, not blind retries.
- Match verification to the consequences of a mistake. A reversible copy edit and
  a destructive migration need different evidence.
- Prior effort does not justify more effort. The next action's expected information
  and the remaining acceptance criteria do.
- A checkpoint must produce a decision: fix a gap, continue with a stated reason,
  change the method, or report a concrete blocker.

## Boundaries

Use available verification evidence before judging completion. When available,
`superpowers:verification-before-completion` supports evidence checks and
`superpowers:systematic-debugging` supports testing a new causal hypothesis.
Neither is a prerequisite dependency: apply the same principles locally if those
skills are unavailable. This skill does not authorize extra edits or external actions.
