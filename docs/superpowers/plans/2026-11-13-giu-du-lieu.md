# Giữ dữ liệu — kế hoạch triển khai

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Glean không còn mất dữ liệu khi diễn đàn sửa/xóa bình luận, khi bấm "Sàng lại", và có sao lưu tự động kèm ảnh.

**Architecture:** Thêm cột/bảng bằng migration tại chỗ trong `server/db.ts`. Logic lưu trữ bình luận (bản sửa, phát hiện xóa) nằm trong file mới `server/archive.ts`, được gọi từ đồng bộ (`sync.ts`) và sàng (`scraper.ts`). Sàng lại chuyển từ "xóa rồi quét" sang "upsert + đánh dấu thiếu". Sao lưu là module mới `server/backup.ts` với bộ hẹn giờ riêng.

**Tech Stack:** Node ≥ 22.13 (đang chạy 24), Fastify 5, `node:sqlite`, cheerio, React 18 + Vite, `node:test` qua `tsx`.

**Spec:** [docs/superpowers/specs/2026-11-13-giu-du-lieu-design.md](../specs/2026-11-13-giu-du-lieu-design.md)

## Global Constraints

- Không thêm dependency npm mới.
- DB thật `data/glean.db` phải nâng cấp tại chỗ, không mất dữ liệu. Test và kiểm thử không bao giờ chạm `data/` (luôn dùng `GLEAN_DATA_DIR` tạm).
- Mọi chuỗi giao diện qua `t('tiếng Việt', 'English')`.
- Mặc định: `sync.comments.recheckPages = 2`, `sync.comments.recheckWithinHours = 48`; `backup = { enabled: true, intervalHours: 24, keep: 7, targetDir: '', includeMedia: true, notifyOnFail: true }`.
- Tên bản sao lưu tự động: `glean-auto-YYYYMMDD-HHmmss.db` (giờ máy). Chỉ tệp khớp `glean-auto-*.db` bị xoay vòng xóa.
- Chốt an toàn phát hiện xóa: bỏ qua khi có trang 0 bài, khi có bài thiếu ID thật, hoặc khi số thiếu > 2 **và** > một nửa số bình luận đã lưu trong khoảng.
- Không commit trừ khi người dùng yêu cầu. `web/` đang có thay đổi chưa commit của người dùng: không hoàn tác hay định dạng lại phần không liên quan.
- Kiểm thử trong app chỉ dùng diễn đàn mẫu, không gửi request tới diễn đàn thật.

## Review Focus

1. Diễn đàn trả trang lỗi/chống bot với HTTP 200 (0 bài) trong lúc đọc lại → không bình luận nào bị đánh dấu xóa. Test: Task 2 `skips when a page has no posts`.
2. DB cũ đã có lượt sàng (dòng `scrape_*` chưa có `post_id`) rồi sàng lại → dòng cũ được khớp theo `#n`, không nhân đôi. Test: Task 4 `rerun matches legacy rows without post_id`.
3. Nội dung chỉ khác khoảng trắng/xuống dòng → không tạo bản sửa. Test: Task 2 `whitespace-only change is not an edit`.
4. Thư mục sao lưu không ghi được (ổ rời bị rút) → lượt sao lưu ghi lỗi, app chạy tiếp. Test: Task 5 `runBackup records an error when the folder is unusable`.
5. Sàng lại một bài đã bị xóa trên diễn đàn → giữ nguyên ảnh và bình luận của chính lượt sàng. Test: Task 4 `archiveFallback keeps the job's own data`.

---

### Task 1: Hạ tầng test và migration DB

**Files:**
- Modify: `package.json` (script `test`)
- Create: `server/test/setup.ts`
- Modify: `server/db.ts` (bảng mới, hàm `migrate`)
- Modify: `server/system.ts` (`CLONABLE` thêm `comment_revision`, `backup_run`)
- Test: `server/db.test.ts`

