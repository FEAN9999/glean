import type { FastifyInstance } from 'fastify';

/**
 * A small, deterministic XenForo-style forum used as the default data source, so the whole
 * pipeline (sync, search, sieve, archive of deleted threads) can be exercised offline.
 * Content is spread over a time window; posts "appear" as wall-clock time passes, and a few
 * threads disappear (deleted) along the way.
 */

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FORUMS = [
  {
    id: 1,
    name: 'Xe & Đường dài',
    nouns: ['con Wave', 'xe côn tay', 'cung Hà Giang', 'đèo Khau Phạ', 'lốp sau', 'nhông xích', 'bình xăng con', 'chuyến Tây Bắc', 'đèn trợ sáng', 'giảm xóc'],
    verbs: ['thay', 'độ lại', 'đi thử', 'bảo dưỡng', 'cân lại', 'chạy rốt-đa'],
    titles: ['Nhật ký {n} ngày đi {x}', 'Hỏi về {x}, ai rành chỉ giúp', '{x}: chia sẻ sau {n} nghìn km', 'Review nhanh {x}', 'Kinh nghiệm {v} {x} tại nhà'],
  },
  {
    id: 2,
    name: 'Bếp nhà',
    nouns: ['nồi phở bò', 'bánh mì que', 'cá kho tộ', 'mắm tép', 'bò kho', 'chè bưởi', 'nước dùng', 'lò nướng', 'bánh bông lan', 'gà ủ muối'],
    verbs: ['nấu', 'ủ', 'nướng', 'thử làm', 'kho', 'chỉnh công thức'],
    titles: ['Lần đầu {v} {x} — thành quả', 'Công thức {x} cho {n} người', 'Vì sao {x} của mình bị nhạt?', 'Góc khoe: {x} cuối tuần', '{x} kiểu miền Tây, ai thử chưa'],
  },
  {
    id: 3,
    name: 'Máy ảnh & Khoảnh khắc',
    nouns: ['ống 35mm', 'film Kodak', 'ảnh phố đêm', 'chân dung ngược sáng', 'máy rangefinder', 'bộ lọc ND', 'ảnh đường phố Sài Gòn', 'flash rời', 'ống macro', 'cảm biến full-frame'],
    verbs: ['chụp', 'hậu kỳ', 'thử', 'scan', 'đo sáng', 'canh'],
    titles: ['Topic ảnh: {x}', '{n} khung hình với {x}', 'Nhờ góp ý {x}', 'Mới tập {v} {x}', 'So sánh {x} sau {n} tháng'],
  },
  {
    id: 4,
    name: 'Đồ chơi công nghệ',
    nouns: ['bàn phím cơ', 'NAS tự build', 'tai nghe in-ear', 'router mesh', 'mini PC', 'màn hình 4K', 'ổ SSD', 'loa bluetooth', 'đồng hồ thông minh', 'homelab'],
    verbs: ['build', 'nâng cấp', 'thử', 'cài', 'mod', 'test'],
    titles: ['Build {x} ngân sách {n} triệu', '{x}: dùng {n} tuần thấy gì', 'Hỏi: nên mua {x} nào?', 'Mình vừa {v} {x}', 'Tổng hợp lỗi {x} hay gặp'],
  },
];

const FILLER = [
  'nói thật là', 'theo mình thấy', 'hôm qua', 'sáng nay', 'cuối tuần rồi', 'anh em cho hỏi', 'mình nghĩ', 'cái này', 'tạm ổn', 'khá ngon',
  'hơi tốn', 'nên thử', 'không đáng', 'đáng tiền', 'đi kèm', 'bên cạnh đó', 'tóm lại', 'chốt lại', 'quan trọng nhất', 'thêm một điểm',
];
const ENDINGS = ['nhé.', 'đó.', 'các bác ạ.', 'thôi.', 'vậy.', 'mà.', '.', '!', '?', ' haha.'];
const JUNK = ['up', 'hóng', '+1', 'chấm', 'đánh dấu', 'ok', 'like'];
const NAME_A = ['gio', 'may', 'bac', 'tieu', 'lang', 'song', 'nui', 'heo', 'meo', 'tre', 'sang', 'pho', 'hem', 'ca'];
const NAME_B = ['Bac', 'Xanh', 'Nho', 'Lon', 'Dem', 'Mua', 'Nau', 'Pho', 'Ray', 'Lua', 'Tho', 'Vang'];

const WINDOW_START = Date.parse('2026-09-01T00:00:00Z');
const WINDOW_END = Date.parse('2027-01-31T00:00:00Z');
const PER_PAGE = 20;
const THREADS_PER_FORUM = 48;

