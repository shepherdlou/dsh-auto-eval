// @ts-check
/**
 * eval.yaml: the one file that defines an eval. It is plain data so the user
 * can read and review it; every grader names exactly one failure mode.
 */
import YAML from 'yaml'

/**
 * @typedef {'code' | 'judge'} GraderKind
 * @typedef {{ mode: string, kind: GraderKind, file: string, description?: string }} GraderSpec
 * @typedef {{
 *   kind: 'command', command: string, timeoutMs: number, env: Record<string, string>,
 *   isolation: 'shared' | 'worktree',
 * } | {
 *   kind: 'dsh-agent', dshCommand: string, profile: string, patch?: string,
 *   permissionMode: string, timeoutMs: number, env: Record<string, string>,
 *   isolation: 'shared' | 'worktree',
 * }} TargetSpec
 * @typedef {{ provider?: string, model?: string, reasoningEffort?: string, maxTokens: number }} JudgeSpec
 * @typedef {{ input: number, output: number, cacheRead?: number }} Price
 * @typedef {{
 *   name: string,
 *   description: string,
 *   target: TargetSpec,
 *   repeats: number,
 *   concurrency: number,
 *   split: { seed: number, testFraction: number, stratifyBy: 'tag' | 'none' },
 *   judge: JudgeSpec,
 *   goal: 'score' | 'cost' | 'latency',
 *   prices: Record<string, Price>,
 *   graders: GraderSpec[],
 *   thresholds: { judgeTpr: number, judgeTnr: number, headroom: number, minEffect: number, minCostGain: number },
 * }} EvalSpec
 */

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/

/** @param {unknown} value */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate a raw eval.yaml object and fill defaults.
 * @param {unknown} raw
 * @returns {{ spec?: EvalSpec, errors: string[] }}
 */
export function validateSpec(raw) {
  /** @type {string[]} */
  const errors = []
  if (!isRecord(raw)) return { errors: ['eval.yaml must be a mapping'] }

  const name = raw.name
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    errors.push('name must be lowercase kebab-case (a-z, 0-9, -)')
  }

  const target = parseTarget(raw.target, errors)

  const repeats = int(raw.repeats, 3, 'repeats', 1, 50, errors)
  const concurrency = int(raw.concurrency, 4, 'concurrency', 1, 64, errors)

  const splitRaw = isRecord(raw.split) ? raw.split : {}
  const split = {
    seed: int(splitRaw.seed, 42, 'split.seed', 0, 2 ** 31 - 1, errors),
    testFraction: num(splitRaw.testFraction, 0.3, 'split.testFraction', 0.05, 0.8, errors),
    stratifyBy: /** @type {'tag' | 'none'} */ (splitRaw.stratifyBy === 'none' ? 'none' : 'tag'),
  }

  const judgeRaw = isRecord(raw.judge) ? raw.judge : {}
  /** @type {JudgeSpec} */
  const judge = { maxTokens: int(judgeRaw.maxTokens, 2048, 'judge.maxTokens', 64, 65536, errors) }
  for (const key of /** @type {const} */ (['provider', 'model', 'reasoningEffort'])) {
    const value = judgeRaw[key]
    if (value === undefined) continue
    if (typeof value !== 'string' || value.length === 0) errors.push(`judge.${key} must be a non-empty string`)
    else judge[key] = value
  }

  const goal = raw.goal ?? 'score'
  if (goal !== 'score' && goal !== 'cost' && goal !== 'latency') errors.push('goal must be score, cost, or latency')

  /** @type {Record<string, Price>} */
  const prices = {}
  if (raw.prices !== undefined) {
    if (!isRecord(raw.prices)) errors.push('prices must map model id to {input, output, cacheRead?} USD per 1M tokens')
    else {
      for (const [model, price] of Object.entries(raw.prices)) {
        if (!isRecord(price) || typeof price.input !== 'number' || typeof price.output !== 'number') {
          errors.push(`prices.${model} needs numeric input and output`)
          continue
        }
        prices[model] = {
          input: price.input,
          output: price.output,
          ...typeof price.cacheRead === 'number' ? { cacheRead: price.cacheRead } : {},
        }
      }
    }
  }
  if (goal === 'cost' && Object.keys(prices).length === 0) {
    errors.push('goal: cost needs a prices table (dsh reports tokens, not money)')
  }

  /** @type {GraderSpec[]} */
  const graders = []
  if (raw.graders !== undefined && !Array.isArray(raw.graders)) errors.push('graders must be a list')
  const seen = new Set()
  for (const [index, entry] of (Array.isArray(raw.graders) ? raw.graders : []).entries()) {
    const where = `graders[${index}]`
    if (!isRecord(entry)) { errors.push(`${where} must be a mapping`); continue }
    if ('modes' in entry) errors.push(`${where}: one grader checks exactly one failure mode; split it into separate graders`)
    const mode = entry.mode
    if (typeof mode !== 'string' || !NAME_PATTERN.test(mode)) { errors.push(`${where}.mode must be kebab-case`); continue }
    if (seen.has(mode)) errors.push(`${where}: duplicate failure mode "${mode}"`)
    seen.add(mode)
    const kind = entry.kind
    if (kind !== 'code' && kind !== 'judge') { errors.push(`${where}.kind must be code or judge`); continue }
    const file = entry.file ?? (kind === 'code' ? `graders/${mode}.check.mjs` : `graders/${mode}.judge.md`)
    if (typeof file !== 'string') { errors.push(`${where}.file must be a path`); continue }
    if (kind === 'code' && !/\.m?js$/.test(file)) errors.push(`${where}: code graders are .mjs/.js files`)
    if (kind === 'judge' && !file.endsWith('.md')) errors.push(`${where}: judge graders are .md rubric files`)
    if (file.startsWith('/') || file.split(/[\\/]/).includes('..')) errors.push(`${where}.file must stay inside the eval directory`)
    graders.push({
      mode, kind, file,
      ...typeof entry.description === 'string' ? { description: entry.description } : {},
    })
  }

  const thresholdsRaw = isRecord(raw.thresholds) ? raw.thresholds : {}
  const thresholds = {
    judgeTpr: num(thresholdsRaw.judgeTpr, 0.9, 'thresholds.judgeTpr', 0, 1, errors),
    judgeTnr: num(thresholdsRaw.judgeTnr, 0.9, 'thresholds.judgeTnr', 0, 1, errors),
    headroom: num(thresholdsRaw.headroom, 0.95, 'thresholds.headroom', 0, 1, errors),
    minEffect: num(thresholdsRaw.minEffect, 0.03, 'thresholds.minEffect', 0, 1, errors),
    minCostGain: num(thresholdsRaw.minCostGain, 0.05, 'thresholds.minCostGain', 0, 1, errors),
  }

  if (errors.length > 0 || target === undefined) return { errors }
  return {
    errors,
    spec: {
      name: /** @type {string} */ (name),
      description: typeof raw.description === 'string' ? raw.description : '',
      target,
      repeats,
      concurrency,
      split,
      judge,
      goal,
      prices,
      graders,
      thresholds,
    },
  }
}

