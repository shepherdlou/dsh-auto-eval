import assert from 'node:assert/strict'
import { test } from 'node:test'
import { range } from './range.js'

test('range is inclusive', () => {
  assert.deepEqual(range(1, 3), [1, 2, 3])
  assert.deepEqual(range(5, 5), [5])
})
