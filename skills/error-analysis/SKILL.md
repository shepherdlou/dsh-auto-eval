---
name: error-analysis
description: Read real traces with the user before writing any eval. Sample traces, have the user label and annotate them in the review UI (open coding), group their notes into failure modes (axial coding), and rank the modes by frequency.
whenToUse: Before building an eval; when the user asks what is going wrong with their agent or app; when there are traces nobody has looked at.
---

# Error analysis

Goal: a short, ranked list of failure modes that the user recognizes as the
real problems, each defined clearly enough to grade. Everything after this
(cases, graders, hillclimbing) builds on it, so do not rush it.

## 1. Set up

- `eval_init` with `action: create`, a kebab-case `name`, the `target`
  (`dsh-agent` or `command`), and for `command` the command line.

## 2. Get traces

- dsh agent: `eval_traces` `action: list` to see what exists (sessions from
  this working directory only; "flagged" means the user gave a thumbs-down).
  Then `action: sample` with `n` around 30-50. The default `mixed` strategy
  takes flagged sessions first, then unusual ones (tool errors, abnormal
  endings), then random ones, so the sample is not only known-bad cases.
  Narrow with `contains` or `sinceDays` if the user cares about one area.
- Own app: ask for a JSONL export and use `action: import` with `file`.
  Each line: `{id?, input, output, messages?, usage?, meta?}`.

If there are fewer than ~20 traces, say so: patterns from tiny samples are
guesses. Offer to generate realistic inputs and run them through the target
(`/build-eval` covers synthetic inputs) and then analyze those traces.

## 3. Open coding (the user reads)

- `eval_review` `action: open` `view: traces` and give the user the URL.
- Tell them how it works, in two lines: mark each trace Pass or Fail
  (keys `1`/`2`, `j`/`k` to move) and write a short note on the **first**
  thing that went wrong, in their own words. No categories yet.
- Suggest a stopping rule: keep going until about 20 traces in a row
  surface no new kind of problem (theoretical saturation), or ~50 traces.
- While they work you may summarize traces they ask about, but do not label
  for them and do not pre-fill notes.

## 4. Axial coding (you propose, the user decides)

When the user is done, read `labels/traces.jsonl` (latest line per id wins)
and the failing traces' notes. Group the notes into 3-8 failure modes:

- Each mode is one observable, gradable problem ("cites a refund window the
  policy does not contain"), not a vague quality ("bad answers").
- Write `taxonomy.json`:
  `{"modes": [{"id": "kebab-id", "name": "Short name", "description": "What counts and what does not", "traceIds": ["..."]}]}`
- Assign every failing trace to at least one mode; a note that fits nothing
  stays unassigned rather than forced.

Then `eval_review` `view: taxonomy`: the user renames, merges, splits and
reassigns (drag a note onto a mode). Their version is final.

## 5. Prioritize

Report a table: mode, count, share of failing traces, one example trace id.
Rank by frequency and by impact (ask the user which failures are costly).
Recommend which 1-3 modes deserve an eval first and why. Some modes are just
bugs to fix directly (a missing tool, a wrong config): say so; not every
failure needs an eval.

Next: `/build-eval` for the chosen modes.