**Interfaces:**
- Produces: `export function migrate(d: DatabaseSync): void` (chạy lúc import `db.ts`, sau khối `CREATE`); `export function ensureColumn(d: DatabaseSync, table: string, column: string, ddl: string): boolean` (true nếu vừa thêm).
- Produces bảng: `comment_revision(id INTEGER PRIMARY KEY AUTOINCREMENT, comment_id INTEGER NOT NULL, content TEXT NOT NULL, captured_at TEXT NOT NULL, replaced_at TEXT NOT NULL)` + index `(comment_id, id)`; `backup_run(id INTEGER PRIMARY KEY AUTOINCREMENT, trigger TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT, file TEXT, size_bytes INTEGER, media_copied INTEGER NOT NULL DEFAULT 0, media_bytes INTEGER NOT NULL DEFAULT 0, error TEXT)`.
- Produces cột: `comment.edit_count INTEGER NOT NULL DEFAULT 0`, `comment.edited_at TEXT`, `comment.deleted_at TEXT`; `scrape.run_no INTEGER NOT NULL DEFAULT 1`; trên `scrape_image`, `scrape_video`, `scrape_link`, `scrape_comment`: `post_id INTEGER`, `last_seen_run INTEGER NOT NULL DEFAULT 1`, `missing_since TEXT`.

- [ ] **Step 1: Script test và setup.** `package.json`: `"test": "node --import tsx --import ./server/test/setup.ts --test \"server/**/*.test.ts\""`. `server/test/setup.ts` đặt `process.env.GLEAN_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'glean-test-'))`. Mỗi file test gọi `loadConfig(0)` trước khi dùng `cfg()`.

- [ ] **Step 2: Viết test thất bại** trong `server/db.test.ts`:

```ts
test('migrate adds new columns to a pre-upgrade database', () => {
  const d = new DatabaseSync(':memory:');
  d.exec(`CREATE TABLE comment(id INTEGER PRIMARY KEY, thread_id INTEGER, post_no INTEGER, page INTEGER, author TEXT, content TEXT, content_lc TEXT, created_at TEXT, url TEXT, updated_at TEXT);
          CREATE TABLE scrape(id INTEGER PRIMARY KEY, thread_id INTEGER);
          CREATE TABLE scrape_image(id INTEGER PRIMARY KEY, scrape_id INTEGER, page INTEGER, post_no INTEGER, origin_url TEXT);
          CREATE TABLE scrape_video(id INTEGER PRIMARY KEY, scrape_id INTEGER);
          CREATE TABLE scrape_link(id INTEGER PRIMARY KEY, scrape_id INTEGER);
          CREATE TABLE scrape_comment(id INTEGER PRIMARY KEY, scrape_id INTEGER);
          INSERT INTO comment(id, content) VALUES (1, 'x');`);
  migrate(d);
  const cols = (t: string) => d.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => c.name);
  assert.ok(['edit_count', 'edited_at', 'deleted_at'].every((c) => cols('comment').includes(c)));
  assert.ok(cols('scrape').includes('run_no'));
  for (const t of ['scrape_image', 'scrape_video', 'scrape_link', 'scrape_comment'])
    assert.ok(['post_id', 'last_seen_run', 'missing_since'].every((c) => cols(t).includes(c)));
  assert.equal((d.prepare('SELECT edit_count FROM comment WHERE id=1').get() as any).edit_count, 0);
});
test('migrate is a no-op the second time', () => { /* migrate twice on the same db: no throw, ensureColumn returns false */ });
```

- [ ] **Step 3: Chạy `npm test`** → FAIL (`migrate` chưa có).
- [ ] **Step 4: Cài đặt** `ensureColumn` (đọc `PRAGMA table_info`, `ALTER TABLE … ADD COLUMN` nếu thiếu), `migrate`, thêm hai bảng mới vào khối `CREATE` và gọi `migrate(db)` ngay sau đó. Thêm `comment_revision`, `backup_run` vào `CLONABLE`.
- [ ] **Step 5: `npm test` và `npm run typecheck`** → PASS.

---

### Task 2: Bản sửa và phát hiện xóa bình luận

