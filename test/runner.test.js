import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { parseSpec } from '../lib/core/spec.js'
import { costOf, runEval } from '../lib/runner.js'
import { parseHeadlessStream, runDshAgentTarget } from '../lib/targets/dsh-agent.js'
import { parseCommandOutput } from '../lib/targets/command.js'
import { CATEGORY_CHECK, TRIAGE_APP, fakeDsh, gitInit, tempProject, triageCases, writeFiles } from './helpers.js'

/** @param {string} yaml */
function spec(yaml) {
  const { spec: value, errors } = parseSpec(yaml)
  assert.deepEqual(errors, [])
  return /** @type {import('../lib/core/spec.js').EvalSpec} */ (value)
}

async function triageProject() {
  const root = await tempProject('triage')
  await writeFiles(root, {
    'app.mjs': TRIAGE_APP,
    'rules.json': JSON.stringify({ refund: 'refund', crash: 'bug', invoice: 'billing' }),
    '.evals/triage/graders/wrong-category.check.mjs': CATEGORY_CHECK,
    '.evals/triage/graders/promises-refund.judge.md': 'Fails if the reply promises a refund for a ticket that is not about refunds.\n',
  })
  return root
}

describe('runner', () => {
  it('runs a command target with code and judge graders', async () => {
    const root = await triageProject()
    const evalSpec = spec(`
name: triage
target: { kind: command, command: "node app.mjs", timeoutMs: 20000 }
repeats: 2
prices: { toy-1: { input: 1, output: 2 } }
graders:
  - { mode: wrong-category, kind: code }
  - { mode: promises-refund, kind: judge }
`)
    /** @type {string[]} */
    const judged = []
    const judge = async (/** @type {any} */ request) => {
      judged.push(request.mode)
      const promises = String(request.output.reply).includes('refund')
      const isRefund = String(request.input.ticket).includes('refund')
      return { pass: !promises || isRefund, critique: 'checked the reply' }
    }
    const runDir = join(root, '.evals/triage/runs/r1')
    const { summary, rows } = await runEval({
      spec: evalSpec, evalRoot: join(root, '.evals/triage'), cases: triageCases(), split: 'train',
      candidateRoot: root, runDir, judge, consistencySample: 3,
    })
    assert.equal(rows.length, 48)
    // rules miss 'money back', 'error', 'charged' => 12 of 24 cases wrong.
    assert.equal(summary.perMode['wrong-category']?.passRate, 0.5)
    assert.equal(summary.perMode['promises-refund']?.passRate, 1)
    assert.equal(summary.score, 0.5)
    assert.ok(summary.ci.low < 0.5 && summary.ci.high > 0.5)
    assert.equal(summary.infra.count, 0)
    assert.ok(summary.judgeConsistency && summary.judgeConsistency.checked === 3)
    assert.ok(Math.abs(/** @type {number} */ (summary.costUsd) - 48 * (100 + 40) / 1e6) < 1e-12)
    assert.ok(summary.diagnostics.some(d => d.includes('failed every repeat')))
    assert.ok(existsSync(join(runDir, 'results.html')))
    assert.ok(existsSync(join(runDir, 'summary.json')))
    const transcript = JSON.parse(readFileSync(join(runDir, rows[0].transcript), 'utf8'))
    assert.equal(transcript.output.category !== undefined, true)
    assert.equal(judged.length, 48 + 3)
    const html = readFileSync(join(runDir, 'results.html'), 'utf8')
    assert.match(html, /wrong-category/)
  })

  it('reports infra errors separately and never sends expected to the target', async () => {
    const root = await tempProject('infra')
    await writeFiles(root, {
      'app.mjs': `import { readFileSync } from 'node:fs'
const c = JSON.parse(readFileSync(0, 'utf8'))
if ('expected' in c) { console.log(JSON.stringify({ output: 'LEAK' })); process.exit(0) }
if (c.id === 'boom') process.exit(3)
if (c.id === 'slow') await new Promise(r => setTimeout(r, 5000))
console.log('plain text answer')`,
      '.evals/x/graders/not-leaked.check.mjs': `export default ({ output }) => output !== 'LEAK'`,
    })
    const evalSpec = spec(`
name: x
target: { kind: command, command: "node app.mjs", timeoutMs: 1500 }
repeats: 1
graders: [{ mode: not-leaked, kind: code }]
`)
    const cases = [
      { id: 'ok', input: 'a', expected: 'secret' },
      { id: 'boom', input: 'b' },
      { id: 'slow', input: 'c' },
    ]
    const { summary, rows } = await runEval({
      spec: evalSpec, evalRoot: join(root, '.evals/x'), cases, split: 'all',
      candidateRoot: root, runDir: join(root, 'run'),
    })
    assert.equal(summary.score, 1)
    assert.equal(summary.infra.count, 2)
    assert.deepEqual(Object.keys(summary.infra.byKind).sort(), ['exit', 'timeout'])
    assert.equal(rows.find(r => r.caseId === 'ok')?.output, 'plain text answer')
  })

  it('isolates each run in a git worktree', async () => {
    const root = await triageProject()
    await writeFiles(root, {
      'app.mjs': TRIAGE_APP + `\nimport { writeFileSync } from 'node:fs'\nwriteFileSync('side-effect.txt', 'x')\n`,
    })
    gitInit(root)
    // An uncommitted edit is part of the snapshot.
    await writeFiles(root, { 'rules.json': JSON.stringify({ refund: 'refund', 'money back': 'refund', crash: 'bug', error: 'bug', invoice: 'billing', charged: 'billing' }) })
    const evalSpec = spec(`
name: triage
target: { kind: command, command: "node app.mjs", isolation: worktree }
repeats: 1
graders: [{ mode: wrong-category, kind: code }]
`)
    const { summary } = await runEval({
      spec: evalSpec, evalRoot: join(root, '.evals/triage'), cases: triageCases().slice(0, 8), split: 'train',
      candidateRoot: root, runDir: join(root, 'run'),
    })
    assert.equal(summary.score, 1)
    assert.equal(existsSync(join(root, 'side-effect.txt')), false)
  })

  it('runs the dsh-agent target through the headless protocol', async () => {
    const root = await tempProject('agent')
    const dsh = await fakeDsh(root)
    await writeFiles(root, { '.dsh/auto-eval-target.yml': '- id: agent-default-model\n  config: { provider: p, model: m }\n' })
    const target = /** @type {any} */ (spec(`
name: a
target: { kind: dsh-agent, dshCommand: ${JSON.stringify(dsh)}, patch: .dsh/auto-eval-target.yml, isolation: shared }
`).target)
    const result = await runDshAgentTarget({
      target, evalCase: { id: 'c', input: { task: 'run the tests' } }, workdir: root, candidateRoot: root,
      readSession: async () => { throw new Error('no store') },
    })
    assert.equal(result.output, 'All tests pass.')
    assert.equal(result.infraError, undefined)
    assert.equal(result.trace.toolCalls, 1)
    assert.equal(result.trace.usage.inputTokens, 500)
    assert.match(result.sessionId ?? '', /^session-fake-/)
    assert.equal(readFileSync(join(root, 'agent-was-here.txt'), 'utf8'), 'run the tests')
    const text = result.trace.items.find(i => i.kind === 'assistant')?.text ?? ''
    assert.match(text, /--profile headless --patch .*auto-eval-target\.yml --json -/)

    const failing = await fakeDsh(await tempProject('agent2'), { reason: 'max-tokens', reply: '' })
    const cut = await runDshAgentTarget({
      target: { ...target, dshCommand: failing }, evalCase: { id: 'c', input: 'x' }, workdir: root, candidateRoot: root,
    })
    assert.equal(cut.infraError?.kind, 'max-tokens')
    const missing = await runDshAgentTarget({
      target: { ...target, dshCommand: join(root, 'no-such-dsh') }, evalCase: { id: 'c', input: 'x' }, workdir: root, candidateRoot: root,
    })
    assert.equal(missing.infraError?.kind, 'spawn')
  })

  it('parses outputs and computes cost', () => {
    assert.deepEqual(parseCommandOutput('log line\n{"output": 3}\n'), { output: 3 })
    assert.deepEqual(parseCommandOutput('"just a string"'), { output: 'just a string' })
    assert.deepEqual(parseCommandOutput('hello'), { output: 'hello' })
    const stream = parseHeadlessStream('{"type":"error","message":"boom"}\nnot json\n')
    assert.equal(stream.error, 'boom')
    const usage = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, reasoningTokens: 0 }
    assert.equal(costOf(usage, 'm', { m: { input: 1, output: 2, cacheRead: 0.1 } }), 3.1)
    assert.equal(costOf(usage, 'other', { m: { input: 1, output: 2 }, n: { input: 1, output: 1 } }), undefined)
  })
})
