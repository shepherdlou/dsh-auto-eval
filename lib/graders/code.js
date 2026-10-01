// @ts-check
/**
 * Code graders: `graders/<mode>.check.mjs` default-exports a function that
 * returns whether the failure mode is ABSENT.
 *
 *   export default function check({ input, output, expected, case, trace, workdir }) {
 *     return { pass: output.category === expected.category, reason: `got ${output.category}` }
 *   }
 *
 * Returning a bare boolean is allowed. Throwing marks a grader error, which is
 * reported separately and never counted as a target failure.
 */
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * @typedef {{ pass: boolean, reason?: string }} Grade
 * @typedef {{
 *   input: unknown, output: unknown, expected?: unknown, case: import('../core/spec.js').EvalCase,
 *   trace: import('../core/traces.js').Trace, workdir: string,
 * }} CheckContext
 */

/**
 * Import a check module, bypassing the module cache when the file changed.
 * @param {string} path
 * @returns {Promise<(context: CheckContext) => unknown>}
 */
export async function loadCheck(path) {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined) throw new Error(`code grader not found: ${path}`)
  const url = `${pathToFileURL(path).href}?mtime=${info.mtimeMs}`
  const module = await import(url)
  const check = module.default ?? module.check
  if (typeof check !== 'function') throw new Error(`${path} must default-export a function`)
  return check
}

/**
 * @param {unknown} value
 * @returns {Grade}
 */
export function normalizeGrade(value) {
  if (typeof value === 'boolean') return { pass: value }
  if (value !== null && typeof value === 'object' && typeof (/** @type {any} */ (value)).pass === 'boolean') {
    const { pass, reason } = /** @type {{ pass: boolean, reason?: unknown }} */ (value)
    return { pass, ...reason !== undefined ? { reason: String(reason) } : {} }
  }
  throw new Error(`code grader must return a boolean or {pass, reason}, got ${JSON.stringify(value)}`)
}

/**
 * @param {{ evalRoot: string, file: string, context: CheckContext, timeoutMs?: number }} options
 * @returns {Promise<Grade>}
 */
export async function runCodeGrader({ evalRoot, file, context, timeoutMs = 60_000 }) {
  const check = await loadCheck(resolve(evalRoot, file))
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`code grader ${file} timed out after ${timeoutMs} ms`)), timeoutMs)
  })
  try {
    return normalizeGrade(await Promise.race([Promise.resolve(check(context)), timeout]))
  } finally {
    clearTimeout(timer)
  }
}
