import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function tempProject(label = 'proj') {
  return mkdtemp(join(tmpdir(), `dae-${label}-`))
}

/** @param {string} root @param {Record<string, string>} files */
export async function writeFiles(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content)
  }
}

/** @param {string} cwd @param {string[]} args */
export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).trim()
}

/** @param {string} cwd */
export function gitInit(cwd) {
  git(cwd, 'init', '-q', '-b', 'main')
  git(cwd, 'add', '-A')
  git(cwd, 'commit', '-q', '-m', 'init')
}

/**
 * A toy support-triage app: classifies a ticket by keyword. `RULES` lives in
 * rules.json so a hillclimb can improve it by editing one file.
 */
export const TRIAGE_APP = `
import { readFileSync } from 'node:fs'
const input = JSON.parse(readFileSync(0, 'utf8'))
const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'))
const text = String(input.input.ticket).toLowerCase()
let category = 'other'
for (const [word, cat] of Object.entries(rules)) if (text.includes(word)) { category = cat; break }
const reply = category === 'refund' ? 'We will refund you within 30 days.' : 'Thanks, we are looking into it.'
console.log(JSON.stringify({ output: { category, reply }, usage: { input_tokens: 100, output_tokens: 20 }, model: 'toy-1' }))
`

export const CATEGORY_CHECK = `
export default function check({ output, expected }) {
  return { pass: output.category === expected.category, reason: 'got ' + output.category + ', want ' + expected.category }
}
`

export function triageCases() {
  const rows = []
  const words = { refund: 'refund', 'money back': 'refund', crash: 'bug', error: 'bug', invoice: 'billing', charged: 'billing' }
  let i = 0
  for (const [phrase, category] of Object.entries(words)) {
    for (let k = 0; k < 4; k++) {
      rows.push({ id: `t${String(i++).padStart(2, '0')}`, input: { ticket: `Hi, ${phrase} please (${k})` }, expected: { category }, tags: [category] })
    }
  }
  return rows
}

/** A fake `dsh` executable that speaks the headless --json protocol. */
export async function fakeDsh(dir, { reply = 'All tests pass.', reason = 'completed' } = {}) {
  const path = join(dir, 'fake-dsh.mjs')
  await writeFile(path, `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'
const task = readFileSync(0, 'utf8')
writeFileSync('agent-was-here.txt', task)
const args = process.argv.slice(2)
const out = e => console.log(JSON.stringify(e))
out({ type: 'session', sessionId: 'session-fake-' + Math.random().toString(36).slice(2, 8), cwd: process.cwd() })
out({ type: 'status', phase: 'turn_start', turn: 1 })
out({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'ls' } })
out({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'a.txt' })
out({ type: 'text', text: ${JSON.stringify(reply)} + ' args=' + args.join(' ') })
out({ type: 'status', phase: 'step_end', turn: 1, step: 1, usage: { inputTokens: 500, outputTokens: 50 } })
out({ type: 'status', phase: 'turn_end', turn: 1, reason: { kind: ${JSON.stringify(reason)} } })
out({ type: 'final', text: ${JSON.stringify(reply)} })
process.exit(${reason === 'completed' ? 0 : 1})
`)
  await chmod(path, 0o755)
  return path
}

/** Approve every inbox case, as a user would in the review UI. */
export async function approveAll(root, name, home) {
  const { evalPaths, readJsonl, appendJsonl } = await import('../lib/core/store.js')
  const paths = evalPaths(root, name, home)
  for (const c of await readJsonl(paths.inboxCases)) {
    await appendJsonl(join(paths.labels, 'cases.jsonl'), { id: c.id, status: 'approved', note: '', at: new Date().toISOString() })
  }
}
