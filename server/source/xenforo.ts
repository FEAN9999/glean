import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { cfg } from '../config.ts';
import { fetchRaw, HttpError } from '../net.ts';

/** Adapter for XenForo-2-style forums: forum listing pages and thread pages. */

export interface ListedThread {
  id: number;
  title: string;
  author: string;
  createdAt: string;
  lastPostAt: string | null;
  replies: number;
  url: string;
}

export interface ParsedPost {
  postId: number;
  postNo: number;
  author: string;
  createdAt: string;
  text: string;
  url: string;
  images: string[];
  videos: { url: string; kind: 'file' | 'embed' }[];
  links: { url: string; text: string }[];
}

export interface ParsedThreadPage {
  title: string;
  forumId: number | null;
  totalPages: number;
  posts: ParsedPost[];
}

const base = () => cfg().source.baseUrl.replace(/\/+$/, '');

export const forumUrl = (forumId: number, page = 1) => `${base()}/forums/${forumId}/${page > 1 ? `page-${page}` : ''}`;
export const threadUrl = (threadId: number, page = 1) => `${base()}/threads/${threadId}/${page > 1 ? `page-${page}` : ''}`;

export interface ThreadRef {
  threadId: number;
  /** Host of the pasted link when it differs from the configured source. */
  foreignHost: string | null;
  /** True if the foreign host is one of the source's previous domains. */
  knownOldDomain: boolean;
}

