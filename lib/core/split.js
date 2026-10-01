// @ts-check
/** Seeded, stratified splits for eval cases and for judge-alignment labels. */

/**
 * Small deterministic PRNG (mulberry32).
 * @param {number} seed
 * @returns {() => number} uniform in [0, 1)
 */
export function seededRandom(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Fisher–Yates shuffle into a new array.
 * @template T
 * @param {readonly T[]} items
 * @param {() => number} random
 * @returns {T[]}
 */
export function shuffled(items, random) {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [/** @type {T} */ (out[j]), /** @type {T} */ (out[i])]
  }
  return out
}

/**
 * Group items by key, keeping first-seen key order sorted for determinism.
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T) => string} keyOf
 */
function strata(items, keyOf) {
  /** @type {Map<string, T[]>} */
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group)
}

/**
 * Split cases into train and test at random, stratified by first tag.
 * Both sides get at least one case when there are two or more cases.
 * @template {{ id: string, tags?: string[] }} C
 * @param {readonly C[]} cases
 * @param {{ seed: number, testFraction: number, stratifyBy: 'tag' | 'none' }} options
 * @returns {{ train: C[], test: C[] }}
 */
export function splitCases(cases, options) {
  const random = seededRandom(options.seed)
  const sorted = [...cases].sort((a, b) => a.id.localeCompare(b.id))
  const groups = options.stratifyBy === 'tag' ? strata(sorted, c => c.tags?.[0] ?? '') : [sorted]
  /** @type {C[]} */ const train = []
  /** @type {C[]} */ const test = []
  let carry = 0
  for (const group of groups) {
    const order = shuffled(group, random)
    // Carry the fractional remainder across strata so small strata do not all round to zero.
    const exact = order.length * options.testFraction + carry
    const take = Math.floor(exact)
    carry = exact - take
    test.push(...order.slice(0, take))
    train.push(...order.slice(take))
  }
  if (cases.length >= 2 && test.length === 0) test.push(/** @type {C} */ (train.pop()))
  if (cases.length >= 2 && train.length === 0) train.push(/** @type {C} */ (test.pop()))
  return { train, test }
}

/**
 * Partition human labels for judge alignment into few-shot / dev / test,
 * stratified by the human verdict so each side sees both passes and fails.
 * Few-shot examples come only from the few-shot partition; TPR/TNR are
 * reported on test, which the judge prompt never sees.
 * @template {{ id: string, pass: boolean }} L
 * @param {readonly L[]} labels
 * @param {{ seed: number, fractions?: readonly [number, number, number] }} options
 */
export function partitionLabels(labels, options) {
  const [fewshotFraction, devFraction] = options.fractions ?? [0.15, 0.45, 0.4]
  const random = seededRandom(options.seed)
  /** @type {L[]} */ const fewshot = []
  /** @type {L[]} */ const dev = []
  /** @type {L[]} */ const test = []
  const sorted = [...labels].sort((a, b) => a.id.localeCompare(b.id))
  for (const group of strata(sorted, label => String(label.pass))) {
    const order = shuffled(group, random)
    const nFew = Math.round(order.length * fewshotFraction)
    const nDev = Math.round(order.length * devFraction)
    fewshot.push(...order.slice(0, nFew))
    dev.push(...order.slice(nFew, nFew + nDev))
    test.push(...order.slice(nFew + nDev))
  }
  return { fewshot, dev, test }
}
