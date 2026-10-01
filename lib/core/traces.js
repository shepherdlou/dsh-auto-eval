// @ts-check
/**
 * Normalize dsh session logs (and imported app traces) into one trace shape
 * that the review UI renders and the judge reads.
 */
import { asText, clip } from './judge.js'

/**
 * @typedef {'system' | 'user' | 'context' | 'assistant' | 'reasoning' | 'tool-call' | 'tool-result' | 'turn-end'} TraceItemKind
 * @typedef {{ rating: 'positive' | 'negative', note?: string, category?: string }} Feedback
 * @typedef {{
 *   kind: TraceItemKind, text: string, name?: string, callId?: string, isError?: boolean,
 *   messageId?: string, time?: number, turn?: number, feedback?: Feedback,
 * }} TraceItem
 * @typedef {{ inputTokens: number, outputTokens: number, cacheReadTokens: number, reasoningTokens: number }} Usage
 * @typedef {{
 *   id: string, source: 'dsh-session' | 'import', sessionId?: string, cwd?: string, createdAt?: number,
 *   provider?: string, model?: string, reasoningEffort?: string,
 *   input: string, output: string, items: TraceItem[],
 *   toolCalls: number, toolErrors: number, usage: Usage,
 *   durationMs?: number, endReason?: string,
 *   feedback: (Feedback & { messageId: string })[], meta?: Record<string, unknown>,
 * }} Trace
 */

/** @returns {Usage} */
export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }
}

/**
 * @param {Usage} total
 * @param {any} usage dsh TokenUsage or a loose {input_tokens,...} object
 */
export function addUsage(total, usage) {
  if (usage === null || typeof usage !== 'object') return total
  const pick = (/** @type {string[]} */ ...keys) => {
    for (const key of keys) if (typeof usage[key] === 'number') return usage[key]
    return 0
  }
  total.inputTokens += pick('inputTokens', 'input_tokens', 'prompt_tokens')
  total.outputTokens += pick('outputTokens', 'output_tokens', 'completion_tokens')
  total.cacheReadTokens += pick('cacheReadTokens', 'cache_read_tokens', 'prompt_cache_hit_tokens')
  total.reasoningTokens += pick('reasoningTokens', 'reasoning_tokens')
  return total
}

/** @param {any} content dsh ContentBlock[] */
function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (block?.type === 'text') return block.text
      if (block?.type === 'image') return '[image]'
      if (block?.type === 'file') return '[file]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * Normalize a dsh `sessionQuery.readSession()` snapshot (or a bare event list).
 * @param {{ session?: any, header?: any, events: readonly any[] } | readonly any[]} snapshot
 * @param {{ id?: string }} [options]
 * @returns {Trace}
 */
