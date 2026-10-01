// @ts-check
/**
 * On-disk layout. Everything the user should review lives under
 * `<project>/.evals/<name>/`; held-out test cases and their transcripts live
 * outside the workspace under `$DSH_HOME/auto-eval/<projectHash>/<name>/heldout/`.
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { NAME_PATTERN, parseSpec, validateCase } from './spec.js'

/** Resolve dsh's home directory the same way dsh does: `$DSH_HOME`, else `~/.dsh`. */
export function dshHome() {
  const value = process.env.DSH_HOME
  return value !== undefined && value !== '' ? value : join(homedir(), '.dsh')
}

/** @param {string} cwd */
export function projectHash(cwd) {
  let real = cwd
  try { real = realpathSync(cwd) } catch { /* keep the given path */ }
  return createHash('sha256').update(real).digest('hex').slice(0, 12)
}

/** @param {string} name */
export function assertEvalName(name) {
  if (!NAME_PATTERN.test(name)) throw new Error(`invalid eval name "${name}": use lowercase kebab-case`)
}

/**
 * Paths for one eval.
 * @param {string} cwd project root
 * @param {string} name eval name
 * @param {string} [home] dsh home override (tests)
 */
export function evalPaths(cwd, name, home = dshHome()) {
  assertEvalName(name)
  const root = join(cwd, '.evals', name)
  const heldout = join(home, 'auto-eval', projectHash(cwd), name, 'heldout')
  return {
    root,
    spec: join(root, 'eval.yaml'),
    traces: join(root, 'traces'),
    labels: join(root, 'labels'),
    taxonomy: join(root, 'taxonomy.json'),
    cases: join(root, 'cases'),
    allCases: join(root, 'cases', 'all.jsonl'),
    trainCases: join(root, 'cases', 'train.jsonl'),
    graders: join(root, 'graders'),
    runs: join(root, 'runs'),
    hillclimb: join(root, 'hillclimb'),
    hillclimbLog: join(root, 'hillclimb', 'log.jsonl'),
    hillclimbState: join(root, 'hillclimb', 'state.json'),
    heldout,
    testCases: join(heldout, 'test.jsonl'),
    heldoutRuns: join(heldout, 'runs'),
  }
}

/** @typedef {ReturnType<typeof evalPaths>} EvalPaths */

/** @param {string} path */
export async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

/** @param {string} path */
export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

/** @param {string} path @param {unknown} value */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, undefined, 2)}\n`)
  await rename(tmp, path)
}

/**
 * Read a JSONL file; a missing file reads as empty. Malformed lines throw with
 * their line number so a hand-edited file fails loudly.
 * @param {string} path
 * @returns {Promise<any[]>}
 */
export async function readJsonl(path) {
  let text
  try { text = await readFile(path, 'utf8') } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') return []
    throw error
  }
  const out = []
  for (const [index, line] of text.split('\n').entries()) {
    if (line.trim() === '') continue
    try { out.push(JSON.parse(line)) } catch {
      throw new Error(`${path}:${index + 1}: invalid JSON line`)
    }
  }
  return out
}

/** @param {string} path @param {readonly unknown[]} rows */
export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length > 0 ? '\n' : ''))
  await rename(tmp, path)
}

/** @param {string} path @param {unknown} row */
export async function appendJsonl(path, row) {
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${JSON.stringify(row)}\n`)
}

/**
 * Load and validate an eval's spec.
 * @param {EvalPaths} paths
 */
export async function loadSpec(paths) {
  let text
  try { text = await readFile(paths.spec, 'utf8') } catch {
    throw new Error(`no eval at ${paths.root} (missing eval.yaml); run eval_init first`)
  }
  const { spec, errors } = parseSpec(text)
  if (spec === undefined) throw new Error(`invalid ${paths.spec}:\n- ${errors.join('\n- ')}`)
  return spec
}

/**
 * Load cases from a JSONL file, validating each record.
 * @param {string} path
 * @returns {Promise<import('./spec.js').EvalCase[]>}
 */
export async function loadCases(path) {
  const rows = await readJsonl(path)
  const ids = new Set()
  return rows.map((row, index) => {
    const { case: value, error } = validateCase(row, index + 1)
    if (value === undefined) throw new Error(`${path}: ${error}`)
    if (ids.has(value.id)) throw new Error(`${path}: duplicate case id "${value.id}"`)
    ids.add(value.id)
    return value
  })
}

/**
 * List eval names under a project.
 * @param {string} cwd
 */
export async function listEvals(cwd) {
  let entries
  try { entries = await readdir(join(cwd, '.evals'), { withFileTypes: true }) } catch { return [] }
  const names = []
  for (const entry of entries) {
    if (entry.isDirectory() && NAME_PATTERN.test(entry.name) && await exists(join(cwd, '.evals', entry.name, 'eval.yaml'))) {
      names.push(entry.name)
    }
  }
  return names.sort()
}

/** A sortable, filesystem-safe run id. */
export function newRunId(prefix = 'run') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 6)}`
}
