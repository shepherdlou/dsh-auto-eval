// @ts-check
/**
 * Hillclimb keep/revert rules. A patch survives only when it helps on the
 * train split by more than the noise floor and the never-seen test split
 * rises too; a train-only gain is the classic overfitting signal.
 */

/**
 * @typedef {{ delta: number, noise: number }} SplitDelta
 * @typedef {{ relDelta: number } | undefined} ResourceDelta relative change, e.g. -0.2 = 20% cheaper
 * @typedef {{ decision: 'keep' | 'revert', reason: string }} Decision
 */

/**
 * @param {{
 *   goal: 'score' | 'cost' | 'latency',
 *   train: SplitDelta,
 *   test: SplitDelta,
 *   resource?: ResourceDelta,
 *   minResourceGain?: number,
 * }} input
 * @returns {Decision}
 */
export function decideRound(input) {
  const { goal, train, test } = input
  const fmt = (/** @type {number} */ x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}pt`

  if (goal === 'score') {
    if (train.delta < -train.noise || test.delta < -test.noise) {
      return { decision: 'revert', reason: `regression: train ${fmt(train.delta)}, test ${fmt(test.delta)}` }
    }
    if (train.delta <= train.noise) {
      return {
        decision: 'revert',
        reason: `train ${fmt(train.delta)} is within the noise floor (±${fmt(train.noise).slice(1)})`,
      }
    }
    if (test.delta <= 0) {
      return {
        decision: 'revert',
        reason: `only train rose (train ${fmt(train.delta)}, test ${fmt(test.delta)}): overfitting signal`,
      }
    }
    return { decision: 'keep', reason: `train ${fmt(train.delta)} > noise, test ${fmt(test.delta)}` }
  }

  // cost / latency: quality must hold within noise on both splits, and the
  // resource must drop by at least minResourceGain.
  const minGain = input.minResourceGain ?? 0.05
  if (train.delta < -train.noise || test.delta < -test.noise) {
    return { decision: 'revert', reason: `quality dropped beyond noise: train ${fmt(train.delta)}, test ${fmt(test.delta)}` }
  }
  const resource = input.resource
  if (resource === undefined || !Number.isFinite(resource.relDelta)) {
    return { decision: 'revert', reason: `no ${goal} measurement for this round` }
  }
  if (resource.relDelta > -minGain) {
    return {
      decision: 'revert',
      reason: `${goal} changed ${(resource.relDelta * 100).toFixed(1)}%, less than the required -${(minGain * 100).toFixed(0)}%`,
    }
  }
  return {
    decision: 'keep',
    reason: `${goal} ${(resource.relDelta * 100).toFixed(1)}% with quality held (train ${fmt(train.delta)}, test ${fmt(test.delta)})`,
  }
}

/**
 * The run has stalled when the last `window` decided rounds kept nothing.
 * Voided rounds (touched the eval itself) count as not kept.
 * @param {readonly { decision: string }[]} rounds
 * @param {number} [window]
 */
export function isStalled(rounds, window = 3) {
  if (rounds.length < window) return false
  return rounds.slice(-window).every(round => round.decision !== 'keep')
}
