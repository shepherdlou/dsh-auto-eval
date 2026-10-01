// The shipped examples must keep working: run each through the real ops.
import assert from 'node:assert/strict'
import { chmodSync, cpSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { hillclimbFinish, hillclimbRound, hillclimbStart } from '../lib/ops/hillclimb.js'
import { validateEval } from '../lib/ops/init.js'
import { runOp } from '../lib/ops/run.js'
import { splitOp } from '../lib/ops/split.js'
import { gitInit, tempProject } from './helpers.js'

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url))

/** Stands in for the LLM judge: flags the planted "every order is refundable" promise. */
const judge = async ({ output }) => {
  const reply = String(output?.reply ?? output)
  const bad = /every order is refundable/i.test(reply)
  return { pass: !bad, critique: bad ? 'promises a refund' : 'ok' }
}

describe('examples', () => {
  it('support-triage: validate, run, split, hillclimb to a fix', async () => {
    const root = await tempProject('ex-triage')
    const home = await tempProject('ex-triage-home')
    cpSync(join(EXAMPLES, 'support-triage'), root, { recursive: true })
    gitInit(root)
    const opts = { cwd: root, name: 'support-triage', home }
    const valid = await validateEval(opts)
    assert.equal(valid.ok, true, JSON.stringify(valid.errors))
    assert.equal(valid.counts.inbox, 30)

    const inbox = await runOp({ ...opts, split: 'inbox' }, { judge })
    assert.ok(inbox.score < 0.5, 'the toy app starts out bad')
    assert.ok(inbox.perMode['promises-refund'].passRate < 0.5)

    await splitOp(opts)
    const start = await hillclimbStart({ ...opts, baselineRuns: 1 }, { judge })
    writeFileSync(join(start.editIn, 'rules.json'), JSON.stringify({
      refund: 'refund', 'money back': 'refund', reimburse: 'refund', return: 'refund',
      crash: 'bug', error: 'bug', closing: 'bug', blank: 'bug', 'never load': 'bug', 'does nothing': 'bug',
      invoice: 'billing', charged: 'billing', receipt: 'billing', payment: 'billing', vat: 'billing',
    }))
    writeFileSync(join(start.editIn, 'replies.json'), JSON.stringify({
      refund: 'Sorry about that. Refunds are available within 30 days of purchase; I have opened a refund request for you.',
      bug: 'Thanks for the report. Could you share the steps that lead to the problem and your app version?',
      billing: 'I can help with billing. Please confirm the email on the account and I will look up the charge.',
      other: 'Thanks for reaching out. Tell me a bit more and I will point you to the right place.',
    }))
    const round = await hillclimbRound({ ...opts, note: 'more synonyms; no blanket refund promise' }, { judge })
    assert.equal(round.decision, 'keep', round.reason)
    const done = await hillclimbFinish(opts)
    assert.ok(done.best.test.score > done.baseline.test.score)
  })

  it('dsh-agent: fixtures, per-run worktrees, workdir graders', async () => {
    const root = await tempProject('ex-agent')
    const home = await tempProject('ex-agent-home')
    cpSync(join(EXAMPLES, 'dsh-agent'), root, { recursive: true })
    // A stand-in agent that fixes the off-by-one the honest way and runs the tests.
    const fake = join(root, 'fake-dsh.mjs')
    writeFileSync(fake, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
readFileSync(0, 'utf8')
const out = e => console.log(JSON.stringify(e))
out({ type: 'session', sessionId: 'session-fake', cwd: process.cwd() })
const file = 'work/range.js'
writeFileSync(file, readFileSync(file, 'utf8').replace('i < end', 'i <= end'))
out({ type: 'tool_call', callId: 'c1', tool: 'edit', input: { path: file } })
out({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'ok' })
const test = execFileSync('node', ['--test'], { cwd: 'work', encoding: 'utf8' })
out({ type: 'tool_call', callId: 'c2', tool: 'bash', input: { command: 'node --test' } })
out({ type: 'tool_result', callId: 'c2', status: 'completed', result: test.slice(-200) })
out({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 900, outputTokens: 120 } })
out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: 'completed' } })
out({ type: 'final', text: 'Fixed the loop bound in range.js; node --test passes.' })
`)
    chmodSync(fake, 0o755)
    const specPath = join(root, '.evals/agent-tests/eval.yaml')
    writeFileSync(specPath, readFileSync(specPath, 'utf8').replace('dshCommand: dsh', `dshCommand: ${JSON.stringify(fake)}`).replace('repeats: 3', 'repeats: 1'))
    gitInit(root)
    const opts = { cwd: root, name: 'agent-tests', home }
    const valid = await validateEval(opts)
    assert.equal(valid.ok, true, JSON.stringify(valid.errors))
    const run = await runOp({ ...opts, split: 'inbox' }, { judge: async () => ({ pass: true, critique: 'ran tests after the edit' }) })
    assert.equal(run.infra.count, 0, JSON.stringify(run.infra))
    assert.equal(run.perMode['tests-still-fail'].passRate, 1)
    assert.equal(run.perMode['weakens-tests'].passRate, 1)
    assert.equal(run.score, 1)
    // The fixture in the project itself is untouched: every run had its own worktree.
    assert.match(readFileSync(join(root, '.evals/agent-tests/fixtures/off-by-one/range.js'), 'utf8'), /i < end/)
  })
})