/** Accepts a thread ID, or any link containing /threads/<slug>.<id> or /threads/<id>. */
export function parseThreadRef(input: string): ThreadRef | null {
  const s = input.trim();
  if (/^\d+$/.test(s)) return { threadId: Number(s), foreignHost: null, knownOldDomain: false };
  const m = s.match(/\/threads\/(?:[^/?#]*\.)?(\d+)(?:[/?#]|$)/);
  if (!m) return null;
  let foreignHost: string | null = null;
  let knownOldDomain = false;
  try {
    const host = new URL(s.startsWith('http') ? s : `https://${s}`).host;
    const srcHost = new URL(base()).host;
    if (host !== srcHost) {
      foreignHost = host;
      knownOldDomain = cfg().source.previousBaseUrls.some((u) => {
        try {
          return new URL(u).host === host;
        } catch {
          return false;
        }
      });
    }
  } catch {
    /* relative link */
  }
  return { threadId: Number(m[1]), foreignHost, knownOldDomain };
}

function abs(u: string | undefined, pageUrl: string) {
  if (!u || u.startsWith('data:') || u.startsWith('javascript:')) return null;
  try {
    return new URL(u, pageUrl).toString();
  } catch {
    return null;
  }
}

function maxPage($: cheerio.CheerioAPI) {
  let max = 1;
  $('.pageNav-main a, .pageNav-page a, .pageNavSimple-el').each((_, el) => {
    const n = Number($(el).text().trim());
    if (Number.isFinite(n) && n > max) max = n;
  });
  return max;
}

function timeOf($: cheerio.CheerioAPI, el: cheerio.Cheerio<AnyNode>) {
  const t = el.find('time').first();
  const unix = Number(t.attr('data-time'));
  if (unix) return new Date(unix * 1000).toISOString();
  const dt = t.attr('datetime');
  return dt ? new Date(dt).toISOString() : null;
}

/** "1,234" / "1.234" → 1234; abbreviated "1.2K" / "1,2K" (either decimal mark) → 1200. */
export function parseCount(s: string) {
  const t = s.trim().toUpperCase().replace(/\s+/g, '');
  const abbr = t.match(/^(\d+)(?:[.,](\d+))?([KM])$/);
  if (abbr) {
    const n = Number(`${abbr[1]}.${abbr[2] ?? '0'}`);
    return Math.round(n * (abbr[3] === 'K' ? 1000 : 1_000_000));
  }
  return Number(t.replace(/\D/g, '')) || 0;
}

export interface ForumNode {
  id: number;
  name: string;
  /** Category (or parent forum) the node is listed under. */
  group: string | null;
  depth: number;
}

/** Reads the forum index and returns every forum node (categories and link-forums excluded). */
export async function fetchForumIndex(baseUrl = base()): Promise<ForumNode[]> {
  const url = `${baseUrl.replace(/\/+$/, '')}/`;
  const res = await fetchRaw(url);
  if (!res.ok) throw new HttpError(res.status, url);
  const $ = cheerio.load(await res.text());
  const out = new Map<number, ForumNode>();
  const add = (href: string | undefined, name: string, group: string | null, depth: number) => {
    const m = href?.match(/\/forums\/(?:[^/]*\.)?(\d+)\/?/);
    if (!m || !name.trim()) return;
    const id = Number(m[1]);
    if (!out.has(id)) out.set(id, { id, name: name.trim(), group, depth });
  };
  // XenForo 2 node list: category blocks contain .node--forum items; sub-forums show as .subNodeLink.
  $('.block--category').each((_, cat) => {
    const group = $(cat).find('.block-header a, .block-header').first().text().trim() || null;
    $(cat)
      .find('.node--forum')
      .each((__, node) => {
        const a = $(node).find('.node-title a').first();
        add(a.attr('href'), a.text(), group, 0);
        $(node)
          .find('a.subNodeLink--forum, .node-subNodeFlatList a[href*="/forums/"]')
          .each((___, sub) => add($(sub).attr('href'), $(sub).text(), a.text().trim(), 1));
      });
  });
  // Fallback for skins without category blocks.
  if (!out.size) $('.node-title a[href*="/forums/"]').each((_, a) => add($(a).attr('href'), $(a).text(), null, 0));
  return [...out.values()];
}

export class ThreadGoneError extends Error {
  constructor(public threadId: number, public status: number) {
    super(`Thread ${threadId} unavailable (HTTP ${status})`);
  }
}

export async function fetchForumPage(forumId: number, page: number) {
  const url = forumUrl(forumId, page);
  const res = await fetchRaw(url);
  if (!res.ok) throw new HttpError(res.status, url);
  const html = await res.text();
  const $ = cheerio.load(html);
  const threads: ListedThread[] = [];
  $('.structItem--thread').each((_, el) => {
    const item = $(el);
    const a = item.find('.structItem-title a[href*="/threads/"]').last();
    const href = abs(a.attr('href'), url);
    const ref = href ? parseThreadRef(href) : null;
    if (!ref) return;
    const metaDd = item.find('.structItem-cell--meta dl').first().find('dd').first().text();
    threads.push({
      id: ref.threadId,
      title: a.text().trim(),
      author: (item.attr('data-author') ?? item.find('.username').first().text()).trim(),
      createdAt: timeOf($, item.find('.structItem-startDate')) ?? new Date().toISOString(),
      lastPostAt: timeOf($, item.find('.structItem-latestDate').parent()) ?? timeOf($, item.find('.structItem-cell--latest')),
      replies: parseCount(metaDd),
      url: href!,
    });
  });
  return { threads, totalPages: maxPage($) };
}

export async function fetchThreadPage(threadId: number, page: number): Promise<ParsedThreadPage> {
  const url = threadUrl(threadId, page);
  const res = await fetchRaw(url);
  if (res.status === 404 || res.status === 410) throw new ThreadGoneError(threadId, res.status);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (/challenge-platform|cf-chl|Just a moment/i.test(body))
      throw new Error(`Diễn đàn đang chặn truy cập tự động (HTTP ${res.status}, trang kiểm tra chống bot). Thử lại sau.`);
    if (res.status === 403)
      throw new Error(`Diễn đàn từ chối truy cập bài #${threadId} (HTTP 403). Bài có thể chỉ dành cho thành viên đã đăng nhập.`);
    throw new HttpError(res.status, url);
  }
  const pageUrl = res.url || url;
  const html = await res.text();
  return parseThreadHtml(html, pageUrl, page);
}

export function parseThreadHtml(html: string, pageUrl: string, page: number): ParsedThreadPage {
  const $ = cheerio.load(html);
  // Thread prefixes ("Có ảnh", "Hỏi"...) are rendered as labels inside the h1; keep only the title text.
  const h1 = $('h1.p-title-value').first().clone();
  h1.find('.label, .labelLink, .label-append').remove();
  const title = h1.text().replace(/\s+/g, ' ').trim() || $('title').text().split('|')[0].trim();
  const forumHref = $('.p-breadcrumbs a[href*="/forums/"]').last().attr('href') ?? '';
  const fm = forumHref.match(/\/forums\/(?:[^/]*\.)?(\d+)/);
  const ignored = cfg().scraper.ignoredDomains.map((d) => d.toLowerCase());
  const isIgnored = (u: string) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return ignored.some((d) => h === d || h.endsWith(`.${d}`));
    } catch {
      return true;
    }
  };

  const posts: ParsedPost[] = [];
  $('article.message--post, article.message').each((idx, el) => {
    const art = $(el);
    const idAttr = art.attr('data-content') ?? art.attr('id') ?? '';
    const postId = Number(idAttr.replace(/\D/g, '')) || 0;
    const noText = art.find('.message-attribution-opposite a').filter((_, a) => /#\s*\d/.test($(a).text())).first().text();
    const postNo = Number(noText.replace(/\D/g, '')) || (page - 1) * cfg().source.postsPerPage + idx + 1;
    const body = art.find('.message-body .bbWrapper, .bbWrapper').first();

    const images = new Set<string>();
    body.find('img').each((_, img) => {
      const $img = $(img);
      if ($img.hasClass('smilie') || $img.closest('blockquote').length) return;
      // Link-preview cards: keep the preview picture (often the shared photo itself),
      // drop the site favicon and generic site logos.
      if ($img.closest('.bbCodeBlock--unfurl').length && !$img.hasClass('bbCodeBlockUnfurl-image')) return;
      const u = abs($img.attr('data-url') ?? $img.attr('data-src') ?? $img.attr('src'), pageUrl);
      if (u && $img.hasClass('bbCodeBlockUnfurl-image') && /favicon|apple-touch-icon|\/logo/i.test(u)) return;
      if (u && !isIgnored(u)) images.add(u);
    });
    art.find('.message-attachments a.file-preview, .attachment a.js-lbImage, a.js-lbImage').each((_, a) => {
      const u = abs($(a).attr('href'), pageUrl);
      if (u && !isIgnored(u)) images.add(u);
    });

    const videos = new Map<string, 'file' | 'embed'>();
    body.find('video source[src], video[src]').each((_, v) => {
      const u = abs($(v).attr('src'), pageUrl);
      if (u && !isIgnored(u)) videos.set(u, 'file');
    });
    body.find('iframe[src], [data-s9e-mediaembed-src]').each((_, f) => {
      const u = abs($(f).attr('src') ?? $(f).attr('data-s9e-mediaembed-src'), pageUrl);
      if (u && !isIgnored(u)) videos.set(u, 'embed');
    });

    const links: { url: string; text: string }[] = [];
    const seenLinks = new Set<string>();
    // Link-preview cards: keep the link, with the previewed page title as its text.
    body.find('.bbCodeBlock--unfurl').each((_, card) => {
      const $c = $(card);
      if ($c.closest('blockquote').length) return;
      const u = abs($c.attr('data-url') ?? $c.find('a[href]').first().attr('href'), pageUrl);
      if (!u || !/^https?:/.test(u) || isIgnored(u) || seenLinks.has(u)) return;
      seenLinks.add(u);
      links.push({ url: u, text: $c.find('.contentRow-header').first().text().trim().slice(0, 300) });
    });
    body.find('a[href]').each((_, a) => {
      const $a = $(a);
      if ($a.closest('blockquote, .bbCodeBlock--unfurl').length || $a.find('img').length) return;
      const u = abs($a.attr('href'), pageUrl);
      if (!u || seenLinks.has(u) || images.has(u) || videos.has(u)) return;
      // Cloudflare e-mail obfuscation and similar infrastructure links are not content
      if (new URL(u).pathname.startsWith('/cdn-cgi/')) return;
      if (/\/(threads|members|posts|goto)\//.test(new URL(u).pathname) && !$a.hasClass('link--external')) return;
      if (!/^https?:/.test(u) || isIgnored(u)) return;
      seenLinks.add(u);
      links.push({ url: u, text: $a.text().trim().slice(0, 300) });
    });

    const clone = body.clone();
    clone.find('blockquote, .bbCodeBlock--quote, .bbCodeBlock--unfurl, script, style, .js-extraPhrases').remove();
    clone.find('br').replaceWith('\n');
    clone.find('p, div').each((_, d) => {
      $(d).append('\n');
    });
    const text = clone
      .text()
      .replace(/[ \t ]+/g, ' ')
      .replace(/\n\s*\n+/g, '\n')
      .trim();

    const permalink = art.find('.message-attribution-main a[href]').first().attr('href');
    posts.push({
      postId,
      postNo,
      author: (art.attr('data-author') ?? art.find('.message-name .username').first().text()).trim() || 'Ẩn danh',
      createdAt: timeOf($, art.find('.message-attribution-main')) ?? new Date().toISOString(),
      text,
      url: abs(permalink, pageUrl) ?? `${pageUrl}#post-${postId}`,
      images: [...images],
      videos: [...videos].map(([u, kind]) => ({ url: u, kind })),
      links,
    });
  });

  return { title, forumId: fm ? Number(fm[1]) : null, totalPages: maxPage($), posts };
}
