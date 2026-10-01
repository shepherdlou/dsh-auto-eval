// @ts-check
/**
 * Run an eval: every case × repeat through the target, every grader on every
 * scored output, then aggregate with intervals and diagnostics. Infra
 * failures (timeouts, provider errors, cut-off replies) and grader errors are
 * excluded from the score and reported on their own, because counting them
 * as target failures hides what is actually broken.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { runCodeGrader } from './graders/code.js'
import { readRubric } from './graders/llm.js'
import { bootstrapMeanCI, mean, quantile, wilson } from './core/stats.js'
import { clip } from './core/judge.js'
import { renderTraceText } from './core/traces.js'
import { appendJsonl, newRunId, writeJson } from './core/store.js'
import { runCommandTarget } from './targets/command.js'
import { runDshAgentTarget } from './targets/dsh-agent.js'
import {
  addDetachedWorktree, copyFixture, removeWorktree, repoRoot, snapshotRef, untrackedFiles,
} from './targets/worktree.js'
import { writeReport } from './report.js'

/**
 * @typedef {import('./core/spec.js').EvalSpec} EvalSpec
 * @typedef {import('./core/spec.js').EvalCase} EvalCase
 * @typedef {import('./graders/llm.js').Judge} Judge
 * @typedef {{ pass: boolean, reason?: string, critique?: string } | { error: string }} GradeOutcome
 * @typedef {{
 *   caseId: string, rep: number, tags: string[], pass: boolean | null,
 *   grades: Record<string, GradeOutcome>, output: string, latencyMs: number,
 *   usage: import('./core/traces.js').Usage, costUsd?: number, model?: string, sessionId?: string,
 *   infraError?: { kind: string, message: string }, transcript: string,
 * }} RunRow
 */

/**
 * USD cost of one run from token counts. dsh reports disjoint counts (input
 * excludes cache reads); output is assumed to include reasoning tokens.
 * @param {import('./core/traces.js').Usage} usage
 * @param {string | undefined} model
 * @param {Record<string, import('./core/spec.js').Price>} prices
 */
export function costOf(usage, model, prices) {
  const entries = Object.entries(prices)
  if (entries.length === 0) return undefined
  const price = (model !== undefined ? prices[model] : undefined) ?? (entries.length === 1 ? entries[0]?.[1] : undefined)
  if (price === undefined) return undefined
  return (usage.inputTokens * price.input
    + usage.cacheReadTokens * (price.cacheRead ?? price.input)
    + usage.outputTokens * price.output) / 1e6
}

/**
 * Bounded-concurrency map preserving input order.
 * @template T, R
 * @param {readonly T[]} items @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function pool(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(/** @type {T} */ (items[index]), index)
    }
  })
  await Promise.all(workers)
  return results
}

/** @param {string} id */
function safeName(id) {
  return id.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)
}

/**
 * @param {{
 *   spec: EvalSpec, evalRoot: string, cases: readonly EvalCase[], split: string,
 *   candidateRoot: string, candidateRef?: string, runDir: string, runId?: string,
 *   repeats?: number, judge?: Judge, readSession?: (id: string) => Promise<any>,
 *   signal?: AbortSignal, onProgress?: (done: number, total: number) => void,
 *   modes?: readonly string[], consistencySample?: number,
 * }} options
 */