**Files:**
- Create: `server/archive.ts`
- Modify: `server/source/xenforo.ts` (`ParsedPost.editedAt`)
- Modify: `server/sync.ts` (`upsertComments`)
- Modify: `server/scraper.ts` (chỗ gọi `upsertComments`)
- Test: `server/archive.test.ts`, `server/source/xenforo.test.ts`

**Interfaces:**
- Consumes: cột/bảng của Task 1.
- Produces:
  - `ParsedPost.editedAt: string | null` (ISO, đọc từ `.message-lastEdit time` bằng `data-time`/`datetime` như `timeOf`).
  - `export const normalizeText = (s: string): string` (gộp mọi khoảng trắng thành một dấu cách, trim).
  - `export function findMissingIds(stored: number[], seen: number[], lo: number | null, hi: number | null): number[]` (thuần: ID đã lưu nằm trong [lo, hi], null = không giới hạn, mà không có trong `seen`).
  - `export function reconcileDeletions(threadId: number, pages: ParsedPost[][], o: { startsAtFirstPage: boolean; endsAtLastPage: boolean }): { deleted: number; skipped: null | 'empty-page' | 'missing-id' | 'too-many' }`.
  - `upsertComments(threadId, page, posts): { added: number; edited: number }` (trước đây trả `number`).

- [ ] **Step 1: Test parser** `parseThreadHtml reads the last-edit time`: HTML tối thiểu một `article.message` có `data-content="post-5"` và `<div class="message-lastEdit"><time data-time="1762990000"></time></div>` → `posts[0].editedAt === new Date(1762990000 * 1000).toISOString()`; bài không có khối đó → `null`.

- [ ] **Step 2: Test archive** (`server/archive.test.ts`, dùng DB tạm qua setup, chèn `thread`/`comment` trực tiếp):

```ts
test('findMissingIds respects open bounds', () => {
  assert.deepEqual(findMissingIds([1, 2, 3, 4], [2, 4], null, null), [1, 3]);
  assert.deepEqual(findMissingIds([1, 2, 3, 4], [2, 4], 2, 4), [3]);
});
test('edit stores the previous version', () => {
  // comment 10 with content 'cũ' → upsertComments with text 'mới'
  // → { added: 0, edited: 1 }; comment.edit_count = 1; one comment_revision row with content 'cũ'
});
test('whitespace-only change is not an edit', () => {
  // 'a  b\n c' then 'a b c' → edited 0, no revision row
});
test('marks comments missing from a re-read range as deleted', () => {
  // stored ids 101..105 for thread 1; pages [[101,102],[104,105]] (103 gone), starts/ends true → deleted 1, comment 103 has deleted_at
});
test('a reappearing comment loses its deleted mark', () => {
  // 103 has deleted_at; upsertComments with post 103 → deleted_at IS NULL
});
test('skips when a page has no posts', () => { /* pages [[101,102],[]] → { deleted: 0, skipped: 'empty-page' } */ });
test('skips when a seen post has no real id', () => { /* a post with postId 0 → skipped 'missing-id' */ });
test('skips when too many would be marked', () => { /* stored 101..110, seen [101] → skipped 'too-many', nothing marked */ });
test('fallback ids are never marked deleted', () => { /* stored id = 1*100000+7 with post_no 7 is ignored by the range check */ });
```

- [ ] **Step 3: `npm test`** → FAIL.
- [ ] **Step 4: Cài đặt.**
  - `xenforo.ts`: thêm `editedAt` vào `ParsedPost` và `parseThreadHtml`.
  - `upsertComments`: bài mới → chèn (kèm `edited_at`). Bài đã có: nếu `normalizeText` khác → chép bản cũ vào `comment_revision` (`captured_at` = `updated_at` cũ, `replaced_at` = now), ghi nội dung mới, `edit_count + 1`; nếu chỉ khác khoảng trắng → ghi nội dung mới, không tạo bản sửa. Mọi bài thấy được: `deleted_at = NULL`, cập nhật `page`, `edited_at`.
  - `reconcileDeletions`: chốt an toàn theo thứ tự `empty-page` → `missing-id` → `too-many`; `lo` = ID nhỏ nhất trang đầu (null nếu `startsAtFirstPage`), `hi` = ID lớn nhất trang cuối (null nếu `endsAtLastPage`). Lấy ID đã lưu `WHERE thread_id=? AND deleted_at IS NULL AND id <> thread_id*100000 + post_no`. Đặt `deleted_at = now()`.
  - `scraper.ts`: sửa chỗ gọi `upsertComments` theo kiểu trả về mới.
