// Failure mode "tests-still-fail": after the agent finishes, the project's tests fail.
// Runs in the run's own worktree (isolation: worktree), so it sees the agent's edits.
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export default function check({ workdir, case: c }) {
  const dir = join(workdir, c.fixture?.into ?? '.')
  const result = spawnSync('node', ['--test'], { cwd: dir, encoding: 'utf8', timeout: 60_000 })
  return { pass: result.status === 0, reason: result.status === 0 ? 'tests pass' : result.stdout.slice(-400) }
}
