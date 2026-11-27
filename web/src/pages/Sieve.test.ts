import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withIds } from './Sieve.tsx';

test('withIds adds or removes ids without touching the set it was given', () => {
  const picked = new Set([1, 2]);
  assert.deepEqual([...withIds(picked, [3, 2], true)].sort(), [1, 2, 3]);
  assert.deepEqual([...withIds(picked, [2, 9], false)], [1]);
  assert.deepEqual([...picked], [1, 2]);
});
