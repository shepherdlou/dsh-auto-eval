// A dsh session log in the persisted event shape (docs/persistence-catalog.md):
// one human prompt, a tool call that errors, a retry, a final answer, and a
// thumbs-down on that answer.
export const sessionSnapshot = {
  session: {
    header: { id: 'session-abc', createdAt: 1_000, cwd: '/work/proj' },
  },
  inheritedEventCount: 0,
  events: [
    { seq: 0, time: 1_000, type: 'system/message', data: { turn: 1, step: 1, message: { id: 'm0', role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }], source: { kind: 'system-prompt' } } } },
    { seq: 1, time: 1_001, type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } }, reason: 'initial' } },
    { seq: 2, time: 1_002, type: 'user/message', data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'Fix the failing test in utils.js' }], source: { kind: 'user' } } },
    { seq: 3, time: 1_003, type: 'user/message', data: { id: 'm1b', role: 'user', content: [{ type: 'text', text: '<git status>clean</git status>' }], source: { kind: 'context' } } },
    { seq: 4, time: 1_004, type: 'turn/start', data: { turn: 1 } },
    { seq: 5, time: 1_010, type: 'assistant/message', data: { turn: 1, step: 1, message: { id: 'm2', role: 'assistant', content: [{ type: 'reasoning', text: 'Look at the test first.' }, { type: 'text', text: 'Let me run the tests.' }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }], source: { kind: 'model' } }, usage: { inputTokens: 1200, outputTokens: 80, cacheReadTokens: 400, reasoningTokens: 20 } } },
    { seq: 6, time: 1_011, type: 'tool/call', data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' } },
    { seq: 7, time: 1_020, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'm3', role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'npm ERR! missing script: test' }], source: { kind: 'tool', callId: 'c1' } } } },
    { seq: 8, time: 1_030, type: 'assistant/message', data: { turn: 1, step: 2, message: { id: 'm4', role: 'assistant', content: [{ type: 'text', text: 'Done — I deleted the failing test.' }], source: { kind: 'model' } }, usage: { inputTokens: 1300, outputTokens: 40 } } },
    { seq: 9, time: 1_031, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 10, time: 1_040, type: 'feedback/message-put', data: { sessionId: 'session-abc', item: { messageId: 'm4', rating: 'negative', note: 'deleted the test instead of fixing it', version: 'v1', createdAt: 1_040, updatedAt: 1_040 } } },
  ],
}
