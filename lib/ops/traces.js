// @ts-check
/**
 * eval_traces: pull past dsh sessions (same workspace only) or import a
 * user's app traces, sample them for error analysis, and write the sample
 * to `.evals/<name>/traces/` for the review UI.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { evalPaths, readJsonl, writeJson } from '../core/store.js'
import { normalizeImported, normalizeSession, summarizeTrace } from '../core/traces.js'
import { sampleTraces } from '../core/sample.js'
import { safeName } from '../runner.js'
import { loadTraces } from '../review/data.js'

/**
 * @typedef {{
 *   listSessions(signal?: AbortSignal): Promise<any[]>,
 *   readSession(id: string): Promise<any>,
 * }} SessionQuery
 */

/** Session ids produced by this eval's own runs, so they never count as production traces. @param {import('../core/store.js').EvalPaths} paths */
async function evalSessionIds(paths) {
  const ids = new Set()
  let runs
  try { runs = await readdir(paths.runs) } catch { return ids }
  for (const run of runs) {
    for (const row of await readJsonl(join(paths.runs, run, 'results.jsonl')).catch(() => [])) {
      if (typeof row.sessionId === 'string') ids.add(row.sessionId)
    }
  }
  return ids
}

/**
 * @param {{
 *   cwd: string, sessionQuery: SessionQuery, scan?: number, contains?: string,
 *   since?: number, allowOtherWorkspaces?: boolean, exclude?: Set<string>, signal?: AbortSignal,
 * }} options
 */
export async function collectSessionTraces(options) {
  const records = await options.sessionQuery.listSessions(options.signal)
  const scan = options.scan ?? 200
  const candidates = records
    .filter(record => {
      const header = record?.header
      if (!header || typeof header.id !== 'string') return false
      if (header.origin === 'subagent' || header.parentSession !== undefined) return false
      if (!options.allowOtherWorkspaces && header.cwd !== options.cwd) return false
      if (options.since !== undefined && typeof header.createdAt === 'number' && header.createdAt < options.since) return false
      return !options.exclude?.has(header.id)
    })
    .slice(0, scan)
  const traces = []
  for (const record of candidates) {
    options.signal?.throwIfAborted()
    try {
      const trace = normalizeSession(await options.sessionQuery.readSession(record.header.id), { id: record.header.id })
      if (trace.input === '') continue
      if (options.contains && !trace.input.toLowerCase().includes(options.contains.toLowerCase())) continue
      traces.push(trace)
    } catch { /* unreadable or still-live session: skip */ }
  }
  return { traces, scanned: candidates.length, total: records.length }
}

/**
 * @param {{
 *   cwd: string, name: string, home?: string, sessionQuery?: SessionQuery,
 *   action: 'list' | 'sample' | 'import', n?: number, seed?: number,
 *   strategy?: 'mixed' | 'random' | 'flagged', contains?: string, sinceDays?: number,
 *   scan?: number, file?: string, allowOtherWorkspaces?: boolean, signal?: AbortSignal,
 * }} options
 */
export async function tracesOp(options) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const existing = new Set((await loadTraces(paths)).map(t => t.id))

  if (options.action === 'import') {
    if (!options.file) throw new Error('import needs file: a JSONL file of {id?, input, output, messages?, usage?, meta?} records')
    const text = await readFile(resolve(options.cwd, options.file), 'utf8')
    const rows = text.split('\n').filter(line => line.trim() !== '').map((line, index) => {
      try { return JSON.parse(line) } catch { throw new Error(`${options.file}:${index + 1}: invalid JSON`) }
    })
    const pool = rows.map((row, index) => normalizeImported(row, index)).filter(t => !existing.has(t.id))
    const picked = options.n !== undefined
      ? sampleTraces(pool.map(t => ({ ...summarizeTrace(t), trace: t })), { n: options.n, seed: options.seed ?? 1, strategy: 'random' }).sample.map(s => s.trace)
      : pool
    for (const trace of picked) await writeJson(join(paths.traces, `${safeName(trace.id)}.json`), trace)
    return { action: 'import', imported: picked.length, skippedExisting: rows.length - pool.length, tracesDir: paths.traces }
  }

  if (options.sessionQuery === undefined) {
    throw new Error('this dsh profile has no session query service; import traces from a file instead (action: import)')
  }
  const { traces, scanned, total } = await collectSessionTraces({
    cwd: options.cwd,
    sessionQuery: options.sessionQuery,
    exclude: new Set([...existing, ...await evalSessionIds(paths)]),
    ...options.scan !== undefined ? { scan: options.scan } : {},
    ...options.contains !== undefined ? { contains: options.contains } : {},
    ...options.sinceDays !== undefined ? { since: Date.now() - options.sinceDays * 86_400_000 } : {},
    ...options.allowOtherWorkspaces ? { allowOtherWorkspaces: true } : {},
    ...options.signal ? { signal: options.signal } : {},
  })
  const summaries = traces.map(summarizeTrace)

  if (options.action === 'list') {
    return {
      action: 'list', sessionsInStore: total, scanned, usable: traces.length, alreadySampled: existing.size,
      flagged: summaries.filter(s => s.negativeFeedback).length,
      withToolErrors: summaries.filter(s => s.toolErrors > 0).length,
      preview: summaries.slice(0, 20),
    }
  }

  const n = options.n ?? 30
  const byId = new Map(traces.map(t => [t.id, t]))
  const { sample, reasons } = sampleTraces(summaries, { n, seed: options.seed ?? 1, strategy: options.strategy ?? 'mixed' })
  for (const summary of sample) {
    await writeJson(join(paths.traces, `${safeName(summary.id)}.json`), byId.get(summary.id))
  }
  /** @type {Record<string, number>} */
  const why = {}
  for (const reason of Object.values(reasons)) why[reason] = (why[reason] ?? 0) + 1
  return { action: 'sample', sampled: sample.length, from: traces.length, reasons: why, totalInEval: existing.size + sample.length, tracesDir: paths.traces }
}
