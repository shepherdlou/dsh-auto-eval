import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { evalPaths, readJsonl, writeJsonl } from '../lib/core/store.js'
import { hillclimbFinish, hillclimbRound, hillclimbStart, hillclimbStatus } from '../lib/ops/hillclimb.js'
import { initEval, validateEval } from '../lib/ops/init.js'
import { splitOp } from '../lib/ops/split.js'
import { runOp } from '../lib/ops/run.js'
import { CATEGORY_CHECK, TRIAGE_APP, git, gitInit, tempProject, triageCases, writeFiles } from './helpers.js'

const RULES_ALL = { refund: 'refund', 'money back': 'refund', crash: 'bug', error: 'bug', invoice: 'billing', charged: 'billing' }

describe('hillclimb', () => {
  it('keeps real gains, reverts regressions, voids eval edits', async () => {
    const root = await tempProject('hc')
    const home = await tempProject('hc-home')
    await writeFiles(root, {
      'app.mjs': TRIAGE_APP,
      'rules.json': JSON.stringify({ refund: 'refund', crash: 'bug', invoice: 'billing' }),
    })
    gitInit(root)
    await initEval({ cwd: root, name: 'triage', target: 'command', command: 'node app.mjs', home })
    const paths = evalPaths(root, 'triage', home)
    await writeFile(paths.spec, [
      'name: triage',
      'target: { kind: command, command: "node app.mjs", timeoutMs: 20000 }',
      'repeats: 1',
      'concurrency: 8',
      'split: { seed: 5, testFraction: 0.3 }',
      'graders: [{ mode: wrong-category, kind: code }]',
      '',
    ].join('\n'))
    await writeFiles(paths.root, { 'graders/wrong-category.check.mjs': CATEGORY_CHECK })
    await writeJsonl(paths.inboxCases, triageCases())
    assert.equal((await validateEval({ cwd: root, name: 'triage', home })).ok, true)

    // A pre-split run sees future test cases, so the split archives it.
    const pre = await runOp({ cwd: root, name: 'triage', home, split: 'inbox', limit: 4 }, {})
    assert.equal(pre.split, 'inbox')
    const split = await splitOp({ cwd: root, name: 'triage', home })
    assert.equal(split.train.added + split.test.added, 24)
    assert.equal(split.archivedPreSplitRuns, 1)
    assert.equal((await readJsonl(paths.inboxCases)).length, 0)
    assert.ok(existsSync(paths.testCases))
    assert.ok(!paths.testCases.startsWith(root), 'test cases live outside the workspace')

    // Test runs only report aggregates.
    const testRun = await runOp({ cwd: root, name: 'triage', home, split: 'test' }, {})
    assert.equal('failures' in testRun, false)
    assert.equal('perCase' in testRun, false)

    const start = await hillclimbStart({ cwd: root, name: 'triage', home, baselineRuns: 2, maxRounds: 5 }, {})
    assert.equal(start.noiseFloor.train, 0, 'deterministic target and grader: no noise')
    assert.ok(start.baseline.train.score > 0.3 && start.baseline.train.score < 0.7)
    assert.ok(start.trainFailures.length > 0)
    const editIn = start.editIn
    assert.notEqual(editIn, root)

    // Round 1: a regression is reverted.
    await writeFile(join(editIn, 'rules.json'), JSON.stringify({ crash: 'bug' }))
    const r1 = await hillclimbRound({ cwd: root, name: 'triage', home, note: 'drop rules' }, {})
    assert.equal(r1.decision, 'revert')
    assert.match(r1.reason, /regression/)
    assert.deepEqual(JSON.parse(readFileSync(join(editIn, 'rules.json'), 'utf8')), { refund: 'refund', crash: 'bug', invoice: 'billing' })

    // Round 2: the fix is kept.
    await writeFile(join(editIn, 'rules.json'), JSON.stringify(RULES_ALL))
    const r2 = await hillclimbRound({ cwd: root, name: 'triage', home, note: 'add synonyms' }, {})
    assert.equal(r2.decision, 'keep', r2.reason)
    assert.equal(r2.train.score, 1)
    assert.equal(r2.test.score, 1)

    // Round 3: touching the eval voids the round.
    await writeFiles(editIn, { '.evals/triage/graders/wrong-category.check.mjs': 'export default () => true' })
    const r3 = await hillclimbRound({ cwd: root, name: 'triage', home, note: 'game the grader' }, {})
    assert.equal(r3.decision, 'void')
    assert.equal(existsSync(join(editIn, '.evals')), false)

    // No edits: nothing to evaluate.
    await assert.rejects(hillclimbRound({ cwd: root, name: 'triage', home }, {}), /no changes/)

    // Changing the real eval mid-climb voids the round too.
    const graderPath = join(paths.graders, 'wrong-category.check.mjs')
    const original = readFileSync(graderPath, 'utf8')
    await writeFile(graderPath, original + '\n// tweak\n')
    await writeFile(join(editIn, 'rules.json'), JSON.stringify({ ...RULES_ALL, foo: 'other' }))
    const r4 = await hillclimbRound({ cwd: root, name: 'triage', home, note: 'x' }, {})
    assert.equal(r4.decision, 'void')
    await writeFile(graderPath, original)

    const status = await hillclimbStatus({ cwd: root, name: 'triage', home })
    assert.equal(status.best.round, 2)
    assert.deepEqual(status.history.map(h => h.decision), ['revert', 'keep', 'void', 'void'])

    const done = await hillclimbFinish({ cwd: root, name: 'triage', home })
    assert.equal(done.bestRound, 2)
    assert.equal(done.best.test.score, 1)
    assert.match(done.changes, /rules\.json/)
    assert.equal(existsSync(editIn), false, 'worktree removed, branch kept')
    assert.match(git(root, 'branch', '--list', 'auto-eval/*'), /auto-eval\/triage\/hc-/)
    // The user's checkout is untouched.
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'rules.json'), 'utf8')), { refund: 'refund', crash: 'bug', invoice: 'billing' })
    const log = await readJsonl(paths.hillclimbLog)
    assert.deepEqual(log.map(e => e.kind ?? e.decision), ['baseline', 'revert', 'keep', 'void', 'void', 'finish'])
  })
})