interface DemoPost {
  id: number;
  no: number;
  author: string;
  at: number;
  html: string;
}
interface DemoThread {
  id: number;
  forumId: number;
  title: string;
  author: string;
  createdAt: number;
  deletedAt: number | null;
  posts: DemoPost[];
}

const threads: DemoThread[] = [];

function pick<T>(r: () => number, arr: T[]) {
  return arr[Math.floor(r() * arr.length)];
}
function nick(r: () => number) {
  return `${pick(r, NAME_A)}${pick(r, NAME_B)}${r() < 0.5 ? Math.floor(r() * 99) : ''}`;
}
function sentence(r: () => number, f: (typeof FORUMS)[number]) {
  const parts = [pick(r, FILLER), pick(r, f.verbs), pick(r, f.nouns), pick(r, FILLER)];
  if (r() < 0.5) parts.push(pick(r, f.nouns));
  const s = parts.join(' ');
  return s[0].toUpperCase() + s.slice(1) + ' ' + pick(r, ENDINGS);
}

function build() {
  let postId = 1000;
  for (const f of FORUMS) {
    for (let i = 0; i < THREADS_PER_FORUM; i++) {
      const id = f.id * 1000 + i + 1;
      const r = mulberry32(id * 7919);
      const createdAt = WINDOW_START + Math.floor(r() * (WINDOW_END - WINDOW_START) * 0.85);
      const title = pick(r, f.titles)
        .replace('{x}', pick(r, f.nouns))
        .replace('{v}', pick(r, f.verbs))
        .replace('{n}', String(2 + Math.floor(r() * 30)));
      const author = nick(r);
      const big = r() < 0.18;
      const count = big ? 60 + Math.floor(r() * 140) : 2 + Math.floor(r() * 45);
      const deletedAt = r() < 0.06 ? createdAt + Math.floor((2 + r() * 20) * 86400_000) : null;
      const posts: DemoPost[] = [];
      let t = createdAt;
      for (let n = 1; n <= count; n++) {
        if (n > 1) t += Math.floor(r() * r() * 18 * 3600_000) + 60_000;
        const pr = mulberry32(id * 131 + n);
        const pAuthor = n === 1 ? author : nick(pr);
        let html = '';
        if (n > 1 && pr() < 0.12) {
          html += `<blockquote class="bbCodeBlock bbCodeBlock--quote"><div class="bbCodeBlock-title">${nick(pr)} đã viết:</div><div class="bbCodeBlock-content">${sentence(pr, f)}</div></blockquote>`;
        }
        if (n > 1 && pr() < 0.14) {
          html += pick(pr, JUNK);
        } else {
          const lines = 1 + Math.floor(pr() * (n === 1 ? 6 : 3));
          html += Array.from({ length: lines }, () => sentence(pr, f)).join('<br />');
        }
        const imgRoll = pr();
        if (n === 1 || imgRoll < 0.3) {
          const k = n === 1 ? 2 + Math.floor(pr() * 5) : 1 + Math.floor(pr() * 3);
          for (let j = 1; j <= k; j++) {
            const kind = pr();
            const src =
              kind < 0.04
                ? `/demo-forum/img/${id}-${n}-${j}-bin.jpg`
                : kind < 0.08
                  ? `/demo-forum/img/missing-${id}-${n}-${j}.png`
                  : kind < 0.12
                    ? `http://ads.example.invalid/banner-${j}.gif`
                    : `/demo-forum/img/${id}-${n}-${j}.svg`;
            html += `<br /><img src="${src}" class="bbImage" alt="ảnh ${j}" loading="lazy" />`;
          }
        }
        if (pr() < 0.04) {
          html += `<br /><span data-s9e-mediaembed="youtube"><iframe src="https://www.youtube-nocookie.com/embed/${['aqz-KE-bpKQ', 'ScMzIvxBSi4', 'LXb3EKWsInQ'][n % 3]}" allowfullscreen></iframe></span>`;
        }
        if (pr() < 0.03) {
          html += `<br /><video controls><source src="/demo-forum/video/${id}-${n}.mp4" type="video/mp4" /></video>`;
        }
        if (pr() < 0.12) {
          const slug = pick(pr, ['Đèo_Mã_Pí_Lèng', 'Phở', 'Máy_ảnh_rangefinder', 'Bàn_phím_cơ', 'Hà_Giang', 'Cá_kho']);
          html += `<br /><a href="https://vi.wikipedia.org/wiki/${encodeURIComponent(slug)}" class="link link--external" target="_blank" rel="nofollow">Tham khảo: ${slug.replace(/_/g, ' ')}</a>`;
        }
        posts.push({ id: ++postId, no: n, author: pAuthor, at: t, html });
      }
      threads.push({ id, forumId: f.id, title, author, createdAt, deletedAt, posts });
    }
  }
}
build();

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const slugify = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

