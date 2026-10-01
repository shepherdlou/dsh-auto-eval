import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  bootstrapMeanCI, collectStream, confusion, correctedPassRate, correctedPassRateCI,
  decideRound, effectiveNoise, isStalled, noiseFloor, normalizeImported, normalizeSession,
  pairedDelta, parseJudgement, parseSpec, partitionLabels, renderTraceText, sampleTraces,
  seededRandom, splitCases, starterSpec, buildJudgeRequest, wilson, repeatSd,
} from '../lib/core/index.js'
import { sessionSnapshot } from './fixtures/session.js'

describe('spec', () => {
  it('accepts the starter spec for both targets', () => {
    for (const target of /** @type {const} */ (['command', 'dsh-agent'])) {
      const { spec, errors } = parseSpec(starterSpec({ name: 'demo', target }))
      assert.deepEqual(errors, [])
      assert.equal(spec?.target.kind, target)
      assert.equal(spec?.repeats, 3)
    }
    const { spec } = parseSpec(starterSpec({ name: 'demo', target: 'dsh-agent' }))
    assert.equal(spec?.target.isolation, 'worktree')
  })

  it('enforces one failure mode per grader', () => {
    const { errors } = parseSpec(`
name: x
target: { kind: command, command: "node app.mjs" }
graders:
  - { mode: a, kind: code, modes: [a, b] }
  - { mode: a, kind: judge }
  - { mode: Bad_Name, kind: code }
  - { mode: c, kind: judge, file: graders/c.check.mjs }
  - { mode: d, kind: code, file: ../escape.mjs }
`)
    assert.ok(errors.some(e => e.includes('exactly one failure mode')))
    assert.ok(errors.some(e => e.includes('duplicate failure mode')))
    assert.ok(errors.some(e => e.includes('kebab-case')))
    assert.ok(errors.some(e => e.includes('judge graders are .md')))
    assert.ok(errors.some(e => e.includes('inside the eval directory')))
  })

  it('requires prices for a cost goal and defaults grader files', () => {
    assert.ok(parseSpec('name: x\ntarget: {kind: command, command: a}\ngoal: cost\n').errors.some(e => e.includes('prices')))
    const { spec } = parseSpec('name: x\ntarget: {kind: command, command: a}\ngraders: [{mode: tone, kind: judge}]\n')
    assert.equal(spec?.graders[0]?.file, 'graders/tone.judge.md')
  })
})

describe('split', () => {
  const cases = Array.from({ length: 40 }, (_, i) => ({ id: `c${String(i).padStart(2, '0')}`, tags: [i % 4 === 0 ? 'refund' : 'other'] }))

  it('is deterministic and disjoint', () => {
    const a = splitCases(cases, { seed: 7, testFraction: 0.3, stratifyBy: 'tag' })
    const b = splitCases([...cases].reverse(), { seed: 7, testFraction: 0.3, stratifyBy: 'tag' })
    assert.deepEqual(a.test.map(c => c.id).sort(), b.test.map(c => c.id).sort())
    assert.equal(a.train.length + a.test.length, 40)
    assert.equal(a.test.length, 12)
    const testIds = new Set(a.test.map(c => c.id))
    assert.ok(a.train.every(c => !testIds.has(c.id)))
    assert.ok(a.test.some(c => c.tags[0] === 'refund'), 'stratified: rare tag lands in test')
  })

  it('keeps both sides non-empty for tiny sets', () => {
    const tiny = splitCases(cases.slice(0, 2), { seed: 1, testFraction: 0.1, stratifyBy: 'none' })
    assert.equal(tiny.train.length, 1)
    assert.equal(tiny.test.length, 1)
  })

  it('partitions labels with both verdicts on each side', () => {
    const labels = Array.from({ length: 40 }, (_, i) => ({ id: `l${i}`, pass: i % 3 !== 0 }))
    const { fewshot, dev, test } = partitionLabels(labels, { seed: 3 })
    assert.equal(fewshot.length + dev.length + test.length, 40)
    for (const part of [dev, test]) {
      assert.ok(part.some(l => l.pass) && part.some(l => !l.pass))
    }
  })

  it('seededRandom is uniform-ish', () => {
    const random = seededRandom(123)
    let sum = 0
    for (let i = 0; i < 10_000; i++) sum += random()
    assert.ok(Math.abs(sum / 10_000 - 0.5) < 0.02)
  })
})