export async function runEval(options) {
  const { spec, evalRoot, cases, candidateRoot, runDir } = options
  const runId = options.runId ?? newRunId(options.split)
  const repeats = options.repeats ?? spec.repeats
  const graders = spec.graders.filter(g => options.modes === undefined || options.modes.includes(g.mode))
  if (graders.length === 0) throw new Error('no graders to run: add at least one grader to eval.yaml')
  if (cases.length === 0) throw new Error(`no ${options.split} cases to run`)

  /** @type {Map<string, string>} */
  const rubrics = new Map()
  for (const grader of graders) {
    if (grader.kind === 'judge') {
      if (options.judge === undefined) throw new Error('judge graders need an LLM; no llm service is available')
      rubrics.set(grader.mode, await readRubric(evalRoot, grader.file))
    }
  }

  const startedAt = new Date().toISOString()
  /** @type {string[]} */
  const notes = []
  const isolation = spec.target.isolation
  /** @type {string | undefined} */ let repo
  /** @type {string | undefined} */ let ref
  if (isolation === 'worktree') {
    repo = await repoRoot(candidateRoot)
    if (repo === undefined) throw new Error('target.isolation: worktree needs a git repository; set isolation: shared')
    ref = options.candidateRef ?? await snapshotRef(candidateRoot)
    if (options.candidateRef === undefined) {
      const untracked = await untrackedFiles(candidateRoot)
      if (untracked.length > 0) {
        notes.push(`${untracked.length} untracked file(s) are not part of the run snapshot (git add them to include): ${untracked.slice(0, 5).join(', ')}`)
      }
    }
  }
  if (isolation === 'shared' && cases.some(c => c.fixture !== undefined)) {
    throw new Error('case fixtures need target.isolation: worktree')
  }

  const transcriptsDir = join(runDir, 'transcripts')
  await mkdir(transcriptsDir, { recursive: true })
  const resultsPath = join(runDir, 'results.jsonl')

  const work = cases.flatMap(evalCase => Array.from({ length: repeats }, (_, rep) => ({ evalCase, rep: rep + 1 })))
  let done = 0
  /** @type {{ row: RunRow, evalCase: EvalCase, output: unknown, traceText?: string }[]} */
  const judged = []

  const rows = await pool(work, spec.concurrency, async ({ evalCase, rep }) => {
    options.signal?.throwIfAborted()
    /** @type {string | undefined} */ let worktree
    let workdir = candidateRoot
    try {
      if (isolation === 'worktree' && repo !== undefined && ref !== undefined) {
        worktree = await addDetachedWorktree(repo, ref, `${runId}-${evalCase.id}-${rep}`)
        workdir = join(worktree, relative(repo, candidateRoot))
        if (evalCase.fixture) await copyFixture(evalRoot, evalCase.fixture, workdir)
      }
      const result = spec.target.kind === 'command'
        ? await runCommandTarget({ target: spec.target, evalCase, workdir, ...options.signal ? { signal: options.signal } : {} })
        : await runDshAgentTarget({
          target: spec.target, evalCase, workdir, candidateRoot,
          ...options.signal ? { signal: options.signal } : {},
          ...options.readSession ? { readSession: options.readSession } : {},
        })

      /** @type {Record<string, GradeOutcome>} */
      const grades = {}
      const hasSteps = result.trace.items.some(item => item.kind === 'tool-call' || item.kind === 'tool-result')
      const traceText = hasSteps ? renderTraceText(result.trace, { maxChars: 12_000 }) : undefined
      if (result.infraError === undefined) {
        for (const grader of graders) {
          try {
            if (grader.kind === 'code') {
              grades[grader.mode] = await runCodeGrader({
                evalRoot, file: grader.file,
                context: { input: evalCase.input, output: result.output, expected: evalCase.expected, case: evalCase, trace: result.trace, workdir },
              })
            } else {
              const judgement = await /** @type {Judge} */ (options.judge)({
                mode: grader.mode, rubric: /** @type {string} */ (rubrics.get(grader.mode)),
                input: evalCase.input, output: result.output, expected: evalCase.expected,
                ...traceText !== undefined ? { trace: traceText } : {},
                ...options.signal ? { signal: options.signal } : {},
              })
              grades[grader.mode] = { pass: judgement.pass, critique: judgement.critique }
            }
          } catch (error) {
            grades[grader.mode] = { error: error instanceof Error ? error.message : String(error) }
          }
        }
      }
      const outcomes = Object.values(grades)
      const pass = result.infraError !== undefined || outcomes.some(g => 'error' in g)
        ? null
        : outcomes.every(g => 'pass' in g && g.pass)
      const transcript = `transcripts/${safeName(evalCase.id)}.${rep}.json`
      /** @type {RunRow} */
      const row = {
        caseId: evalCase.id,
        rep,
        tags: evalCase.tags ?? [],
        pass,
        grades,
        output: clip(typeof result.output === 'string' ? result.output : JSON.stringify(result.output), 4000),
        latencyMs: result.latencyMs,
        usage: result.trace.usage,
        ...result.model ? { model: result.model } : {},
        ...result.sessionId ? { sessionId: result.sessionId } : {},
        ...result.infraError ? { infraError: result.infraError } : {},
        transcript,
      }
      const cost = costOf(row.usage, row.model, spec.prices)
      if (cost !== undefined) row.costUsd = cost
      await writeJson(join(runDir, transcript), {
        caseId: evalCase.id, rep, input: evalCase.input, expected: evalCase.expected, tags: evalCase.tags ?? [],
        output: result.output, grades, pass, infraError: result.infraError, latencyMs: result.latencyMs,
        trace: result.trace,
      })
      await appendJsonl(resultsPath, row)
      if (pass !== null && rubrics.size > 0) {
        judged.push({ row, evalCase, output: result.output, ...traceText !== undefined ? { traceText } : {} })
      }
      return row
    } finally {
      if (worktree !== undefined && repo !== undefined) await removeWorktree(repo, worktree)
      options.onProgress?.(++done, work.length)
    }
  })

  // Grader consistency: grade the same output again; a judge that flips on
  // identical input adds noise every hillclimb round has to beat.
  /** @type {{ checked: number, flips: number, flipRate: number } | undefined} */
  let consistency
  const sampleSize = Math.min(options.consistencySample ?? 0, judged.length)
  if (sampleSize > 0 && options.judge !== undefined) {
    let checked = 0
    let flips = 0
    for (const item of judged.slice(0, sampleSize)) {
      for (const [mode, rubric] of rubrics) {
        const first = item.row.grades[mode]
        if (first === undefined || !('pass' in first)) continue
        try {
          const again = await options.judge({
            mode, rubric, input: item.evalCase.input, output: item.output, expected: item.evalCase.expected,
            ...item.traceText !== undefined ? { trace: item.traceText } : {},
            ...options.signal ? { signal: options.signal } : {},
          })
          checked++
          if (again.pass !== first.pass) flips++
        } catch { /* a failed re-grade is not a flip */ }
      }
    }
    consistency = { checked, flips, flipRate: checked === 0 ? 0 : flips / checked }
  }

  const summary = summarize({ spec, rows, runId, split: options.split, startedAt, repeats, graders, notes, consistency, ref })
  await writeJson(join(runDir, 'summary.json'), summary)
  await writeReport(runDir, summary, rows)
  return { summary, rows }
}

