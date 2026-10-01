// @ts-check
/** Plain-text eval status, shared by the /eval command and the CLI. */
import { evalPaths, listEvals, readJsonl } from './core/store.js'
import { validateEval } from './ops/init.js'
import { hillclimbStatus } from './ops/hillclimb.js'
import { calibrationStatus } from './ops/judge-check.js'
import { reviewStatus } from './review/data.js'
import { listRuns } from './review/runs.js'

/** @param {number | null | undefined} x */
const pct = x => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`)

/**
 * @param {string} cwd
 * @param {{ home?: string }} [options]
 */
export async function statusText(cwd, options = {}) {
  const names = await listEvals(cwd)
  if (names.length === 0) {
    return 'No evals in this project yet. Type /auto-eval to start with error analysis on your real traces.'
  }
  const lines = []
  for (const evalName of names) {
    const paths = evalPaths(cwd, evalName, options.home)
    const check = await validateEval({ cwd, name: evalName, ...options.home ? { home: options.home } : {} })
    const spec = check.spec
    lines.push(`■ ${evalName}${spec ? ` (${spec.target.kind}, ${spec.graders.length} grader${spec.graders.length === 1 ? '' : 's'})` : ' (invalid eval.yaml)'}`)
    lines.push(`  cases: ${check.counts.inbox ?? 0} inbox · ${check.counts.train ?? 0} train · ${check.counts.test ?? 0} test (held out)`)
    const review = await reviewStatus(paths)
    if (review.traces.total > 0 || review.taxonomy.length > 0) {
      lines.push(`  error analysis: ${review.traces.labeled}/${review.traces.total} traces labeled by you · ${review.taxonomy.length} failure modes`)
      if (review.taxonomy.length > 0 && review.traces.labeled === 0) {
        lines.push('  ! the failure modes were not derived from your labels: review traces before trusting them')
      }
    }
    if (review.cases.inbox > 0) {
      lines.push(`  case review: ${review.cases.approved} approved · ${review.cases.rejected} rejected · ${review.cases.inbox - review.cases.approved - review.cases.rejected} waiting`)
    }
    if (spec) {
      for (const c of await calibrationStatus(paths, spec)) {
        lines.push(c.status === 'missing'
          ? `  judge ${c.mode}: not calibrated`
          : `  judge ${c.mode}: ${c.status} · TPR ${pct(c.tpr)} · TNR ${pct(c.tnr)}`)
      }
    }
    const runs = await listRuns(paths)
    const last = runs[0]
    if (last) lines.push(`  last run: ${last.runId} · ${last.split} · ${pct(last.score)} [${pct(last.ci?.low)}–${pct(last.ci?.high)}]`)
    const hc = await hillclimbStatus({ cwd, name: evalName, ...options.home ? { home: options.home } : {} })
    if (hc.status !== 'none') {
      lines.push(`  hillclimb ${hc.id}: ${hc.status}, round ${hc.round}/${hc.maxRounds}, best round ${hc.best?.round} (train ${pct(hc.best?.train)}, test ${pct(hc.best?.test)})${hc.stalled ? ' · stalled' : ''}`)
    }
    for (const row of await readJsonl(paths.audit)) lines.push(`  ! skipped ${row.kind}: ${row.reason}`)
    for (const error of check.errors) lines.push(`  ! ${error}`)
  }
  return lines.join('\n')
}
