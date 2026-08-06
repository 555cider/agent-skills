---
name: step-back
description: Use before declaring any work complete, fixed, passing, done, or ready — a plan as much as an implementation — and whenever the same failure, test, or check is about to be seen a third time, or a single subgoal has run past 15 tool calls. Forces two questions you can answer but never ask on your own: was this actually the best available, and is the remaining effort still proportional to the job. Do not use to narrow the scope the user asked for, to skip verification the user requested, or in place of actually running the tests.
license: MIT
compatibility: Prompt only. No scripts, no dependencies, no network.
---

# Step Back

Two failure modes, one dial. Under-invest and you ship the first thing that worked.
Over-invest and you are still verifying something that was fine forty tool calls ago.
Both come from never asking whether the effort matches the job.

You already know the answer. When your human partner interrupts a long grind with
"should this really be taking this long?", you say no — immediately, and you are right.
The judgment was there the whole time. What was missing was a moment when it runs.
This skill is that moment, placed where you cannot move it.

Use the user's language when reporting.

## One dial, two edges

```
  under-invested ──────────────●────────────── over-invested
  "done"                                       "one more check"
  first thing that worked                      circling a wrong hypothesis
```

Both edges are the same failure: no one asked whether the effort matched the job.

## Tripwires

Three, and they are non-negotiable. Each is countable from the transcript — that is
why these three and not others. No rule here is based on elapsed time, because you
have no reliable sense of it.

| | Fires when |
| --- | --- |
| **T1** | You are about to declare work complete, fixed, passing, done, or ready. A plan handed over as final counts. |
| **T2** | You are about to see the same failure, run the same test, or perform the same check for the **third** time. |
| **T3** | A single subgoal has consumed more than **15** tool calls. |

T3 counts **per subgoal**, not per session. A new subgoal resets it. Counting it
session-wide makes it fire constantly, and a tripwire that always fires is ignored.

When a tripwire fires, say so in one line before continuing. The report is what makes
the decision visible; a silent step-back is indistinguishable from not doing it.

## At a tripwire

**T1 — the completion check.** "Was this the best?" is worthless, because *yes* is free.
Ask the version that costs something:

> If I threw this away and did it again, what would I do differently?

An answer means you are not done — go do that. No answer means you are done. This costs
one paragraph of thought and catches the thing you settled for at 60% because it worked.

**T2 and T3 — the effort check.** Ask:

> What exactly am I trying to learn by continuing? One sentence.

If the sentence exists, continue — and say it. If it does not, stop and report what you
have. "Just to be safe" and "to make sure everything works" are not sentences; they are
the absence of one.

## Escalation

Count each tripwire separately. T2 recurring and T3 recurring are two different counts.

**First firing** → decide yourself, one line of report, keep moving.

> `step-back: 같은 테스트 3회차 — 계속합니다. 직전 편집이 원인인지 확인하려는 겁니다.`

**Second firing of the same tripwire** → stop. Hand it over with the real state and a
concrete fork.

> `step-back: 이걸로 6회차입니다. 가설이 틀렸습니다. 픽스처 설정을 읽어볼까요, 아니면 여기서 되는 것까지만 보고할까요?`

You already decided to continue once and it did not pay off. That is data. Do not make
the same call alone a second time.

## Principles

**A. Against under-investing** — read these at T1.

1. The first answer that worked is not the best answer. It is the first one. Sometimes
   they are the same; you cannot tell which without looking.
2. "Is this the best?" costs nothing to answer yes to. "What would I do differently on a
   rewrite?" costs something. Ask the one that costs something.
3. Re-read the original request — the text of it, not your memory of it. Goals drift
   quietly while you work, and the thing you are about to call done is often a good
   answer to a question that mutated three steps ago.
4. A completion claim carries a list of what is left. "Nothing is left" is also a list.
   Write it out and see whether you still believe it.

**B. Against over-investing** — read these at T2 and T3.

5. To continue, you must be able to say what you are trying to learn, in one sentence.
   If you cannot, you are not investigating. You are circling.
6. Three attempts at the same thing means the hypothesis is wrong, not the attempt. Stop
   producing attempt four. Produce hypothesis two.
7. Verification scales with what a mistake costs. A change you can revert in one command
   has not earned the scrutiny of a migration you cannot.
8. If your human partner asked "should this really take this long?" and you would answer
   no — you knew before they asked. Answer now, without being asked.
9. Time already spent is not a reason to spend more. Only the distance left counts.
10. Saying you are stuck is faster than being stuck. The person you would be interrupting
    has context you do not.

## This is not permission to do less

The failure mode of this skill is using edge B to excuse edge A — shipping something thin
and reporting that you "stepped back". Guard it:

- What you stop is **effort spent on verification and exploration**. What you never stop
  is **the scope the user asked for**. Narrowing scope is the user's decision, not yours.
  If part of the work is genuinely blocked, finish everything else and say plainly what
  you left out and why.
- If the user asked for thorough, careful, exhaustive, or "take your time", the T2 and T3
  thresholds **do not apply**. An explicit request beats this contract. Say that you are
  deliberately running long.
- On work that is legitimately large — a migration, a broad audit, a full sweep — a
  tripwire does not mean stop. It means look up once, confirm the path is still right,
  and keep going.
- Never let T1 pass unanswered because you would rather be finished.

## Boundaries

- **superpowers:verification-before-completion** asks whether you actually ran the
  evidence. This skill asks whether the result was the best available and whether the
  effort still fits. Run verification first — you cannot judge a result you have not
  measured — then step back. Neither replaces the other.
- **superpowers:systematic-debugging** owns what happens when T2 fires and the cause is
  still unknown. This skill gets you to "the hypothesis is wrong" and hands off there.
- **superpowers:brainstorming** and **writing-plans** own the front of the work. T1 still
  fires at the end of planning: a plan is work, and a plan you would rewrite differently
  is not finished.

## Common Mistakes

- Letting T1 pass on a plan. Plans get the completion check exactly like code does.
- Counting T3 session-wide instead of per subgoal, so it fires constantly and gets tuned out.
- Answering "what am I trying to learn?" with a topic instead of a sentence. "The test
  setup" is a topic. "Whether the fixture is shared between these two tests" is a sentence.
- Reporting the tripwire without the reason. The one line exists to make the decision
  visible; stripped of the reason it is noise.
- Escalating to the user on the first firing. The first firing is yours to decide.
- Invoking this instead of doing the work. A step-back that produces no decision and no
  report did not happen.
