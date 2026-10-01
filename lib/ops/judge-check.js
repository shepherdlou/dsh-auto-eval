// @ts-check
/**
 * eval_judge_check: align an LLM judge with human labels. Labels split into
 * few-shot (become the judge's calibration examples), dev (iterate on the
 * rubric; disagreements are shown) and test (final TPR/TNR; items are never
 * shown, so the rubric cannot be fitted to them).
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { confusion } from '../core/align.js'
import { clip } from '../core/judge.js'
import { partitionLabels } from '../core/split.js'
import { evalPaths, exists, loadCases, loadSpec, readJson, readJsonl, writeJson, writeJsonl } from '../core/store.js'
import { readRubric } from '../graders/llm.js'
import { fewshotFile } from '../runner.js'
import { renderTraceText } from '../core/traces.js'
import { labelFiles, latestLabels } from '../review/data.js'

/**
 * @param {import('../core/store.js').EvalPaths} paths @param {string} runId @param {string} caseId @param {number} rep
 */
async function loadLabeledItem(paths, runId, caseId, rep) {
  for (const dir of [paths.runs, paths.archivedRuns]) {
    const runDir = join(dir, runId)
    if (!await exists(join(runDir, 'results.jsonl'))) continue
    const rows = await readJsonl(join(runDir, 'results.jsonl'))
    const row = rows.find(r => r.caseId === caseId && r.rep === rep)
    if (row) return readJson(join(runDir, row.transcript))
  }
  return undefined
}

/**
 * @param {{ cwd: string, name: string, home?: string, mode: string, seed?: number, consistency?: number }} options
 * @param {{ judge: import('../graders/llm.js').Judge, signal?: AbortSignal }} deps
 */
