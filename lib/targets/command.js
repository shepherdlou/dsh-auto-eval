// @ts-check
/**
 * `command` target: the user's own LLM app. Each case is written to the
 * command's stdin as JSON ({id, input, tags, meta}; never the expected answer)
 * and the command prints its result on stdout, either as JSON
 * `{"output": ..., "messages"?: [...], "usage"?: {...}, "model"?: "..."}`
 * or as plain text.
 */
import { normalizeImported } from '../core/traces.js'
import { runProcess } from './process.js'

/**
 * @typedef {import('../core/spec.js').EvalCase} EvalCase
 * @typedef {import('../core/traces.js').Trace} Trace
 * @typedef {{
 *   output: unknown, trace: Trace, latencyMs: number, model?: string, sessionId?: string,
 *   infraError?: { kind: string, message: string },
 * }} TargetResult
 */

/** @param {string} stdout */
export function parseCommandOutput(stdout) {
  const trimmed = stdout.trim()
  /** @param {string} text */
  const tryJson = text => { try { return JSON.parse(text) } catch { return undefined } }
  let value = tryJson(trimmed)
  if (value === undefined) {
    const lines = trimmed.split('\n').filter(line => line.trim() !== '')
    value = tryJson(lines.at(-1) ?? '')
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'output' in value) return value
  return { output: value !== undefined && typeof value !== 'object' ? value : trimmed }
}

/**
 * @param {{
 *   target: Extract<import('../core/spec.js').TargetSpec, { kind: 'command' }>,
 *   evalCase: EvalCase, workdir: string, signal?: AbortSignal,
 * }} options
 * @returns {Promise<TargetResult>}
 */
export async function runCommandTarget({ target, evalCase, workdir, signal }) {
  const payload = {
    id: evalCase.id,
    input: evalCase.input,
    ...evalCase.tags ? { tags: evalCase.tags } : {},
    ...evalCase.meta ? { meta: evalCase.meta } : {},
  }
  const result = await runProcess({
    command: target.command,
    shell: true,
    cwd: workdir,
    env: { ...process.env, ...target.env, DSH_AUTO_EVAL: '1', DSH_AUTO_EVAL_CASE_ID: evalCase.id },
    stdin: `${JSON.stringify(payload)}\n`,
    timeoutMs: target.timeoutMs,
    ...signal ? { signal } : {},
  })
  const base = { latencyMs: result.durationMs }
  /** @param {string} kind @param {string} message */
  const infra = (kind, message) => ({
    ...base, output: '', trace: normalizeImported({ id: evalCase.id, input: evalCase.input, output: '' }, 0),
    infraError: { kind, message },
  })
  if (result.spawnError) return infra('spawn', result.spawnError)
  if (result.timedOut) return infra('timeout', `no result within ${target.timeoutMs} ms`)
  if (result.aborted) return infra('aborted', 'run cancelled')
  if (result.code !== 0) return infra('exit', `exit ${result.code}: ${result.stderr.trim().slice(-800)}`)

  const parsed = parseCommandOutput(result.stdout)
  const trace = normalizeImported({
    id: evalCase.id,
    input: evalCase.input,
    output: parsed.output,
    ...Array.isArray(parsed.messages) ? { messages: parsed.messages } : {},
    ...parsed.usage ? { usage: parsed.usage } : {},
  }, 0)
  if (typeof parsed.model === 'string') trace.model = parsed.model
  return {
    ...base,
    output: parsed.output,
    trace,
    ...typeof parsed.model === 'string' ? { model: parsed.model } : {},
  }
}
