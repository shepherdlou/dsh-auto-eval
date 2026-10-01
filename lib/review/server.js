// @ts-check
/**
 * Local review server: the annotation UI for traces, failure-mode taxonomy,
 * eval inputs, grader labels and run results. It binds 127.0.0.1 only,
 * requires a random token on every request, and never serves anything from
 * the held-out store.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadSpec, readJson, readJsonl } from '../core/store.js'
import { readRubric } from '../graders/llm.js'
import {
  RUN_ID_PATTERN, appendJsonl, codingNotes, labelFiles, latestLabels, loadTaxonomy, loadTraces,
  reviewStatus, saveTaxonomy,
} from './data.js'
import { listRuns } from './runs.js'

const APP_PATH = fileURLToPath(new URL('./app.html', import.meta.url))
const MAX_BODY = 1024 * 1024

/**
 * @typedef {{ url: string, port: number, token: string, close(): Promise<void> }} ReviewServer
 */

class HttpError extends Error {
  /** @param {number} status @param {string} message */
  constructor(status, message) { super(message); this.status = status }
}

/** @param {import('node:http').IncomingMessage} req */
async function readBody(req) {
  let size = 0
  /** @type {Buffer[]} */
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new HttpError(413, 'body too large')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') } catch { throw new HttpError(400, 'invalid JSON body') }
}

