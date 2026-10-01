// Human checkpoints and the tools that keep the agent out of them:
// grader-less runs for error analysis, the review CLI that outlives a
// headless dsh process, bulk case approval, and stale judge calibration.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { appendFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { evalPaths, readJsonl, writeJsonl } from '../lib/core/store.js'
import { runOp } from '../lib/ops/run.js'
import { calibrationStatus, rubricHash } from '../lib/ops/judge-check.js'
import { loadSpec, writeJson } from '../lib/core/store.js'
import { readRubric } from '../lib/graders/llm.js'
import { statusText } from '../lib/status.js'
import { startReviewServer } from '../lib/review/server.js'
import { TRIAGE_APP, tempProject, triageCases, writeFiles } from './helpers.js'

const CLI = fileURLToPath(new URL('../bin/dsh-auto-eval.mjs', import.meta.url))

async function project() {
  const root = await tempProject('cp')
  const home = await tempProject('cp-home')
  await writeFiles(root, {
    'app.mjs': TRIAGE_APP,
    'rules.json': JSON.stringify({ refund: 'refund' }),
    '.evals/triage/eval.yaml': 'name: triage\ntarget: { kind: command, command: "node app.mjs" }\nrepeats: 1\n',
  })
  const paths = evalPaths(root, 'triage', home)
  await writeJsonl(paths.inboxCases, triageCases().slice(0, 6))
  return { root, home, paths }
}

describe('human checkpoints', () => {
  it('eval_run without graders collects outputs and can save them as traces', async () => {
    const { root, home, paths } = await project()
    const run = await runOp({ cwd: root, name: 'triage', home, split: 'inbox', saveAsTraces: true }, {})
    assert.equal(run.scoredRuns, 0)
    assert.equal(run.outputs.length, 6)
    assert.equal(run.savedTraces, 6)
    assert.ok(run.diagnostics.some(d => /no graders/.test(d)))
    const traces = readdirSync(paths.traces)
    assert.equal(traces.length, 6)
    await assert.rejects(runOp({ cwd: root, name: 'triage', home, split: 'test', saveAsTraces: true }, {}), /cannot be saved as traces/)
  })

  it('bulk-approves remaining cases through the review server', async () => {
    const { paths } = await project()
    const server = await startReviewServer({ paths })
    try {
      const base = server.url.replace(/\/\?token=.*/, '')
      const res = await fetch(`${base}/api/case-label-bulk`, {
        method: 'POST', headers: { 'x-review-token': server.token, 'content-type': 'application/json' },
        body: JSON.stringify({ ids: ['t00', 't01', 't02'], status: 'approved' }),
      })
      assert.deepEqual(await res.json(), { count: 3 })
      const labels = await readJsonl(join(paths.labels, 'cases.jsonl'))
      assert.equal(labels.filter(l => l.status === 'approved').length, 3)
    } finally {
      await server.close()
    }
  })

  it('the CLI serves the review page outside dsh and prints status', async () => {
    const { root, home } = await project()
    const env = { ...process.env, DSH_HOME: home }
    const status = await new Promise(resolve => {
      const p = spawn(process.execPath, [CLI, 'status', '--cwd', root], { env })
      let out = ''
      p.stdout.on('data', d => { out += d })
      p.on('close', () => resolve(out))
    })
    assert.match(status, /■ triage \(command, 0 graders\)/)
    assert.match(status, /case review: 0 approved · 0 rejected · 6 waiting/)

    const child = spawn(process.execPath, [CLI, 'review', 'triage', '--cwd', root], { env })
    try {
      const url = await new Promise((resolve, reject) => {
        let out = ''
        child.stdout.on('data', d => {
          out += d
          const m = /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(out)
          if (m) resolve(m[1])
        })
        child.on('close', code => reject(new Error(`cli exited ${code}`)))
      })
      const page = await fetch(url)
      assert.equal(page.status, 200)
    } finally {
      child.kill('SIGTERM')
    }
  })

  it('a judge calibration goes stale when its rubric changes', async () => {
    const { root, home, paths } = await project()
    await writeFiles(paths.root, {
      'eval.yaml': 'name: triage\ntarget: { kind: command, command: "node app.mjs" }\ngraders: [{ mode: tone, kind: judge }]\n',
      'graders/tone.judge.md': 'FAIL if the reply is rude. PASS otherwise.\n',
    })
    const spec = await loadSpec(paths)
    assert.deepEqual((await calibrationStatus(paths, spec)).map(c => c.status), ['missing'])
    await writeJson(join(paths.root, 'judge-checks', 'tone.json'), {
      test: { tpr: 0.95, tnr: 0.92, meetsThresholds: true },
      rubricHash: rubricHash(await readRubric(paths.root, 'graders/tone.judge.md')),
    })
    assert.deepEqual((await calibrationStatus(paths, spec)).map(c => c.status), ['ok'])
    appendFileSync(join(paths.graders, 'tone.judge.md'), 'Also FAIL if it uses emoji.\n')
    assert.deepEqual((await calibrationStatus(paths, spec)).map(c => c.status), ['stale'])
    assert.match(await statusText(root, { home }), /judge tone: stale/)
  })
})