describe('stats', () => {
  it('bootstrap CI brackets the mean', () => {
    const values = Array.from({ length: 50 }, (_, i) => (i % 5 === 0 ? 0 : 1))
    const ci = bootstrapMeanCI(values)
    assert.equal(ci.mean, 0.8)
    assert.ok(ci.low < 0.8 && ci.high > 0.8)
    assert.ok(ci.low > 0.6 && ci.high <= 1)
  })

  it('paired delta uses only shared cases', () => {
    const base = new Map([['a', 0], ['b', 1], ['c', 0.5]])
    const cand = new Map([['a', 1], ['b', 1], ['z', 0]])
    const result = pairedDelta(base, cand)
    assert.equal(result.n, 2)
    assert.equal(result.delta, 0.5)
  })

  it('noise floor from repeated runs and from repeat variance', () => {
    assert.equal(noiseFloor([0.7]), null)
    assert.ok(Math.abs(/** @type {number} */ (noiseFloor([0.7, 0.7, 0.7]))) < 1e-12)
    // Deterministic target: every case all-pass or all-fail, so no noise at all.
    assert.equal(effectiveNoise([0.5, 0.5, 0.5], [{ passes: 3, n: 3 }, { passes: 0, n: 3 }]), 0)
    // Coin-flip cases: identical lucky runs must not hide the predicted noise.
    const coin = Array.from({ length: 20 }, () => ({ passes: 1, n: 2 }))
    assert.ok(repeatSd(coin) > 0)
    assert.ok(effectiveNoise([0.5, 0.5, 0.5], coin) > 0.1)
  })

  it('wilson interval', () => {
    const { low, high } = wilson(8, 10)
    assert.ok(low > 0.4 && low < 0.5 && high > 0.9 && high < 1)
  })
})

describe('decide', () => {
  const noise = 0.03
  it('keeps only when train beats noise and test rises', () => {
    assert.equal(decideRound({ goal: 'score', train: { delta: 0.1, noise }, test: { delta: 0.05, noise } }).decision, 'keep')
    const trainOnly = decideRound({ goal: 'score', train: { delta: 0.1, noise }, test: { delta: 0, noise } })
    assert.equal(trainOnly.decision, 'revert')
    assert.match(trainOnly.reason, /overfitting/)
    assert.equal(decideRound({ goal: 'score', train: { delta: 0.02, noise }, test: { delta: 0.1, noise } }).decision, 'revert')
    assert.match(decideRound({ goal: 'score', train: { delta: 0.2, noise }, test: { delta: -0.2, noise } }).reason, /regression/)
  })

  it('cost goal holds quality and needs a real saving', () => {
    const keep = decideRound({ goal: 'cost', train: { delta: -0.01, noise }, test: { delta: 0, noise }, resource: { relDelta: -0.4 } })
    assert.equal(keep.decision, 'keep')
    assert.equal(decideRound({ goal: 'cost', train: { delta: 0, noise }, test: { delta: 0, noise }, resource: { relDelta: -0.01 } }).decision, 'revert')
    assert.equal(decideRound({ goal: 'cost', train: { delta: -0.2, noise }, test: { delta: 0, noise }, resource: { relDelta: -0.9 } }).decision, 'revert')
  })

  it('detects a stall', () => {
    assert.equal(isStalled([{ decision: 'keep' }, { decision: 'revert' }, { decision: 'void' }]), false)
    assert.equal(isStalled([{ decision: 'keep' }, { decision: 'revert' }, { decision: 'void' }, { decision: 'revert' }]), true)
  })
})

describe('judge', () => {
  it('parses strict verdicts and a json fence', () => {
    assert.deepEqual(parseJudgement('{"critique":"ok","pass":true}'), { critique: 'ok', pass: true })
    assert.deepEqual(parseJudgement('```json\n{"pass": false, "critique": "quote: x"}\n```'), { critique: 'quote: x', pass: false })
  })

  it('rejects anything else', () => {
    assert.throws(() => parseJudgement('PASS'), /not one JSON object/)
    assert.throws(() => parseJudgement('{"pass":"yes","critique":"x"}'), /true or false/)
    assert.throws(() => parseJudgement('{"pass":true}'), /exactly/)
    assert.throws(() => parseJudgement('{"pass":true,"critique":"a","score":5}'), /exactly/)
    assert.throws(() => parseJudgement('[]'), /one JSON object/)
  })

  it('puts the rubric verbatim in the system prompt', () => {
    const { system, user } = buildJudgeRequest({
      mode: 'invents-policy', rubric: 'Fails if the reply cites a refund window not in the policy.',
      input: { ticket: 'refund?' }, output: 'You have 90 days.', expected: '30 days',
      fewshot: [{ input: 'q', output: 'a', critique: 'c', pass: true }],
    })
    assert.match(system, /Fails if the reply cites a refund window/)
    assert.match(system, /"invents-policy"/)
    assert.match(user, /## Reference answer\n30 days/)
    assert.match(user, /Example 1/)
  })

  it('assembles a dsh stream', async () => {
    async function* stream() {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index: 0, text: 'hmm' }
      yield { type: 'block-start', index: 1, blockType: 'text' }
      yield { type: 'text-delta', index: 1, text: '{"critique":"x",' }
      yield { type: 'text-delta', index: 1, text: '"pass":false}' }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const result = await collectStream(stream())
    assert.equal(result.text, '{"critique":"x","pass":false}')
    assert.equal(result.reasoning, 'hmm')
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 })
  })

  it('marks provider failures as infra', async () => {
    async function* stream() {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'rate_limited', message: 'slow down' } } }
    }
    await assert.rejects(collectStream(stream()), error => error.infra === true && /rate_limited/.test(error.message))
  })
})

