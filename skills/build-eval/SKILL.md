---
name: build-eval
description: Turn chosen failure modes into a working eval - representative cases reviewed by the user, one grader per failure mode (code first, LLM judge only when needed), judges calibrated against human labels, a train/test split, and a diagnosed baseline.
whenToUse: After error analysis has produced failure modes, or when the user names specific failure modes to measure.
---

# Build an eval

Write every message to the user in the language they write in: if they write
Chinese, you reply in Chinese, even though these instructions and the tool
results are in English. Failure-mode names and descriptions follow them too.

Inputs: the eval directory from `/error-analysis` and the failure modes the
user chose (`taxonomy.json`). If neither exists, run `/error-analysis` first
unless the user explicitly declines it.

A good eval: cases sampled from what matters in production; a strong
configuration scores well below 100% (headroom); repeated runs agree (low
variance); stronger models and higher effort score higher. Keep these in
mind at every step.

## 1. Collect cases into `cases/inbox.jsonl`

One JSON object per line:
`{"id": "...", "input": ..., "expected"?: ..., "tags"?: ["mode-or-slice"], "source"?: "...", "fixture"?: {"dir": "fixtures/x", "into": "."}}`

- `input` is what the target receives (dsh agent: the task text, or
  `{"task": "..."}`; own app: whatever its stdin JSON `input` should be).
- `expected` is optional reference data for graders. The target never sees it.
- `fixture` (dsh-agent with `isolation: worktree`) copies files from the eval
  directory into the run's fresh worktree, e.g. a broken repo state.

Sources, in this order, telling the user which you used:
1. Production traces from error analysis (`traces/`), especially the failing
   ones: the input that produced the failure becomes a case.
2. Bug reports or tickets the user points you to.
3. 5-10 cases the user writes or dictates.
4. Synthetic cases: pick 2-4 dimensions that matter (e.g. user persona x
   request type x difficulty), enumerate combinations, then write natural
   inputs for each tuple. Avoid near-duplicates and avoid inputs only a model
   would write.

Do not select cases because today's model fails them; that measures its
quirks, not what is hard. Aim for 30+ cases, with each chosen failure mode
exercised by several. Tag each case with the mode(s) or slice it targets.

Then `eval_review` `view: cases`: the user approves or rejects each case
(and fixes tags). Ask them to reject anything unrealistic or with a wrong
reference, then **end your turn** until they are done. `eval_split` will not
take unreviewed cases.

## 2. Write one grader per failure mode

In `eval.yaml` under `graders`, one entry per mode:
`- { mode: <taxonomy id>, kind: code | judge, file: graders/<mode>.check.mjs | graders/<mode>.judge.md }`

Pick the cheapest grader that is reliable. The test: could two careful people
disagree about the verdict? If no, write code. If yes, it needs judgment, so
use a judge.

- **Code** when the output is constrained: exact or normalized match, label
  or category, JSON schema, a regex, tests passing in the run's workdir.
  `graders/<mode>.check.mjs`:
  ```js
  export default function check({ input, output, expected, case: c, trace, workdir }) {
    return { pass: output.category === expected.category, reason: `got ${output.category}` }
  }
  ```
  `pass: true` means the failure mode is absent. `trace` is the normalized
  transcript (items, toolCalls, toolErrors, usage); `workdir` is where the
  target ran (dsh agent: inspect files, run tests).
  Regular expressions over natural-language replies ("does the reply promise
  a refund?", "does it invent order facts?") are not code-checkable: they
  break on the next paraphrase. Those are judge graders.
- **LLM judge** for anything that needs reading comprehension. `graders/<mode>.judge.md` is the
  rubric, sent verbatim as the judge's system prompt after a fixed protocol
  (binary verdict plus critique, JSON only). Write it as checkable claims:
  ```md
  Failure mode: the reply states a refund window, fee or eligibility rule that is not in the policy text given in the input.

  FAIL if any of these hold:
  - The reply names a number of days for refunds other than the policy's.
  - The reply promises a refund for an item the policy excludes.
  PASS otherwise, including when the reply declines to state a window.
  Ignore tone, length and anything unrelated to refund terms.
  ```
  No 1-5 scales. No bundled checks: one mode per rubric.

Show the user each grader file in full and ask them to confirm it captures
their definition. Run `eval_init` `action: validate`.

## 3. Get outputs to grade

First confirm the target runs with `eval_run` `limit: 1` (not a manual shell
test: the target gets dsh's environment, your shell may not).


Run the target on a small slice: `eval_run` `split: inbox`, `limit: 10-20`,
`repeats: 1`. Read the failures it returns. Fix target-independent problems
first (infra errors, a crashing command, a missing permission).

## 4. Validate the graders with the user

- `eval_review` `view: results` on that run: ask the user to read a sample
  of scored transcripts and press "I disagree" on any wrong verdict. Read
  `labels/disputes.jsonl` and fix the grader (code bug, or rubric wording).
- For each **judge**: `eval_review` `view: grader` with its `mode` and the
  run id. The user labels outputs blind (the judge's verdict appears only
  after they label). Ask for 30+ labels with both passes and fails; run more
  inbox cases if there are too few fails. **End your turn** while they label.

## 5. Calibrate each judge

`eval_judge_check` with the `mode`. Labels split into few-shot examples
(written to `graders/<mode>.fewshot.jsonl` and used in every run), dev and
test. You see dev disagreements, never test items.

- Low TPR (judge fails outputs the user passed): rubric too strict or vague.
- Low TNR (judge passes real failures): add concrete FAIL criteria.
- Edit the rubric using dev disagreements only, rerun, repeat until test TPR
  and TNR meet the thresholds (default 0.9) or you have to tell the user the
  mode is not reliably judgeable (then consider a code check or a narrower
  definition).
- Show the final rubric and the numbers to the user.

## 6. Split and baseline

- `eval_split`. Train stays in the workspace; test moves out of reach and
  only aggregate scores ever come back. Earlier inbox runs are archived. It
  refuses cases the user has not reviewed; `skipReview` exists only for when
  the user explicitly says to skip review (pass their words as `reason`).
- Settle the graders before the split. After it, the inbox is empty and the
  test cases are out of reach, so re-validating a grader means `eval_run` on
  train.
- `eval_run` `split: train` and `split: test` with the configured repeats
  (3+ for an LLM target) and `consistencySample: 5` once.
- Report: score with its 95% interval per split, pass rate per failure mode,
  infra error count, and every diagnostic. Act on them:
  - infrastructure errors above a few percent: fix before trusting anything;
  - score above the headroom threshold: the eval is too easy; add harder
    cases the user cares about;
  - cases failing every repeat: read them; ambiguous task or grader bug?
  - judge flips on identical input: tighten the rubric;
  - many flaky cases: more repeats or more cases.
- Point the user to `runs/<id>/results.html`.

Next: `/hillclimb` if the user wants to improve the target against this eval.
