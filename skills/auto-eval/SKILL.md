---
name: auto-eval
description: Start here for evals. Looks at what already exists in .evals/ and routes to error analysis, building an eval, calibrating a judge, or hillclimbing.
whenToUse: The user wants to evaluate, test, measure, benchmark or improve an LLM app or this dsh agent's behavior, or mentions evals, graders, LLM judges, regressions, failure modes or hillclimbing.
---

# Auto-eval: router

An eval is only as good as the looking-at-data that went into it. This plugin
puts the user's own reading of real traces first, then turns what they found
into one grader per failure mode, checks the graders against human labels,
and only then optimizes.

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
- Prefer code graders; use an LLM judge only for open-ended output.
- Held-out test cases are reported as aggregate scores only. Never try to read
  them; tool calls that reference the held-out store are blocked.
