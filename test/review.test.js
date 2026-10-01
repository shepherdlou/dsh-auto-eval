import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { evalPaths, writeJson, writeJsonl } from '../lib/core/store.js'
import { normalizeSession } from '../lib/core/traces.js'
import { parseSpec } from '../lib/core/spec.js'
import { runEval } from '../lib/runner.js'
import { startReviewServer } from '../lib/review/server.js'
import { reviewStatus } from '../lib/review/data.js'
import { CATEGORY_CHECK, TRIAGE_APP, tempProject, triageCases, writeFiles } from './helpers.js'
import { sessionSnapshot } from './fixtures/session.js'

describe('review server', () => {
  it('serves labels, taxonomy, cases, blind grader labels and results', async () => {
    const root = await tempProject('review')
    const home = await tempProject('home')
    const paths = evalPaths(root, 'triage', home)
    await writeFiles(root, {
      'app.mjs': TRIAGE_APP,
      'rules.json': JSON.stringify({ refund: 'refund' }),
      '.evals/triage/eval.yaml': 'name: triage\ntarget: { kind: command, command: "node app.mjs" }\nrepeats: 1\ngraders:\n  - { mode: wrong-category, kind: code }\n  - { mode: promises-refund, kind: judge }\n',
      '.evals/triage/graders/wrong-category.check.mjs': CATEGORY_CHECK,
      '.evals/triage/graders/promises-refund.judge.md': 'Fails if the reply promises a refund the ticket did not ask for.\n',
    })
    const trace = normalizeSession(sessionSnapshot)
    await writeJson(join(paths.traces, `${trace.id}.json`), trace)
    await writeJson(join(paths.traces, 'other.json'), { ...trace, id: 'other', feedback: [] })
    await writeJsonl(paths.inboxCases, triageCases().slice(0, 4))
    const { spec } = parseSpec('name: triage\ntarget: { kind: command, command: "node app.mjs" }\nrepeats: 1\ngraders:\n  - { mode: wrong-category, kind: code }\n  - { mode: promises-refund, kind: judge }\n')
    await runEval({
      spec, evalRoot: paths.root, cases: triageCases().slice(0, 4), split: 'inbox', candidateRoot: root,
      runDir: join(paths.runs, 'run-1'), runId: 'run-1',
      judge: async () => ({ pass: false, critique: 'promised a refund' }),
    })

    const server = await startReviewServer({ paths })
    try {
      const base = server.url.replace(/\/\?token=.*/, '')
      const call = async (path, init = {}) => {
        const res = await fetch(base + path, { ...init, headers: { 'x-review-token': server.token, 'content-type': 'application/json' } })
        return { status: res.status, body: await res.json() }
      }

      assert.equal((await fetch(base + '/api/meta')).status, 401)
      const page = await fetch(server.url)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /Failure modes/)

      const meta = await call('/api/meta')
      assert.equal(meta.body.evalName, 'triage')
      assert.equal(meta.body.runs[0].runId, 'run-1')

      const traces = await call('/api/traces')
      assert.equal(traces.body.length, 2)
      assert.equal(traces.body.find(t => t.id === 'session-abc').flagged, true)

      await call('/api/trace-label', { method: 'POST', body: JSON.stringify({ id: 'session-abc', pass: false, note: 'deleted the test' }) })
      await call('/api/trace-label', { method: 'POST', body: JSON.stringify({ id: 'other', pass: true, note: '' }) })
      const tax = await call('/api/taxonomy', { method: 'PUT', body: JSON.stringify({ modes: [{ id: 'deletes-tests', name: 'Deletes tests', traceIds: ['session-abc'] }, { id: 'rare', name: 'Rare', traceIds: [] }] }) })
      assert.equal(tax.body.modes[0].id, 'deletes-tests')
      assert.equal((await call('/api/taxonomy', { method: 'PUT', body: JSON.stringify({ modes: [{ id: 'Bad Id' }] }) })).status, 400)
      const notes = await call('/api/taxonomy')
      assert.deepEqual(notes.body.notes.find(n => n.traceId === 'session-abc').modes, ['deletes-tests'])

      const cases = await call('/api/cases')
      assert.equal(cases.body.length, 4)
      await call('/api/case-label', { method: 'POST', body: JSON.stringify({ id: cases.body[0].id, status: 'rejected', note: 'dup' }) })

      const status = await reviewStatus(paths)
      assert.deepEqual(status.traces, { total: 2, labeled: 2, pass: 1, fail: 1, withNotes: 1 })
      assert.equal(status.cases.rejected, 1)

      const items = await call('/api/grader-items?mode=promises-refund&run=run-1')
      assert.equal(items.body.items.length, 4)
      assert.match(items.body.rubric, /promises a refund/)
      const itemId = items.body.items[0].id
      const blind = await call(`/api/grader-item?mode=promises-refund&run=run-1&id=${encodeURIComponent(itemId)}`)
      assert.equal(blind.body.grader, null, 'judge verdict hidden before the human labels')
      await call('/api/grader-label', { method: 'POST', body: JSON.stringify({ mode: 'promises-refund', id: itemId, pass: true }) })
      const revealed = await call(`/api/grader-item?mode=promises-refund&run=run-1&id=${encodeURIComponent(itemId)}`)
      assert.equal(revealed.body.grader.pass, false)

      const run = await call('/api/run?run=run-1')
      assert.equal(run.body.rows.length, 4)
      const transcript = await call(`/api/transcript?run=run-1&file=${encodeURIComponent(run.body.rows[0].transcript)}`)
      assert.ok(transcript.body.trace)
      assert.equal((await call('/api/transcript?run=run-1&file=../../eval.yaml')).status, 400)
      assert.equal((await call('/api/run?run=..%2F..')).status, 400)

      await call('/api/dispute', { method: 'POST', body: JSON.stringify({ run: 'run-1', caseId: 't00', rep: 1, mode: 'promises-refund', graderPass: false, note: 'fine' }) })
      assert.equal((await call('/api/disputes')).body.length, 1)
    } finally {
      await server.close()
    }
  })
})
