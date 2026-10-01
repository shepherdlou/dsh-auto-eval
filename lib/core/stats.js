// @ts-check
/**
 * Statistics for eval scores. Repeats of one case are correlated, so
 * intervals resample whole cases (a cluster bootstrap) instead of treating
 * every run as independent.
 */
import { seededRandom } from './split.js'

/** @param {readonly number[]} values */
export function mean(values) {
  if (values.length === 0) return NaN
  let sum = 0
  for (const value of values) sum += value
  return sum / values.length
}

/** @param {readonly number[]} values */
export function sampleSd(values) {
  if (values.length < 2) return NaN
  const m = mean(values)
  let sum = 0
  for (const value of values) sum += (value - m) ** 2
  return Math.sqrt(sum / (values.length - 1))
}

/**
 * Linear-interpolated quantile of a sorted array.
 * @param {readonly number[]} sorted @param {number} q
 */
export function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const position = (sorted.length - 1) * q
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  const a = /** @type {number} */ (sorted[lower])
  const b = /** @type {number} */ (sorted[upper])
  return a + (b - a) * (position - lower)
}

/**
 * Wilson score interval for a binomial proportion.
 * @param {number} successes @param {number} n @param {number} [z]
 */
export function wilson(successes, n, z = 1.96) {
  if (n === 0) return { p: NaN, low: NaN, high: NaN }
  const p = successes / n
  const denom = 1 + z * z / n
  const center = (p + z * z / (2 * n)) / denom
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom
  return { p, low: Math.max(0, center - half), high: Math.min(1, center + half) }
}

/**
 * Percentile bootstrap CI for the mean of per-case scores.
 * @param {readonly number[]} values per-case scores in [0, 1]
 * @param {{ iters?: number, alpha?: number, seed?: number, proportions?: boolean }} [options]
 *   proportions: values are pass rates, so an all-0 or all-1 sample gets a Wilson interval
 */
export function bootstrapMeanCI(values, options = {}) {
  const { iters = 2000, alpha = 0.05, seed = 1, proportions = true } = options
  const n = values.length
  if (n === 0) return { mean: NaN, low: NaN, high: NaN, n }
  const random = seededRandom(seed)
  const means = new Float64Array(iters)
  for (let i = 0; i < iters; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) sum += /** @type {number} */ (values[Math.floor(random() * n)])
    means[i] = sum / n
  }
  const sorted = [...means].sort((a, b) => a - b)
  const m = mean(values)
  // All cases at 0 or all at 1: the bootstrap collapses to a zero-width
  // interval ("12/12 -> [1, 1]"), which overstates certainty. Use Wilson on
  // the case count instead (12/12 -> about [0.76, 1]).
  if (proportions && (m === 1 || m === 0) && n > 0) {
    const w = wilson(m * n, n, 1.96)
    return { mean: m, low: w.low, high: w.high, n }
  }
  return { mean: m, low: quantile(sorted, alpha / 2), high: quantile(sorted, 1 - alpha / 2), n }
}

/**
 * Paired comparison on the cases both runs scored: delta = candidate - baseline,
 * with a bootstrap CI over cases.
 * @param {ReadonlyMap<string, number>} baseline per-case scores
 * @param {ReadonlyMap<string, number>} candidate per-case scores
 * @param {{ iters?: number, alpha?: number, seed?: number }} [options]
 */
export function pairedDelta(baseline, candidate, options = {}) {
  /** @type {number[]} */
  const diffs = []
  for (const [id, score] of candidate) {
    const base = baseline.get(id)
    if (base !== undefined) diffs.push(score - base)
  }
  const ci = bootstrapMeanCI(diffs, { ...options, proportions: false })
  return { delta: ci.mean, low: ci.low, high: ci.high, n: diffs.length }
}

/**
 * Noise floor from k repeated runs of the same configuration: the 95%
 * half-width of the difference between two independent runs,
 * 1.96 * sqrt(2) * sd. A change smaller than this is indistinguishable from
 * rerunning the baseline.
 * @param {readonly number[]} runScores eval scores of repeated baseline runs
 * @returns {number | null} null when fewer than two runs exist
 */
export function noiseFloor(runScores) {
  if (runScores.length < 2) return null
  return 1.96 * Math.SQRT2 * sampleSd(runScores)
}

/**
 * Run-to-run standard deviation of the eval score predicted from the repeat
 * variance inside one run: each case's pass fraction over r repeats has
 * variance p(1-p)/(r-1) (unbiased), and the eval score averages n cases.
 * Between-case difficulty is excluded on purpose, because rounds are compared
 * on the same cases.
 * @param {readonly { passes: number, n: number }[]} perCase
 */
export function repeatSd(perCase) {
  const usable = perCase.filter(c => c.n >= 2)
  if (usable.length === 0) return NaN
  let sum = 0
  for (const { passes, n } of usable) {
    const p = passes / n
    sum += p * (1 - p) / (n - 1)
  }
  return Math.sqrt(sum) / usable.length
}

/**
 * Noise floor for one split: the larger of the empirical run-to-run noise
 * (k repeated baseline runs) and the noise predicted from repeat variance,
 * so three lucky identical baseline runs cannot make a noisy eval look exact.
 * @param {readonly number[]} runScores
 * @param {readonly { passes: number, n: number }[]} perCase
 */
export function effectiveNoise(runScores, perCase) {
  const empirical = noiseFloor(runScores) ?? 0
  const predictedSd = repeatSd(perCase)
  const predicted = Number.isFinite(predictedSd) ? 1.96 * Math.SQRT2 * predictedSd : 0
  return Math.max(empirical, predicted)
}
