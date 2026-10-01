// @ts-check
/**
 * Review data: labels are append-only JSONL logs (the latest entry per key
 * wins), so nothing a reviewer did is ever silently lost and the model can
 * read the files directly. The taxonomy is one JSON document.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { NAME_PATTERN } from '../core/spec.js'
import { appendJsonl, exists, readJson, readJsonl, writeJson } from '../core/store.js'

/**
 * @typedef {{ id: string, pass: boolean | null, note: string, at: string }} TraceLabel
 * @typedef {{ id: string, status: 'approved' | 'rejected' | 'unreviewed', note: string, tags?: string[], at: string }} CaseLabel
 * @typedef {{ id: string, runId: string, caseId: string, rep: number, pass: boolean, note: string, at: string }} GraderLabel
 * @typedef {{ id: string, name: string, description: string, traceIds: string[] }} FailureMode
 * @typedef {{ modes: FailureMode[], updatedAt?: string }} Taxonomy
 */

export const RUN_ID_PATTERN = /^[a-zA-Z0-9_.-]{1,120}$/

/**
 * Latest entry per key from an append-only label log.
 * @template {{ id: string }} T
 * @param {string} path
 * @returns {Promise<Map<string, T>>}
 */
export async function latestLabels(path) {
  /** @type {Map<string, T>} */
  const map = new Map()
  for (const row of await readJsonl(path)) {
    if (row && typeof row.id === 'string') map.set(row.id, row)
  }
  return map
}

/** @param {import('../core/store.js').EvalPaths} paths */
export const labelFiles = paths => ({
  traces: join(paths.labels, 'traces.jsonl'),
  cases: join(paths.labels, 'cases.jsonl'),
  disputes: join(paths.labels, 'disputes.jsonl'),
  /** @param {string} mode */
  grader: mode => join(paths.labels, `grader-${mode}.jsonl`),
})

/**
 * @param {import('../core/store.js').EvalPaths} paths
 * @returns {Promise<import('../core/traces.js').Trace[]>}
 */
export async function loadTraces(paths) {
  let names
  try { names = await readdir(paths.traces) } catch { return [] }
  const traces = []
  for (const name of names.filter(n => n.endsWith('.json')).sort()) {
    try { traces.push(JSON.parse(await readFile(join(paths.traces, name), 'utf8'))) } catch { /* skip unreadable */ }
  }
  return traces
}

/** @param {unknown} value @returns {Taxonomy} */
export function validateTaxonomy(value) {
  if (value === null || typeof value !== 'object' || !Array.isArray(/** @type {any} */ (value).modes)) {
    throw new Error('taxonomy must be {"modes": [...]}')
  }
  const ids = new Set()
  const modes = /** @type {any[]} */ (/** @type {any} */ (value).modes).map((mode, index) => {
    if (typeof mode?.id !== 'string' || !NAME_PATTERN.test(mode.id)) throw new Error(`modes[${index}].id must be kebab-case`)
    if (ids.has(mode.id)) throw new Error(`duplicate failure mode id "${mode.id}"`)
    ids.add(mode.id)
    const traceIds = Array.isArray(mode.traceIds) ? [...new Set(mode.traceIds.filter((/** @type {unknown} */ id) => typeof id === 'string'))] : []
    return {
      id: mode.id,
      name: typeof mode.name === 'string' && mode.name !== '' ? mode.name : mode.id,
      description: typeof mode.description === 'string' ? mode.description : '',
      traceIds: /** @type {string[]} */ (traceIds),
    }
  })
  return { modes }
}

/** @param {import('../core/store.js').EvalPaths} paths @returns {Promise<Taxonomy>} */
export async function loadTaxonomy(paths) {
  if (!await exists(paths.taxonomy)) return { modes: [] }
  return validateTaxonomy(await readJson(paths.taxonomy))
}

/** @param {import('../core/store.js').EvalPaths} paths @param {unknown} value */
export async function saveTaxonomy(paths, value) {
  const taxonomy = validateTaxonomy(value)
  // Most frequent first: the order the user should prioritize evals in.
  taxonomy.modes.sort((a, b) => b.traceIds.length - a.traceIds.length || a.id.localeCompare(b.id))
  const saved = { ...taxonomy, updatedAt: new Date().toISOString() }
  await writeJson(paths.taxonomy, saved)
  return saved
}

/**
 * Aggregate counts for tools and the UI header.
 * @param {import('../core/store.js').EvalPaths} paths
 */
export async function reviewStatus(paths) {
  const files = labelFiles(paths)
  const traces = await loadTraces(paths)
  /** @type {Map<string, TraceLabel>} */
  const traceLabels = await latestLabels(files.traces)
  const traceIds = new Set(traces.map(t => t.id))
  const labeled = [...traceLabels.values()].filter(l => traceIds.has(l.id) && l.pass !== null)
  const taxonomy = await loadTaxonomy(paths)
  /** @type {Map<string, CaseLabel>} */
  const caseLabels = await latestLabels(files.cases)
  const inbox = await readJsonl(paths.inboxCases)
  return {
    traces: {
      total: traces.length,
      labeled: labeled.length,
      pass: labeled.filter(l => l.pass === true).length,
      fail: labeled.filter(l => l.pass === false).length,
      withNotes: labeled.filter(l => l.note.trim() !== '').length,
    },
    taxonomy: taxonomy.modes.map(m => ({ id: m.id, name: m.name, count: m.traceIds.length })),
    cases: {
      inbox: inbox.length,
      approved: inbox.filter(c => caseLabels.get(c.id)?.status === 'approved').length,
      rejected: inbox.filter(c => caseLabels.get(c.id)?.status === 'rejected').length,
    },
  }
}

/**
 * Notes for axial coding: every labeled trace with its note and current modes.
 * @param {import('../core/store.js').EvalPaths} paths
 */
export async function codingNotes(paths) {
  const traces = await loadTraces(paths)
  /** @type {Map<string, TraceLabel>} */
  const labels = await latestLabels(labelFiles(paths).traces)
  const taxonomy = await loadTaxonomy(paths)
  return traces
    .map(trace => {
      const label = labels.get(trace.id)
      return {
        traceId: trace.id,
        pass: label?.pass ?? null,
        note: label?.note ?? '',
        modes: taxonomy.modes.filter(m => m.traceIds.includes(trace.id)).map(m => m.id),
        input: trace.input.slice(0, 200),
      }
    })
    .filter(n => n.pass !== null || n.note !== '')
}

export { appendJsonl }
