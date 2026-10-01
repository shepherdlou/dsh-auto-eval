// @ts-check
/**
 * Trace sampling for error analysis. Reading data is the point, so the sample
 * mixes three sources: traces a user already flagged, traces that look
 * unusual (tool errors, abnormal endings), and a uniform random remainder so
 * the review is not only of known-bad cases.
 */
import { seededRandom, shuffled } from './split.js'

/**
 * @typedef {{
 *   id: string, negativeFeedback?: boolean, toolErrors?: number, endReason?: string, model?: string,
 * }} Sampleable
 */

/**
 * @template {Sampleable} T
 * @param {readonly T[]} pool
 * @param {{ n: number, seed: number, strategy?: 'mixed' | 'random' | 'flagged' }} options
 * @returns {{ sample: T[], reasons: Record<string, string> }}
 */
export function sampleTraces(pool, options) {
  const random = seededRandom(options.seed)
  const strategy = options.strategy ?? 'mixed'
  const order = shuffled([...pool].sort((a, b) => a.id.localeCompare(b.id)), random)
  /** @type {T[]} */ const sample = []
  /** @type {Record<string, string>} */ const reasons = {}
  const take = (/** @type {T} */ item, /** @type {string} */ reason) => {
    if (sample.length >= options.n || reasons[item.id] !== undefined) return
    sample.push(item)
    reasons[item.id] = reason
  }

  if (strategy === 'random') {
    for (const item of order) take(item, 'random')
    return { sample, reasons }
  }

  const flagged = order.filter(item => item.negativeFeedback === true)
  if (strategy === 'flagged') {
    for (const item of flagged) take(item, 'negative feedback')
    return { sample, reasons }
  }

  // mixed: up to 40% flagged, up to 20% unusual, the rest uniform.
  const flaggedQuota = Math.ceil(options.n * 0.4)
  for (const item of flagged.slice(0, flaggedQuota)) take(item, 'negative feedback')
  const unusual = order.filter(item =>
    (item.toolErrors ?? 0) > 0 || (item.endReason !== undefined && item.endReason !== 'completed'))
  const unusualQuota = sample.length + Math.ceil(options.n * 0.2)
  for (const item of unusual) {
    if (sample.length >= unusualQuota) break
    take(item, (item.toolErrors ?? 0) > 0 ? 'tool errors' : `ended: ${item.endReason}`)
  }
  for (const item of order) take(item, 'random')
  return { sample, reasons }
}