export function normalizeSession(snapshot, options = {}) {
  const events = Array.isArray(snapshot) ? snapshot : /** @type {any} */ (snapshot).events ?? []
  const header = Array.isArray(snapshot) ? undefined
    : /** @type {any} */ (snapshot).session?.header ?? /** @type {any} */ (snapshot).header ?? /** @type {any} */ (snapshot).session
  const sessionId = typeof header?.id === 'string' ? header.id : options.id
  /** @type {TraceItem[]} */
  const items = []
  /** @type {Map<string, string>} */
  const toolNames = new Map()
  /** @type {Map<string, Feedback>} */
  const feedback = new Map()
  const usage = emptyUsage()
  let toolCalls = 0
  let toolErrors = 0
  /** @type {string | undefined} */ let provider
  /** @type {string | undefined} */ let model
  /** @type {string | undefined} */ let reasoningEffort
  /** @type {string | undefined} */ let endReason
  /** @type {number | undefined} */ let firstTime
  /** @type {number | undefined} */ let lastTime

  for (const event of events) {
    const data = event?.data
    const time = typeof event?.time === 'number' ? event.time : undefined
    if (time !== undefined) {
      firstTime ??= time
      lastTime = time
    }
    switch (event?.type) {
      case 'system/message':
        items.push({ kind: 'system', text: textOf(data?.message?.content), time })
        break
      case 'user/message': {
        const human = data?.source?.kind === 'user'
        items.push({ kind: human ? 'user' : 'context', text: textOf(data?.content), messageId: data?.id, time })
        break
      }
      case 'assistant/message': {
        addUsage(usage, data?.usage)
        const message = data?.message
        for (const block of message?.content ?? []) {
          if (block?.type === 'reasoning' && block.text) {
            items.push({ kind: 'reasoning', text: block.text, messageId: message?.id, time, turn: data?.turn })
          } else if (block?.type === 'text' && block.text) {
            items.push({ kind: 'assistant', text: block.text, messageId: message?.id, time, turn: data?.turn })
          }
        }
        break
      }
      case 'tool/call':
        toolCalls++
        toolNames.set(data?.callId, data?.name)
        items.push({ kind: 'tool-call', name: data?.name, callId: data?.callId, text: data?.arguments ?? '', time, turn: data?.turn })
        break
      case 'tool/result': {
        if (event.surfaceOp !== undefined && event.surfaceOp !== 'append') break
        const message = data?.message
        const isError = message?.isError === true || data?.error !== undefined
        if (isError) toolErrors++
        const callId = message?.toolCallId
        items.push({
          kind: 'tool-result', callId, name: toolNames.get(callId), isError,
          text: textOf(message?.content), messageId: message?.id, time, turn: data?.turn,
        })
        break
      }
      case 'request/header': {
        const config = data?.header?.config
        if (typeof config?.model === 'string') model = config.model
        if (typeof config?.provider === 'string') provider = config.provider
        if (typeof config?.reasoningEffort === 'string') reasoningEffort = config.reasoningEffort
        break
      }
      case 'turn/end':
        endReason = data?.reason?.kind
        items.push({ kind: 'turn-end', text: endReason ?? '', time, turn: data?.turn })
        break
      case 'feedback/message-put': {
        const item = data?.item
        if (typeof item?.messageId === 'string') {
          feedback.set(item.messageId, {
            rating: item.rating,
            ...typeof item.note === 'string' ? { note: item.note } : {},
            ...typeof item.category === 'string' ? { category: item.category } : {},
          })
        }
        break
      }
      case 'feedback/message-delete':
        if (typeof data?.messageId === 'string') feedback.delete(data.messageId)
        break
      default:
        break
    }
  }

  for (const item of items) {
    if (item.messageId !== undefined) {
      const rating = feedback.get(item.messageId)
      if (rating) item.feedback = rating
    }
  }

  const input = items.find(item => item.kind === 'user')?.text ?? ''
  const output = [...items].reverse().find(item => item.kind === 'assistant')?.text ?? ''
  return {
    id: sessionId ?? `session-${firstTime ?? 0}`,
    source: 'dsh-session',
    ...sessionId !== undefined ? { sessionId } : {},
    ...typeof header?.cwd === 'string' ? { cwd: header.cwd } : {},
    ...typeof header?.createdAt === 'number' ? { createdAt: header.createdAt } : firstTime !== undefined ? { createdAt: firstTime } : {},
    ...provider !== undefined ? { provider } : {},
    ...model !== undefined ? { model } : {},
    ...reasoningEffort !== undefined ? { reasoningEffort } : {},
    input,
    output,
    items,
    toolCalls,
    toolErrors,
    usage,
    ...firstTime !== undefined && lastTime !== undefined ? { durationMs: lastTime - firstTime } : {},
    ...endReason !== undefined ? { endReason } : {},
    feedback: [...feedback.entries()].map(([messageId, value]) => ({ messageId, ...value })),
  }
}

/**
 * Normalize one imported trace record from a user's own app. Accepts
 * `{id?, input, output, messages?: [{role, content}], usage?, meta?}`.
 * @param {any} raw
 * @param {number} index
 * @returns {Trace}
 */