/**
 * @param {unknown} raw
 * @param {string[]} errors
 * @returns {TargetSpec | undefined}
 */
function parseTarget(raw, errors) {
  if (!isRecord(raw)) { errors.push('target is required (kind: command | dsh-agent)'); return undefined }
  const timeoutMs = int(raw.timeoutMs, 300_000, 'target.timeoutMs', 1000, 3_600_000, errors)
  /** @type {Record<string, string>} */
  const env = {}
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) errors.push('target.env must be a mapping')
    else for (const [key, value] of Object.entries(raw.env)) env[key] = String(value)
  }
  const isolationRaw = raw.isolation
  if (isolationRaw !== undefined && isolationRaw !== 'shared' && isolationRaw !== 'worktree') {
    errors.push('target.isolation must be shared or worktree')
  }
  if (raw.kind === 'command') {
    if (typeof raw.command !== 'string' || raw.command.trim() === '') {
      errors.push('target.command is required for kind: command')
      return undefined
    }
    return {
      kind: 'command', command: raw.command, timeoutMs, env,
      isolation: isolationRaw === 'worktree' ? 'worktree' : 'shared',
    }
  }
  if (raw.kind === 'dsh-agent') {
    const patch = raw.patch
    if (patch !== undefined && typeof patch !== 'string') errors.push('target.patch must be a path relative to the candidate root')
    return {
      kind: 'dsh-agent',
      dshCommand: typeof raw.dshCommand === 'string' ? raw.dshCommand : 'dsh',
      profile: typeof raw.profile === 'string' ? raw.profile : 'headless',
      ...typeof patch === 'string' ? { patch } : {},
      permissionMode: typeof raw.permissionMode === 'string' ? raw.permissionMode : 'workspace-write',
      timeoutMs,
      env,
      isolation: isolationRaw === 'shared' ? 'shared' : 'worktree',
    }
  }
  errors.push('target.kind must be command or dsh-agent')
  return undefined
}

