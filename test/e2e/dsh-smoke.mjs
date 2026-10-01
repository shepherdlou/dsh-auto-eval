#!/usr/bin/env node
// End-to-end smoke test against a REAL dsh install, no API key needed: a
// scripted Messages-compatible mock model drives `dsh --profile headless`
// through the plugin's tools. Not part of `npm test` (it needs dsh).
//
//   dsh plugin --profile headless add /path/to/dsh-auto-eval
//   DSH_BIN=$(which dsh) node test/e2e/dsh-smoke.mjs
//
// Honors DSH_HOME, so an isolated home works too.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const dsh = process.env.DSH_BIN ?? 'dsh'
const home = process.env.DSH_HOME || join(homedir(), '.dsh')
const heldoutProbe = join(home, 'auto-eval', 'probe', 'smoke', 'heldout', 'test.jsonl')

const script = [
  { tool: 'eval_init', input: { action: 'create', name: 'smoke', target: 'command', command: 'node app.mjs' } },
  { tool: 'eval_init', input: { action: 'validate', name: 'smoke' } },
  { tool: 'eval_traces', input: { name: 'smoke', action: 'sample', n: 5 } },
  { tool: 'eval_review', input: { name: 'smoke', action: 'open', view: 'traces' } },
  { tool: 'eval_hillclimb', input: { name: 'smoke', action: 'status' } },
  { tool: 'read', input: { path: heldoutProbe } },
  { text: 'smoke done' },
]
const requests = []
const sideRequests = []

const server = createServer((req, res) => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => {
    const parsed = JSON.parse(body || '{}')
    // Requests without tools are dsh side calls (e.g. session titles): answer
    // them without consuming a scripted step.
    const side = !Array.isArray(parsed.tools) || parsed.tools.length === 0
    if (side) sideRequests.push(parsed)
    else requests.push(parsed)
    const step = side ? { text: 'Smoke session' } : script[requests.length - 1] ?? { text: 'script exhausted' }
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' })
    const sse = payload => res.write(`data: ${JSON.stringify(payload)}\n\n`)
    sse({ type: 'message_start', message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'mock', content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
    if (step.tool) {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${requests.length}`, name: step.tool, input: {} } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    } else {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } })
    }
    sse({ type: 'message_stop' })
    res.end()
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

const project = mkdtempSync(join(tmpdir(), 'dae-smoke-'))
writeFileSync(join(project, 'app.mjs'), 'console.log(JSON.stringify({ output: "hi" }))\n')
spawnSync('git', ['init', '-q'], { cwd: project })

const child = await new Promise(resolve => {
  const proc = spawn(dsh, ['--profile', 'headless', '--json', '-'], {
    cwd: project,
    env: {
      ...process.env,
      DEEPSEEK_BASE_URL: `http://127.0.0.1:${port}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
      DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'workspace-write',
    },
  })
  let stdout = ''
  let stderr = ''
  proc.stdout.on('data', c => { stdout += c })
  proc.stderr.on('data', c => { stderr += c })
  proc.stdin.end('Run the auto-eval smoke script.')
  const timer = setTimeout(() => proc.kill('SIGKILL'), 120_000)
  proc.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
})

if (process.env.SMOKE_DEBUG) console.log(child.stdout)
const events = child.stdout.split('\n').filter(Boolean).map(line => { try { return JSON.parse(line) } catch { return { raw: line } } })
const results = events.filter(e => e.type === 'tool_result')
const calls = events.filter(e => e.type === 'tool_call')
console.log(`dsh exit ${child.code}; ${requests.length} agent requests (+${sideRequests.length} side); ${calls.length} tool calls`)
for (const [i, r] of results.entries()) console.log(`  ${calls[i]?.tool}: ${r.status} ${String(r.result).replace(/\s+/g, ' ').slice(0, 160)}`)
if (child.code !== 0) console.log(child.stderr.slice(-2000))

