import '../test/setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../config.ts';
import { parseForumHtml, parseThreadHtml, parseThreadRef } from './xenforo.ts';

loadConfig(0);

const article = (id: number, extra = '', body = `Nội dung ${id}`) => `
<article class="message message--post" data-author="An" data-content="post-${id}">
  <header class="message-attribution">
    <ul class="message-attribution-main"><li><a href="/threads/t.1/post-${id}"><time data-time="1762900000"></time></a></li></ul>
  </header>
  <div class="message-content">
    <div class="message-body"><div class="bbWrapper">${body}</div></div>
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

// A reply quotes post 5: the quote carries post 5's media again.
const quoteOf5 = (inner: string) => `
<blockquote data-quote="An" data-source="post: 5" class="bbCodeBlock bbCodeBlock--expandable bbCodeBlock--quote js-expandWatch">
  <div class="bbCodeBlock-title"><a href="/goto/post?id=5" class="bbCodeBlock-sourceJump">An đã viết:</a></div>
  <div class="bbCodeBlock-content"><div class="bbCodeBlock-expandContent js-expandContent">${inner}</div></div>
</blockquote>`;
const videoFile = (src: string) => `<div class="bbMediaWrapper"><video controls><source src="${src}" /></video></div>`;
const embed = (src: string) => `<span data-s9e-mediaembed="youtube"><iframe allowfullscreen src="${src}"></iframe></span>`;
const lazyEmbed = (src: string) => `<span data-s9e-mediaembed="youtube"><iframe data-s9e-mediaembed-src="${src}"></iframe></span>`;

test('a reply does not count the videos of the post it quotes', () => {
  const own = `${videoFile('https://x.test/v/1.mp4')}${embed('https://www.youtube.com/embed/aaa')}${lazyEmbed('https://www.youtube.com/embed/bbb')}`;
  const html = article(5, '', own) + article(6, '', `${quoteOf5(own)}Hay quá`) + article(7, '', `${quoteOf5(own)}${videoFile('https://x.test/v/2.mp4')}`);
  const r = parseThreadHtml(html, 'http://x.test/threads/t.1/', 1);
  assert.deepEqual(
    r.posts.map((p) => p.videos),
    [
      [
        { url: 'https://x.test/v/1.mp4', kind: 'file' },
        { url: 'https://www.youtube.com/embed/aaa', kind: 'embed' },
        { url: 'https://www.youtube.com/embed/bbb', kind: 'embed' },
      ],
      [],
      [{ url: 'https://x.test/v/2.mp4', kind: 'file' }],
    ],
  );
});

test('a reply does not count the images of the post it quotes', () => {
  const own =
    '<img src="https://x.test/i/1.jpg" class="bbImage" />' +
    '<a href="https://x.test/attachments/2-jpg.2/" class="js-lbImage"><img src="https://x.test/attachments/2-jpg.2/thumb" class="bbImage" /></a>';
  const html = article(5, '', own) + article(6, '', `${quoteOf5(own)}Đẹp`);
  const r = parseThreadHtml(html, 'http://x.test/threads/t.1/', 1);
  assert.deepEqual(
    r.posts.map((p) => p.images),
    [['https://x.test/i/1.jpg', 'https://x.test/attachments/2-jpg.2/thumb', 'https://x.test/attachments/2-jpg.2/'], []],
  );
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

test('parseThreadRef reads /t/ links', () => {
  assert.equal(parseThreadRef('https://rphang.land/t/chao-ae.200791/')?.threadId, 200791);
  assert.equal(parseThreadRef('/t/abc.5/page-2')?.threadId, 5);
});

test('forum list and breadcrumbs accept /box/', () => {
  const list = `<div class="structItem structItem--thread"><div class="structItem-title"><a href="/t/bai-a.77/">Bài A</a></div></div>`;
  assert.equal(parseForumHtml(list, 'https://rphang.land/box/hang.127/').threads[0].id, 77);
  const html = `<div class="p-breadcrumbs"><a href="/box/hang.127/">Hàng</a></div><h1 class="p-title-value">T</h1>${article(5)}`;
  assert.equal(parseThreadHtml(html, 'https://rphang.land/t/a.1/', 1).forumId, 127);
});

test('an empty data-url falls back to src', () => {
  const html = `<h1 class="p-title-value">T</h1>${article(5, '', '<img class="bbImage" data-url="" src="https://rphang.land/attachments/a-jpeg.1/">')}`;
  const r = parseThreadHtml(html, 'https://rphang.land/t/a.1/', 1);
  assert.deepEqual(r.posts[0].images, ['https://rphang.land/attachments/a-jpeg.1/']);
});

test('internal /t/ and /box/ links are not counted as links', () => {
  const html = `<h1 class="p-title-value">T</h1>${article(5, '', '<a href="https://rphang.land/t/khac.9/">x</a>')}`;
  assert.equal(parseThreadHtml(html, 'https://rphang.land/t/a.1/', 1).posts[0].links.length, 0);
});
