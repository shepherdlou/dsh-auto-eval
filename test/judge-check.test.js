import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { appendJsonl, evalPaths, loadCases, readJsonl, writeJsonl } from '../lib/core/store.js'
import { judgeCheckOp } from '../lib/ops/judge-check.js'
import { runOp } from '../lib/ops/run.js'
import { splitOp } from '../lib/ops/split.js'
import { CATEGORY_CHECK, TRIAGE_APP, tempProject, triageCases, writeFiles } from './helpers.js'

/** Ground truth for "promises-refund": the reply promises a refund on a non-refund ticket. */
const truth = (input, output) => !(String(output.reply).includes('refund') && !/refund|money back/.test(String(input.ticket)))

describe('eval_judge_check', () => {
  it('reports TPR/TNR, writes few-shot examples, and never surfaces held-out cases', async () => {
    const root = await tempProject('jc')
    const home = await tempProject('jc-home')
    await writeFiles(root, {
      'app.mjs': TRIAGE_APP.replace("'Thanks, we are looking into it.'", "(text.includes('invoice') ? 'We can refund this anytime.' : 'Thanks, we are looking into it.')"),
      'rules.json': JSON.stringify({ refund: 'refund', 'money back': 'refund', crash: 'bug', error: 'bug', invoice: 'billing', charged: 'billing' }),
      '.evals/triage/eval.yaml': 'name: triage\ntarget: { kind: command, command: "node app.mjs" }\nrepeats: 2\ngraders:\n  - { mode: wrong-category, kind: code }\n  - { mode: promises-refund, kind: judge }\n',
      '.evals/triage/graders/wrong-category.check.mjs': CATEGORY_CHECK,
      '.evals/triage/graders/promises-refund.judge.md': 'FAIL if the reply promises a refund on a ticket that is not about refunds. PASS otherwise.\n',
    })
    const opts = { cwd: root, name: 'triage', home }
    const paths = evalPaths(root, 'triage', home)
    await writeJsonl(paths.inboxCases, triageCases())

    // A judge that is right except on two cases (one false fail, one false pass).
    const judge = async ({ input, output }) => {
      let pass = truth(input, output)
      if (/\(0\)/.test(input.ticket) && /refund please/.test(input.ticket)) pass = !pass
      if (/invoice please \(1\)/.test(input.ticket)) pass = !pass
      return { pass, critique: pass ? 'no promise' : 'promises a refund' }
    }
    const run = await runOp({ ...opts, split: 'inbox' }, { judge })
    // The human labels every graded output with the ground truth.
    for (const row of await readJsonl(join(paths.runs, run.runId, 'results.jsonl'))) {
      const t = JSON.parse(readFileSync(join(paths.runs, run.runId, row.transcript), 'utf8'))
      await appendJsonl(join(paths.labels, 'grader-promises-refund.jsonl'), {
        id: `${row.caseId}#${row.rep}@${run.runId}`, runId: run.runId, caseId: row.caseId, rep: row.rep,
        pass: truth(t.input, t.output), note: '', at: new Date().toISOString(),
      })
    }

    const before = await judgeCheckOp({ ...opts, mode: 'promises-refund' }, { judge })
    assert.equal(before.labels.total, 48)
    assert.ok(before.labels.fail >= 6)
    assert.equal(before.partitions.fewshot + before.partitions.dev + before.partitions.test, 48)
    assert.ok(before.test.tpr > 0.8 && before.test.tnr > 0.6, JSON.stringify(before.test))
    assert.ok(before.dev.disagreements.every(d => d.human !== d.judge))
    const fewshot = await readJsonl(join(paths.graders, 'promises-refund.fewshot.jsonl'))
    assert.equal(fewshot.length, before.partitions.fewshot)
    assert.ok(fewshot.some(e => e.pass) && fewshot.some(e => !e.pass))

    // After the split, labels on held-out cases may only be hidden test items.
    await splitOp(opts)
    const heldout = new Set((await loadCases(paths.testCases)).map(c => c.id))
    assert.ok(heldout.size > 0)
    const after = await judgeCheckOp({ ...opts, mode: 'promises-refund' }, { judge })
    assert.equal(after.partitions.fewshot + after.partitions.dev + after.partitions.test, 48)
    const shownIds = after.dev.disagreements.map(d => d.id.split('#')[0])
    assert.ok(shownIds.every(id => !heldout.has(id)), 'no held-out case in dev disagreements')
    const fewshotAfter = await readJsonl(join(paths.graders, 'promises-refund.fewshot.jsonl'))
    const heldoutTickets = new Set((await loadCases(paths.testCases)).map(c => c.input.ticket))
    assert.ok(fewshotAfter.every(e => !heldoutTickets.has(e.input.ticket)), 'no held-out case in few-shot examples')
  })
})
