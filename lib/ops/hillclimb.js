// @ts-check
/**
 * eval_hillclimb: improve the target one patch at a time.
 *
 * - All edits happen in a dedicated branch worktree; the user's checkout is
 *   never touched.
 * - The baseline is run several times first to measure the noise floor.
 * - Each round commits the worktree, runs train and test, and keeps the patch
 *   only when train improves beyond noise AND test rises. Anything else is
 *   reverted. A round that edits the eval itself is voided.
 * - Test per-case scores live in the held-out store; only aggregates return.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { bootstrapMeanCI, effectiveNoise, mean, pairedDelta } from '../core/stats.js'
import { decideRound, isStalled } from '../core/decide.js'
import { appendJsonl, evalPaths, exists, loadSpec, readJson, readJsonl, writeJson } from '../core/store.js'
import { runEval } from '../runner.js'
import {
  addBranchWorktree, changedPaths, commitAll, diffStat, removeWorktree, repoRoot, resetTo, snapshotRef, untrackedFiles,
} from '../targets/worktree.js'
import { git } from '../targets/process.js'
import { casesFor } from './run.js'

/**
 * @typedef {import('./run.js').RunDeps} RunDeps
 * @typedef {{ score: number, ci: { low: number, high: number }, costPerRunUsd: number | null, latencyP50: number }} SplitStats
 */

const WORKTREE_DIR = '.dsh-auto-eval'

/**
 * Files under a directory, recursively, sorted.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function filesUnder(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await filesUnder(path))
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/**
 * Hash of everything that defines the eval: the spec, graders (and their
 * few-shot files), cases, fixtures, and the held-out test cases. Any change
 * during a hillclimb makes scores incomparable.
 * @param {import('../core/store.js').EvalPaths} paths
 */
export async function evalFingerprint(paths) {
  const hash = createHash('sha256')
  const files = [
    paths.spec,
    ...await filesUnder(paths.graders),
    ...(await filesUnder(paths.cases)).filter(file => file !== paths.inboxCases),
    ...await filesUnder(join(paths.root, 'fixtures')),
    paths.testCases,
  ]
  for (const file of files) {
    hash.update(relative(paths.root, file)).update('\0').update(await readFile(file).catch(() => Buffer.from('')))
  }
  return hash.digest('hex')
}

/** @param {import('../core/store.js').EvalPaths} paths */
async function loadState(paths) {
  if (!await exists(paths.hillclimbState)) throw new Error('no hillclimb has been started for this eval; use action: start')
  return readJson(paths.hillclimbState)
}

/** @param {import('../core/store.js').EvalPaths} paths @param {string} id */
const heldoutStatePath = (paths, id) => join(paths.heldout, `hillclimb-${id}.json`)

/**
 * Run train and test for one candidate.
 * @param {{
 *   spec: import('../core/spec.js').EvalSpec, paths: import('../core/store.js').EvalPaths,
 *   candidateRoot: string, candidateRef: string, label: string, repeats: number, deps: RunDeps,
 * }} input
 */
async function runBoth({ spec, paths, candidateRoot, candidateRef, label, repeats, deps }) {
  const common = {
    spec, evalRoot: paths.root, candidateRoot, candidateRef, repeats,
    ...deps.judge ? { judge: deps.judge } : {},
    ...deps.readSession ? { readSession: deps.readSession } : {},
    ...deps.signal ? { signal: deps.signal } : {},
    ...deps.onProgress ? { onProgress: deps.onProgress } : {},
  }
  const trainId = `${label}-train`
  const testId = `${label}-test`
  const train = await runEval({ ...common, cases: await casesFor(paths, 'train'), split: 'train', runId: trainId, runDir: join(paths.runs, trainId) })
  const test = await runEval({ ...common, cases: await casesFor(paths, 'test'), split: 'test', runId: testId, runDir: join(paths.heldoutRuns, testId), redactCaseIds: true })
  return { train: train.summary, test: test.summary, trainRows: train.rows }
}

/** @param {import('../runner.js').RunSummary} summary */
function perCaseScores(summary) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const [id, c] of Object.entries(summary.perCase)) if (c.score !== null) out[id] = c.score
  return out
}

