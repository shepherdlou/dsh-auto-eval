// @ts-check
/** Run listings shared by the review server and the plugin tools. */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJson } from '../core/store.js'
import { RUN_ID_PATTERN } from './data.js'

/**
 * Workspace runs (never held-out ones), newest first.
 * @param {import('../core/store.js').EvalPaths} paths
 */
export async function listRuns(paths) {
  let names
  try { names = await readdir(paths.runs) } catch { return [] }
  const runs = []
  for (const name of names) {
    if (!RUN_ID_PATTERN.test(name)) continue
    try {
      const summary = await readJson(join(paths.runs, name, 'summary.json'))
      runs.push({
        runId: name, split: summary.split, score: summary.score, ci: summary.ci,
        cases: summary.cases, repeats: summary.repeats, finishedAt: summary.finishedAt,
      })
    } catch { /* an unfinished run has no summary */ }
  }
  return runs.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)))
}
