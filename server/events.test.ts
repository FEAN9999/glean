import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyReply } from 'fastify';
import { loadConfig } from './config.ts';
import { setTestFallback } from './db.ts';
import { addSite, withSite } from './site.ts';
import { addClient, emit, Ev, removeClient } from './events.ts';

loadConfig(0);
addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' });

test('events carry the site code', () => {
  const got: string[] = [];
  const id = addClient({ raw: { write: (s: string) => got.push(s) } } as unknown as FastifyReply, ['*']);
  try {
    withSite('rphang', () => emit(Ev.NewScrape, {}));
    assert.match(got[0], /"site":"rphang"/);
    // Outside a request there is no site; the test fallback (the main site) is switched off for this.
    const prev = setTestFallback(null);
    try {
      emit(Ev.NewScrape, {});
    } finally {
      setTestFallback(prev);
    }
    assert.match(got[1], /"site":null/);
  } finally {
    removeClient(id);
  }
});