/** @param {readonly import('../runner.js').RunSummary[]} runs */
function averagePerCase(runs) {
  /** @type {Record<string, number[]>} */
  const acc = {}
  for (const run of runs) for (const [id, score] of Object.entries(perCaseScores(run))) (acc[id] ??= []).push(score)
  return Object.fromEntries(Object.entries(acc).map(([id, scores]) => [id, mean(scores)]))
}

/** @param {readonly import('../runner.js').RunSummary[]} runs @returns {SplitStats} */
function splitStats(runs) {
  const perCase = averagePerCase(runs)
  const ci = bootstrapMeanCI(Object.values(perCase))
  const costs = runs.map(r => r.costPerCaseUsd)
  return {
    score: ci.mean,
    ci: { low: ci.low, high: ci.high },
    costPerRunUsd: costs.every(c => c !== null) ? mean(/** @type {number[]} */ (costs)) : null,
    latencyP50: mean(runs.map(r => r.latencyMs.p50)),
  }
}

/** @param {readonly import('../runner.js').RunSummary[]} runs */
function noiseOf(runs) {
  const counts = runs.flatMap(r => Object.values(r.perCase).map(c => ({ passes: c.passes, n: c.n })))
  return effectiveNoise(runs.map(r => r.score), counts)
}

/** @param {readonly import('../runner.js').RunRow[]} rows @param {string} runDir */
function topFailures(rows, runDir) {
  return rows.filter(row => row.pass === false).slice(0, 12).map(row => ({
    caseId: row.caseId,
    rep: row.rep,
    failedModes: Object.entries(row.grades).filter(([, g]) => 'pass' in g && !g.pass).map(([mode]) => mode),
    transcript: join(runDir, row.transcript),
  }))
}

/** @param {number} x */
const pt = x => (Number.isFinite(x) ? Math.round(x * 1000) / 10 : null)

/**
 * @param {{
 *   cwd: string, name: string, home?: string, goal?: 'score' | 'cost' | 'latency',
 *   maxRounds?: number, repeats?: number, baselineRuns?: number,
 * }} options
 * @param {RunDeps} deps
 */
