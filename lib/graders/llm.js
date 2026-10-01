// @ts-check
/**
 * LLM judge graders: `graders/<mode>.judge.md` is the rubric, shown to the
 * user verbatim and sent verbatim as the judge's system prompt. Calls go
 * through dsh's `ctx.llm.stream`, never into a session log.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildJudgeRequest, collectStream, parseJudgement } from '../core/judge.js'

/**
 * @typedef {{ stream(options: any): AsyncIterable<any> }} LlmService
 * @typedef {{ provider: string, model: string, reasoningEffort?: string }} ModelSelection
 * @typedef {{ pass: boolean, critique: string, usage?: import('../core/judge.js').TokenUsage }} Judgement
 * @typedef {(request: {
 *   mode: string, rubric: string, input: unknown, output: unknown, expected?: unknown,
 *   trace?: string, fewshot?: readonly import('../core/judge.js').FewShot[], signal?: AbortSignal,
 * }) => Promise<Judgement>} Judge
 */

/** Strip YAML frontmatter, if any, from a rubric file. @param {string} text */
export function rubricBody(text) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return match ? text.slice(match[0].length) : text
}

/** @param {string} evalRoot @param {string} file */
export async function readRubric(evalRoot, file) {
  return rubricBody(await readFile(resolve(evalRoot, file), 'utf8'))
}

/**
 * @param {{ llm: LlmService, selection: ModelSelection, maxTokens: number, retries?: number }} options
 * @returns {Judge}
 */
export function createJudge({ llm, selection, maxTokens, retries = 1 }) {
  return async request => {
    const { system, user } = buildJudgeRequest(request)
    /** @type {unknown} */
    let lastError
    for (let attempt = 0; attempt <= retries; attempt++) {
      const reply = await collectStream(llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {},
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        temperature: 0,
        maxTokens,
        ...request.signal ? { signal: request.signal } : {},
      }))
      try {
        return { ...parseJudgement(reply.text), ...reply.usage ? { usage: reply.usage } : {} }
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
}