/** Threads deleted by hand through the demo control route (to try the archive feature). */
const manualDeleted = new Set<number>();
const visible = (t: DemoThread, nowMs: number) =>
  t.createdAt <= nowMs && !(t.deletedAt && t.deletedAt <= nowMs) && !manualDeleted.has(t.id);
const visiblePosts = (t: DemoThread, nowMs: number) => t.posts.filter((p) => p.at <= nowMs);
const timeTag = (ms: number) => `<time class="u-dt" datetime="${new Date(ms).toISOString()}" data-time="${Math.floor(ms / 1000)}">${new Date(ms).toLocaleString('vi-VN')}</time>`;

function pageNav(baseHref: string, page: number, total: number) {
  if (total <= 1) return '';
  const items = [];
  for (let p = 1; p <= total; p++) {
    if (p === 1 || p === total || Math.abs(p - page) <= 2) {
      items.push(`<li class="pageNav-page${p === page ? ' pageNav-page--current' : ''}"><a href="${baseHref}${p > 1 ? `page-${p}` : ''}">${p}</a></li>`);
    }
  }
  return `<nav class="pageNavWrapper"><div class="pageNav"><ul class="pageNav-main">${items.join('')}</ul></div></nav>`;
}

function layout(title: string, body: string) {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8"><title>${esc(title)} | Diễn đàn mẫu</title>
<style>body{font:15px system-ui;margin:0;background:#f5f5f5;color:#222}main{max-width:900px;margin:0 auto;padding:16px}
.structItem,.message{background:#fff;border:1px solid #ddd;margin:8px 0;padding:10px}.bbImage{max-width:240px;display:block;margin:6px 0}
blockquote{border-left:3px solid #ccc;margin:6px 0;padding:4px 8px;color:#666}.pageNav-main{display:flex;gap:6px;list-style:none;padding:0}</style>
</head><body><header style="background:#2a3a55;color:#fff;padding:10px 16px">Diễn đàn mẫu — dữ liệu giả lập cho Sàng</header><main>${body}</main></body></html>`;
}

function svgImage(key: string) {
  const r = mulberry32([...key].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const hue = Math.floor(r() * 360);
  const shapes = Array.from({ length: 7 }, () => {
    const h = (hue + Math.floor(r() * 120) - 60 + 360) % 360;
    if (r() < 0.5)
      return `<circle cx="${Math.floor(r() * 800)}" cy="${Math.floor(r() * 560)}" r="${40 + Math.floor(r() * 180)}" fill="hsl(${h} 55% ${35 + Math.floor(r() * 40)}%)" opacity="0.85"/>`;
    return `<rect x="${Math.floor(r() * 700)}" y="${Math.floor(r() * 480)}" width="${60 + Math.floor(r() * 300)}" height="${40 + Math.floor(r() * 220)}" fill="hsl(${h} 45% ${30 + Math.floor(r() * 45)}%)" opacity="0.8" transform="rotate(${Math.floor(r() * 40) - 20} 400 280)"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="560" viewBox="0 0 800 560"><rect width="800" height="560" fill="hsl(${hue} 30% 88%)"/>${shapes}<text x="24" y="536" font-family="sans-serif" font-size="22" fill="rgba(0,0,0,.55)">${esc(key)}</text></svg>`;
}

export function registerDemoForum(app: FastifyInstance) {
  app.get('/demo-forum/', async (_req, reply) => {
    const nodes = FORUMS.map(
      (f) => `<div class="node node--forum node--id${f.id}"><h3 class="node-title"><a href="/demo-forum/forums/${slugify(f.name)}.${f.id}/">${esc(f.name)}</a></h3></div>`,
    ).join('');
    const body = `<div class="block block--category"><div class="block-container"><h2 class="block-header"><a>Chuyên mục mẫu</a></h2><div class="block-body">${nodes}</div></div></div>`;
    reply.type('text/html').send(layout('Trang chủ', `<h1 class="p-title-value">Diễn đàn mẫu</h1>${body}`));
  });

  app.get<{ Params: { slug: string; page?: string } }>('/demo-forum/forums/:slug/:page?', async (req, reply) => {
    const id = Number(req.params.slug.split('.').pop());
    const f = FORUMS.find((x) => x.id === id);
    if (!f) return reply.code(404).type('text/html').send(layout('Không tìm thấy', '<h1>Không tìm thấy</h1>'));
    const page = Number((req.params.page ?? '').replace('page-', '')) || 1;
    const nowMs = Date.now();
    const list = threads
      .filter((t) => t.forumId === id && visible(t, nowMs))
      .map((t) => ({ t, posts: visiblePosts(t, nowMs) }))
      .sort((a, b) => b.posts.at(-1)!.at - a.posts.at(-1)!.at);
    const total = Math.max(1, Math.ceil(list.length / PER_PAGE));
    const items = list
      .slice((page - 1) * PER_PAGE, page * PER_PAGE)
      .map(
        ({ t, posts }) => `<div class="structItem structItem--thread js-inlineModContainer" data-author="${esc(t.author)}">
  <div class="structItem-cell structItem-cell--main">
    <div class="structItem-title"><a href="/demo-forum/threads/${slugify(t.title)}.${t.id}/">${esc(t.title)}</a></div>
    <div class="structItem-minor"><ul class="structItem-parts"><li><a class="username">${esc(t.author)}</a></li><li class="structItem-startDate"><a>${timeTag(t.createdAt)}</a></li></ul></div>
  </div>
  <div class="structItem-cell structItem-cell--meta"><dl class="pairs pairs--justified"><dt>Trả lời</dt><dd>${posts.length - 1}</dd></dl></div>
  <div class="structItem-cell structItem-cell--latest"><a class="structItem-latestDate">${timeTag(posts.at(-1)!.at)}</a></div>
</div>`,
      )
      .join('');
    reply
      .type('text/html')
      .send(layout(f.name, `<h1 class="p-title-value">${esc(f.name)}</h1>${items}${pageNav(`/demo-forum/forums/${slugify(f.name)}.${f.id}/`, page, total)}`));
  });

  app.get<{ Params: { slug: string; page?: string } }>('/demo-forum/threads/:slug/:page?', async (req, reply) => {
    const id = Number(req.params.slug.split('.').pop());
    const t = threads.find((x) => x.id === id);
    const nowMs = Date.now();
    if (!t || !visible(t, nowMs))
      return reply.code(404).type('text/html').send(layout('Không tìm thấy', '<div class="blockMessage">Chủ đề không tồn tại hoặc đã bị xóa.</div>'));
    const page = Number((req.params.page ?? '').replace('page-', '')) || 1;
    const posts = visiblePosts(t, nowMs);
    const total = Math.max(1, Math.ceil(posts.length / PER_PAGE));
    const forum = FORUMS.find((f) => f.id === t.forumId)!;
    const base = `/demo-forum/threads/${slugify(t.title)}.${t.id}/`;
    const items = posts
      .slice((page - 1) * PER_PAGE, page * PER_PAGE)
      .map(
        (p) => `<article class="message message--post js-post" data-author="${esc(p.author)}" data-content="post-${p.id}" id="js-post-${p.id}">
  <div class="message-cell message-cell--user"><h4 class="message-name"><a class="username">${esc(p.author)}</a></h4></div>
  <div class="message-cell message-cell--main">
    <header class="message-attribution">
      <ul class="message-attribution-main"><li><a href="${base}post-${p.id}" class="u-concealed">${timeTag(p.at)}</a></li></ul>
      <ul class="message-attribution-opposite"><li><a href="${base}post-${p.id}">#${p.no}</a></li></ul>
    </header>
    <div class="message-content"><div class="message-body"><div class="bbWrapper">${p.html}</div></div></div>
  </div>
</article>`,
      )
      .join('');
    reply.type('text/html').send(
      layout(
        t.title,
        `<div class="p-breadcrumbs"><a href="/demo-forum/">Diễn đàn</a> › <a href="/demo-forum/forums/${slugify(forum.name)}.${forum.id}/">${esc(forum.name)}</a></div>
<h1 class="p-title-value">${esc(t.title)}</h1>${pageNav(base, page, total)}${items}${pageNav(base, page, total)}`,
      ),
    );
  });

  app.get<{ Params: { file: string } }>('/demo-forum/img/:file', async (req, reply) => {
    const f = req.params.file;
    if (f.startsWith('missing-')) return reply.code(404).send('not found');
    if (f.endsWith('-bin.jpg')) return reply.type('text/html').send('<html><body>Hotlink protection</body></html>');
    reply.header('cache-control', 'public, max-age=86400').type('image/svg+xml').send(svgImage(f.replace(/\.svg$/, '')));
  });
  // Demo-only: simulate a moderator deleting (or restoring) a thread on the forum.
  app.post<{ Params: { id: string } }>('/demo-forum/_toggle-delete/:id', async (req) => {
    const id = Number(req.params.id);
    if (manualDeleted.has(id)) manualDeleted.delete(id);
    else manualDeleted.add(id);
    return { threadId: id, deleted: manualDeleted.has(id) };
  });
  app.get('/demo-forum/video/:file', async (_req, reply) => reply.code(404).send('video not available in demo'));
}

export const demoStats = () => ({ threads: threads.length, posts: threads.reduce((a, t) => a + t.posts.length, 0) });
