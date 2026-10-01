// @ts-check
/**
 * Judge alignment against human labels. "Positive" means PASS: TPR is how
 * often the judge passes what a human passed, TNR how often it fails what a
 * human failed. A judge's raw pass rate is biased by its errors; the
 * Rogan–Gladen estimator corrects it.
 */
import { seededRandom } from './split.js'
import { quantile } from './stats.js'

/**
 * @typedef {{ human: boolean, judge: boolean }} Pair
 */

/** @param {readonly Pair[]} pairs */
export function confusion(pairs) {
  let tp = 0, fn = 0, tn = 0, fp = 0
  for (const { human, judge } of pairs) {
    if (human && judge) tp++
    else if (human && !judge) fn++
    else if (!human && !judge) tn++
    else fp++
  }
  const tpr = tp + fn === 0 ? NaN : tp / (tp + fn)
  const tnr = tn + fp === 0 ? NaN : tn / (tn + fp)
  return {
    tp, fn, tn, fp,
    n: pairs.length,
    tpr,
    tnr,
    balancedAccuracy: (tpr + tnr) / 2,
    agreement: pairs.length === 0 ? NaN : (tp + tn) / pairs.length,
  }
}

/**
 * Corrected pass rate θ = (p_obs + TNR − 1) / (TPR + TNR − 1), clipped to [0, 1].
 * Undefined when the judge is no better than chance (TPR + TNR ≤ 1).
 * @param {number} observed @param {number} tpr @param {number} tnr
 */
export function correctedPassRate(observed, tpr, tnr) {
  const denom = tpr + tnr - 1
  if (!(denom > 0)) return NaN
  return Math.min(1, Math.max(0, (observed + tnr - 1) / denom))
}

/**
 * Bootstrap CI for the corrected pass rate, resampling both the labeled
 * alignment set (uncertainty in TPR/TNR) and the judge's verdicts on the
 * unlabeled run (uncertainty in p_obs).
 * @param {readonly Pair[]} labeled
 * @param {readonly boolean[]} verdicts judge verdicts on the evaluated run
 * @param {{ iters?: number, alpha?: number, seed?: number }} [options]
 */
export function correctedPassRateCI(labeled, verdicts, options = {}) {
  const { iters = 2000, alpha = 0.05, seed = 7 } = options
  const base = confusion(labeled)
  const observed = verdicts.length === 0 ? NaN : verdicts.filter(Boolean).length / verdicts.length
  const theta = correctedPassRate(observed, base.tpr, base.tnr)
  if (labeled.length === 0 || verdicts.length === 0) return { theta, observed, low: NaN, high: NaN }
  const random = seededRandom(seed)
  /** @type {number[]} */
  const samples = []
  for (let i = 0; i < iters; i++) {
    /** @type {Pair[]} */
    const pairs = []
    for (let j = 0; j < labeled.length; j++) pairs.push(/** @type {Pair} */ (labeled[Math.floor(random() * labeled.length)]))
    let passes = 0
    for (let j = 0; j < verdicts.length; j++) if (verdicts[Math.floor(random() * verdicts.length)]) passes++
    const c = confusion(pairs)
    const value = correctedPassRate(passes / verdicts.length, c.tpr, c.tnr)
    if (Number.isFinite(value)) samples.push(value)
  }
  samples.sort((a, b) => a - b)
  return { theta, observed, low: quantile(samples, alpha / 2), high: quantile(samples, 1 - alpha / 2) }
}
