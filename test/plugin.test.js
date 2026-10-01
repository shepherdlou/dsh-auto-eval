// Mounts the real plugin on a real dsh ToolRuntime and drives every tool
// through ctx.tools.execute, with stub llm / sessionQuery / skills / commands.
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as plugin from '../index.js'
import { evalPaths, writeJsonl } from '../lib/core/store.js'
import { CATEGORY_CHECK, TRIAGE_APP, gitInit, tempProject, triageCases, writeFiles } from './helpers.js'
import { sessionSnapshot } from './fixtures/session.js'

function fakeLlm() {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      const output = /## Output to evaluate\n([\s\S]*?)\n\n/.exec(options.messages[0].content[0].text)?.[1] ?? ''
      const verdict = { critique: 'checked', pass: !output.includes('refund') }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(verdict) }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(verdict) } }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
}

function fakeSessionQuery(cwd) {
  const mk = (id, extra = {}) => ({ header: { id, cwd, createdAt: Date.now(), ...extra }, live: false, persisted: true })
  const sessions = [mk('session-abc'), mk('session-2'), mk('other-ws', { cwd: '/elsewhere' }), mk('child', { origin: 'subagent' })]
  return {
    listSessions: async () => sessions,
    readSession: async id => {
      const snapshot = structuredClone(sessionSnapshot)
      snapshot.session.header = { ...snapshot.session.header, id, cwd }
      return snapshot
    },
  }
}

async function mount(cwd, home) {
  process.env.DSH_HOME = home
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const llm = fakeLlm()
  ctx.provide('llm', llm)
  ctx.provide('sessionQuery', fakeSessionQuery(cwd))
  ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'fixture', model: 'judge-model' }) })
  const registered = { skills: [], commands: [] }
  ctx.provide('skills', {
    registerProvider: create => { registered.skills.push(create({ signal: new AbortController().signal, invalidate() {} })); return () => {} },
  })
  ctx.provide('commands', { register: def => { registered.commands.push(def); return () => {} } })
  await ctx.plugin(plugin, {})
  const agent = { id: 'session-x', session: { header: { cwd } } }
  let n = 0
  const call = async (name, args) => {
    const result = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId(`c${++n}`), name, arguments: args, agent,
    })
    if (result.isError) return { error: result.content.map(b => b.text).join('') }
    return result.value
  }
  return { ctx, call, llm, registered }
}

describe('plugin', () => {
  it('registers tools, skills and the /eval command, and runs the workflow', async () => {
    const root = await tempProject('plugin')
    const home = await tempProject('plugin-home')
    await writeFiles(root, { 'app.mjs': TRIAGE_APP, 'rules.json': JSON.stringify({ refund: 'refund', crash: 'bug' }) })
    gitInit(root)
    const { ctx, call, llm, registered } = await mount(root, home)

    const names = ctx.tools.schemas().map(s => s.name).filter(n => n.startsWith('eval_')).sort()
    assert.deepEqual(names, ['eval_hillclimb', 'eval_init', 'eval_judge_check', 'eval_review', 'eval_run', 'eval_split', 'eval_traces'])

    const provider = registered.skills[0]
    const skills = await provider.list({})
    assert.deepEqual(skills.map(s => s.name).sort(), ['auto-eval', 'build-eval', 'error-analysis', 'hillclimb'])
    const skill = await provider.get(skills.find(s => s.name === 'hillclimb'), {})
    assert.match(skill.content, /# Hillclimb/)
    assert.equal(skill.invocation.userInvocable, true)
    assert.equal(registered.commands[0].name, 'eval')
    const empty = await registered.commands[0].handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })
    assert.match(empty.text, /No evals/)

    const created = await call('eval_init', { action: 'create', name: 'triage', target: 'command', command: 'node app.mjs' })
    assert.ok(created.evalDir.startsWith(root))
    assert.deepEqual((await call('eval_init', { action: 'list' })).evals, ['triage'])

    const listed = await call('eval_traces', { name: 'triage', action: 'list' })
    assert.equal(listed.usable, 2, 'other workspaces and subagent sessions are excluded')
    const sampled = await call('eval_traces', { name: 'triage', action: 'sample', n: 5 })
    assert.equal(sampled.sampled, 2)

    const review = await call('eval_review', { name: 'triage', action: 'open', view: 'traces' })
    assert.match(review.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=.+#\/traces$/)
    assert.equal(review.traces.total, 2)
    const page = await fetch(review.url)
    assert.equal(page.status, 200)

    const paths = evalPaths(root, 'triage', home)
    await writeFiles(paths.root, {
      'eval.yaml': 'name: triage\ntarget: { kind: command, command: "node app.mjs" }\nrepeats: 1\ngraders:\n  - { mode: wrong-category, kind: code }\n  - { mode: promises-refund, kind: judge }\n',
      'graders/wrong-category.check.mjs': CATEGORY_CHECK,
      'graders/promises-refund.judge.md': 'Fails if the reply promises a refund for a ticket that does not ask for one. Check the ticket text and the reply.\n',
    })
    await writeJsonl(paths.inboxCases, triageCases())
    const valid = await call('eval_init', { action: 'validate', name: 'triage' })
    assert.equal(valid.ok, true, JSON.stringify(valid.errors))

    const run = await call('eval_run', { name: 'triage', split: 'inbox', limit: 6 })
    assert.equal(run.cases, 6)
    assert.ok(Array.isArray(run.failures))
    assert.ok(llm.calls.length >= 6)
    assert.equal(llm.calls[0].model, 'judge-model', 'falls back to the agent default model')
    assert.equal(llm.calls[0].temperature, 0)

    const split = await call('eval_split', { name: 'triage' })
    assert.equal(split.train.added + split.test.added, 24)
    const test = await call('eval_run', { name: 'triage', split: 'test' })
    assert.equal(test.failures, undefined)
    assert.equal(test.perCase, undefined)
    assert.equal(typeof test.score, 'number')

    // The guard blocks other tools from reading the held-out store.
    ctx.tools.register(defineTool({
      name: 'read_file', description: 'read', parameters: { path: { type: 'string', required: true } },
      output: { schema: { type: 'string' }, render: (_a, v) => [{ type: 'text', text: v }] },
      async execute() { return 'secret' },
    }))
    const denied = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('g1'), name: 'read_file',
      arguments: { path: join(paths.heldout, 'test.jsonl') }, agent: { id: 'x', session: { header: { cwd: root } } },
    })
    assert.equal(denied.isError, true)
    assert.match(denied.content.map(b => b.text).join(''), /held-out/)
    const allowed = await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('g2'), name: 'read_file',
      arguments: { path: join(root, 'rules.json') }, agent: { id: 'x', session: { header: { cwd: root } } },
    })
    assert.equal(allowed.isError, false)

    const hc = await call('eval_hillclimb', { name: 'triage', action: 'status' })
    assert.equal(hc.status, 'none')
    const status = await registered.commands[0].handler({ agent: { session: { header: { cwd: root } } }, rawInput: '' })
    assert.match(status.text, /■ triage \(command, 2 graders\)/)
    assert.match(status.text, /judge promises-refund: not calibrated/)

    await call('eval_review', { name: 'triage', action: 'close' })
    ctx.registry.delete(plugin)
    await new Promise(resolve => setTimeout(resolve, 50))
  })
})
