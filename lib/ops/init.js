// @ts-check
/** eval_init: scaffold an eval; validate: check it is runnable. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { starterSpec, parseSpec } from '../core/spec.js'
import { evalPaths, exists, listEvals, loadCases, readJsonl } from '../core/store.js'
import { loadCheck } from '../graders/code.js'
import { readRubric } from '../graders/llm.js'

/**
 * @param {{
 *   cwd: string, name: string, target: 'command' | 'dsh-agent', command?: string,
 *   description?: string, home?: string,
 * }} options
 */
export async function initEval(options) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const created = []
  for (const dir of [paths.root, paths.traces, paths.labels, paths.cases, paths.graders, paths.runs]) {
    await mkdir(dir, { recursive: true })
  }
  if (!await exists(paths.spec)) {
    await writeFile(paths.spec, starterSpec({
      name: options.name, target: options.target,
      ...options.command !== undefined ? { command: options.command } : {},
      ...options.description !== undefined ? { description: options.description } : {},
    }))
    created.push(paths.spec)
  }
  const readme = join(paths.root, 'README.md')
  if (!await exists(readme)) {
    await writeFile(readme, [
      `# Eval: ${options.name}`,
      '',
      options.description ?? '',
      '',
      '- `eval.yaml` - target, repeats, split, judge model, graders',
      '- `traces/` - sampled traces for error analysis; `labels/` - your labels and notes',
      '- `taxonomy.json` - failure modes found in error analysis, most frequent first',
      '- `cases/inbox.jsonl` - collected cases before the split; `cases/train.jsonl` - train split',
      '- `graders/` - one file per failure mode: `<mode>.check.mjs` (code) or `<mode>.judge.md` (LLM judge rubric)',
      '- `runs/` - results.jsonl, transcripts, summary.json and results.html per run',
      '- `hillclimb/log.jsonl` - every hillclimb round, kept or reverted, and why',
      '',
      'Held-out test cases live outside the workspace and are only ever reported as aggregate scores.',
      '',
    ].join('\n'))
    created.push(readme)
  }
  return { paths, created }
}

/**
 * Check an eval end to end without running the target.
 * @param {{ cwd: string, name: string, home?: string }} options
 */
export async function validateEval(options) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  /** @type {string[]} */ const errors = []
  /** @type {string[]} */ const warnings = []
  let text
  try { text = await readFile(paths.spec, 'utf8') } catch {
    return { ok: false, errors: [`missing ${paths.spec}; run eval_init`], warnings, counts: {} }
  }
  const { spec, errors: specErrors } = parseSpec(text)
  errors.push(...specErrors)
  if (spec !== undefined) {
    if (spec.graders.length === 0) warnings.push('no graders yet: do error analysis, then add one grader per failure mode')
    for (const grader of spec.graders) {
      const file = resolve(paths.root, grader.file)
      if (!await exists(file)) { errors.push(`grader file missing: ${grader.file}`); continue }
      if (grader.kind === 'code') {
        try { await loadCheck(file) } catch (error) { errors.push(`${grader.file}: ${error instanceof Error ? error.message : String(error)}`) }
      } else {
        const rubric = (await readRubric(paths.root, grader.file)).trim()
        if (rubric.length < 40) warnings.push(`${grader.file}: the rubric is very short; list concrete, checkable pass/fail criteria`)
        if (/\b(1|one)\s*(-|to)\s*(5|10|five|ten)\b|\bscore\b.*\bscale\b/i.test(rubric)) {
          warnings.push(`${grader.file}: looks like a rating scale; judges here return a binary pass/fail for one failure mode`)
        }
      }
    }
    if (spec.target.kind === 'dsh-agent' && spec.target.patch !== undefined && !await exists(resolve(options.cwd, spec.target.patch))) {
      warnings.push(`target.patch ${spec.target.patch} does not exist yet (relative to the project root)`)
    }
  }
  /** @type {Record<string, number>} */
  const counts = {}
  for (const [key, path] of /** @type {const} */ ([['inbox', paths.inboxCases], ['train', paths.trainCases], ['test', paths.testCases]])) {
    try { counts[key] = (await loadCases(path)).length } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }
  counts.traces = (await readJsonl(join(paths.labels, 'traces.jsonl'))).length
  if ((counts.train ?? 0) + (counts.test ?? 0) + (counts.inbox ?? 0) === 0) warnings.push('no cases yet')
  if ((counts.test ?? 0) > 0 && (counts.test ?? 0) < 10) warnings.push(`only ${counts.test} held-out test cases; test-set gates will be noisy`)
  return { ok: errors.length === 0, errors, warnings, counts, ...spec ? { spec } : {} }
}

/** @param {string} cwd */
export async function listProjectEvals(cwd) {
  return listEvals(cwd)
}