- [ ] **Step 5: `npm test` và `npm run typecheck`** → PASS.

---

### Task 3: Đọc lại vài trang cuối khi đồng bộ bình luận

**Files:**
- Modify: `server/config.ts` (`sync.comments.recheckPages`, `sync.comments.recheckWithinHours`)
- Modify: `server/sync.ts`
- Test: `server/sync.test.ts`

**Interfaces:**
- Consumes: `upsertComments` → `{ added, edited }`, `reconcileDeletions` (Task 2).
- Produces:
  - `export function commentSyncStartPage(o: { syncedCount: number; perPage: number; storedMaxPage: number; recheckPages: number }): number` = `forward = floor(syncedCount/perPage)+1`; nếu `recheckPages <= 0 || storedMaxPage <= 0` trả `forward`; ngược lại `max(1, min(forward, storedMaxPage - recheckPages + 1))`.
  - `export function threadsNeedingComments(forumId: number, limit: number, at?: Date): number[]`: chủ đề chưa đủ bình luận **hoặc** (`recheckPages > 0` và `last_post_at >= at − recheckWithinHours`), `is_deleted = 0`, `ORDER BY last_post_at DESC`.
  - `export async function syncThreadComments(threadId: number, maxPages: number, ctx: RunCtx): Promise<{ added: number; edited: number; deleted: number }>`; `RunCtx` thêm `fetchPage?: typeof fetchThreadPage` (mặc định `fetchThreadPage`, dùng cho test). Export `RunCtx`.
  - `sync_history_item.action` thêm giá trị `'edited'` và `'deleted'` (`comment_delta` = số lượng).

- [ ] **Step 1: Test thất bại:**

```ts
test('commentSyncStartPage', () => {
  assert.equal(commentSyncStartPage({ syncedCount: 45, perPage: 20, storedMaxPage: 3, recheckPages: 2 }), 2);
  assert.equal(commentSyncStartPage({ syncedCount: 45, perPage: 20, storedMaxPage: 3, recheckPages: 0 }), 3);
  assert.equal(commentSyncStartPage({ syncedCount: 0, perPage: 20, storedMaxPage: 0, recheckPages: 2 }), 1);
  assert.equal(commentSyncStartPage({ syncedCount: 20, perPage: 20, storedMaxPage: 1, recheckPages: 2 }), 1);
});
test('threadsNeedingComments includes recently active threads', () => {
  // A: needs comments; B: fully synced, last_post 1h ago; C: fully synced, last_post 100h ago
  // recheck 2/48h → [A, B] (any order); with recheckPages 0 → [A]
});
test('syncThreadComments re-reads stored pages and detects edits and deletions', () => {
  // thread with 3 stored pages (per page 2), fake fetchPage serves pages 2..3 where one post changed text and one is gone
  // → { added: 0, edited: 1, deleted: 1 }, and fetchPage was called for pages 2 and 3 only
});
```

- [ ] **Step 2: `npm test`** → FAIL.
- [ ] **Step 3: Cài đặt.** Thêm hai khóa config (mặc định 2 và 48). `syncThreadComments`: lấy `storedMaxPage = MAX(page)`, bắt đầu từ `commentSyncStartPage(...)`; trang `<= storedMaxPage` không tính vào `maxPages`, trang mới hơn thì tính; gom bài theo trang; sau vòng lặp gọi `reconcileDeletions(threadId, pages, { startsAtFirstPage: start === 1, endsAtLastPage: lastFetched === totalPages })` (bỏ qua khi `ThreadGoneError`). `syncCommentsForum`: ghi mục `comments` / `edited` / `deleted` khi > 0; dòng log `[forum] bài N: +a bình luận, ~e sửa, −d xóa`; khi reconcile bị bỏ qua, ghi log lý do. `runAutoSync` truyền danh sách mới; đồng bộ tay dùng chung `syncCommentsForum`.
- [ ] **Step 4: `npm test` và `npm run typecheck`** → PASS.