export function normalizeImported(raw, index) {
  if (raw === null || typeof raw !== 'object') throw new Error(`trace ${index + 1}: must be an object`)
  /** @type {TraceItem[]} */
  const items = []
  if (Array.isArray(raw.messages)) {
    for (const message of raw.messages) {
      const role = message?.role
      const text = typeof message?.content === 'string' ? message.content : asText(message?.content)
      if (role === 'system') items.push({ kind: 'system', text })
      else if (role === 'user') items.push({ kind: 'user', text })
      else if (role === 'assistant') {
        if (text) items.push({ kind: 'assistant', text })
        for (const call of message?.tool_calls ?? message?.toolCalls ?? []) {
          items.push({
            kind: 'tool-call',
            name: call?.function?.name ?? call?.name,
            callId: call?.id,
            text: call?.function?.arguments ?? asText(call?.arguments),
          })
        }
      } else if (role === 'tool') items.push({ kind: 'tool-result', callId: message?.tool_call_id, text })
    }
  } else {
    if (raw.input !== undefined) items.push({ kind: 'user', text: asText(raw.input) })
    if (raw.output !== undefined) items.push({ kind: 'assistant', text: asText(raw.output) })
  }
  const input = raw.input !== undefined ? asText(raw.input) : items.find(item => item.kind === 'user')?.text ?? ''
  const output = raw.output !== undefined ? asText(raw.output) : [...items].reverse().find(item => item.kind === 'assistant')?.text ?? ''
  return {
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : `import-${index + 1}`,
    source: 'import',
    input,
    output,
    items,
    toolCalls: items.filter(item => item.kind === 'tool-call').length,
    toolErrors: 0,
    usage: addUsage(emptyUsage(), raw.usage),
    feedback: [],
    ...raw.meta && typeof raw.meta === 'object' ? { meta: raw.meta } : {},
  }
}

/**
 * Compact text rendering for judges and quick reads. System prompts and
 * reasoning are omitted unless asked for; long tool output is clipped.
 * @param {Trace} trace
 * @param {{ maxChars?: number, includeSystem?: boolean, includeReasoning?: boolean }} [options]
 */
export function renderTraceText(trace, options = {}) {
  const max = options.maxChars ?? 20_000
  /** @type {string[]} */
  const lines = []
  for (const item of trace.items) {
    switch (item.kind) {
      case 'system': if (options.includeSystem) lines.push(`[system]\n${clip(item.text, 2000)}`); break
      case 'reasoning': if (options.includeReasoning) lines.push(`[reasoning]\n${clip(item.text, 1500)}`); break
      case 'user': lines.push(`[user]\n${item.text}`); break
      case 'context': lines.push(`[injected context]\n${clip(item.text, 800)}`); break
      case 'assistant': lines.push(`[assistant]\n${item.text}`); break
      case 'tool-call': lines.push(`[tool call ${item.name ?? '?'}] ${clip(item.text, 1200)}`); break
      case 'tool-result': lines.push(`[tool result ${item.name ?? ''}${item.isError ? ' ERROR' : ''}]\n${clip(item.text, 1500)}`); break
      case 'turn-end': if (item.text !== 'completed') lines.push(`[turn ended: ${item.text}]`); break
      default: break
    }
  }
  return clip(lines.join('\n\n'), max)
}

/**
 * One-line summary used in listings.
 * @param {Trace} trace
 */
export function summarizeTrace(trace) {
  const negative = trace.feedback.some(f => f.rating === 'negative')
  return {
    id: trace.id,
    createdAt: trace.createdAt,
    model: trace.model,
    input: clip(trace.input.replace(/\s+/g, ' '), 160),
    toolCalls: trace.toolCalls,
    toolErrors: trace.toolErrors,
    endReason: trace.endReason,
    negativeFeedback: negative,
  }
}
