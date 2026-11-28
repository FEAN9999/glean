import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtDuration, highlight, isLinkLike, parseThreadInput } from './format.ts';

const hits = (text: string, q: string) =>
  highlight(text, q)
    .filter((x) => x.hit)
    .map((x) => x.s);

test('highlight ignores accents and đ, and keeps the text whole', () => {
  assert.deepEqual(hits('Hà Nội mùa thu', 'ha noi'), ['Hà', 'Nội']);
  assert.deepEqual(hits('Đường dài', 'duong'), ['Đường']);
  for (const [text, q] of [['Hà Nội mùa thu', 'ha noi'], ['Đường dài', 'dai']]) {
    assert.equal(
      highlight(text, q)
        .map((x) => x.s)
        .join(''),
      text,
    );
  }
});

test('highlight skips one-letter words', () => {
  assert.deepEqual(highlight('a b c', 'a b'), [{ s: 'a b c', hit: false }]);
});

test('parseThreadInput reads a thread id from an id or a thread link', () => {
  const ok = {
    '12345': 12345,
    ' 12345 ': 12345,
    'https://forum.example.com/threads/ten-bai.12345/': 12345,
    'https://forum.example.com/threads/ten-bai.12345/page-3': 12345,
    'https://forum.example.com/threads/12345/': 12345,
    'https://forum.example.com/threads/ten-bai.12345#post-9': 12345,
  };
  for (const [input, id] of Object.entries(ok)) assert.equal(parseThreadInput(input), id, input);
  for (const input of ['xin chào', 'https://forum.example.com/forums/chuyen-muc.12/', '']) assert.equal(parseThreadInput(input), null, input);
});

test('fmtDuration speaks the app language', () => {
  assert.deepEqual([fmtDuration(null), fmtDuration(0.5), fmtDuration(2.24), fmtDuration(125)], ['—', '500 ms', '2.2 giây', '2 phút 5 giây']);
  const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'en-US' }, configurable: true });
  try {
    assert.deepEqual([fmtDuration(2.24), fmtDuration(125)], ['2.2 s', '2 min 5 s']);
  } finally {
    if (before) Object.defineProperty(globalThis, 'localStorage', before);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('thread input and link detection accept /t/ links', () => {
  assert.equal(parseThreadInput('https://rphang.land/t/a.123/'), 123);
  assert.equal(isLinkLike('rphang.land/t/a.1/'), true);
});
