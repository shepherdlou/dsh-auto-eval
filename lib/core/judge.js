// @ts-check
/**
 * LLM-as-judge protocol. One judge checks one failure mode and answers with a
 * binary verdict plus the critique that justifies it. dsh has no JSON mode, so
 * the protocol is enforced by a strict parser (the pattern dsh's own
 * auto-review uses).
 */

export const JUDGE_PROTOCOL = [
  'You are an evaluator. You check ONE failure mode in the output of an AI system.',
  'Read the rubric, the input, and the output, then decide:',
  '- "pass": true  when the failure mode described by the rubric is ABSENT,',
  '- "pass": false when the failure mode is PRESENT.',
  '',
  'Rules:',
  '- Judge only the failure mode in the rubric; ignore every other quality of the output.',
  '- Check each claim in the rubric against the evidence and quote the evidence you rely on.',
  '- Write the critique first, then decide.',
  '- Reply with exactly one JSON object and nothing else:',
  '  {"critique": "<evidence-based reasoning, at most 150 words>", "pass": true}',
].join('\n')

/**
 * @typedef {{ input: unknown, output: unknown, critique: string, pass: boolean }} FewShot
 */

/** @param {unknown} value */
export function asText(value) {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  return JSON.stringify(value, undefined, 2)
}

/**
 * @param {string} text @param {number} max
 */
export function clip(text, max) {
  if (text.length <= max) return text
  const head = Math.floor(max * 0.7)
  const tail = max - head
  return `${text.slice(0, head)}\n…[${text.length - max} characters omitted]…\n${text.slice(text.length - tail)}`
}

/**
 * Build the judge request: the protocol plus the rubric file verbatim as the
 * system prompt, and the case as the user message.
 * @param {{
 *   mode: string, rubric: string, input: unknown, output: unknown,
 *   expected?: unknown, trace?: string, fewshot?: readonly FewShot[], maxChars?: number,
 * }} options
 * @returns {{ system: string, user: string }}
 */
export function buildJudgeRequest(options) {
  const max = options.maxChars ?? 24_000
  const system = `${JUDGE_PROTOCOL}\n\n## Rubric for failure mode "${options.mode}"\n\n${options.rubric.trim()}\n`
  /** @type {string[]} */
  const parts = []
  for (const [index, example] of (options.fewshot ?? []).entries()) {
    parts.push(
      `### Example ${index + 1}`,
      `Input:\n${clip(asText(example.input), 2000)}`,
      `Output:\n${clip(asText(example.output), 3000)}`,
      `Verdict: ${JSON.stringify({ critique: example.critique, pass: example.pass })}`,
      '',
    )
  }
  if (parts.length > 0) parts.unshift('## Labeled examples (for calibration only)', '')
  parts.push('## Input', clip(asText(options.input), Math.floor(max * 0.3)), '')
  if (options.expected !== undefined) parts.push('## Reference answer', clip(asText(options.expected), Math.floor(max * 0.15)), '')
  parts.push('## Output to evaluate', clip(asText(options.output), Math.floor(max * 0.4)), '')
  if (options.trace !== undefined && options.trace !== '') {
    parts.push('## Execution trace (tool calls and intermediate steps)', clip(options.trace, Math.floor(max * 0.3)), '')
  }
  parts.push('Reply with the JSON object only.')
  return { system, user: parts.join('\n') }
}

/**
 * Strictly parse the judge reply: one JSON object with exactly `critique`
 * (string) and `pass` (boolean). A single ```json fence is tolerated because
 * models add it often and it carries no ambiguity.
 * @param {string} text
 * @returns {{ critique: string, pass: boolean }}
 */
export function parseJudgement(text) {
  let body = text.trim()
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(body)
  if (fence?.[1] !== undefined) body = fence[1].trim()
  /** @type {unknown} */
  let value
  try { value = JSON.parse(body) } catch {
    throw new Error(`judge reply is not one JSON object: ${clip(text, 200)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('judge reply must be one JSON object')
  }
  const record = /** @type {Record<string, unknown>} */ (value)
  const keys = Object.keys(record).sort()
  if (keys.length !== 2 || keys[0] !== 'critique' || keys[1] !== 'pass') {
    throw new Error(`judge reply must have exactly "critique" and "pass", got ${JSON.stringify(keys)}`)
  }
  if (typeof record.critique !== 'string') throw new Error('judge "critique" must be a string')
  if (typeof record.pass !== 'boolean') throw new Error('judge "pass" must be true or false')
  return { critique: record.critique, pass: record.pass }
}

/**
 * @typedef {{
 *   inputTokens?: number, outputTokens?: number, totalTokens?: number,
 *   cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number,
 * }} TokenUsage
 */

/**
 * Consume a dsh `ctx.llm.stream()` chunk stream: text from complete blocks
 * (or deltas when a block never closed), usage, and the terminal finish.
 * Equivalent to dsh's BlockAssembler for the text-only replies judges give.
 * @param {AsyncIterable<any>} stream
 * @returns {Promise<{ text: string, reasoning: string, usage?: TokenUsage }>}
 */
export async function collectStream(stream) {
  /** @type {Map<number, { type: string, text: string, done: boolean }>} */
  const blocks = new Map()
  /** @type {TokenUsage | undefined} */
  let usage
  let finished = false
  for await (const chunk of stream) {
    switch (chunk?.type) {
      case 'block-start':
        blocks.set(chunk.index, { type: chunk.blockType, text: '', done: false })
        break
      case 'text-delta':
      case 'reasoning-delta': {
        const block = blocks.get(chunk.index) ?? { type: chunk.type === 'text-delta' ? 'text' : 'reasoning', text: '', done: false }
        block.text += chunk.text
        blocks.set(chunk.index, block)
        break
      }
      case 'block-end': {
        const block = chunk.block
        if (block?.type === 'text' || block?.type === 'reasoning') {
          blocks.set(chunk.index, { type: block.type, text: block.text, done: true })
        }
        break
      }
      case 'usage':
        usage = chunk.usage
        break
      case 'finish': {
        finished = true
        const kind = chunk.reason?.kind
        if (kind === 'error' || kind === 'aborted') {
          const failure = chunk.reason.failure ?? {}
          const error = new Error(`judge call ended with ${kind}${failure.code ? ` ${failure.code}` : ''}: ${failure.message ?? ''}`)
          Object.assign(error, { infra: true })
          throw error
        }
        if (kind === 'max-tokens') {
          throw Object.assign(new Error('judge reply was cut off at max tokens; raise judge.maxTokens'), { infra: true })
        }
        if (kind !== 'stop') throw new Error(`judge call ended with ${String(kind)}`)
        break
      }
      default:
        break
    }
  }
  if (!finished) throw Object.assign(new Error('judge stream ended without a finish'), { infra: true })
  const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block)
  return {
    text: ordered.filter(block => block.type === 'text').map(block => block.text).join(''),
    reasoning: ordered.filter(block => block.type === 'reasoning').map(block => block.text).join(''),
    ...usage !== undefined ? { usage } : {},
  }
}