---

### Task 4: "Sàng lại" gộp thay vì xóa

**Files:**
- Modify: `server/scraper.ts`
- Test: `server/scraper.test.ts`

**Interfaces:**
- Consumes: cột Task 1, `reconcileDeletions` (Task 2).
- Produces:
  - `export function savePageItems(scrapeId: number, page: number, posts: ParsedPost[], runNo: number): void`: upsert. Khóa khớp: cùng `scrape_id`, cùng `origin_url` (ảnh/video) hoặc `url` (liên kết) hoặc không thêm cột (bình luận), và `(post_id = ? OR (post_id IS NULL AND post_no = ?))`; `postId` 0 lưu là `NULL`. Khớp → cập nhật `page`, `post_no`, `post_id`, `last_seen_run` (bình luận: cả `author`, `content`, `created_at`, `url`; liên kết: `text`). Không khớp → chèn với `last_seen_run = runNo`.
  - `export function markMissing(scrapeId: number, runNo: number): number`: trên 4 bảng, `missing_since = COALESCE(missing_since, now)` khi `last_seen_run < runNo`, `missing_since = NULL` khi `= runNo`; trả số mục đang thiếu.
  - `export function prepareRerun(id: number): void`: `run_no + 1`, đặt lại trạng thái như route `retry` cũ nhưng **không** xóa dòng/tệp và giữ các tổng số. Riêng lượt đã `is_marked_deleted = 1` (tệp đã bị xóa): xóa các dòng mục như cũ.
  - `export function archiveFallback(id: number, threadId: number): void`: nếu lượt sàng đã có dòng mục của chính nó → không chép từ lượt khác, `computeTotals` với `total_pages` hiện có, `finish(id, { isThreadDeleted: true })`; ngược lại giữ logic cũ.
  - `GET /api/scrapes/:id` thêm `missingCounts: { images, videos, links, comments }`; `donePages` chỉ tính trang có `last_seen_run = run_no` khi lượt đang chạy (đã xong thì tính mọi trang).

- [ ] **Step 1: Test thất bại** (tạo `scrape` bằng `run(...)`, dựng `ParsedPost` giả):

```ts
test('rerun keeps items no longer on the forum and marks them missing', () => {
  // run 1: post 11 img a.jpg, post 12 img b.jpg; set current_url on a.jpg; prepareRerun
  // run 2: only post 11 img a.jpg; markMissing → 1
  // rows: 2; a.jpg same row id, current_url kept, missing_since null; b.jpg missing_since not null
});
test('an item that reappears clears missing_since', () => { /* run 3 sees b.jpg again → missing_since null */ });
test('rerun matches legacy rows without post_id', () => {
  // pre-upgrade row: post_id NULL, post_no 2, origin a.jpg → run 2 with postId 12, postNo 2 → still 1 row, post_id now 12
});
test('prepareRerun on a deleted job drops its rows', () => { /* is_marked_deleted=1 → rows gone, run_no incremented */ });
test("archiveFallback keeps the job's own data", () => {
  // job with own rows, prepareRerun, archiveFallback → rows intact, status Completed, is_thread_deleted 1
});
```

- [ ] **Step 2: `npm test`** → FAIL.
- [ ] **Step 3: Cài đặt.** `processScrape` đọc `run_no`, truyền vào `savePageItems`, giữ bài theo trang trong `Map<number, ParsedPost[]>`; khi đủ mọi trang: `reconcileDeletions(threadId, pagesTheoThứTự, { startsAtFirstPage: true, endsAtLastPage: true })` rồi `markMissing`. Route `retry` gọi `prepareRerun`, bỏ `DELETE` và `removeMedia`. `downloadImages` chỉ lấy `current_url IS NULL AND is_bin = 0`. Lượt lỗi giữa chừng giữ nguyên mọi dòng (nhờ upsert nên không trùng) và không gọi `markMissing`.
- [ ] **Step 4: `npm test` và `npm run typecheck`** → PASS.

