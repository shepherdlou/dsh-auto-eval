// @ts-check
/**
 * Git worktrees isolate candidates and runs. A hillclimb edits one branch
 * worktree; each (case, repeat) can run in its own throwaway detached worktree
 * so state left by one run never leaks into the next.
 */
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { git } from './process.js'

/** @param {string} cwd */
export async function repoRoot(cwd) {
  try { return await git(['rev-parse', '--show-toplevel'], cwd) } catch { return undefined }
}

/** @param {string} cwd @param {string} [ref] */
export async function revParse(cwd, ref = 'HEAD') {
  return git(['rev-parse', '--verify', `${ref}^{commit}`], cwd)
}

/**
 * A commit capturing the current working tree (tracked files, staged or not)
 * without touching the index, the stash list, or the files: `git stash create`.
 * Falls back to HEAD when the tree is clean. Untracked files are not included.
 * @param {string} cwd
 */
export async function snapshotRef(cwd) {
  const stash = await git([
    '-c', 'user.name=dsh-auto-eval', '-c', 'user.email=dsh-auto-eval@localhost',
    'stash', 'create', 'dsh-auto-eval snapshot',
  ], cwd)
  return stash !== '' ? stash : revParse(cwd)
}

/** Untracked, non-ignored files that a snapshot would miss. @param {string} cwd */
export async function untrackedFiles(cwd) {
  const out = await git(['ls-files', '--others', '--exclude-standard'], cwd)
  return out === '' ? [] : out.split('\n')
}

/** Fresh temp directory under the OS temp root. @param {string} label */
export async function tempDir(label) {
  const base = join(tmpdir(), 'dsh-auto-eval')
  await mkdir(base, { recursive: true })
  return mkdtemp(join(base, `${label.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 60)}-`))
}

/**
 * @param {string} repo @param {string} ref @param {string} label
 * @returns {Promise<string>} the worktree directory
 */
export async function addDetachedWorktree(repo, ref, label) {
  const dir = await tempDir(label)
  await rm(dir, { recursive: true, force: true })
  await git(['worktree', 'add', '--detach', '--quiet', dir, ref], repo)
  return dir
}

/** @param {string} repo @param {string} dir */
export async function removeWorktree(repo, dir) {
  try {
    await git(['worktree', 'remove', '--force', dir], repo)
  } catch {
    await rm(dir, { recursive: true, force: true })
    await git(['worktree', 'prune'], repo).catch(() => {})
  }
}

/**
 * Create a branch worktree for a hillclimb.
 * @param {string} repo @param {string} branch @param {string} ref @param {string} dir
 */
export async function addBranchWorktree(repo, branch, ref, dir) {
  await git(['worktree', 'add', '--quiet', '-b', branch, dir, ref], repo)
  return dir
}

/**
 * Commit every change in a worktree. Returns the new commit, or undefined when
 * there was nothing to commit.
 * @param {string} dir @param {string} message
 */
export async function commitAll(dir, message) {
  await git(['add', '-A'], dir)
  const staged = await git(['diff', '--cached', '--name-only'], dir)
  if (staged === '') return undefined
  await git([
    '-c', 'user.name=dsh-auto-eval', '-c', 'user.email=dsh-auto-eval@localhost',
    'commit', '--quiet', '--no-verify', '-m', message,
  ], dir)
  return revParse(dir)
}

/** Discard all changes in a worktree and move it to `ref`. @param {string} dir @param {string} ref */
export async function resetTo(dir, ref) {
  await git(['reset', '--hard', '--quiet', ref], dir)
  await git(['clean', '-fdq'], dir)
}

/**
 * Paths changed in a worktree relative to `ref`, including uncommitted and
 * untracked files.
 * @param {string} dir @param {string} ref
 */
export async function changedPaths(dir, ref) {
  const tracked = await git(['diff', '--name-only', ref], dir)
  const untracked = await git(['ls-files', '--others', '--exclude-standard'], dir)
  return [...new Set([...tracked.split('\n'), ...untracked.split('\n')].filter(Boolean))].sort()
}

/** @param {string} dir @param {string} ref */
export async function diffStat(dir, ref) {
  const stat = await git(['diff', '--stat', ref], dir)
  const untracked = await untrackedFiles(dir)
  return [stat, ...untracked.map(path => ` ${path} (new file)`)].filter(Boolean).join('\n')
}

/** Full patch text of a worktree against `ref`, untracked files listed by name. @param {string} dir @param {string} ref */
export async function diffText(dir, ref) {
  const patch = await git(['diff', ref], dir)
  const untracked = await untrackedFiles(dir)
  return [patch, ...untracked.map(path => `+++ new file: ${path}`)].filter(Boolean).join('\n')
}

/**
 * Copy a case fixture into a run workdir.
 * @param {string} evalRoot @param {{ dir: string, into?: string }} fixture @param {string} workdir
 */
export async function copyFixture(evalRoot, fixture, workdir) {
  const source = resolve(evalRoot, fixture.dir)
  const target = resolve(workdir, fixture.into ?? '.')
  for (const [base, path] of /** @type {const} */ ([[evalRoot, source], [workdir, target]])) {
    const rel = relative(base, path)
    if (rel.startsWith('..') || rel.split(sep).includes('..')) throw new Error(`fixture path escapes its root: ${path}`)
  }
  await cp(source, target, { recursive: true, force: true })
}
