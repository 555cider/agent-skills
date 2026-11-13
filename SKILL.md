---
name: shrink-test-input
description: "Use when the user hands over a sample file (model, drawing, document, database, capture, dataset) to reproduce a bug or add support, when a test is about to read a large, external or gitignored file, or when an existing test pins a whole sample but asserts only a few things: name the features the test needs, cut or generate the smallest file that still carries them, prove it, and commit that instead of the original. Not for regression corpora, performance or scale tests, or golden snapshots of the program's own output."
license: MIT
compatibility: Prompt only. Format-specific cutting recipes and validators belong to each repository; this skill finds and follows them, or leaves one behind.
---

# Shrink Test Input

A sample the user hands over is evidence, not test input. A test pinned to the whole
file needs that file forever: a customer's file cannot be committed, a gitignored
copy makes the test skip on every other machine and CI (a green that means nothing),
and a 2 MB file hides which three objects the test is actually about. Keep what the
test reads; drop the rest. Use the user's language.

## 1. Find the repository's recipe first

How to cut a given format is the repository's knowledge, not this skill's. Look for
a doc or repo skill on test data (`.claude/skills/`, `docs/`, `CONTRIBUTING*`, and
READMEs in `testdata/`, `fixtures/`, `tests/`), generator scripts already sitting
beside test data, the repo's rule on where samples may live, and the reader or
validator it trusts for that format. Follow what you find. When there is none, work
ad hoc, and at the end write down what worked where the repo keeps such notes, so the
second sample of the same format is cheap.

## 2. Write the feature list before touching the file

One line per feature, stated as something the test will observe. Name the kind
(entity type, layer, block, record, table row, header field), the exact values, and
the producer quirk if that is the point (originating tool and version, units, axis
convention, encoding, an unusual but valid construct). Include **multiplicity** when
it matters: a definition shared by at least two users, a first versus a later
occurrence, nesting depth, a second top-level container. Derive it from the user's words, the
failing code path, or, for an existing test, its assertions. If you only know "this
file breaks", find the failing path first; the feature list is the minimal cause.
The list becomes the test's assertions and the index entry next to the shrunk file.

## 3. Pin the behaviour on the original

Write the test against the original, kept outside the repo: it fails for the named
reason (bug) or passes with the new support. After reducing, the same test on the
shrunk input must give the same verdict **for the same reason** (same error, same value),
not merely the same pass or fail.

When converting, also check that the old test ever ran: a missing sample often ends
in an early `return` that reports a pass, a lookup by file name that silently picks
another file, or a suite CI never selects. Remove the skip and the name lookup with
the new input, and say in the report where the converted test actually runs.

## 4. Choose the lightest form that keeps the features

1. **Built in test code**: the feature is a structure the code reads (a few records,
   a small graph, a short text).
2. **Generator script committed beside its output**: the feature needs a valid file
   in the format, not the original's bytes. The script states intent and can be
   rerun when the format or the feature changes.
3. **Reduced cut of the original**: the feature is what one particular producer
   wrote and you cannot author it faithfully. Say in the index why 2 was not enough.
4. **Original stays outside the repo**: only when the property is size or breadth
   itself (performance, memory, a regression corpus). Such a test must say it skips
   when the file is absent; never count its green from another machine as evidence.

Take the highest one that keeps every listed feature.

## 5. Reduce against a predicate, not by eye

Predicate = the test gives the original's verdict **and** the format's authoritative
reader opens the candidate without new errors. Drop the second half and reduction
drifts into a broken file that exercises a parse-error path instead.

- Structural pass first: keep the reference closure of the featured items and drop
  what nothing references (other pages, sheets, layers or tables, unused definitions,
  history, previews, embedded media).
- Then delta passes: delete chunks, keep a deletion only if the predicate holds, and
  repeat at finer grain until a pass removes nothing or the file is small and
  readable enough to review in a diff.
- Edit through the format's own library or producing application when the bytes have
  internal offsets, indexes or checksums; text formats can be cut line by line.
- Automate the loop when the predicate is a command. Keep one-off loops in scratch
  space; ship a reducer in the repo only when the repo's recipe calls for one.

## 6. Make it safe to commit

- Scrub content the feature list does not need: names, addresses, owner and project
  metadata, author, file paths, comments, thumbnails, and real-world coordinates
  (move to the origin unless georeferencing is a feature). Keep type and length where
  the reader depends on them.
- Binary formats hide it from byte search (compressed sections, dictionaries, unused
  definitions, linked-file paths): inspect with the producing application, or copy
  the kept content into a fresh file made from a blank template.
- A committed unscrubbed intermediate stays in history: land it as one squash.
- Record the licence of third-party samples.
- Follow the repo's rule on derived customer data. Without one, ask the user once
  before committing a cut of someone else's file; forms 1 and 2 need no such answer.

## 7. Prove the shrunk input still carries each feature

- **Mutation check**: for each listed feature, alter or remove it in a scratch copy;
  the test must fail. A feature whose removal stays green is not tested: fix the
  test, not the input.
- Run the test on the original (when present) and on the shrunk input: same verdict.
- Open the final file once more with the authoritative reader.

## 8. Leave provenance next to the shrunk input

In the repo's test-data index or a header comment: the feature list, the source as a
description plus a content hash (not a private path, not the customer's name), the
form chosen and why, and the command that regenerates or re-reduces it. Tests refer
to it by repo-relative path, never a machine path.

## Converting an existing test

Convert only when it removes a real dependency: a test that skips, a file that cannot
be committed, or a large file only that test reads. A test over a file already
committed and kept as a corpus gains nothing, and copying a few of its rows into the
test drops the reader path and the real file's noise the code must ignore.

When a test already pins a whole sample, take the feature list from its assertions,
keep the old test until the new one is shown equivalent on the original, then repoint
it. Delete a committed large file only after grepping its path and file name for
every other reader.

## Boundaries

Keep regression corpora and performance inputs whole. Do not change product code to
make a file easier to reduce. This skill does not authorize committing, pushing or
publishing anything.