/**
 * @param {{
 *   spec: EvalSpec, rows: readonly RunRow[], runId: string, split: string, startedAt: string,
 *   repeats: number, graders: readonly import('./core/spec.js').GraderSpec[], notes: readonly string[],
 *   consistency?: { checked: number, flips: number, flipRate: number }, ref?: string,
 * }} input
 */
export function summarize({ spec, rows, runId, split, startedAt, repeats, graders, notes, consistency, ref }) {
  /** @type {Record<string, { passes: number, n: number, score: number | null, infra: number, graderErrors: number }>} */
  const perCase = {}
  for (const row of rows) {
    const entry = perCase[row.caseId] ??= { passes: 0, n: 0, score: null, infra: 0, graderErrors: 0 }
    if (row.infraError) entry.infra++
    else if (row.pass === null) entry.graderErrors++
    else {
      entry.n++
      if (row.pass) entry.passes++
    }
  }
  for (const entry of Object.values(perCase)) entry.score = entry.n === 0 ? null : entry.passes / entry.n
  const caseScores = Object.values(perCase).map(c => c.score).filter(/** @returns {s is number} */ s => s !== null)
  const ci = bootstrapMeanCI(caseScores)

  /** @type {Record<string, { passes: number, n: number, passRate: number, low: number, high: number }>} */
  const perMode = {}
  for (const grader of graders) {
    let passes = 0
    let n = 0
    for (const row of rows) {
      const grade = row.grades[grader.mode]
      if (grade === undefined || !('pass' in grade)) continue
      n++
      if (grade.pass) passes++
    }
    const w = wilson(passes, n)
    perMode[grader.mode] = { passes, n, passRate: w.p, low: w.low, high: w.high }
  }

  const infraRows = rows.filter(row => row.infraError)
  /** @type {Record<string, number>} */
  const byKind = {}
  for (const row of infraRows) {
    const kind = /** @type {{ kind: string }} */ (row.infraError).kind
    byKind[kind] = (byKind[kind] ?? 0) + 1
  }
  const graderErrorRows = rows.filter(row => !row.infraError && row.pass === null)

  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
  let cost = 0
  let costKnown = rows.length > 0
  for (const row of rows) {
    usage.inputTokens += row.usage.inputTokens
    usage.outputTokens += row.usage.outputTokens
    usage.cacheReadTokens += row.usage.cacheReadTokens
    usage.reasoningTokens += row.usage.reasoningTokens
    if (row.costUsd === undefined) costKnown = false
    else cost += row.costUsd
  }
  const latencies = rows.filter(row => !row.infraError).map(row => row.latencyMs).sort((a, b) => a - b)

  /** @type {string[]} */
  const diagnostics = [...notes]
  const infraRate = rows.length === 0 ? 0 : infraRows.length / rows.length
  if (infraRate > 0.05) {
    diagnostics.push(`infrastructure errors in ${(infraRate * 100).toFixed(0)}% of runs (${JSON.stringify(byKind)}); fix these before trusting the score`)
  }
  if (graderErrorRows.length > 0) {
    diagnostics.push(`${graderErrorRows.length} run(s) hit a grader error; read them, the grader may be buggy`)
  }
  if (Number.isFinite(ci.mean) && ci.mean > spec.thresholds.headroom) {
    diagnostics.push(`score ${(ci.mean * 100).toFixed(1)}% is above the ${(spec.thresholds.headroom * 100).toFixed(0)}% headroom threshold; the eval may be too easy to measure improvements`)
  }
  const allFail = Object.entries(perCase).filter(([, c]) => c.n >= 2 && c.passes === 0).map(([id]) => id)
  if (allFail.length > 0) {
    diagnostics.push(`${allFail.length} case(s) failed every repeat; read them for ambiguous tasks or grader bugs: ${allFail.slice(0, 8).join(', ')}`)
  }
  const flaky = Object.values(perCase).filter(c => c.score !== null && c.score > 0 && c.score < 1).length
  if (repeats > 1 && caseScores.length > 0 && flaky / caseScores.length > 0.3) {
    diagnostics.push(`${flaky} of ${caseScores.length} cases are flaky across repeats; expect a high noise floor`)
  }
  if (consistency && consistency.flips > 0) {
    diagnostics.push(`the judge flipped ${consistency.flips} of ${consistency.checked} re-grades of identical output; tighten the rubric`)
  }
  if (caseScores.length > 0 && caseScores.length < 20) {
    diagnostics.push(`only ${caseScores.length} scored cases; intervals are wide`)
  }

  return {
    runId,
    evalName: spec.name,
    split,
    startedAt,
    finishedAt: new Date().toISOString(),
    target: spec.target.kind,
    ...ref ? { ref } : {},
    cases: Object.keys(perCase).length,
    repeats,
    runs: rows.length,
    scoredRuns: rows.filter(row => row.pass !== null).length,
    score: ci.mean,
    ci: { low: ci.low, high: ci.high },
    perMode,
    perCase,
    infra: { count: infraRows.length, rate: infraRate, byKind, examples: infraRows.slice(0, 5).map(row => ({ caseId: row.caseId, rep: row.rep, ...row.infraError })) },
    graderErrors: { count: graderErrorRows.length, examples: graderErrorRows.slice(0, 5).map(row => ({ caseId: row.caseId, rep: row.rep, grades: row.grades })) },
    usage,
    costUsd: costKnown ? cost : null,
    costPerCaseUsd: costKnown && rows.length > 0 ? cost / rows.length : null,
    latencyMs: { mean: mean(latencies), p50: quantile(latencies, 0.5), p90: quantile(latencies, 0.9) },
    ...consistency ? { judgeConsistency: consistency } : {},
    diagnostics,
  }
}

/** @typedef {ReturnType<typeof summarize>} RunSummary */
