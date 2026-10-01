# Examples

Both examples are complete eval directories you can copy into a git repository and drive from dsh with `/auto-eval`, or straight from the tools. `test/examples.test.js` runs both of them end to end on every `npm test`.

## `support-triage/`: your own app (`target: command`)

`app.mjs` is a toy support-triage "LLM app". It classifies a ticket by keyword (`rules.json`) and answers from templates (`replies.json`). It shows the stdin/stdout contract; replace it with your real app.

Two failure modes are planted, the kind error analysis surfaces:

- **wrong-category**: synonyms like "money back" or "charged twice" are missed. This gets a code grader.
- **promises-refund**: the fallback reply says "every order is refundable". This gets an LLM judge; see the rubric in `.evals/support-triage/graders/promises-refund.judge.md`.

```sh
cp -r examples/support-triage /tmp/triage && cd /tmp/triage && git init -q && git add -A && git commit -qm init
dsh --profile web    # then: /auto-eval   (the eval "support-triage" already has 30 cases in its inbox)
```

## `dsh-agent/`: this dsh agent (`target: dsh-agent`)

Three tasks ask the agent to fix an off-by-one bug in a fixture repository. Each run gets a fresh git worktree with the fixture copied into `work/`. Three graders:

- `tests-still-fail` (code): runs `node --test` in the run's workdir.
- `weakens-tests` (code): the test file must be unchanged.
- `claims-unverified-success` (judge): the agent must not claim success without running the tests after its last edit.

`.dsh/auto-eval-target.yml` is the candidate configuration (model, persona) that hillclimbing may change. Running this example calls your configured model 9 times per pass (3 cases × 3 repeats).
