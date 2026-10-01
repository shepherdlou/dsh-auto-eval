// @ts-check
/**
 * dsh-auto-eval: auto-eval and hillclimbing for DeepSeek Harness.
 *
 * Registers the eval_* tools, the bundled workflow skills (/auto-eval,
 * /error-analysis, /build-eval, /hillclimb), the /eval status command, and a
 * guard that keeps model tool calls away from the held-out store.
 */
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import z from '@deepseek-ai/schemastery'
import YAML from 'yaml'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dshHome, evalPaths, exists, listEvals, loadSpec } from './lib/core/store.js'
import { createJudge } from './lib/graders/llm.js'
import { initEval, validateEval } from './lib/ops/init.js'
import { tracesOp } from './lib/ops/traces.js'
import { splitOp } from './lib/ops/split.js'
import { runOp } from './lib/ops/run.js'
import { judgeCheckOp } from './lib/ops/judge-check.js'
import { hillclimbFinish, hillclimbRound, hillclimbStart, hillclimbStatus } from './lib/ops/hillclimb.js'
import { startReviewServer } from './lib/review/server.js'
import { reviewStatus } from './lib/review/data.js'
export { statusText }
import { statusText } from './lib/status.js'

export const name = 'dsh-auto-eval'
export const inject = ['tools']

/**
 * @typedef {{ reviewPort: number, guardHeldout: boolean, allowOtherWorkspaces: boolean, sessionScanLimit: number }} Config
 */

export const Config = z.object({
  reviewPort: z.natural().default(0).description('Port for the local review UI; 0 picks a free port.'),
  guardHeldout: z.boolean().default(true).description('Deny model tool calls that reference the held-out store.'),
  allowOtherWorkspaces: z.boolean().default(false).description('Let eval_traces read sessions recorded in other working directories.'),
  sessionScanLimit: z.natural().default(300).description('Newest sessions eval_traces reads per call.'),
})

const SKILL_NAMES = ['auto-eval', 'error-analysis', 'build-eval', 'hillclimb']
const SKILLS_DIR = fileURLToPath(new URL('./skills/', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('./bin/dsh-auto-eval.mjs', import.meta.url))
// BUNDLED_SKILL_RANK from @deepseek-ai/dsh-skill; a constant, not worth a peer dependency.
const BUNDLED_SKILL_RANK = 600

/** @param {string} raw @param {string} path */
export function parseSkillFile(raw, path) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (match?.[1] === undefined) throw new Error(`dsh-auto-eval: ${path} has no YAML frontmatter`)
  const meta = YAML.parse(match[1])
  if (typeof meta?.description !== 'string' || meta.description === '') throw new Error(`dsh-auto-eval: ${path} has no description`)
  return {
    description: meta.description,
    ...typeof meta.whenToUse === 'string' ? { whenToUse: meta.whenToUse } : {},
    content: raw.slice(match[0].length).trim(),
  }
}

/**
 * Tool values must be plain JSON: NaN/Infinity become null, undefined drops.
 * @param {unknown} value
 * @returns {any}
 */
export const toJson = value => JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)) ?? 'null')

/** @param {unknown} value */
const asJsonText = value => [{ type: /** @type {const} */ ('text'), text: JSON.stringify(value, undefined, 2) }]
const JSON_OUTPUT = { schema: /** @type {const} */ ({ type: 'json' }), render: (/** @type {unknown} */ _args, /** @type {unknown} */ value) => asJsonText(value) }
const EVAL_NAME = /** @type {const} */ ({ type: 'string', required: true, description: 'Eval name (kebab-case), the directory under .evals/' })

/**
 * @param {import('@deepseek-ai/cordis').Context & Record<string, any>} ctx
 * @param {Config} config
 */
