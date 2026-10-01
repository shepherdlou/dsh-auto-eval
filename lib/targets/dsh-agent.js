// @ts-check
/**
 * `dsh-agent` target: run the agent itself, one-shot, through the headless
 * bundle: `dsh --profile headless [--patch <candidate>] --json -` with the
 * task on stdin. The NDJSON stream gives the session id, final answer, usage
 * and turn-end reason; the full, untruncated trace is read back from the
 * session store when the plugin can reach it.
 */
import { isAbsolute, resolve } from 'node:path'
import { emptyUsage, addUsage, normalizeSession } from '../core/traces.js'
import { runProcess } from './process.js'

/**
 * @typedef {import('./command.js').TargetResult} TargetResult
 * @typedef {import('../core/traces.js').Trace} Trace
 * @typedef {import('../core/traces.js').TraceItem} TraceItem
 */

/** @param {unknown} input */
export function taskText(input) {
  if (typeof input === 'string') return input
  if (input !== null && typeof input === 'object') {
    const record = /** @type {Record<string, unknown>} */ (input)
    for (const key of ['task', 'prompt', 'message']) {
      if (typeof record[key] === 'string') return /** @type {string} */ (record[key])
    }
  }
  return JSON.stringify(input, undefined, 2)
}

/**
 * Fold the headless `--json` NDJSON stream into a result and a fallback trace.
 * @param {string} stdout
 */
export function parseHeadlessStream(stdout) {
  /** @type {string | undefined} */ let sessionId
  /** @type {string | undefined} */ let cwd
  /** @type {string | undefined} */ let final
  /** @type {string | undefined} */ let endReason
  /** @type {string | undefined} */ let endError
  /** @type {string | undefined} */ let error
  const usage = emptyUsage()
  /** @type {TraceItem[]} */
  const items = []
  /** @type {Map<string, string>} */
  const names = new Map()
  let toolCalls = 0
  let toolErrors = 0
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue
    /** @type {any} */
    let event
    try { event = JSON.parse(line) } catch { continue }
    switch (event?.type) {
      case 'session': sessionId = event.sessionId; cwd = event.cwd; break
      case 'text': items.push({ kind: 'assistant', text: String(event.text ?? '') }); break
      case 'thinking': items.push({ kind: 'reasoning', text: String(event.text ?? '') }); break
      case 'tool_call':
        toolCalls++
        names.set(event.callId, event.tool)
        items.push({ kind: 'tool-call', name: event.tool, callId: event.callId, text: JSON.stringify(event.input ?? {}) })
        break
      case 'tool_result': {
        const isError = event.status === 'error'
        if (isError) toolErrors++
        items.push({ kind: 'tool-result', callId: event.callId, name: names.get(event.callId), isError, text: String(event.result ?? '') })
        break
      }
      case 'status':
        if (event.phase === 'step_end' && event.usage) addUsage(usage, event.usage)
        if (event.phase === 'turn_end') {
          endReason = event.reason?.kind
          if (event.reason?.kind === 'error') endError = `${event.reason.error?.code ?? ''} ${event.reason.error?.message ?? ''}`.trim()
        }
        break
      case 'final': final = String(event.text ?? ''); break
      case 'error': error = String(event.message ?? 'unknown error'); break
      default: break
    }
  }
  return { sessionId, cwd, final, endReason, endError, error, usage, items, toolCalls, toolErrors }
}

/**
 * @param {{
 *   target: Extract<import('../core/spec.js').TargetSpec, { kind: 'dsh-agent' }>,
 *   evalCase: import('../core/spec.js').EvalCase, workdir: string, candidateRoot: string,
 *   signal?: AbortSignal, readSession?: (id: string) => Promise<any>,
 * }} options
 * @returns {Promise<TargetResult>}
 */
export async function runDshAgentTarget({ target, evalCase, workdir, candidateRoot, signal, readSession }) {
  const task = taskText(evalCase.input)
  const args = ['--profile', target.profile]
  if (target.patch !== undefined) {
    args.push('--patch', isAbsolute(target.patch) ? target.patch : resolve(candidateRoot, target.patch))
  }
  args.push('--json', '-')
  const result = await runProcess({
    command: target.dshCommand,
    args,
    cwd: workdir,
    env: { ...process.env, ...target.env, DSH_PERMISSION_MODE: target.permissionMode, DSH_AUTO_EVAL: '1' },
    stdin: task,
    timeoutMs: target.timeoutMs,
    ...signal ? { signal } : {},
  })
  const stream = parseHeadlessStream(result.stdout)

  /** @type {Trace} */
  let trace = {
    id: stream.sessionId ?? evalCase.id,
    source: 'dsh-session',
    ...stream.sessionId ? { sessionId: stream.sessionId } : {},
    ...stream.cwd ? { cwd: stream.cwd } : {},
    input: task,
    output: stream.final ?? '',
    items: [{ kind: 'user', text: task }, ...stream.items],
    toolCalls: stream.toolCalls,
    toolErrors: stream.toolErrors,
    usage: stream.usage,
    ...stream.endReason ? { endReason: stream.endReason } : {},
    feedback: [],
  }
  if (stream.sessionId && readSession) {
    try {
      const full = normalizeSession(await readSession(stream.sessionId), { id: stream.sessionId })
      if (full.items.length > 0) trace = full
    } catch { /* the NDJSON projection is the fallback */ }
  }

  const base = {
    latencyMs: result.durationMs,
    trace,
    ...stream.sessionId ? { sessionId: stream.sessionId } : {},
    ...trace.model ? { model: trace.model } : {},
  }
  /** @param {string} kind @param {string} message */
  const infra = (kind, message) => ({ ...base, output: stream.final ?? '', infraError: { kind, message } })
  if (result.spawnError) return infra('spawn', `cannot start ${target.dshCommand}: ${result.spawnError}`)
  if (result.timedOut) return infra('timeout', `no result within ${target.timeoutMs} ms`)
  if (result.aborted) return infra('aborted', 'run cancelled')
  if (stream.error !== undefined && stream.final === undefined) return infra('runner', stream.error)
  if (stream.endReason === 'error') return infra('llm-error', stream.endError ?? 'provider error')
  if (stream.endReason === 'max-tokens') return infra('max-tokens', 'the reply was cut off at max tokens')
  if (stream.endReason === 'aborted' || stream.endReason === 'interrupted') return infra('aborted', `turn ended: ${stream.endReason}`)
  if (stream.endReason === 'blocked') {
    return infra('blocked', `the turn blocked (usually a tool approval nobody can answer headlessly); check target.permissionMode (${target.permissionMode})`)
  }
  if (result.code !== 0 && stream.final === undefined) {
    return infra('exit', `exit ${result.code}: ${result.stderr.trim().slice(-800)}`)
  }
  // A completed turn is the agent's answer even when it is wrong; graders decide.
  return { ...base, output: stream.final ?? '' }
}
