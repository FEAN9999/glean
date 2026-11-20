import './test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.ts';
import { fetchPage } from './net.ts';

loadConfig(0);

test('fetchPage retries when the body stalls past the timeout', async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html' });
    if (hits === 1) {
      res.write('<html>'); // headers and a first chunk arrive, then the rest never does
      return;
    }
    res.end('<html>ok</html>');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const page = await fetchPage(url, { timeoutMs: 300, retries: 2 });
    assert.equal(page.text, '<html>ok</html>');
    assert.equal(page.status, 200);
    assert.equal(hits, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
