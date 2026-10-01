// @ts-check
/** Child-process helper with a timeout that kills the whole process group. */
import { spawn } from 'node:child_process'

/**
 * @typedef {{
 *   code: number | null, signal: NodeJS.Signals | null, stdout: string, stderr: string,
 *   timedOut: boolean, aborted: boolean, spawnError?: string, durationMs: number,
 * }} ProcessResult
 */

/**
 * @param {{
 *   command: string, args?: readonly string[], shell?: boolean, cwd: string,
 *   env?: NodeJS.ProcessEnv, stdin?: string, timeoutMs: number, signal?: AbortSignal,
 *   maxBytes?: number,
 * }} options
 * @returns {Promise<ProcessResult>}
 */
export function runProcess(options) {
  const maxBytes = options.maxBytes ?? 16 * 1024 * 1024
  const started = Date.now()
  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const kill = () => {
      if (child.pid === undefined || child.exitCode !== null) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* already gone */ }
    }
    const timer = setTimeout(() => { timedOut = true; kill() }, options.timeoutMs)
    const onAbort = () => { aborted = true; kill() }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()

    /** @param {Partial<ProcessResult>} extra */
    const finish = (extra) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        code: child.exitCode, signal: child.signalCode, stdout, stderr, timedOut, aborted,
        durationMs: Date.now() - started, ...extra,
      })
    }
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { if (stdout.length < maxBytes) stdout += chunk })
    child.stderr.on('data', chunk => { if (stderr.length < maxBytes) stderr += chunk })
    child.on('error', error => finish({ spawnError: error.message }))
    child.on('close', (code, signal) => finish({ code, signal }))
    child.stdin.on('error', () => { /* child may exit before reading stdin */ })
    child.stdin.end(options.stdin ?? '')
  })
}

/**
 * Run git and return trimmed stdout; throws with stderr on failure.
 * @param {readonly string[]} args @param {string} cwd
 */
export async function git(args, cwd) {
  const result = await runProcess({ command: 'git', args, cwd, timeoutMs: 120_000 })
  if (result.spawnError) throw new Error(`git: ${result.spawnError}`)
  if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim() || result.stdout.trim()}`)
  return result.stdout.trim()
}
