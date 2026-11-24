import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useLatest } from './load.ts';

test('useLatest: only the newest request is still current', () => {
  let latest!: () => () => boolean;
  const Probe = () => {
    latest = useLatest();
    return null;
  };
  renderToString(createElement(Probe));
  const first = latest();
  assert.equal(first(), true);
  const second = latest();
  assert.deepEqual([first(), second()], [false, true]);
});
