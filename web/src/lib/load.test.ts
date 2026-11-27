import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { singleFlight, useLatest } from './load.ts';

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

// Review finding: "Sàng lại tất cả" sends one NewScrape per job, and each one reloaded the whole queue.
test('singleFlight: calls during a run share one trailing run, however many there are', async () => {
  const runs: (() => void)[] = [];
  const load = singleFlight(() => new Promise<void>((done) => runs.push(done)));
  load();
  for (let i = 0; i < 100; i++) load();
  assert.equal(runs.length, 1);
  runs[0]();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs.length, 2);
  runs[1]();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(runs.length, 2);
  load();
  assert.equal(runs.length, 3);
});

test('singleFlight: a failed run still lets the next call run', async () => {
  let n = 0;
  const load = singleFlight(() => {
    n++;
    return Promise.reject(new Error('down'));
  });
  load();
  await new Promise((r) => setTimeout(r, 0));
  load();
  assert.equal(n, 2);
});