---

### Task 5: Sao lưu tự động

**Files:**
- Create: `server/backup.ts`
- Modify: `server/config.ts` (mục `backup`), `server/system.ts` (kiểm tra `backup.targetDir` khi lưu cấu hình), `server/index.ts` (`registerBackup`, `initBackup`)
- Test: `server/backup.test.ts`

**Interfaces:**
- Consumes: bảng `backup_run` (Task 1), `telegram` (`server/notify.ts`).
- Produces:
  - `AppConfig.backup: { enabled: boolean; intervalHours: number; keep: number; targetDir: string; includeMedia: boolean; notifyOnFail: boolean }`.
  - `export function validateBackupDir(p: string): string` → đường dẫn tuyệt đối (rỗng = `DATA_DIR/backups`, tương đối thì tính từ `DATA_DIR`); ném `ApiError(400, 'INVALID_BACKUP_DIR', …, 'inline')` nếu nằm trong `cfg().storage.basePath` hoặc không tạo được.
  - `export function autoBackupName(d: Date): string`.
  - `export function pruneAutoBackups(dir: string, keep: number): string[]` (tên đã xóa, cũ nhất trước).
  - `export function mirrorMedia(src: string, dest: string): { copied: number; bytes: number }` (đệ quy; chép khi đích thiếu hoặc khác kích thước; không xóa gì ở đích).
  - `export async function runBackup(trigger: 'auto' | 'manual'): Promise<BackupRun>`; `BackupRun` = dòng `backup_run` dạng camelCase. Không chạy chồng (đang chạy → trả lượt đang chạy).
  - `export function backupStatus(): { running: boolean; last: BackupRun | null; lastSuccessAt: string | null; nextDueAt: string | null; dir: string }`.
  - `export function initBackup(): void` (kiểm tra sau 60 giây rồi mỗi 10 phút: bật và chưa có lượt thành công trong `intervalHours` → `runBackup('auto')`).
  - Routes: `GET /api/backups/status`, `POST /api/backups/run` (`requireSudo`).

- [ ] **Step 1: Test thất bại:**

```ts
test('autoBackupName uses local time', () => {
  assert.equal(autoBackupName(new Date(2026, 10, 13, 9, 5, 7)), 'glean-auto-20261113-090507.db');
});
test('pruneAutoBackups keeps the newest N and ignores other files', () => {
  // 9 glean-auto-* files + glean-2026-11-01.db + notes.txt, keep 7 → removes the 2 oldest auto files only
});
test('mirrorMedia copies only new or changed files', () => {
  // first run copies 2; second run copies 0; change one file's size → copies 1; extra file in dest survives
});
test('runBackup writes a database copy and records the run', async () => {
  // targetDir = temp dir → file exists, run.sizeBytes > 0, run.error null, run.finishedAt set
});
test('runBackup records an error when the folder is unusable', async () => {
  // targetDir = path of an existing *file* → run.error non-empty, no throw
});
test('validateBackupDir rejects a folder inside the media folder', () => { /* throws ApiError INVALID_BACKUP_DIR */ });
```

- [ ] **Step 2: `npm test`** → FAIL.
- [ ] **Step 3: Cài đặt.** `runBackup`: ghi dòng `backup_run`, `VACUUM INTO` (thoát dấu `'` như `system.ts`), `pruneAutoBackups(dir, keep)`, `mirrorMedia(cfg().storage.basePath, dir/media)` nếu `includeMedia`; lỗi → ghi `error`, gửi `telegram(...)` nếu `notifyOnFail`. `system.ts` PUT config: nếu `patch.backup?.targetDir !== undefined` thì gọi `validateBackupDir`. `index.ts`: đăng ký route, gọi `initBackup()` sau `initAutoSync()`.
- [ ] **Step 4: `npm test` và `npm run typecheck`** → PASS.