describe('align', () => {
  it('computes TPR/TNR and the corrected pass rate', () => {
    const pairs = [
      ...Array.from({ length: 9 }, () => ({ human: true, judge: true })),
      { human: true, judge: false },
      ...Array.from({ length: 8 }, () => ({ human: false, judge: false })),
      ...Array.from({ length: 2 }, () => ({ human: false, judge: true })),
    ]
    const c = confusion(pairs)
    assert.equal(c.tpr, 0.9)
    assert.equal(c.tnr, 0.8)
    // observed 0.62 => (0.62 + 0.8 - 1) / (0.9 + 0.8 - 1) = 0.6
    assert.ok(Math.abs(correctedPassRate(0.62, 0.9, 0.8) - 0.6) < 1e-9)
    assert.ok(Number.isNaN(correctedPassRate(0.5, 0.5, 0.5)))
    const ci = correctedPassRateCI(pairs, Array.from({ length: 50 }, (_, i) => i % 3 !== 0))
    assert.ok(ci.low <= ci.theta && ci.theta <= ci.high)
  })
})

describe('traces', () => {
  it('normalizes a dsh session log', () => {
    const trace = normalizeSession(sessionSnapshot)
    assert.equal(trace.id, 'session-abc')
    assert.equal(trace.cwd, '/work/proj')
    assert.equal(trace.model, 'deepseek-flash')
    assert.equal(trace.input, 'Fix the failing test in utils.js')
    assert.equal(trace.output, 'Done — I deleted the failing test.')
    assert.equal(trace.toolCalls, 1)
    assert.equal(trace.toolErrors, 1)
    assert.equal(trace.endReason, 'completed')
    assert.deepEqual(trace.usage, { inputTokens: 2500, outputTokens: 120, cacheReadTokens: 400, reasoningTokens: 20 })
    assert.equal(trace.durationMs, 40)
    assert.equal(trace.feedback[0]?.rating, 'negative')
    const answer = trace.items.find(item => item.messageId === 'm4')
    assert.equal(answer?.feedback?.note, 'deleted the test instead of fixing it')
    assert.equal(trace.items.filter(item => item.kind === 'context').length, 1)
    const text = renderTraceText(trace)
    assert.match(text, /\[tool result bash ERROR\]/)
    assert.doesNotMatch(text, /You are a coding agent/)
  })

  it('normalizes imported app traces', () => {
    const trace = normalizeImported({
      id: 't1',
      messages: [
        { role: 'user', content: 'refund?' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'x', function: { name: 'lookup', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'x', content: 'policy: 30 days' },
        { role: 'assistant', content: '30 days.' },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    }, 0)
    assert.equal(trace.input, 'refund?')
    assert.equal(trace.output, '30 days.')
    assert.equal(trace.toolCalls, 1)
    assert.equal(trace.usage.inputTokens, 10)
    assert.equal(normalizeImported({ input: 'a', output: 'b' }, 4).id, 'import-5')
  })

  it('samples flagged, unusual, then random', () => {
    const pool = Array.from({ length: 30 }, (_, i) => ({
      id: `s${i}`, negativeFeedback: i < 3, toolErrors: i >= 3 && i < 6 ? 1 : 0, endReason: 'completed',
    }))
    const { sample, reasons } = sampleTraces(pool, { n: 10, seed: 1 })
    assert.equal(sample.length, 10)
    assert.equal(Object.values(reasons).filter(r => r === 'negative feedback').length, 3)
    assert.equal(Object.values(reasons).filter(r => r === 'tool errors').length, 2)
    assert.equal(new Set(sample.map(s => s.id)).size, 10)
  })
})
