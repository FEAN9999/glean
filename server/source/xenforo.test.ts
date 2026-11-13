import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.ts';
import { parseThreadHtml } from './xenforo.ts';

loadConfig(0);

const article = (id: number, extra = '') => `
<article class="message message--post" data-author="An" data-content="post-${id}">
  <header class="message-attribution">
    <ul class="message-attribution-main"><li><a href="/threads/t.1/post-${id}"><time data-time="1762900000"></time></a></li></ul>
  </header>
  <div class="message-content">
    <div class="message-body"><div class="bbWrapper">Nội dung ${id}</div></div>
    ${extra}
  </div>
</article>`;

test('parseThreadHtml reads the last-edit time', () => {
  const html = `<h1 class="p-title-value">T</h1>${article(5, '<div class="message-lastEdit">Sửa lần cuối: <time data-time="1762990000"></time></div>')}${article(6)}`;
  const r = parseThreadHtml(html, 'http://x.test/threads/t.1/', 1);
  assert.equal(r.posts[0].editedAt, new Date(1762990000 * 1000).toISOString());
  assert.equal(r.posts[1].editedAt, null);
});

test('the last-edit line is not part of the post text', () => {
  const html = article(5, '<div class="message-lastEdit">Sửa lần cuối: <time data-time="1762990000"></time></div>');
  const r = parseThreadHtml(html, 'http://x.test/threads/t.1/', 1);
  assert.equal(r.posts[0].text, 'Nội dung 5');
});
