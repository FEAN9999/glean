import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectRealtime, disconnectRealtime } from './realtime.ts';

/** Stands in for the browser's EventSource: records each stream opened. */
class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeEventSource.made.push(this);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
// Renewing the browser cookie posts to the server: answer it here.
globalThis.fetch = async () => new Response(JSON.stringify({ success: true, data: true }), { headers: { 'content-type': 'application/json' } });

const settle = () => new Promise((r) => setImmediate(r));
const latest = () => FakeEventSource.made.at(-1)!;

test('a stream the server refused is opened again after a pause; one the browser is retrying is left alone', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeEventSource.made = [];
  connectRealtime();
  assert.equal(FakeEventSource.made.length, 1);

  // dropped connection: the browser reconnects by itself
  latest().onerror!();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(FakeEventSource.made.length, 1);

  // refused (e.g. an expired cookie): closed for good unless we open a new one
  latest().readyState = FakeEventSource.CLOSED;
  latest().onerror!();
  t.mock.timers.tick(3000);
  await settle();
  assert.equal(FakeEventSource.made.length, 2);
  disconnectRealtime();
});

test('after logging out, a pending reconnect does nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  FakeEventSource.made = [];
  connectRealtime();
  latest().readyState = FakeEventSource.CLOSED;
  latest().onerror!();
  disconnectRealtime();
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(FakeEventSource.made.length, 1);
});
