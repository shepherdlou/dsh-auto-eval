#!/usr/bin/env node
// dsh-auto-eval CLI: the review UI and status outside a dsh process.
// A headless or one-shot dsh run exits after its turn, taking the review
// server it started with it; this keeps the UI up for as long as you need.
//
//   dsh-auto-eval review <name> [--cwd <project>] [--port <n>]
//   dsh-auto-eval status [--cwd <project>]
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { evalPaths, exists } from '../lib/core/store.js'
import { startReviewServer } from '../lib/review/server.js'
import { statusText } from '../lib/status.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { cwd: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
})
const [command, name] = positionals
const cwd = resolve(values.cwd ?? process.cwd())
const usage = 'usage: dsh-auto-eval review <name> [--cwd dir] [--port n]\n       dsh-auto-eval status [--cwd dir]'

if (values.help || command === undefined) {
  console.log(usage)
  process.exit(command === undefined && !values.help ? 1 : 0)
}
if (command === 'status') {
  console.log(await statusText(cwd))
} else if (command === 'review') {
  if (!name) { console.error(usage); process.exit(1) }
  const paths = evalPaths(cwd, name)
  if (!await exists(paths.root)) { console.error(`no eval "${name}" under ${cwd}/.evals`); process.exit(1) }
  const server = await startReviewServer({ paths, port: values.port ? Number(values.port) : 0 })
  console.log(`Review UI for "${name}": ${server.url}`)
  console.log('Labels are saved as you go. Press Ctrl-C to stop.')
  const stop = async () => { await server.close(); process.exit(0) }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
} else {
  console.error(`unknown command "${command}"\n${usage}`)
  process.exit(1)
}