export async function hillclimbStart(options, deps) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const spec = await loadSpec(paths)
  if (await exists(paths.hillclimbState)) {
    const previous = await readJson(paths.hillclimbState)
    if (previous.status === 'active') throw new Error(`hillclimb ${previous.id} is still active on branch ${previous.branch}; finish it first`)
  }
  const train = await casesFor(paths, 'train')
  const test = await casesFor(paths, 'test')
  if (train.length === 0 || test.length === 0) throw new Error('hillclimbing needs both a train and a test split; run eval_split first')
  if (spec.graders.length === 0) throw new Error('no graders in eval.yaml')
  const goal = options.goal ?? spec.goal
  if (goal === 'cost' && Object.keys(spec.prices).length === 0) throw new Error('goal: cost needs a prices table in eval.yaml')

  const repo = await repoRoot(options.cwd)
  if (repo === undefined) throw new Error('hillclimbing needs a git repository: candidates are commits on a branch worktree')
  const relRoot = relative(repo, options.cwd)
  /** @type {string[]} */
  const warnings = []
  const untracked = (await untrackedFiles(options.cwd)).filter(p => !p.startsWith('.evals/') && !p.startsWith(`${WORKTREE_DIR}/`))
  if (untracked.length > 0) warnings.push(`untracked files are not part of the baseline: ${untracked.slice(0, 5).join(', ')}${untracked.length > 5 ? '…' : ''}`)
  const baseRef = await snapshotRef(options.cwd)
  if (baseRef !== await git(['rev-parse', 'HEAD'], options.cwd)) {
    warnings.push('uncommitted changes to tracked files were snapshotted into the baseline commit; the hillclimb branch includes them')
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-')
  const id = `hc-${stamp}`
  const branch = `auto-eval/${spec.name}/${id}`
  const base = join(options.cwd, WORKTREE_DIR)
  await mkdir(base, { recursive: true })
  // Ignore the whole directory (including this file) from the user's repo.
  await writeFile(join(base, '.gitignore'), '*\n')
  const worktree = join(base, `${spec.name}-${id}`)
  await addBranchWorktree(repo, branch, baseRef, worktree)
  const candidateRoot = relRoot === '' ? worktree : join(worktree, relRoot)

  const repeats = options.repeats ?? spec.repeats
  const baselineRuns = Math.max(1, options.baselineRuns ?? 2)
  const trainRuns = []
  const testRuns = []
  /** @type {import('../runner.js').RunRow[]} */
  let lastTrainRows = []
  let lastTrainRun = ''
  for (let i = 1; i <= baselineRuns; i++) {
    const label = `${id}-base${i}`
    const result = await runBoth({ spec, paths, candidateRoot, candidateRef: baseRef, label, repeats, deps })
    trainRuns.push(result.train)
    testRuns.push(result.test)
    lastTrainRows = result.trainRows
    lastTrainRun = `${label}-train`
  }
  const noise = { train: noiseOf(trainRuns), test: noiseOf(testRuns) }
  const trainStats = splitStats(trainRuns)
  const testStats = splitStats(testRuns)
  if (noise.train > spec.thresholds.minEffect) {
    warnings.push(`train noise floor ±${pt(noise.train)}pt exceeds minEffect ${pt(spec.thresholds.minEffect)}pt: small real gains will be reverted; add cases or repeats`)
  }
  if (trainStats.score > spec.thresholds.headroom) warnings.push('the baseline is already near the ceiling on train; little room to climb')
  if (infraHeavy(trainRuns) || infraHeavy(testRuns)) warnings.push('many infrastructure errors in the baseline; fix them before climbing')

  const state = {
    id, evalName: spec.name, goal, status: 'active', branch, worktree, candidateRoot, repo, relRoot,
    baseRef, bestRef: baseRef, round: 0, maxRounds: options.maxRounds ?? 10, repeats,
    fingerprint: await evalFingerprint(paths),
    noise,
    baseline: { train: trainStats, test: testStats },
    best: { round: 0, ref: baseRef, train: trainStats, test: testStats, trainPerCase: averagePerCase(trainRuns), trainRunId: lastTrainRun },
    history: [],
    startedAt: new Date().toISOString(),
  }
  await writeJson(paths.hillclimbState, state)
  const testPerCase = averagePerCase(testRuns)
  await writeJson(heldoutStatePath(paths, id), { baselineTestPerCase: testPerCase, bestTestPerCase: testPerCase })
  await appendJsonl(paths.hillclimbLog, {
    hillclimb: id, round: 0, kind: 'baseline', at: state.startedAt, branch, baseRef,
    train: { score: trainStats.score, ci: trainStats.ci }, test: { score: testStats.score, ci: testStats.ci }, noise,
  })
  return {
    id, branch, editIn: candidateRoot, goal, maxRounds: state.maxRounds, repeats,
    baseline: { train: trainStats, test: testStats, runs: baselineRuns },
    noiseFloor: { train: noise.train, test: noise.test },
    warnings,
    trainFailures: topFailures(lastTrainRows, join(paths.runs, lastTrainRun)),
    next: `Read train failures (never test), make ONE change inside ${candidateRoot}, then call eval_hillclimb with action: round and a short note.`,
  }
}

/** @param {readonly import('../runner.js').RunSummary[]} runs */
function infraHeavy(runs) {
  return runs.some(r => r.infra.rate > 0.1)
}

/**
 * @param {{ cwd: string, name: string, home?: string, note?: string }} options
 * @param {RunDeps} deps
 */
