import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.ts';
import { parseForumHtml, parseThreadHtml } from './xenforo.ts';

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

const reactions = (inner: string) => `<div class="reactionsBar js-reactionsList is-active"><a class="reactionsBar-link" href="/posts/1/reactions">${inner}</a></div>`;

test('parseThreadHtml counts reactions: named users plus "others"', () => {
  const html = `<h1 class="p-title-value">T</h1>${article(5, reactions('<bdi>An</bdi>, <bdi>Bình</bdi> và 12 người khác'))}${article(6, reactions('<bdi>An</bdi>'))}${article(7)}`;
  const r = parseThreadHtml(html, 'http://x.test/threads/t.1/', 1);
  assert.deepEqual(
    r.posts.map((p) => p.likes),
    [14, 1, 0],
  );
});

test('reaction "others" counts with thousands separators and in English', () => {
  const html = `${article(5, reactions('<bdi>An</bdi> và 1.234 người khác'))}${article(6, reactions('<bdi>An</bdi> and 3 others'))}`;
  const r = parseThreadHtml(html, 'http://x.test/threads/t.1/', 1);
  assert.deepEqual(
    r.posts.map((p) => p.likes),
    [1235, 4],
  );
});

const listItem = (id: number, meta: string) => `
<div class="structItem structItem--thread" data-author="An">
  <div class="structItem-cell structItem-cell--main">
    <div class="structItem-title"><a href="/threads/t.${id}/">Chủ đề ${id}</a></div>
    <div class="structItem-minor"><ul class="structItem-parts"><li class="structItem-startDate"><a><time data-time="1762900000"></time></a></li></ul></div>
  </div>
  <div class="structItem-cell structItem-cell--meta">${meta}</div>
</div>`;

test('parseForumHtml reads views from the second meta pair', () => {
  const html =
    listItem(1, '<dl class="pairs pairs--justified"><dt>Trả lời</dt><dd>5</dd></dl><dl class="pairs pairs--justified structItem-minor"><dt>Lượt xem</dt><dd>1,2K</dd></dl>') +
    listItem(2, '<dl class="pairs pairs--justified"><dt>Trả lời</dt><dd>7</dd></dl>');
  const r = parseForumHtml(html, 'http://x.test/forums/f.1/');
  assert.deepEqual(
    r.threads.map((t) => [t.id, t.replies, t.views]),
    [
      [1, 5, 1200],
      [2, 7, 0],
    ],
  );
});
