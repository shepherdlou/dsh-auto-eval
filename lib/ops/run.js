// @ts-check
/**
 * eval_run: run one split and report. Train and inbox runs report in full;
 * test runs are stored in the held-out store and only aggregates come back.
 */
import { join } from 'node:path'
import { evalPaths, loadCases, loadSpec, newRunId } from '../core/store.js'
import { seededRandom, shuffled } from '../core/split.js'
import { runEval } from '../runner.js'

/**
 * @typedef {{
 *   judge?: import('../graders/llm.js').Judge,
 *   readSession?: (id: string) => Promise<any>,
 *   signal?: AbortSignal,
 *   onProgress?: (done: number, total: number) => void,
 * }} RunDeps
 */

/**
 * Cases for a split.
 * @param {import('../core/store.js').EvalPaths} paths
 * @param {'inbox' | 'train' | 'test'} split
 */
export async function casesFor(paths, split) {
  const path = split === 'inbox' ? paths.inboxCases : split === 'train' ? paths.trainCases : paths.testCases
  return loadCases(path)
}

/**
 * What a test-split run may reveal: aggregate numbers only.
 * @param {import('../runner.js').RunSummary} summary
 */
export function heldoutView(summary) {
  return {
    runId: summary.runId,
    split: summary.split,
    cases: summary.cases,
    repeats: summary.repeats,
    score: summary.score,
    ci: summary.ci,
    perMode: Object.fromEntries(Object.entries(summary.perMode).map(([mode, m]) => [mode, { passRate: m.passRate, n: m.n }])),
    infra: { count: summary.infra.count, byKind: summary.infra.byKind },
    graderErrors: summary.graderErrors.count,
    costPerCaseUsd: summary.costPerCaseUsd,
    latencyMs: summary.latencyMs,
    diagnostics: summary.diagnostics,
    note: 'held-out split: per-case results stay outside the workspace',
  }
}

/**
 * Full view of a visible run, minus the bulky per-case map, plus the failures
 * worth reading first.
 * @param {import('../runner.js').RunSummary} summary
 * @param {readonly import('../runner.js').RunRow[]} rows
 * @param {string} runDir
 */
export function visibleView(summary, rows, runDir) {
  const failures = rows
    .filter(row => row.pass === false)
    .slice(0, 15)
    .map(row => ({
      caseId: row.caseId,
      rep: row.rep,
      failed: Object.entries(row.grades)
        .filter(([, g]) => 'pass' in g && !g.pass)
        .map(([mode, g]) => ({ mode, why: String(('critique' in g && g.critique) || ('reason' in g && g.reason) || '').slice(0, 300) })),
      transcript: join(runDir, row.transcript),
    }))
  const { perCase: _perCase, ...rest } = summary
  return { ...rest, failures, report: join(runDir, 'results.html') }
}

/**
 * @param {{
 *   cwd: string, name: string, home?: string, split: 'inbox' | 'train' | 'test',
 *   repeats?: number, limit?: number, modes?: string[], consistencySample?: number,
 * }} options
 * @param {RunDeps} deps
 */
export async function runOp(options, deps) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const spec = await loadSpec(paths)
  let cases = await casesFor(paths, options.split)
  if (options.limit !== undefined && options.limit < cases.length) {
    cases = shuffled(cases, seededRandom(spec.split.seed + 1)).slice(0, options.limit)
  }
  const heldout = options.split === 'test'
  const runId = newRunId(options.split)
  const runDir = join(heldout ? paths.heldoutRuns : paths.runs, runId)
  const { summary, rows } = await runEval({
    spec, evalRoot: paths.root, cases, split: options.split, candidateRoot: options.cwd, runDir, runId,
    redactCaseIds: heldout,
    ...options.repeats !== undefined ? { repeats: options.repeats } : {},
    ...options.modes !== undefined ? { modes: options.modes } : {},
    ...options.consistencySample !== undefined ? { consistencySample: options.consistencySample } : {},
    ...deps.judge ? { judge: deps.judge } : {},
    ...deps.readSession ? { readSession: deps.readSession } : {},
    ...deps.signal ? { signal: deps.signal } : {},
    ...deps.onProgress ? { onProgress: deps.onProgress } : {},
  })
  return heldout ? heldoutView(summary) : visibleView(summary, rows, runDir)
}
