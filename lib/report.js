// @ts-check
/**
 * Static results page written next to every run: score with its interval,
 * per-failure-mode pass rates, diagnostics, and every case's repeats with the
 * grader verdicts and the transcript one click away. Self-contained so it
 * opens from disk without a server.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderTraceText } from './core/traces.js'

/** @param {string} text */
export function escapeHtml(text) {
  return text.replace(/[&<>"']/g, ch => /** @type {Record<string, string>} */ ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch)
}

/** @param {number | null | undefined} x */
const pct = x => (x === null || x === undefined || !Number.isFinite(x) ? '—' : `${(x * 100).toFixed(1)}%`)

/** Shared design tokens for generated pages (light and dark). */
export const PAGE_STYLE = `
:root { color-scheme: light dark;
  --bg: #f6f7f9; --surface: #ffffff; --ink: #14181f; --ink-2: #4b5563; --muted: #7b8494; --rule: #e1e5eb;
  --pass: #1a7f4b; --pass-bg: #e3f4ea; --fail: #b42318; --fail-bg: #fde8e6; --warn: #8a5a00; --warn-bg: #fff3d6;
  --skip: #6b7280; --skip-bg: #eceef1; --accent: #3b5bdb; --code: #f0f2f5;
  --font: system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  --mono: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #0f1216; --surface: #171b21; --ink: #e8ebf0; --ink-2: #b3bac5; --muted: #8a93a0; --rule: #2a3039;
  --pass: #5fd394; --pass-bg: #15301f; --fail: #ff8a80; --fail-bg: #3a1714; --warn: #f5c451; --warn-bg: #352a0c;
  --skip: #a0a7b2; --skip-bg: #23282f; --accent: #8ea6ff; --code: #1e232b; } }
:root[data-theme="dark"] {
  --bg: #0f1216; --surface: #171b21; --ink: #e8ebf0; --ink-2: #b3bac5; --muted: #8a93a0; --rule: #2a3039;
  --pass: #5fd394; --pass-bg: #15301f; --fail: #ff8a80; --fail-bg: #3a1714; --warn: #f5c451; --warn-bg: #352a0c;
  --skip: #a0a7b2; --skip-bg: #23282f; --accent: #8ea6ff; --code: #1e232b; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--font); }
main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 64px; }
h1 { font-size: 1.4rem; margin: 0 0 4px; } h2 { font-size: 1.05rem; margin: 28px 0 10px; }
.sub { color: var(--muted); font-size: .85rem; }
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 10px; padding: 14px 16px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-top: 16px; }
.kpi .v { font-size: 1.5rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.kpi .l { color: var(--muted); font-size: .8rem; }
table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { color: var(--muted); font-weight: 600; font-size: .8rem; }
.table-wrap { overflow-x: auto; }
.chip { display: inline-block; min-width: 26px; padding: 1px 7px; margin: 1px 2px 1px 0; border-radius: 999px; font-size: .78rem; font-weight: 600; cursor: pointer; border: 0; font-family: inherit; }
.pass { color: var(--pass); background: var(--pass-bg); } .fail { color: var(--fail); background: var(--fail-bg); }
.skip { color: var(--skip); background: var(--skip-bg); } .warn { color: var(--warn); background: var(--warn-bg); }
.diag { margin: 0; padding-left: 18px; } .diag li { margin: 4px 0; }
pre { background: var(--code); padding: 10px 12px; border-radius: 8px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; font: 12.5px/1.45 var(--mono); max-height: 520px; overflow-y: auto; }
dialog { width: min(900px, calc(100vw - 32px)); max-height: calc(100vh - 48px); border: 1px solid var(--rule); border-radius: 12px; background: var(--surface); color: var(--ink); padding: 0; }
dialog .head { display: flex; justify-content: space-between; align-items: center; padding: 12px 16px; border-bottom: 1px solid var(--rule); position: sticky; top: 0; background: var(--surface); }
dialog .body { padding: 12px 16px 20px; }
button.close { border: 1px solid var(--rule); background: transparent; color: var(--ink); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
.muted { color: var(--muted); }
dialog td:first-child { white-space: nowrap; }
`

/**
 * @param {string} runDir
 * @param {import('./runner.js').RunSummary} summary
 * @param {readonly import('./runner.js').RunRow[]} rows
 */
export async function writeReport(runDir, summary, rows) {
  /** @type {Record<string, { text: string, grades: unknown, output: string, input: unknown, expected: unknown }>} */
  const transcripts = {}
  for (const row of rows) {
    try {
      const data = JSON.parse(await readFile(join(runDir, row.transcript), 'utf8'))
      transcripts[`${row.caseId}#${row.rep}`] = {
        text: renderTraceText(data.trace, { maxChars: 8000 }),
        grades: data.grades,
        output: typeof data.output === 'string' ? data.output : JSON.stringify(data.output, undefined, 2),
        input: data.input,
        expected: data.expected,
      }
    } catch { /* report what is readable */ }
  }

  /** @type {Map<string, import('./runner.js').RunRow[]>} */
  const byCase = new Map()
  for (const row of rows) {
    const list = byCase.get(row.caseId) ?? []
    list.push(row)
    byCase.set(row.caseId, list)
  }
  const caseRows = [...byCase.entries()]
    .sort(([a], [b]) => (summary.perCase[a]?.score ?? 2) - (summary.perCase[b]?.score ?? 2) || a.localeCompare(b))
    .map(([id, list]) => {
      const chips = list.sort((a, b) => a.rep - b.rep).map(row => {
        const cls = row.infraError ? 'warn' : row.pass === null ? 'skip' : row.pass ? 'pass' : 'fail'
        const label = row.infraError ? 'infra' : row.pass === null ? 'err' : row.pass ? 'pass' : 'fail'
        const failed = Object.entries(row.grades).filter(([, g]) => 'pass' in g && !g.pass).map(([m]) => m)
        return `<button class="chip ${cls}" data-key="${escapeHtml(`${row.caseId}#${row.rep}`)}" title="${escapeHtml(failed.join(', ') || label)}">${row.rep}:${label}</button>`
      }).join('')
      const failedModes = [...new Set(list.flatMap(row => Object.entries(row.grades).filter(([, g]) => 'pass' in g && !g.pass).map(([m]) => m)))]
      return `<tr><td><code>${escapeHtml(id)}</code></td><td>${pct(summary.perCase[id]?.score)}</td><td>${chips}</td><td class="muted">${escapeHtml(failedModes.join(', '))}</td></tr>`
    }).join('\n')

  const modeRows = Object.entries(summary.perMode).map(([mode, m]) =>
    `<tr><td><code>${escapeHtml(mode)}</code></td><td>${pct(m.passRate)}</td><td class="muted">${pct(m.low)} – ${pct(m.high)}</td><td>${m.passes}/${m.n}</td></tr>`).join('\n')

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(`${summary.evalName} results`)}</title>
<style>${PAGE_STYLE}</style></head>
<body><main>
<h1>${escapeHtml(summary.evalName)} · ${escapeHtml(summary.split)}</h1>
<div class="sub">${escapeHtml(summary.runId)} · ${escapeHtml(summary.target)} · ${summary.cases} cases × ${summary.repeats} repeats · ${escapeHtml(summary.finishedAt)}</div>
<div class="kpis">
  <div class="card kpi"><div class="v">${pct(summary.score)}</div><div class="l">score · 95% CI ${pct(summary.ci.low)} – ${pct(summary.ci.high)}</div></div>
  <div class="card kpi"><div class="v">${summary.scoredRuns}/${summary.runs}</div><div class="l">runs scored</div></div>
  <div class="card kpi"><div class="v">${summary.infra.count}</div><div class="l">infrastructure errors</div></div>
  <div class="card kpi"><div class="v">${summary.costPerCaseUsd === null ? '—' : `$${summary.costPerCaseUsd.toFixed(4)}`}</div><div class="l">cost per run</div></div>
  <div class="card kpi"><div class="v">${Number.isFinite(summary.latencyMs.p50) ? `${(summary.latencyMs.p50 / 1000).toFixed(1)}s` : '—'}</div><div class="l">median latency</div></div>
</div>
${summary.diagnostics.length > 0 ? `<h2>Diagnostics</h2><div class="card"><ul class="diag">${summary.diagnostics.map(d => `<li>${escapeHtml(d)}</li>`).join('')}</ul></div>` : ''}
<h2>Failure modes</h2>
<div class="card table-wrap"><table><thead><tr><th>mode</th><th>pass rate</th><th>95% CI</th><th>passes</th></tr></thead><tbody>${modeRows}</tbody></table></div>
<h2>Cases <span class="sub">worst first · click a repeat to read its transcript</span></h2>
<div class="card table-wrap"><table><thead><tr><th>case</th><th>score</th><th>repeats</th><th>failed modes</th></tr></thead><tbody>${caseRows}</tbody></table></div>
</main>
<dialog id="d"><div class="head"><strong id="dt"></strong><button class="close" id="dc">Close</button></div><div class="body" id="db"></div></dialog>
<script>
const T = ${JSON.stringify(transcripts).replace(/</g, '\\u003c')};
const esc = s => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const show = v => typeof v === 'string' ? v : JSON.stringify(v, null, 2);
const d = document.getElementById('d');
document.addEventListener('click', e => {
  const key = e.target?.dataset?.key; if (!key || !T[key]) return;
  const t = T[key];
  document.getElementById('dt').textContent = key;
  const grades = Object.entries(t.grades || {}).map(([m, g]) =>
    '<tr><td><code>' + esc(m) + '</code></td><td>' + (g.error ? '<span class="chip skip">error</span>' : g.pass ? '<span class="chip pass">pass</span>' : '<span class="chip fail">fail</span>') +
    '</td><td>' + esc(g.critique || g.reason || g.error || '') + '</td></tr>').join('');
  document.getElementById('db').innerHTML =
    '<h2>Verdicts</h2><table><tbody>' + grades + '</tbody></table>' +
    '<h2>Input</h2><pre>' + esc(show(t.input)) + '</pre>' +
    (t.expected !== undefined ? '<h2>Reference</h2><pre>' + esc(show(t.expected)) + '</pre>' : '') +
    '<h2>Output</h2><pre>' + esc(t.output) + '</pre><h2>Transcript</h2><pre>' + esc(t.text) + '</pre>';
  d.showModal();
});
document.getElementById('dc').onclick = () => d.close();
</script>
</body></html>
`
  await writeFile(join(runDir, 'results.html'), html)
}