export function apply(ctx, config) {
  /** @type {Map<string, import('./lib/review/server.js').ReviewServer>} */
  const servers = new Map()
  ctx.effect(() => () => {
    for (const server of servers.values()) void server.close()
    servers.clear()
  })

  /** @param {any} exec */
  const cwdOf = exec => exec?.agent?.session?.header?.cwd ?? process.cwd()

  /** dsh services are optional at call time: a minimal profile may lack them. */
  const services = () => ({
    llm: ctx.get('llm'),
    sessionQuery: ctx.get('sessionQuery'),
    defaultModel: ctx.get('agentDefaultModel'),
  })

  /**
   * Judge for an eval: the eval's judge model, else the agent default model.
   * @param {import('./lib/core/spec.js').EvalSpec} spec
   */
  const judgeFor = spec => {
    const { llm, defaultModel } = services()
    if (!llm) return undefined
    const fallback = defaultModel?.currentSelection?.() ?? {}
    const provider = spec.judge.provider ?? fallback.provider
    const model = spec.judge.model ?? fallback.model
    if (!provider || !model) return undefined
    const reasoningEffort = spec.judge.reasoningEffort ?? (spec.judge.model === undefined ? fallback.reasoningEffort : undefined)
    return createJudge({
      llm,
      selection: { provider, model, ...reasoningEffort ? { reasoningEffort: String(reasoningEffort) } : {} },
      maxTokens: spec.judge.maxTokens,
    })
  }

  /** @param {string} cwd @param {string} evalName @param {AbortSignal} signal */
  const depsFor = async (cwd, evalName, signal) => {
    const spec = await loadSpec(evalPaths(cwd, evalName))
    const sessionQuery = services().sessionQuery
    const judge = judgeFor(spec)
    return {
      spec,
      deps: {
        signal,
        ...judge ? { judge } : {},
        ...sessionQuery ? { readSession: (/** @type {string} */ id) => sessionQuery.readSession(id) } : {},
      },
    }
  }

  ctx.tools.register(defineTool({
    name: 'eval_init',
    description: [
      'Create, validate, or list evals in this project (.evals/<name>/).',
      'action=create scaffolds eval.yaml for a target: "command" (the user\'s own LLM app: reads one case as JSON on stdin, prints {"output": ...}) or "dsh-agent" (this dsh agent, run headless).',
      'action=validate checks the spec, grader files and case files without running anything. action=list lists evals.',
    ].join(' '),
    parameters: {
      action: { type: 'string', enum: ['create', 'validate', 'list'], required: true },
      name: { type: 'string', description: 'Eval name (kebab-case); not needed for list' },
      target: { type: 'string', enum: ['command', 'dsh-agent'], description: 'For create' },
      command: { type: 'string', description: 'For create with target=command, e.g. "python app.py"' },
      description: { type: 'string', description: 'For create: what this eval measures' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      if (args.action === 'list') return toJson({ evals: await listEvals(cwd) })
      if (!args.name) throw new Error('name is required')
      if (args.action === 'validate') return toJson(await validateEval({ cwd, name: args.name }))
      const { paths, created } = await initEval({
        cwd, name: args.name, target: args.target ?? 'command',
        ...args.command ? { command: args.command } : {},
        ...args.description ? { description: args.description } : {},
      })
      return {
        evalDir: paths.root,
        created,
        next: 'Start with error analysis: get traces (eval_traces, or eval_run with saveAsTraces on collected inputs), open the review UI (eval_review) for the user, then stop and wait for their labels. No grader before the user has read real traces.',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_traces',
    description: [
      'Gather traces for error analysis into .evals/<name>/traces/.',
      'action=list previews past dsh sessions from this working directory (flagged = user thumbs-down).',
      'action=sample picks n sessions (mixed: user-flagged first, then unusual ones such as tool errors, then random).',
      'action=import reads a JSONL file of the user\'s own app traces ({id?, input, output, messages?, usage?, meta?} per line).',
    ].join(' '),
    parameters: {
      name: EVAL_NAME,
      action: { type: 'string', enum: ['list', 'sample', 'import'], required: true },
      n: { type: 'integer', description: 'How many traces to sample (default 30; error analysis wants 30-100)' },
      strategy: { type: 'string', enum: ['mixed', 'random', 'flagged'] },
      contains: { type: 'string', description: 'Only sessions whose first user message contains this text' },
      sinceDays: { type: 'number', description: 'Only sessions from the last N days' },
      file: { type: 'string', description: 'For import: JSONL path relative to the project root' },
      seed: { type: 'integer' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const { sessionQuery } = services()
      return toJson(await tracesOp({
        cwd: cwdOf(exec), name: args.name, action: args.action,
        scan: config.sessionScanLimit,
        allowOtherWorkspaces: config.allowOtherWorkspaces,
        signal: exec.signal,
        ...sessionQuery ? { sessionQuery } : {},
        ...args.n !== undefined ? { n: args.n } : {},
        ...args.strategy ? { strategy: args.strategy } : {},
        ...args.contains ? { contains: args.contains } : {},
        ...args.sinceDays !== undefined ? { sinceDays: args.sinceDays } : {},
        ...args.file ? { file: args.file } : {},
        ...args.seed !== undefined ? { seed: args.seed } : {},
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_review',
    description: [
      'Open the local review web UI for the user and/or report label progress.',
      'Views: traces (pass/fail + open-coding notes), taxonomy (group notes into failure modes), cases (approve/reject eval inputs),',
      'grader (blind human labels for one judge on one run; the judge verdict shows after labeling), results (scores and transcripts; the user can dispute verdicts).',
      'Give the user the URL; labels are saved to .evals/<name>/labels/ and taxonomy.json as they work.',
    ].join(' '),
    parameters: {
      name: EVAL_NAME,
      action: { type: 'string', enum: ['open', 'status', 'close'], required: true },
      view: { type: 'string', enum: ['traces', 'taxonomy', 'cases', 'grader', 'results'] },
      mode: { type: 'string', description: 'Failure mode, for view=grader' },
      run: { type: 'string', description: 'Run id, for view=grader or results' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const paths = evalPaths(cwdOf(exec), args.name)
      if (!await exists(paths.root)) throw new Error(`no eval "${args.name}"; run eval_init first`)
      const key = paths.root
      if (args.action === 'close') {
        await servers.get(key)?.close()
        servers.delete(key)
        return { closed: true }
      }
      const status = await reviewStatus(paths)
      if (args.action === 'status') return toJson({ ...status, url: servers.get(key)?.url ?? null })
      // A one-shot (headless) dsh exits after this turn and would take the
      // page with it, so the user gets the CLI command instead of a dead URL.
      const oneShot = ctx.get('headlessStartup') !== undefined
      let server = servers.get(key)
      if (!server && !oneShot) {
        server = await startReviewServer({ paths, port: config.reviewPort })
        servers.set(key, server)
      }
      const view = args.view ?? 'traces'
      const hash = view === 'grader'
        ? `#/grader${args.mode ? `/${encodeURIComponent(args.mode)}${args.run ? `/${encodeURIComponent(args.run)}` : ''}` : ''}`
        : view === 'results' && args.run ? `#/results/${encodeURIComponent(args.run)}` : `#/${view}`
      const reopen = `node ${CLI_PATH} review ${args.name} --cwd ${cwdOf(exec)}${hash ? ` # then open ${hash}` : ''}`
      return toJson({
        ...server ? { url: `${server.url}${hash}` } : {},
        ...status,
        oneShotRun: oneShot,
        reopen,
        stop: oneShot
          ? `This is a one-shot dsh run: the page closes when your turn ends. Give the user this command to open it (it prints a URL and keeps the page up): ${reopen}  Then END YOUR TURN; continue only after they say they are done. Do not label, approve, or write notes or failure modes for them.`
          : 'Give the user this URL and END YOUR TURN. The labeling is theirs to do; continue only after they reply that they are done. Do not label, approve, or write notes or failure modes for them. If the page ever stops working, the reopen command brings it back.',
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_split',
    description: 'Split the collected cases (cases/inbox.jsonl) into train (stays in the workspace) and test (moved outside it, reported only as aggregate scores). Requires that the user reviewed every case in the review UI (view: cases). Rejected cases are dropped; runs made before the split are archived out of reach. Returns counts only.',
    parameters: {
      name: EVAL_NAME,
      onlyApproved: { type: 'boolean', description: 'Split only cases the user approved in the review UI; leave the rest in the inbox' },
      skipReview: { type: 'boolean', description: 'ONLY when the user explicitly said to skip case review; recorded in audit.jsonl and shown in every report' },
      reason: { type: 'string', description: 'With skipReview: the user\'s reason' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      return toJson(await splitOp({
        cwd: cwdOf(exec), name: args.name,
        ...args.onlyApproved ? { onlyApproved: true } : {},
        ...args.skipReview ? { skipReview: true } : {},
        ...args.reason ? { reason: args.reason } : {},
      }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_run',
    description: [
      'Run the target on a split and grade every output. split=inbox (before splitting), train, or test.',
      'Works before any grader exists: then it only collects outputs and transcripts (use saveAsTraces to review them as traces); never write your own runner.',
      'Returns score with a 95% interval, pass rate per failure mode, infrastructure errors (excluded from the score), diagnostics, and for visible splits the failures to read first plus a results.html report.',
      'Test runs return aggregates only. Runs can take a while: use limit for a quick check.',
    ].join(' '),
    parameters: {
      name: EVAL_NAME,
      split: { type: 'string', enum: ['inbox', 'train', 'test'], required: true },
      repeats: { type: 'integer', description: 'Override eval.yaml repeats' },
      limit: { type: 'integer', description: 'Run only this many cases (seeded sample)' },
      modes: { type: 'array', items: { type: 'string' }, description: 'Only these failure modes' },
      consistencySample: { type: 'integer', description: 'Re-grade this many outputs with each judge to measure flip rate' },
      saveAsTraces: { type: 'boolean', description: 'Also save each output as a trace for the review UI (error analysis on fresh inputs). Not for split=test.' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const { deps } = await depsFor(cwd, args.name, exec.signal)
      return toJson(await runOp({
        cwd, name: args.name, split: args.split,
        ...args.repeats !== undefined ? { repeats: args.repeats } : {},
        ...args.limit !== undefined ? { limit: args.limit } : {},
        ...args.modes ? { modes: args.modes } : {},
        ...args.consistencySample !== undefined ? { consistencySample: args.consistencySample } : {},
        ...args.saveAsTraces ? { saveAsTraces: true } : {},
      }, deps))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_judge_check',
    description: 'Calibrate one LLM judge against the user\'s grader labels (review UI, Grader labels view). Labels split into few-shot examples, dev (disagreements are returned so you can fix the rubric) and test (TPR/TNR only). Writes graders/<mode>.fewshot.jsonl.',
    parameters: {
      name: EVAL_NAME,
      mode: { type: 'string', required: true, description: 'Failure mode of the judge grader' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const { deps } = await depsFor(cwd, args.name, exec.signal)
      if (!deps.judge) throw new Error('no LLM is available for the judge; set judge.provider and judge.model in eval.yaml')
      return toJson(await judgeCheckOp({ cwd, name: args.name, mode: args.mode }, { judge: deps.judge, signal: exec.signal }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'eval_hillclimb',
    description: [
      'Improve the target against the eval, one patch per round, in a separate git branch worktree.',
      'action=start: create the branch, run the baseline (several times, to measure the noise floor), return where to edit and the train failures.',
      'action=round: evaluate your ONE change in that worktree: kept only if train improves beyond noise and test also rises; otherwise reverted. Edits to the eval itself void the round.',
      'action=finish: settle on the best test-set version and report with intervals. action=status: progress.',
    ].join(' '),
    parameters: {
      name: EVAL_NAME,
      action: { type: 'string', enum: ['start', 'round', 'finish', 'status'], required: true },
      note: { type: 'string', description: 'For round: one line describing the change' },
      goal: { type: 'string', enum: ['score', 'cost', 'latency'], description: 'For start; defaults to eval.yaml goal' },
      maxRounds: { type: 'integer', description: 'For start (default 10)' },
      repeats: { type: 'integer', description: 'For start: repeats per case for every run' },
      baselineRuns: { type: 'integer', description: 'For start: baseline repetitions for the noise floor (default 2)' },
      skipCalibration: { type: 'boolean', description: 'For start, ONLY when the user explicitly accepts uncalibrated judges; recorded in audit.jsonl' },
      reason: { type: 'string', description: 'With skipCalibration: the user\'s reason' },
    },
    output: JSON_OUTPUT,
    async execute(args, exec) {
      const cwd = cwdOf(exec)
      const base = { cwd, name: args.name }
      if (args.action === 'status') return toJson(await hillclimbStatus(base))
      if (args.action === 'finish') return toJson(await hillclimbFinish(base))
      const { deps } = await depsFor(cwd, args.name, exec.signal)
      const result = args.action === 'start'
        ? await hillclimbStart({
          ...base,
          ...args.goal ? { goal: args.goal } : {},
          ...args.maxRounds !== undefined ? { maxRounds: args.maxRounds } : {},
          ...args.repeats !== undefined ? { repeats: args.repeats } : {},
          ...args.baselineRuns !== undefined ? { baselineRuns: args.baselineRuns } : {},
          ...args.skipCalibration ? { skipCalibration: true } : {},
          ...args.reason ? { reason: args.reason } : {},
        }, deps)
        : await hillclimbRound({ ...base, ...args.note ? { note: args.note } : {} }, deps)
      return toJson(result)
    },
  }))

  // Held-out guard: the hillclimber may see test scores, never test content.
  if (config.guardHeldout) {
    const pattern = heldoutPattern(dshHome())
    ctx.on('tools/pre-execute', async (/** @type {any} */ exec, /** @type {() => Promise<any>} */ next) => {
      if (typeof exec?.name === 'string' && exec.name.startsWith('eval_')) return next()
      const text = typeof exec?.arguments === 'string' ? exec.arguments : JSON.stringify(exec?.arguments ?? '')
      if (pattern.test(text)) {
        return {
          kind: 'deny',
          reason: 'dsh-auto-eval keeps held-out eval data out of reach. Use eval_run with split "test" (aggregate scores) or eval_hillclimb instead.',
        }
      }
      return next()
    })
  }

  ctx.inject(['skills'], (/** @type {any} */ skillCtx) => {
    const candidates = SKILL_NAMES.map(skillName => {
      const path = join(SKILLS_DIR, skillName, 'SKILL.md')
      const parsed = parseSkillFile(readFileSync(path, 'utf8'), path)
      return {
        name: skillName,
        description: parsed.description,
        ...parsed.whenToUse ? { whenToUse: parsed.whenToUse } : {},
        invocation: { modelInvocable: true, userInvocable: true },
        provider: 'dsh-auto-eval',
        source: 'bundled',
        rank: BUNDLED_SKILL_RANK,
        resourceBase: { kind: 'directory', path: join(SKILLS_DIR, skillName) },
        locator: path,
      }
    })
    const provider = {
      name: 'dsh-auto-eval',
      list: () => Promise.resolve(candidates),
      /** @param {any} candidate @param {{ signal?: AbortSignal }} options */
      async get(candidate, options) {
        const { rank: _rank, locator, ...summary } = candidate
        const raw = await readFile(locator, { encoding: 'utf8', ...options?.signal ? { signal: options.signal } : {} })
        return { ...summary, content: parseSkillFile(raw, locator).content }
      },
    }
    skillCtx.effect(() => skillCtx.skills.registerProvider(() => provider))
  })

  ctx.inject(['commands'], (/** @type {any} */ commandCtx) => {
    commandCtx.effect(() => commandCtx.commands.register({
      name: 'eval',
      description: 'Show this project\'s evals: cases, last scores, judge calibration and hillclimb status',
      handler: async (/** @type {any} */ invocation) => {
        try {
          return { kind: 'success', text: await statusText(invocation?.agent?.session?.header?.cwd ?? process.cwd()) }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }))
  })
}

/**
 * Matches references to the held-out store: its absolute path, `~/.dsh/auto-eval`,
 * or `$DSH_HOME/auto-eval`, but not look-alikes such as `.dsh/auto-eval-target.yml`.
 * @param {string} home
 */
export function heldoutPattern(home) {
  const escape = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const roots = [escape(join(home, 'auto-eval')), '\\.dsh[\\\\/]+auto-eval', 'DSH_HOME\\}?[\\\\/]+auto-eval']
  return new RegExp(`(?:${roots.join('|')})(?![\\w.-])`)
}
