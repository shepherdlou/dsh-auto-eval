---
name: hillclimb
description: Improve the target (prompts, skills, AGENTS.md, tool descriptions, model and effort, app code) against an existing eval, one patch per round, in a separate git branch; keep a patch only when train improves beyond noise and the held-out test set also rises.
whenToUse: An eval with a train/test split and calibrated graders exists and the user wants a better score, lower cost or lower latency.
---

# Hillclimb

Preconditions: `eval_split` done, graders validated, judges calibrated, a
baseline run with no unresolved diagnostics, and a git repository. If any is
missing, go back to `/build-eval`.

## Configure

Agree with the user on:
- **goal**: `score` (default), `cost` (needs `prices` in eval.yaml; quality
  must hold within noise), or `latency`;
- **budget**: `maxRounds` (default 10) and how much spend is acceptable
  (each round runs train and test with all repeats);
- what may change: system prompt / persona, AGENTS.md, `.dsh/skills/`,
  tool descriptions, model and reasoning effort (dsh agent: the candidate
  patch file named by `target.patch`, e.g. `.dsh/auto-eval-target.yml`), or
  the app's prompts and code.

Then `eval_hillclimb` `action: start`. It creates branch
`auto-eval/<eval>/hc-…` in a worktree (`editIn`), runs the baseline
several times and reports the noise floor. If the noise floor is larger
than the smallest gain worth having, say so and suggest more repeats or
cases before burning rounds.

## Each round

1. Read the **train** failures returned by the last call (open their
   transcript files). Find the most common root cause, not the most vivid
   single failure.
2. Make **one** change inside `editIn`, aimed at that root cause. Good
   patches state a general rule or give the model missing knowledge; they
   generalize to inputs you have not seen.
3. `eval_hillclimb` `action: round` with a one-line `note`.
4. Report one line: round, kept or reverted, train and test change, why.

Rules (the tool enforces what it can):
- Kept only if train improves by more than the noise floor AND test rises.
  Train up but test flat is the overfitting signal: reverted.
- Never edit `.evals/` (graders, cases, eval.yaml): the round is voided and
  reverted. A real eval bug goes to the user; if they approve the fix, finish
  this hillclimb and start a new one.
- Never paste failing transcript content, case inputs or reference answers
  into prompts, skills or code. No special cases for specific inputs.
- Never try to read held-out test data; only its aggregate score exists for
  you.
- Do not touch the user's checkout; all edits go in `editIn`.

## When it stalls

If a round returns `stalled: true` (three rounds without a kept patch), stop
patching. Read every remaining train failure and sort it by cause:
target behavior, grader bug, ambiguous case, infrastructure. Report the
counts to the user with examples, then propose one of: a different kind of
change, more cases or repeats (when real gains are below the noise floor),
or eval fixes (user decides).

## Finish

`eval_hillclimb` `action: finish` when the budget is spent, the goal is met,
or the user says stop. It settles the branch on the best test-set version and
reports baseline vs best on train and test with 95% intervals. Tell the user:

- the gain and whether it clears the noise (if the interval includes zero,
  call it unproven);
- what changed (`changes`), and the command to review and merge the branch;
- the round history (`.evals/<eval>/hillclimb/log.jsonl`).

Merging is the user's decision; do not merge the branch yourself.
