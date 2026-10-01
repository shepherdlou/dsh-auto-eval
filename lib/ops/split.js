// @ts-check
/**
 * eval_split: move collected cases out of the inbox. Train cases stay in the
 * workspace; test cases (with their reference answers) move to the held-out
 * store outside it. Runs made before the split saw future test cases, so
 * they move to the held-out archive too.
 */
import { mkdir, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { splitCases } from '../core/split.js'
import { appendJsonl, evalPaths, loadCases, loadSpec, readJson, writeJsonl } from '../core/store.js'
import { labelFiles, latestLabels } from '../review/data.js'

/**
 * @param {{ cwd: string, name: string, home?: string, onlyApproved?: boolean }} options
 */
export async function splitOp(options) {
  const paths = evalPaths(options.cwd, options.name, options.home)
  const spec = await loadSpec(paths)
  const inbox = await loadCases(paths.inboxCases)
  if (inbox.length === 0) throw new Error('the case inbox is empty: collect cases into cases/inbox.jsonl first')
  /** @type {Map<string, import('../review/data.js').CaseLabel>} */
  const labels = await latestLabels(labelFiles(paths).cases)
  const train = await loadCases(paths.trainCases)
  const test = await loadCases(paths.testCases)
  const known = new Set([...train, ...test].map(c => c.id))

  const rejected = []
  const duplicates = []
  let unreviewed = 0
  const accepted = []
  for (const evalCase of inbox) {
    const label = labels.get(evalCase.id)
    if (known.has(evalCase.id)) { duplicates.push(evalCase.id); continue }
    if (label?.status === 'rejected') { rejected.push(evalCase); continue }
    if (label?.status !== 'approved') {
      unreviewed++
      if (options.onlyApproved) continue
    }
    accepted.push(label?.tags ? { ...evalCase, tags: label.tags } : evalCase)
  }
  if (accepted.length === 0) throw new Error('no cases left to split after removing rejected/unreviewed ones')

  const split = splitCases(accepted, spec.split)
  for (const evalCase of split.train) await appendJsonl(paths.trainCases, evalCase)
  await mkdir(paths.heldout, { recursive: true })
  for (const evalCase of split.test) await appendJsonl(paths.testCases, evalCase)
  for (const evalCase of rejected) await appendJsonl(join(paths.cases, 'rejected.jsonl'), evalCase)
  const leftover = options.onlyApproved ? inbox.filter(c => !known.has(c.id) && labels.get(c.id)?.status !== 'approved' && labels.get(c.id)?.status !== 'rejected') : []
  await writeJsonl(paths.inboxCases, leftover)

  let archived = 0
  let runs = []
  try { runs = await readdir(paths.runs) } catch { /* no runs yet */ }
  for (const runId of runs) {
    let summary
    try { summary = await readJson(join(paths.runs, runId, 'summary.json')) } catch { summary = { split: 'inbox' } }
    if (summary.split !== 'inbox') continue
    await mkdir(paths.archivedRuns, { recursive: true })
    await rename(join(paths.runs, runId), join(paths.archivedRuns, runId))
    archived++
  }

  return {
    train: { added: split.train.length, total: train.length + split.train.length },
    test: { added: split.test.length, total: test.length + split.test.length },
    rejected: rejected.length,
    duplicatesSkipped: duplicates.length,
    unreviewed: options.onlyApproved ? { keptInInbox: leftover.length } : { includedWithoutReview: unreviewed },
    archivedPreSplitRuns: archived,
  }
}
