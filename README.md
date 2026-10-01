# dsh-auto-eval

English | [中文](README.zh.md)

Auto-eval and hillclimbing for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

It builds evals for **this dsh agent** (its prompt, AGENTS.md, skills, model and effort) or for **your own LLM app**, then improves the target against them. The workflow follows Anthropic's
[automated eval design and hillclimbing](https://claude.dev/blog/automating-eval-design-and-hillclimbing/),
with the changes Hamel Husain asked for in
[his review of it](https://hamel.dev/blog/posts/claude-auto-evals/):

- **Data first.** Error analysis on real traces comes before any grader.
- **A web review UI**, not Markdown in chat, for labeling traces, cases and grader outputs.
- **One failure mode per grader**, with a binary pass/fail.
- **The graders themselves are shown.** The judge rubric and the check code are plain files that the agent shows you, not a summary of them.
- **Judges are calibrated against your labels** (TPR/TNR on held-out labels) before anyone trusts them.
- **The human steps are enforced, not suggested.** The agent cannot split an eval you have not reviewed, or hillclimb against an uncalibrated judge. An explicit skip needs your reason, is written to `audit.jsonl`, and shows up in every report.

```
/auto-eval ─► /error-analysis ─► /build-eval ─────────────────► /hillclimb
              sample traces      cases (reviewed)                 branch worktree
              you label + note   one grader per mode              baseline ×k → noise floor
              failure modes      judge ⇄ your labels (TPR/TNR)    one patch per round
              ranked             train/test split, baseline       keep iff train > noise AND test ↑
```

## Install

```sh
# into the profile you use (web, headless, …)
dsh plugin --profile web add github:shepherdlou/dsh-auto-eval
# or from a local checkout
dsh plugin --profile web add ./dsh-auto-eval

dsh --profile web --dump-config | grep -A2 dsh-auto-eval   # shows the "# == dsh-auto-eval" layer
```

Requires dsh ≥ 0.2.0-rc.2, Node ≥ 22 and git.

## Use

In a dsh session in your project, type **`/auto-eval`**. The agent checks what already exists and takes you to the right step. **`/eval`** prints a status summary without calling the model.

The agent gives you a review URL (`http://127.0.0.1:<port>/?token=…`) and stops until you are done. You do the reading and labeling there; the agent samples traces, proposes groupings, writes graders, and runs everything.

The page lives as long as the dsh process that started it. After a one-shot or headless run, reopen it with the bundled CLI (the agent prints the exact command):

```sh
node <plugin dir>/bin/dsh-auto-eval.mjs review <eval> --cwd <project>
node <plugin dir>/bin/dsh-auto-eval.mjs status --cwd <project>      # same as /eval
```

| Review view | What you do |
|---|---|
| Traces | Pass/Fail each trace (`1`/`2`, `j`/`k`), write a note on the first thing that went wrong (open coding) |
| Failure modes | Rename, merge and reassign the failure modes the agent proposes from your notes (axial coding; drag a note onto a mode) |
| Cases | Approve or reject each eval input, and fix its tags (or approve all remaining once you have read them) |
| Grader labels | Label outputs for one judge blind; its verdict appears only after your label |
| Results | Read scored transcripts, dispute any verdict |

## What gets installed

**Skills** (user- and model-invocable): `/auto-eval` (router), `/error-analysis`, `/build-eval`, `/hillclimb`.

**Tools**

| Tool | Purpose |
|---|---|
| `eval_init` | create / validate / list evals under `.evals/<name>/` |
| `eval_traces` | list or sample past dsh sessions from this working directory (thumbs-down first, then unusual ones, then random), or import your app's JSONL traces |
| `eval_review` | open the review UI; label progress |
| `eval_split` | inbox → train (workspace) / test (held out); archives pre-split runs; refuses cases you have not reviewed |
| `eval_run` | run a split × repeats, grade, report score with a 95% interval, per-mode pass rates and diagnostics; test runs return aggregates only. Without graders it only collects outputs; `saveAsTraces` puts them in the review page |
| `eval_judge_check` | calibrate a judge on your labels: few-shot / dev / test; dev disagreements back, test TPR/TNR only, with 95% intervals and a count of how many rubrics the test labels have scored (tuning a rubric to those numbers fits it to them) |
| `eval_hillclimb` | start / round / finish / status; refuses judges without a passing calibration on the current rubric |

**Command**: `/eval`. **Guard**: model tool calls whose arguments reference the held-out store are denied.

## Targets

### Your own app: `kind: command`

Any program. It receives one case on stdin and prints its result on stdout:

```
stdin : {"id": "t01", "input": <case input>, "tags": [...], "meta": {...}}     (never the expected answer)
stdout: {"output": <anything>, "messages"?: [{role, content}], "usage"?: {...}, "model"?: "..."}
```

Plain-text stdout is accepted as the output. A non-zero exit or a timeout is an infrastructure error and does not count as a failure. See [`examples/support-triage`](examples/support-triage).

### This dsh agent: `kind: dsh-agent`

Each run is `dsh --profile headless [--patch <candidate>] --json -` with the task on stdin, in a fresh git worktree (`isolation: worktree`) so no state leaks between runs. Case fixtures (`fixture: {dir, into}`) are copied into that worktree, and code graders get its `workdir` to run tests. When the plugin runs inside dsh, the full trace is read back from the session store.

The candidate configuration consists of files in the repo: AGENTS.md, `.dsh/skills/`, and the patch named by `target.patch`, for example:

```yaml
# .dsh/auto-eval-target.yml — a patch replaces a row's whole config, so restate every key
- id: agent-default-model
  config: { provider: deepseek-official, model: deepseek-flash }
- id: system-prompt
  config:
    personaSuffix: Your working directory is {{cwd}}.
    personaPrefix: You are a coding agent powered by the {{model}} model.
```

A turn that ends in `error`, `max-tokens`, `aborted` or `blocked` is an infrastructure error. `blocked` usually means a tool asked for approval in headless mode; set `target.permissionMode`. See [`examples/dsh-agent`](examples/dsh-agent).

## `eval.yaml`

```yaml
name: support-triage
target: { kind: command, command: "node app.mjs", timeoutMs: 120000, isolation: shared }
repeats: 3            # per-case score = pass fraction over repeats
concurrency: 4
split: { seed: 42, testFraction: 0.3, stratifyBy: tag }
judge: { provider: deepseek-official, model: deepseek-v4-pro, maxTokens: 8192 }   # default: agent default model; reasoning tokens count toward maxTokens
goal: score           # score | cost | latency
prices: { deepseek-flash: { input: 0.27, output: 1.1, cacheRead: 0.07 } }       # USD / 1M tokens (dsh reports tokens only)
graders:
  - { mode: wrong-category, kind: code,  file: graders/wrong-category.check.mjs }
  - { mode: promises-refund, kind: judge, file: graders/promises-refund.judge.md }
thresholds: { judgeTpr: 0.9, judgeTnr: 0.9, headroom: 0.95, minEffect: 0.03, minCostGain: 0.05 }
```

**Code grader:** `export default ({ input, output, expected, case, trace, workdir }) => ({ pass, reason })`.
`pass: true` means the failure mode is absent.

**Judge rubric:** a Markdown file of checkable FAIL/PASS criteria for one failure mode. It is sent verbatim as the judge's system prompt after a fixed protocol: the judge replies with one JSON object, `{"critique": "...", "pass": true|false}`. The protocol is enforced by a strict parser, since dsh has no JSON mode. `eval_judge_check` writes the calibration examples to `graders/<mode>.fewshot.jsonl`, and every run uses them.

## Files

```
.evals/<name>/
  eval.yaml  README.md  taxonomy.json
  traces/                 sampled traces (normalized)
  labels/*.jsonl          your labels; append-only, latest line per id wins
  cases/inbox.jsonl       collected, not yet split
  cases/train.jsonl       train split
  graders/                <mode>.check.mjs | <mode>.judge.md (+ .fewshot.jsonl)
  judge-checks/<mode>.json  calibration result, tied to a hash of the rubric
  audit.jsonl             every human step that was skipped, and why
  runs/<runId>/           results.jsonl, transcripts/, summary.json, results.html
  hillclimb/log.jsonl     every round: patch, deltas, decision, reason
$DSH_HOME/auto-eval/<project-hash>/<name>/heldout/
  test.jsonl, runs/, archived-runs/   ← never in the workspace
.dsh-auto-eval/           hillclimb worktrees (git-ignored)
```

## Statistics and decisions

- **Scores.** A case's score is its pass fraction over repeats; the eval score is the mean over cases. The 95% interval resamples whole cases (cluster bootstrap), because repeats of one case are correlated.
- **Infrastructure and grader errors** are excluded from the score and reported separately.
- **Diagnostics** flag:
  - infrastructure error rate above 5%;
  - grader errors;
  - a score above the headroom threshold;
  - cases that fail every repeat;
  - many flaky cases;
  - a judge that flips on identical input (`consistencySample`).
- **Noise floor.** `1.96·√2·σ`. σ is the larger of the run-to-run spread over the k baseline runs and the spread predicted from within-case repeat variance. That way, a few lucky identical baseline runs cannot hide noise.
- **Round decision.** Each round is compared with the best version so far on the same cases (paired):
  - **keep** iff `Δtrain > noise` **and** `Δtest > 0`;
  - **revert** when only train rose (the overfitting signal) or either split regressed;
  - **void** when the patch touched the eval, or the eval changed. The eval's fingerprint covers `eval.yaml`, graders, cases, fixtures and the held-out test set.
- **Cost and latency goals** require quality to hold within noise on both splits, plus a relative saving of at least `minCostGain`.
- **Stall.** After three rounds without a keep, the agent stops patching and sorts the remaining train failures by root cause.
- **Finish.** The branch settles on the best test-set version. The report gives baseline and best scores with intervals, and calls a gain unproven when the paired test interval includes zero.

## Held-out isolation: what it does and does not do

**Protected:**
- Test cases, their reference answers and their transcripts live outside the workspace.
- Tools only ever return aggregate test numbers. Test diagnostics are redacted of case ids.
- Runs made before the split are moved out of the workspace.
- The review UI never serves held-out data.
- A `tools/pre-execute` guard denies model tool calls whose arguments mention the held-out store.

**Not protected:**
- A determined agent could still reach the files, for example through a shell command that builds the path indirectly. The guard is a tripwire, not a sandbox.
- Production traces you sampled for error analysis stay in `traces/` even if a case was derived from them.

The `/hillclimb` skill also forbids pasting failure content into prompts. Keep a human reading the hillclimb log.

## Configuration

Set these in your profile's `cordis.patch.yml`:

```yaml
- id: auto-eval
  name: dsh-auto-eval
  config:
    reviewPort: 0               # 0 = any free port
    guardHeldout: true
    allowOtherWorkspaces: false # eval_traces reads only sessions from the current cwd
    sessionScanLimit: 300
```

## Development

```sh
npm install
npm test                                   # 38 tests: core, runner, review server, judge calibration, checkpoints, hillclimb, plugin on a real dsh ToolRuntime, examples
dsh plugin --profile headless add .        # then, against a real dsh (no API key; a scripted mock model drives it):
DSH_BIN=$(which dsh) node test/e2e/dsh-smoke.mjs
```

`lib/core/` has no dsh dependency (`import … from 'dsh-auto-eval/core'`).

## Limits

- Error analysis, case review and grader labels need a person. That is the point.
- The dsh session query has no index for this use, so it replays logs; `eval_traces` reads at most `sessionScanLimit` sessions per call.
- The review UI binds to 127.0.0.1. On a remote machine, forward the port.
- Money costs come from your `prices` table; dsh reports token counts only.
- The guard and isolation are best-effort, as described above.

## Credits

Built on ideas from Anthropic's [*Automating eval design and hillclimbing*](https://claude.dev/blog/automating-eval-design-and-hillclimbing/), Hamel Husain's [review](https://hamel.dev/blog/posts/claude-auto-evals/) and the [evals-skills](https://github.com/ai-evals-course/evals-skills) collection, and the dsh plugin tutorial in [deepseek-harness#961](https://github.com/deepseek-ai/deepseek-harness/discussions/961).

MIT License.
