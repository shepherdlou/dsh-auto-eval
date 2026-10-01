// A toy support-triage "LLM app" that speaks the dsh-auto-eval command protocol:
// one case arrives as JSON on stdin ({id, input, tags?, meta?}); the result goes
// to stdout as {"output": ..., "messages"?: [...], "usage"?: {...}, "model"?: "..."}.
//
// It classifies a ticket by keyword (rules.json) and answers from a template
// (replies.json). Swap in your real app: only the stdin/stdout contract matters.
import { readFileSync } from 'node:fs'

const { input } = JSON.parse(readFileSync(0, 'utf8'))
const rules = JSON.parse(readFileSync(new URL('./rules.json', import.meta.url), 'utf8'))
const replies = JSON.parse(readFileSync(new URL('./replies.json', import.meta.url), 'utf8'))

const text = String(input.ticket).toLowerCase()
let category = 'other'
for (const [phrase, cat] of Object.entries(rules)) {
  if (text.includes(phrase)) { category = cat; break }
}
const reply = replies[category] ?? replies.other

console.log(JSON.stringify({
  output: { category, reply },
  messages: [
    { role: 'user', content: input.ticket },
    { role: 'assistant', content: reply },
  ],
  usage: { input_tokens: 120 + text.length, output_tokens: 30 },
  model: 'triage-rules-v1',
}))
