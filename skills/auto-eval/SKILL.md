---
name: auto-eval
description: Start here for evals. Looks at what already exists in .evals/ and routes to error analysis, building an eval, calibrating a judge, or hillclimbing.
whenToUse: The user wants to evaluate, test, measure, benchmark or improve an LLM app or this dsh agent's behavior, or mentions evals, graders, LLM judges, regressions, failure modes or hillclimbing.
---

# Auto-eval: router

Write every message to the user in the language they write in: if they write
Chinese, you reply in Chinese, even though these instructions and the tool
results are in English. Failure-mode names and descriptions follow them too.

An eval is only as good as the looking-at-data that went into it. This plugin
puts the user's own reading of real traces first, then turns what they found
into one grader per failure mode, checks the graders against human labels,
and only then optimizes.

## Human checkpoints (hard rule)

Four steps belong to the user, not to you:

1. labeling traces and writing notes (error analysis),
2. confirming the failure modes,
3. approving or rejecting eval cases,
4. labeling outputs for each LLM judge, and reading scored results.

At each one: open the review page (`eval_review`), give the user the URL, say
in one or two lines what to do there, and **end your turn**. Continue when
they reply. Running headless, one-shot, or "with nobody around" does not
change this: the user answers in the next message. Never label, approve,
write notes, or confirm failure modes on their behalf.

The tools enforce part of this. `eval_split` refuses cases the user has not
reviewed, and `eval_hillclimb` refuses judges that were not calibrated on the
user's labels. Their skip flags are for when the user explicitly decides to
skip a step; pass the user's own words as `reason`. Every skip is recorded in
`audit.jsonl` and shown in `/eval` and in every run report.

## What to evaluate

Ask (once, briefly) which target the user means, unless it is obvious:

- **This dsh agent** (`target: dsh-agent`): its system prompt, AGENTS.md,
  `.dsh/skills/`, model and reasoning effort. Traces come from past dsh
  sessions in this project. Runs use `dsh --profile headless`.
- **The user's own LLM app** (`target: command`): any program that reads one
  case as JSON on stdin and prints `{"output": ...}` (optionally `messages`,
  `usage`, `model`) on stdout. Traces come from a JSONL export.

## Route

Call `eval_init` with `action: list`, then `eval_review` with
`action: status` for the eval in question, and pick the first row that
applies:

| Situation | Next |
|---|---|
| No eval yet, or traces never reviewed | `/error-analysis` |
| Failure modes found (taxonomy.json) but no graders or cases | `/build-eval` |
| Judge graders without calibration (`/eval` says "not calibrated") | `/build-eval`, step 5 |
| Eval built, split done, baseline run | `/hillclimb` |
| Eval exists but scores look wrong or the user distrusts it | audit: below |

If the user already knows exactly which failure mode they care about and has
cases, you may skip to `/build-eval`, but say that error analysis usually
finds failures nobody expected and offer it.

## Audit an existing eval

1. `eval_init` `action: validate`: fix errors first.
2. Read `runs/<latest>/summary.json` diagnostics: infra errors, headroom,
   cases that fail every repeat, judge flip rate.
3. Open `eval_review` `view: results` and ask the user to read 5-10 scored
   transcripts and mark any verdict they disagree with. Disputes land in
   `labels/disputes.jsonl`; each one is a grader bug until proven otherwise.
4. For every judge without a passing `eval_judge_check`, calibrate it.

## Ground rules (all eval work)

- Never invent what the user thinks. Labels, notes, case approvals and
  failure-mode names come from the user through the review UI. Your job is to
  sample well, summarize, propose, and make their review fast.
- Show, don't describe: when you write a grader, show the user the file's
  full contents (the judge rubric or the check code).
- One grader checks one failure mode, with a binary pass/fail.
- Use a code grader when the verdict is mechanical (no two careful people
  could disagree); anything that needs reading the reply, an LLM judge.
  Regular expressions over natural-language replies are not mechanical.
- Held-out test cases are reported as aggregate scores only. Never try to read
  them; tool calls that reference the held-out store are blocked.
- Run the target through `eval_run`, not your own scripts. It works before
  any grader exists (it then only collects outputs) and `saveAsTraces: true`
  turns the outputs into traces for the review page. Keep any scratch files
  under `.evals/<name>/`, not in /tmp.
- To check that the target runs at all, use `eval_run` with `limit: 1`. The
  target starts with the environment dsh was launched with (API keys
  included); your own shell tool may have a scrubbed environment, so a manual
  test failing for a missing key means nothing. Never search the machine for
  credentials; if `eval_run` reports a missing key, ask the user.
