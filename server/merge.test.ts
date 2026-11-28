import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeTop } from './merge.ts';

test('mergeTop merges sorted lists and cuts the window', () => {
  assert.deepEqual(
    mergeTop([[9, 5, 1], [8, 2]], (a, b) => b - a, 1, 3),
    [8, 5, 2],
  );
});