export async function judgeCheckOp(options, deps) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const spec = await loadSpec(paths)
  const grader = spec.graders.find(g => g.mode === options.mode)
  if (!grader) throw new Error(`no grader for failure mode "${options.mode}"`)
  if (grader.kind !== 'judge') throw new Error(`"${options.mode}" is a code grader; only judges need calibration`)
  const rubric = await readRubric(paths.root, grader.file)

  /** @type {Map<string, import('../review/data.js').GraderLabel>} */
  const labelMap = await latestLabels(labelFiles(paths).grader(options.mode))
  const labels = [...labelMap.values()]
  const passes = labels.filter(l => l.pass).length
  /** @type {string[]} */
  const warnings = []
  if (labels.length < 20) warnings.push(`only ${labels.length} human labels; aim for at least 20-40 with both passes and fails`)
  if (passes === 0 || passes === labels.length) {
    throw new Error(`labels for "${options.mode}" are all ${passes === 0 ? 'fail' : 'pass'}; label some of each in the review UI (Grader labels view)`)
  }

  // Labels on held-out eval cases (graded before the split) may only ever be
  // test items here: few-shot examples are written into the workspace and dev
  // disagreements are shown, either of which would leak held-out content.
  const heldoutIds = new Set((await loadCases(paths.testCases)).map(c => c.id))
  const visible = labels.filter(l => !heldoutIds.has(l.caseId))
  const partition = partitionLabels(visible, { seed: options.seed ?? spec.split.seed })
  const fewshot = partition.fewshot
  const dev = partition.dev
  const test = [...partition.test, ...labels.filter(l => heldoutIds.has(l.caseId))]

  // Few-shot examples come only from the few-shot partition; they are
  // written beside the rubric so every run uses the same calibration.
  const examples = []
  for (const label of fewshot) {
    const item = await loadLabeledItem(paths, label.runId, label.caseId, label.rep)
    if (!item) continue
    examples.push({
      input: typeof item.input === 'string' ? clip(item.input, 1500) : item.input,
      output: clip(typeof item.output === 'string' ? item.output : JSON.stringify(item.output), 2500),
      critique: label.note || (label.pass ? 'The failure mode is absent.' : 'The failure mode is present.'),
      pass: label.pass,
    })
  }
  await writeJsonl(join(paths.root, fewshotFile(grader.file)), examples)

  /** @param {readonly import('../review/data.js').GraderLabel[]} part */
  const evaluate = async part => {
    /** @type {{ label: import('../review/data.js').GraderLabel, judge: boolean, critique: string, item: any }[]} */
    const results = []
    for (const label of part) {
      deps.signal?.throwIfAborted()
      const item = await loadLabeledItem(paths, label.runId, label.caseId, label.rep)
      if (!item) continue
      const hasSteps = item.trace?.items?.some((/** @type {any} */ i) => i.kind === 'tool-call')
      try {
        const verdict = await deps.judge({
          mode: options.mode, rubric, fewshot: examples, input: item.input, output: item.output, expected: item.expected,
          ...hasSteps ? { trace: renderTraceText(item.trace, { maxChars: 12_000 }) } : {},
          ...deps.signal ? { signal: deps.signal } : {},
        })
        results.push({ label, judge: verdict.pass, critique: verdict.critique, item })
      } catch (error) {
        warnings.push(`judge failed on ${label.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return results
  }

  const devResults = await evaluate(dev)
  const devStats = confusion(devResults.map(r => ({ human: r.label.pass, judge: r.judge })))
  const disagreements = devResults
    .filter(r => r.label.pass !== r.judge)
    .map(r => ({
      id: r.label.id, human: r.label.pass ? 'pass' : 'fail', judge: r.judge ? 'pass' : 'fail',
      humanNote: r.label.note, judgeCritique: r.critique,
      transcript: `${r.label.runId}/${r.label.caseId}#${r.label.rep}`,
    }))

  const testResults = await evaluate(test)
  const testStats = confusion(testResults.map(r => ({ human: r.label.pass, judge: r.judge })))

  // Consistency: the same input judged twice should not flip.
  let flips = 0
  let checked = 0
  for (const r of devResults.slice(0, options.consistency ?? 5)) {
    try {
      const again = await deps.judge({ mode: options.mode, rubric, fewshot: examples, input: r.item.input, output: r.item.output, expected: r.item.expected })
      checked++
      if (again.pass !== r.judge) flips++
    } catch { /* not a flip */ }
  }

  const meets = testStats.tpr >= spec.thresholds.judgeTpr && testStats.tnr >= spec.thresholds.judgeTnr
  const result = {
    mode: options.mode,
    labels: { total: labels.length, pass: passes, fail: labels.length - passes },
    partitions: { fewshot: examples.length, dev: devResults.length, test: testResults.length },
    dev: { tpr: devStats.tpr, tnr: devStats.tnr, agreement: devStats.agreement, disagreements },
    test: { tpr: testStats.tpr, tnr: testStats.tnr, n: testStats.n, meetsThresholds: meets },
    thresholds: { tpr: spec.thresholds.judgeTpr, tnr: spec.thresholds.judgeTnr },
    consistency: { checked, flips },
    fewshotFile: join(paths.root, fewshotFile(grader.file)),
    warnings,
    next: meets
      ? 'The judge meets the thresholds on held-out labels. Show the user the rubric and these numbers before relying on it.'
      : 'Iterate on the rubric using ONLY the dev disagreements (never the test items), then run eval_judge_check again. Low TPR: the judge fails good outputs (rubric too strict or vague). Low TNR: it misses real failures (add checkable criteria).',
    rubricHash: rubricHash(rubric),
    checkedAt: new Date().toISOString(),
  }
  await writeJson(join(paths.root, 'judge-checks', `${options.mode}.json`), {
    ...result, dev: { ...result.dev, disagreements: result.dev.disagreements.length },
  })
  return result
}

/** Calibration is tied to the exact rubric text it was measured on. @param {string} rubric */
export function rubricHash(rubric) {
  return createHash('sha256').update(rubric.trim()).digest('hex').slice(0, 16)
}

/**
 * Calibration status of every judge grader: ok, missing, failing, or stale
 * (the rubric changed since it was checked).
 * @param {import('../core/store.js').EvalPaths} paths
 * @param {import('../core/spec.js').EvalSpec} spec
 */
export async function calibrationStatus(paths, spec) {
  const out = []
  for (const grader of spec.graders.filter(g => g.kind === 'judge')) {
    const file = join(paths.root, 'judge-checks', `${grader.mode}.json`)
    if (!await exists(file)) { out.push({ mode: grader.mode, status: 'missing' }); continue }
    const check = await readJson(file)
    const current = rubricHash(await readRubric(paths.root, grader.file))
    const status = check.rubricHash !== current ? 'stale' : check.test?.meetsThresholds ? 'ok' : 'failing'
    out.push({ mode: grader.mode, status, tpr: check.test?.tpr ?? null, tnr: check.test?.tnr ?? null })
  }
  return out
}
