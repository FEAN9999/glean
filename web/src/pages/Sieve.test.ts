import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupPicks, pickKey, withIds } from './Sieve.tsx';

test('withIds adds or removes ids without touching the set it was given', () => {
  const picked = new Set([1, 2]);
  assert.deepEqual([...withIds(picked, [3, 2], true)].sort(), [1, 2, 3]);
  assert.deepEqual([...withIds(picked, [2, 9], false)], [1]);
  assert.deepEqual([...picked], [1, 2]);
});

test('pickKey names a row by its site and id, since job ids repeat across sites', () => {
  assert.equal(pickKey({ id: 1, site: { code: 'rphang' } }), 'rphang:1');
});

test('groupPicks splits the chosen rows by site, each with its ids in the order chosen', () => {
  assert.deepEqual(groupPicks(['demo:1', 'rphang:1', 'demo:7']), { demo: [1, 7], rphang: [1] });
});