const tools = (requests[0]?.tools ?? []).map(t => t.name)
assert.ok(tools.includes('eval_init') && tools.includes('eval_hillclimb'), `eval_* tools offered to the model: ${tools.join(', ')}`)
const firstPrompt = JSON.stringify(requests[0]?.system ?? '') + JSON.stringify(requests[0]?.messages ?? '')
assert.match(firstPrompt, /error-analysis/, 'the bundled skills are listed to the model')
assert.match(firstPrompt, /build-eval/, 'the bundled skills are listed to the model')
assert.equal(results[0]?.status, 'completed', 'eval_init create ran')
assert.ok(existsSync(join(project, '.evals', 'smoke', 'eval.yaml')), 'eval.yaml was written in the session cwd')
assert.equal(results[1]?.status, 'completed', 'eval_init validate ran')
assert.equal(results[2]?.status, 'completed', 'eval_traces ran on the real session store')
const sampled = JSON.parse(String(results[2]?.result))
assert.equal(sampled.sampled, 1, 'the live session in this cwd is sampled')
const traceFiles = readdirSync(join(project, '.evals', 'smoke', 'traces'))
const trace = JSON.parse(readFileSync(join(project, '.evals', 'smoke', 'traces', traceFiles[0]), 'utf8'))
assert.equal(trace.input, 'Run the auto-eval smoke script.', 'first human message parsed from the real log')
assert.ok(trace.toolCalls >= 3, `tool calls parsed from the real log (${trace.toolCalls})`)
const review = JSON.parse(String(results[3]?.result))
assert.equal(review.oneShotRun, true, 'a headless run is detected as one-shot')
assert.equal(review.url, undefined, 'no URL that dies with the process')
assert.match(review.reopen, /bin\/dsh-auto-eval\.mjs review smoke --cwd /, 'the CLI command to reopen the page is given instead')
assert.match(review.stop, /END YOUR TURN/)
assert.match(String(results[4]?.result), /"status": "none"/)
assert.equal(results[5]?.status, 'error', 'reading the held-out store is denied')
assert.match(String(results[5]?.result), /held-out/)
assert.equal(events.at(-1)?.type, 'final')
assert.equal(child.code, 0)
console.log('phase 1 (plugin tools inside dsh): OK')

// Phase 2: the runner drives the real dsh binary as a dsh-agent target, each
// run in its own git worktree, and parses the real headless NDJSON stream.
const { parseSpec } = await import('../../lib/core/spec.js')
const { runEval } = await import('../../lib/runner.js')
writeFileSync(join(project, 'grader.mjs'), "export default ({ output }) => ({ pass: /tests pass/i.test(String(output)), reason: String(output) })\n")
spawnSync('git', ['add', '-A'], { cwd: project })
spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: project })
script.push({ text: 'Fixed it, the tests pass.' }, { text: 'I could not finish.' })
const { spec, errors } = parseSpec([
  'name: agent-smoke',
  'target:',
  '  kind: dsh-agent',
  `  dshCommand: ${JSON.stringify(dsh)}`,
  '  profile: headless',
  '  permissionMode: workspace-write',
  '  timeoutMs: 120000',
  '  isolation: worktree',
  '  env:',
  `    DEEPSEEK_BASE_URL: http://127.0.0.1:${port}/v1`,
  '    DEEPSEEK_API_KEY: mock-key',
  'repeats: 2',
  'concurrency: 1',
  'graders: [{ mode: no-success, kind: code, file: grader.mjs }]',
].join('\n'))
assert.deepEqual(errors, [])
const { summary, rows } = await runEval({
  spec, evalRoot: project, cases: [{ id: 'fix', input: { task: 'Fix the tests.' } }], split: 'train',
  candidateRoot: project, runDir: join(project, 'run'),
})
server.close()
console.log(`  runs: ${rows.map(r => `${r.pass} (${r.output})`).join(', ')}; infra ${summary.infra.count}`)
assert.equal(summary.infra.count, 0, JSON.stringify(summary.infra))
assert.deepEqual(rows.map(r => r.pass), [true, false])
assert.ok(rows.every(r => /^session-/.test(r.sessionId ?? '')), 'session ids parsed from the real stream')
assert.ok(rows.every(r => r.trace === undefined))
assert.ok(rows.every(r => r.usage.outputTokens > 0), 'usage parsed from step_end events')
console.log('phase 2 (dsh-agent target on real dsh): OK')
console.log('dsh smoke: OK')