---

### Task 6: Nút điều khiển diễn đàn mẫu và README

**Files:**
- Modify: `server/demo/forum.ts`
- Modify: `README.md`
- Test: `server/demo/forum.test.ts`

**Interfaces:**
- Produces: `POST /demo-forum/_edit-post/:postId` (body tùy chọn `{ text?: string }`; mặc định thêm " (đã sửa)" vào cuối nội dung; trả `{ postId, threadId, editedAt }`), `POST /demo-forum/_toggle-post-delete/:postId` (trả `{ postId, threadId, deleted }`). Bài đã sửa hiển thị `<div class="message-lastEdit">Sửa lần cuối: <time …></time></div>` sau `.message-body`; bài bị xóa không xuất hiện (`#n` của bài khác giữ nguyên).

- [ ] **Step 1: Test thất bại**: dựng Fastify, `registerDemoForum(app)`, `app.inject` sửa một bài rồi GET trang chủ đề của nó → `parseThreadHtml` trả bài đó có nội dung mới và `editedAt`; bật xóa → bài không còn trong `posts`.
- [ ] **Step 2: `npm test`** → FAIL.
- [ ] **Step 3: Cài đặt** (`editedPosts: Map<number, { html: string; at: number }>`, `deletedPosts: Set<number>`). README: mục diễn đàn mẫu thêm hai route; mục mới "Giữ dữ liệu" mô tả đọc lại trang cuối, nhãn sửa/xóa, sàng lại không mất dữ liệu, sao lưu tự động và cách khôi phục (dừng app → chép `glean-auto-….db` thành `data/glean.db`, xóa `glean.db-wal`/`-shm` cũ → chép `media/` của bản sao lưu về `data/media`).
- [ ] **Step 4: `npm test` và `npm run typecheck`** → PASS.

---

### Task 7: Giao diện bình luận sửa/xóa, nhật ký, cài đặt

**Files:**
- Modify: `server/search.ts` (route bản sửa, cột mới, bộ lọc)
- Create: `web/src/components/CommentHistory.tsx`
- Modify: `web/src/pages/Search.tsx`, `web/src/pages/SieveDetail.tsx` (tab "Bình luận lưu trữ"), `web/src/pages/Logs.tsx`, `web/src/pages/Settings.tsx`
- Test: `server/search.test.ts`

**Interfaces:**
- Consumes: cột `edit_count`, `edited_at`, `deleted_at`, bảng `comment_revision`.
- Produces:
  - `GET /api/comments/:id/revisions` → `[{ id, content, capturedAt, replacedAt }]`, mới nhất trước.
  - Kết quả tìm bình luận có thêm `editCount`, `editedAt`, `deletedAt`; body tìm kiếm nhận `onlyChanged?: boolean` → thêm `AND (c.edit_count > 0 OR c.deleted_at IS NOT NULL)` cho cả kết quả lẫn đếm.
  - `export function CommentChanges(p: { id: number; editCount: number; editedAt: string | null; deletedAt: string | null }): JSX.Element | null`: nhãn "đã sửa · N lần" (bấm mở/đóng danh sách bản trước, tải lười) và nhãn "đã xóa trên diễn đàn · <giờ>" (tông `bad`). Không có thay đổi → `null`.

- [ ] **Step 1: Test server thất bại**: `searchComments({ keyword: 'xyz', onlyChanged: true }, false)` chỉ trả bình luận có sửa hoặc xóa; dòng trả về có `editCount`/`deletedAt`.
- [ ] **Step 2: `npm test`** → FAIL; cài đặt phần server; `npm test` → PASS.
- [ ] **Step 3: Giao diện.** Search: gắn `CommentChanges` vào thẻ bình luận; ô chọn "Chỉ bình luận đã sửa/xóa" ("Only edited/deleted comments") trong `.filters` khi xem bình luận, lưu ở tham số URL `changed=1`, gửi `onlyChanged`. SieveDetail tab `synced-comments`: gắn `CommentChanges`. Logs: kiểu `action` thêm `'edited' | 'deleted'`; thẻ "~N sửa" / "−N đã xóa" ("~N edited" / "−N deleted"). Settings → Đồng bộ bình luận: `Num({ p: 'sync.comments.recheckPages', label: t('Đọc lại số trang cuối', 'Re-read last pages'), min: 0 })` và `Num({ p: 'sync.comments.recheckWithinHours', label: t('Đọc lại bài có hoạt động trong (giờ)', 'Re-read threads active within (hours)'), min: 1 })`.
- [ ] **Step 4: `npm run typecheck`** → PASS.