export async function hillclimbRound(options, deps) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const state = await loadState(paths)
  if (state.status !== 'active') throw new Error(`hillclimb ${state.id} is ${state.status}; start a new one`)
  const spec = await loadSpec(paths)
  const roundNo = state.round + 1
  const note = (options.note ?? '').slice(0, 300)

  const record = async (/** @type {Record<string, unknown>} */ entry) => {
    state.round = roundNo
    state.history.push({ round: roundNo, decision: entry.decision, note })
    await writeJson(paths.hillclimbState, state)
    await appendJsonl(paths.hillclimbLog, { hillclimb: state.id, round: roundNo, note, at: new Date().toISOString(), ...entry })
  }

  if (await evalFingerprint(paths) !== state.fingerprint) {
    await record({ decision: 'void', reason: 'the eval (eval.yaml, graders, or cases) changed during the hillclimb' })
    return {
      round: roundNo, decision: 'void',
      reason: 'The eval itself changed since this hillclimb started. Scores are no longer comparable: if the user approved the eval fix, finish this hillclimb and start a new one; otherwise restore the eval files.',
    }
  }

  const changed = await changedPaths(state.worktree, state.bestRef)
  if (changed.length === 0) throw new Error(`no changes in ${state.candidateRoot} since the best version; edit something first`)
  const prefix = state.relRoot === '' ? '' : `${state.relRoot.split(sep).join('/')}/`
  const touchesEval = changed.filter(p => {
    const rel = prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p
    return rel.startsWith('.evals/') || rel.startsWith(`${WORKTREE_DIR}/`)
  })
  if (touchesEval.length > 0) {
    await resetTo(state.worktree, state.bestRef)
    await record({ decision: 'void', reason: `edited the eval itself: ${touchesEval.join(', ')}`, changed })
    return {
      round: roundNo, decision: 'void',
      reason: `Voided and reverted: the patch edited eval files (${touchesEval.join(', ')}). Improve the target, never the eval.`,
      stalled: isStalled(state.history),
    }
  }

  const stat = await diffStat(state.worktree, state.bestRef)
  const candidateRef = /** @type {string} */ (await commitAll(state.worktree, `auto-eval round ${roundNo}: ${note || 'candidate'}`))
  const label = `${state.id}-r${roundNo}`
  const result = await runBoth({ spec, paths, candidateRoot: state.candidateRoot, candidateRef, label, repeats: state.repeats, deps })

  const heldout = await readJson(heldoutStatePath(paths, state.id))
  const trainDelta = pairedDelta(new Map(Object.entries(state.best.trainPerCase)), new Map(Object.entries(perCaseScores(result.train))))
  const testDelta = pairedDelta(new Map(Object.entries(heldout.bestTestPerCase)), new Map(Object.entries(perCaseScores(result.test))))
  const trainStats = splitStats([result.train])
  const testStats = splitStats([result.test])

  /** @type {{ relDelta: number } | undefined} */
  let resource
  if (state.goal === 'cost') {
    const before = mean([state.best.train.costPerRunUsd, state.best.test.costPerRunUsd].filter(x => x !== null))
    const after = mean([trainStats.costPerRunUsd, testStats.costPerRunUsd].filter(x => x !== null))
    if (Number.isFinite(before) && Number.isFinite(after) && before > 0) resource = { relDelta: (after - before) / before }
  } else if (state.goal === 'latency') {
    const before = mean([state.best.train.latencyP50, state.best.test.latencyP50])
    const after = mean([trainStats.latencyP50, testStats.latencyP50])
    if (Number.isFinite(before) && before > 0) resource = { relDelta: (after - before) / before }
  }
  const decision = decideRound({
    goal: state.goal,
    train: { delta: trainDelta.delta, noise: state.noise.train },
    test: { delta: testDelta.delta, noise: state.noise.test },
    ...resource ? { resource } : {},
    minResourceGain: spec.thresholds.minCostGain,
  })

  if (decision.decision === 'keep') {
    state.bestRef = candidateRef
    state.best = { round: roundNo, ref: candidateRef, train: trainStats, test: testStats, trainPerCase: perCaseScores(result.train), trainRunId: `${label}-train` }
    await writeJson(heldoutStatePath(paths, state.id), { ...heldout, bestTestPerCase: perCaseScores(result.test) })
  } else {
    await resetTo(state.worktree, state.bestRef)
  }
  await record({
    decision: decision.decision, reason: decision.reason, candidateRef, changed, diffStat: stat,
    train: { score: trainStats.score, delta: trainDelta.delta, deltaCi: [trainDelta.low, trainDelta.high] },
    test: { score: testStats.score, delta: testDelta.delta },
    ...resource ? { [state.goal]: resource } : {},
  })

  const stalled = isStalled(state.history)
  const bestTrainRows = decision.decision === 'keep'
    ? result.trainRows
    : await readTrainRows(paths, state.best.trainRunId)
  return {
    round: roundNo,
    decision: decision.decision,
    reason: decision.reason,
    train: { score: trainStats.score, delta: trainDelta.delta, deltaCi: [trainDelta.low, trainDelta.high], noise: state.noise.train },
    test: { score: testStats.score, delta: testDelta.delta, noise: state.noise.test },
    ...resource ? { [state.goal]: { relativeChange: resource.relDelta } } : {},
    best: { round: state.best.round, train: state.best.train.score, test: state.best.test.score },
    roundsLeft: Math.max(0, state.maxRounds - roundNo),
    stalled,
    ...stalled ? {
      stallAdvice: 'No patch has been kept for 3 rounds. Stop patching: read every remaining train failure and sort it by root cause (target behavior, grader bug, ambiguous case, infrastructure). Suggest more cases or repeats if changes are below the noise floor; take eval fixes to the user before changing the eval.',
    } : {},
    trainFailures: topFailures(bestTrainRows, join(paths.runs, state.best.trainRunId)),
    editIn: state.candidateRoot,
  }
}