/**
 * @param {unknown} value @param {number} fallback @param {string} field
 * @param {number} min @param {number} max @param {string[]} errors
 */
function int(value, fallback, field, min, max, errors) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    errors.push(`${field} must be an integer in [${min}, ${max}]`)
    return fallback
  }
  return value
}

/**
 * @param {unknown} value @param {number} fallback @param {string} field
 * @param {number} min @param {number} max @param {string[]} errors
 */
function num(value, fallback, field, min, max, errors) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    errors.push(`${field} must be a number in [${min}, ${max}]`)
    return fallback
  }
  return value
}

/**
 * Parse eval.yaml text.
 * @param {string} text
 */
export function parseSpec(text) {
  let raw
  try {
    raw = YAML.parse(text)
  } catch (error) {
    return { errors: [`eval.yaml is not valid YAML: ${error instanceof Error ? error.message : String(error)}`] }
  }
  return validateSpec(raw)
}

/**
 * The starter eval.yaml written by eval_init. Comments explain each knob so
 * the file reads as documentation.
 * @param {{ name: string, description?: string, target: 'command' | 'dsh-agent', command?: string }} options
 */
export function starterSpec(options) {
  const target = options.target === 'command'
    ? [
      'target:',
      '  kind: command',
      `  command: ${JSON.stringify(options.command ?? 'node app.mjs')}  # reads one case as JSON on stdin, prints {"output": ...} on stdout`,
      '  timeoutMs: 120000',
      '  isolation: shared        # worktree = fresh git worktree per (case, repeat)',
    ]
    : [
      'target:',
      '  kind: dsh-agent',
      '  dshCommand: dsh',
      '  profile: headless',
      '  # patch: .dsh/auto-eval-target.yml   # candidate model/effort/persona overlay, relative to the candidate root',
      '  permissionMode: workspace-write',
      '  timeoutMs: 600000',
      '  isolation: worktree      # every (case, repeat) starts from a clean git worktree',
    ]
  return [
    `name: ${options.name}`,
    `description: ${JSON.stringify(options.description ?? '')}`,
    '',
    ...target,
    '',
    'repeats: 3                 # runs per case; per-case score = pass fraction over repeats',
    'concurrency: 4',
    '',
    'split:',
    '  seed: 42',
    '  testFraction: 0.3        # test cases move outside the workspace; hillclimbing sees only their aggregate score',
    '  stratifyBy: tag',
    '',
    'judge:',
    '  # provider: deepseek-official',
    '  # model: deepseek-v4-pro     # defaults to the agent default model',
    '  maxTokens: 2048',
    '',
    'goal: score                # score | cost | latency (cost needs prices)',
    '# prices:                  # USD per 1M tokens',
    '#   deepseek-flash: { input: 0.27, output: 1.1, cacheRead: 0.07 }',
    '',
    '# One grader per failure mode. Prefer code graders; use a judge only for open-ended output.',
    'graders: []',
    '#  - mode: wrong-category',
    '#    kind: code',
    '#    file: graders/wrong-category.check.mjs',
    '#  - mode: invents-policy',
    '#    kind: judge',
    '#    file: graders/invents-policy.judge.md',
    '',
    'thresholds:',
    '  judgeTpr: 0.9',
    '  judgeTnr: 0.9',
    '  headroom: 0.95           # warn when the baseline already scores above this',
    '  minEffect: 0.03          # smallest score change worth acting on',
    '  minCostGain: 0.05        # relative cost/latency drop a cost/latency round must reach',
    '',
  ].join('\n')
}

/**
 * Validate one case record from a cases JSONL file.
 * @param {unknown} value
 * @param {number} line
 * @returns {{ case?: EvalCase, error?: string }}
 */
export function validateCase(value, line) {
  if (!isRecord(value)) return { error: `line ${line}: case must be an object` }
  if (typeof value.id !== 'string' || value.id.length === 0) return { error: `line ${line}: case.id must be a non-empty string` }
  if (value.input === undefined) return { error: `line ${line}: case.input is required` }
  if (value.tags !== undefined && (!Array.isArray(value.tags) || value.tags.some(tag => typeof tag !== 'string'))) {
    return { error: `line ${line}: case.tags must be a list of strings` }
  }
  return { case: /** @type {EvalCase} */ (value) }
}

/**
 * @typedef {{
 *   id: string, input: unknown, expected?: unknown, tags?: string[],
 *   fixture?: { dir: string, into?: string }, meta?: Record<string, unknown>, source?: string,
 * }} EvalCase
 */