---

### Task 8: Giao diện mục không còn trên diễn đàn và sao lưu tự động

**Files:**
- Modify: `web/src/pages/SieveDetail.tsx`, `web/src/pages/Backup.tsx`, `web/src/styles.css` (chỉ khi cần lớp mới)

**Interfaces:**
- Consumes: `missingSince` trên mục sàng, `missingCounts` (Task 4); `/backups/status`, `/backups/run`, `PUT /systems/config { backup }` (Task 5).

- [ ] **Step 1: SieveDetail.** Ô ảnh, dòng video, liên kết, bình luận có `missingSince` → nhãn "Không còn trên diễn đàn" ("No longer on the forum"). Đầu trang, khi tổng `missingCounts` > 0: một dòng "N mục không còn trên diễn đàn, vẫn được giữ trong bản lưu" ("N items are no longer on the forum and are kept in the archive").
- [ ] **Step 2: Backup.** Khối "Sao lưu tự động" ("Automatic backup") đặt trên cùng: trạng thái lượt gần nhất (giờ, dung lượng, số ảnh đã chép, lỗi nếu có), lượt kế tiếp, thư mục đích; form 6 trường của `backup` lưu qua `PUT /systems/config`, lỗi `INVALID_BACKUP_DIR` hiện tại chỗ; nút "Sao lưu ngay" ("Back up now"). `TABLE_LABEL` thêm `comment_revision: ['Bản sửa bình luận', 'Comment revisions']`, `backup_run: ['Lịch sử sao lưu', 'Backup history']`.
- [ ] **Step 3: `npm run typecheck` và `npm run build`** → PASS.

---

### Task 9: Kiểm thử trong app (diễn đàn mẫu, dữ liệu tạm)

**Files:**
- Modify: `.claude/launch.json` (cấu hình `glean-dev-sandbox` trỏ `GLEAN_DATA_DIR` vào thư mục scratchpad của phiên này)

- [ ] **Step 1:** Khởi động `glean-dev-sandbox`, tạo tài khoản, chờ đồng bộ tự động lần đầu.
- [ ] **Step 2: Sửa/xóa.** Chọn một chủ đề có hoạt động gần đây, gọi `_edit-post` cho một bài và `_toggle-post-delete` cho một bài khác trên trang cuối; bấm "Đồng bộ ngay" bình luận. Kỳ vọng: tìm bình luận với "Chỉ bình luận đã sửa/xóa" ra đúng hai bài; nhãn "đã sửa · 1 lần" mở ra bản cũ; nhật ký có mục "~1 sửa" và "−1 đã xóa".
- [ ] **Step 3: Sàng lại.** Sàng chủ đề đó; xóa thêm một bài có ảnh; "Sàng lại" → ảnh của bài đã xóa còn, mang nhãn "Không còn trên diễn đàn". Rồi `_toggle-delete` cả chủ đề và "Sàng lại" → mọi ảnh vẫn còn, có nhãn bài đã bị xóa.
- [ ] **Step 4: Sao lưu.** Bấm "Sao lưu ngay" → tệp `glean-auto-*.db` và thư mục `media/` xuất hiện trong thư mục đích; trạng thái hiện trên trang.
- [ ] **Step 5:** `npm test`, `npm run typecheck`, `npm run build` đều sạch; chụp màn hình nhãn sửa/xóa và khối sao lưu làm bằng chứng.