/** @param {import('../core/store.js').EvalPaths} paths @param {string} runId */
async function readTrainRows(paths, runId) {
  return readJsonl(join(paths.runs, runId, 'results.jsonl'))
}

/**
 * @param {{ cwd: string, name: string, home?: string, keepWorktree?: boolean }} options
 */
export async function hillclimbFinish(options) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const state = await loadState(paths)
  if (state.status !== 'active') throw new Error(`hillclimb ${state.id} is already ${state.status}`)
  const heldout = await readJson(heldoutStatePath(paths, state.id))
  await resetTo(state.worktree, state.bestRef).catch(() => {})
  const testDelta = pairedDelta(new Map(Object.entries(heldout.baselineTestPerCase)), new Map(Object.entries(heldout.bestTestPerCase)))
  const improved = state.bestRef !== state.baseRef
  const withinNoise = !improved || !(testDelta.delta > state.noise.test) || !(testDelta.low > 0)
  const changes = improved ? await git(['diff', '--stat', state.baseRef, state.bestRef], state.worktree).catch(() => '') : ''
  state.status = 'finished'
  state.finishedAt = new Date().toISOString()
  await writeJson(paths.hillclimbState, state)
  if (!options.keepWorktree) await removeWorktree(state.repo, state.worktree)
  const report = {
    id: state.id,
    branch: state.branch,
    bestRound: state.best.round,
    rounds: state.round,
    kept: state.history.filter((/** @type {any} */ h) => h.decision === 'keep').length,
    baseline: { train: state.baseline.train, test: state.baseline.test },
    best: { train: state.best.train, test: state.best.test },
    testDelta: { delta: testDelta.delta, ci95: [testDelta.low, testDelta.high], noiseFloor: state.noise.test },
    verdict: !improved
      ? 'No patch survived; the target is unchanged.'
      : withinNoise
        ? 'The test gain is within the noise floor or its interval includes zero: treat it as unproven. Add cases or repeats before shipping it.'
        : 'Train and test both improved beyond noise.',
    changes,
    apply: improved ? `git diff ${state.baseRef.slice(0, 12)} ${state.branch}   # review, then: git merge ${state.branch}` : null,
  }
  await appendJsonl(paths.hillclimbLog, { hillclimb: state.id, kind: 'finish', at: state.finishedAt, ...report })
  return report
}

/** @param {{ cwd: string, name: string, home?: string }} options */
export async function hillclimbStatus(options) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  if (!await exists(paths.hillclimbState)) return { status: 'none' }
  const state = await readJson(paths.hillclimbState)
  return {
    id: state.id, status: state.status, goal: state.goal, branch: state.branch, editIn: state.candidateRoot,
    round: state.round, maxRounds: state.maxRounds, noise: state.noise,
    baseline: { train: state.baseline.train.score, test: state.baseline.test.score },
    best: { round: state.best.round, train: state.best.train.score, test: state.best.test.score },
    history: state.history,
    stalled: isStalled(state.history),
  }
}