/** @param {string} a @param {string} b */
function tokenMatches(a, b) {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

/** @param {unknown} value @param {string} field */
function requireString(value, field) {
  if (typeof value !== 'string' || value === '') throw new HttpError(400, `${field} is required`)
  return value
}

/**
 * @param {{ paths: import('../core/store.js').EvalPaths, port?: number, token?: string }} options
 * @returns {Promise<ReviewServer>}
 */
export async function startReviewServer({ paths, port = 0, token = randomBytes(18).toString('base64url') }) {
  const files = labelFiles(paths)

  /** @param {string} runId */
  const runDir = runId => {
    if (!RUN_ID_PATTERN.test(runId)) throw new HttpError(400, 'bad run id')
    return join(paths.runs, runId)
  }

  /** @param {string} mode */
  const graderMode = async mode => {
    const spec = await loadSpec(paths)
    const grader = spec.graders.find(g => g.mode === mode)
    if (!grader) throw new HttpError(404, `no grader for mode "${mode}"`)
    return grader
  }

  /** @type {Record<string, (url: URL, req: import('node:http').IncomingMessage) => Promise<unknown>>} */
  const routes = {
    'GET /api/meta': async () => {
      /** @type {any} */
      let spec = null
      try { spec = await loadSpec(paths) } catch { /* the eval may not have a valid spec yet */ }
      return {
        evalName: spec?.name ?? paths.root.split(sep).at(-1),
        graders: spec?.graders ?? [],
        runs: await listRuns(paths),
        status: await reviewStatus(paths),
      }
    },

    'GET /api/traces': async () => {
      const traces = await loadTraces(paths)
      /** @type {Map<string, any>} */
      const labels = await latestLabels(files.traces)
      const taxonomy = await loadTaxonomy(paths)
      return traces.map(trace => ({
        id: trace.id,
        input: trace.input.slice(0, 160),
        model: trace.model,
        createdAt: trace.createdAt,
        toolCalls: trace.toolCalls,
        toolErrors: trace.toolErrors,
        endReason: trace.endReason,
        flagged: trace.feedback.some(f => f.rating === 'negative'),
        label: labels.get(trace.id) ?? null,
        modes: taxonomy.modes.filter(m => m.traceIds.includes(trace.id)).map(m => m.id),
      }))
    },

    'GET /api/trace': async url => {
      const id = requireString(url.searchParams.get('id'), 'id')
      const trace = (await loadTraces(paths)).find(t => t.id === id)
      if (!trace) throw new HttpError(404, 'no such trace')
      /** @type {Map<string, any>} */
      const labels = await latestLabels(files.traces)
      return { trace, label: labels.get(id) ?? null }
    },

    'POST /api/trace-label': async (_url, req) => {
      const body = await readBody(req)
      const id = requireString(body.id, 'id')
      const pass = body.pass === true ? true : body.pass === false ? false : null
      const label = { id, pass, note: typeof body.note === 'string' ? body.note : '', at: new Date().toISOString() }
      await appendJsonl(files.traces, label)
      return label
    },

    'GET /api/taxonomy': async () => ({ taxonomy: await loadTaxonomy(paths), notes: await codingNotes(paths) }),

    'PUT /api/taxonomy': async (_url, req) => {
      try { return await saveTaxonomy(paths, await readBody(req)) } catch (error) {
        if (error instanceof HttpError) throw error
        throw new HttpError(400, error instanceof Error ? error.message : String(error))
      }
    },

    'GET /api/cases': async () => {
      /** @type {Map<string, any>} */
      const labels = await latestLabels(files.cases)
      const inbox = await readJsonl(paths.inboxCases)
      const train = await readJsonl(paths.trainCases)
      return [
        ...inbox.map(c => ({ ...c, pool: 'inbox', label: labels.get(c.id) ?? null })),
        ...train.map(c => ({ ...c, pool: 'train', label: labels.get(c.id) ?? null })),
      ]
    },

    'POST /api/case-label': async (_url, req) => {
      const body = await readBody(req)
      const status = body.status === 'approved' || body.status === 'rejected' ? body.status : 'unreviewed'
      const label = {
        id: requireString(body.id, 'id'),
        status,
        note: typeof body.note === 'string' ? body.note : '',
        ...Array.isArray(body.tags) ? { tags: body.tags.filter((/** @type {unknown} */ t) => typeof t === 'string' && t !== '') } : {},
        at: new Date().toISOString(),
      }
      await appendJsonl(files.cases, label)
      return label
    },

    'POST /api/case-label-bulk': async (_url, req) => {
      const body = await readBody(req)
      const status = body.status === 'approved' || body.status === 'rejected' ? body.status : undefined
      if (!status || !Array.isArray(body.ids)) throw new HttpError(400, 'ids and status are required')
      const at = new Date().toISOString()
      /** @type {Map<string, any>} */
      const labels = await latestLabels(files.cases)
      let count = 0
      for (const id of body.ids) {
        if (typeof id !== 'string' || id === '') continue
        const previous = labels.get(id)
        await appendJsonl(files.cases, { id, status, note: previous?.note ?? '', ...previous?.tags ? { tags: previous.tags } : {}, at })
        count++
      }
      return { count }
    },

    'GET /api/grader-items': async url => {
      const mode = requireString(url.searchParams.get('mode'), 'mode')
      const runId = requireString(url.searchParams.get('run'), 'run')
      const grader = await graderMode(mode)
      const rows = await readJsonl(join(runDir(runId), 'results.jsonl'))
      /** @type {Map<string, any>} */
      const labels = await latestLabels(files.grader(mode))
      return {
        grader,
        rubric: await readRubric(paths.root, grader.file).catch(() => ''),
        items: rows
          .filter(row => row.grades?.[mode] !== undefined && 'pass' in row.grades[mode])
          .map(row => {
            const id = `${row.caseId}#${row.rep}@${runId}`
            return { id, caseId: row.caseId, rep: row.rep, labeled: labels.has(id) }
          }),
      }
    },

    'GET /api/grader-item': async url => {
      const mode = requireString(url.searchParams.get('mode'), 'mode')
      const runId = requireString(url.searchParams.get('run'), 'run')
      const id = requireString(url.searchParams.get('id'), 'id')
      const rows = await readJsonl(join(runDir(runId), 'results.jsonl'))
      const row = rows.find(r => `${r.caseId}#${r.rep}@${runId}` === id)
      if (!row) throw new HttpError(404, 'no such item')
      const transcript = await readJson(join(runDir(runId), row.transcript))
      /** @type {Map<string, any>} */
      const labels = await latestLabels(files.grader(mode))
      const label = labels.get(id) ?? null
      // Blind labeling: the judge's verdict is revealed only after a human label exists.
      return {
        id, caseId: row.caseId, rep: row.rep,
        input: transcript.input, expected: transcript.expected, output: transcript.output, trace: transcript.trace,
        label,
        grader: label ? transcript.grades?.[mode] ?? null : null,
      }
    },

    'POST /api/grader-label': async (_url, req) => {
      const body = await readBody(req)
      const mode = requireString(body.mode, 'mode')
      await graderMode(mode)
      const id = requireString(body.id, 'id')
      const match = /^(.*)#(\d+)@(.+)$/.exec(id)
      if (!match || typeof body.pass !== 'boolean') throw new HttpError(400, 'id and pass are required')
      const label = {
        id, runId: match[3], caseId: match[1], rep: Number(match[2]), pass: body.pass,
        note: typeof body.note === 'string' ? body.note : '', at: new Date().toISOString(),
      }
      await appendJsonl(files.grader(mode), label)
      return label
    },

    'GET /api/run': async url => {
      const runId = requireString(url.searchParams.get('run'), 'run')
      const dir = runDir(runId)
      return { summary: await readJson(join(dir, 'summary.json')), rows: await readJsonl(join(dir, 'results.jsonl')) }
    },

    'GET /api/transcript': async url => {
      const dir = runDir(requireString(url.searchParams.get('run'), 'run'))
      const file = resolve(dir, requireString(url.searchParams.get('file'), 'file'))
      const rel = relative(dir, file)
      if (rel.startsWith('..') || rel.split(sep).includes('..')) throw new HttpError(400, 'bad path')
      return readJson(file)
    },

    'POST /api/dispute': async (_url, req) => {
      const body = await readBody(req)
      const runId = requireString(body.run, 'run')
      const caseId = requireString(body.caseId, 'caseId')
      const mode = requireString(body.mode, 'mode')
      const dispute = {
        id: `${caseId}#${body.rep}@${runId}:${mode}`, runId, caseId, rep: Number(body.rep), mode,
        graderPass: body.graderPass === true, humanPass: body.graderPass !== true,
        note: typeof body.note === 'string' ? body.note : '', withdrawn: body.withdrawn === true,
        at: new Date().toISOString(),
      }
      await appendJsonl(files.disputes, dispute)
      return dispute
    },

    'GET /api/disputes': async () => [...(await latestLabels(files.disputes)).values()],
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    /** @param {number} status @param {unknown} body @param {string} [type] */
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, {
        'content-type': type,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      res.end(type.startsWith('application/json') ? JSON.stringify(body) : body)
    }
    if (url.pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }
    try {
      const given = url.searchParams.get('token') ?? req.headers['x-review-token']
      if (typeof given !== 'string' || !tokenMatches(given, token)) throw new HttpError(401, 'missing or wrong token')
      if (req.method === 'GET' && url.pathname === '/') {
        send(200, await readFile(APP_PATH, 'utf8'), 'text/html; charset=utf-8')
        return
      }
      const handler = routes[`${req.method} ${url.pathname}`]
      if (!handler) throw new HttpError(404, 'not found')
      send(200, await handler(url, req))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      send(status, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolvePromise(undefined))
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    url: `http://127.0.0.1:${actualPort}/?token=${token}`,
    port: actualPort,
    token,
    close: () => new Promise(resolvePromise => {
      server.closeAllConnections?.()
      server.close(() => resolvePromise(undefined))
    }),
  }
}
