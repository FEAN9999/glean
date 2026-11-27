# Sàng lại hàng loạt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sàng lại nhiều bài đã sàng cùng lúc từ Kho: theo bài đã chọn, hoặc tất cả.

**Architecture:** Một endpoint server `POST /api/scrapes/retry-many` chạy `prepareRerun` cho từng lượt đủ điều kiện rồi `kick()` một lần. Trang Kho (`SievePage`) có ô chọn mỗi dòng, thanh thao tác khi đã chọn, và nút "Sàng lại tất cả" có hỏi xác nhận; số bài lấy từ meta `total` mới của `/api/scrapes/processed`.

**Tech Stack:** Fastify 5, node:sqlite qua `server/db.ts`, React 18, `node --test` + tsx.

**Spec:** `docs/superpowers/specs/2026-11-27-sang-lai-hang-loat-design.md`

## Global Constraints

- Mọi chữ hiển thị có cả tiếng Việt và tiếng Anh qua `t(vi, en)`; lỗi server dùng `ApiError(status, code, [vi, en], display)`.
- Chỉ lượt `Completed`/`Failed` và `is_marked_deleted=0` được sàng lại; `Waiting`/`Processing` bỏ qua.
- Tạm dừng sàng (`maintenance.scrape.isPaused`) → từ chối bằng `assertNotPaused(req, 'scrape')`.
- Test và kiểm tra không bao giờ chạm `data/` hay diễn đàn thật: test server import `./test/setup.ts` đầu file; giao diện chỉ thử trên bản scratch (`GLEAN_DATA_DIR` ngoài repo, cổng ≠ 4318), không dùng `glean-dev`.

## Review Focus

- `ids` trùng nhau → mỗi lượt chỉ sàng lại một lần, `queued` không đếm trùng.
- `ids` không tồn tại, đang chờ, hoặc đã xóa → không đổi gì, đếm vào `skipped`.
- Body sai kiểu (`ids` không phải mảng số nguyên dương, mảng rỗng, thiếu cả `ids` lẫn `all`) → 400, không đổi gì.
- Bấm "Sàng lại" khi các dòng đã chọn biến khỏi Kho (lượt khác đã chạy) → server bỏ qua, toast nói đúng số đã đưa vào hàng đợi.
- Sau khi đưa vào hàng đợi, các dòng đó rời Kho; lựa chọn phải được xóa để không còn id "ma".

---

### Task 1: Endpoint `retry-many` và meta `total`

**Files:**
- Modify: `server/scraper.ts` (thêm `retryMany` cạnh `prepareRerun`; route cạnh `/api/scrapes/:id/retry`; meta `total` trong `/api/scrapes/processed`)
- Test: `server/scraper.test.ts`

**Interfaces:**
- Produces: `export function retryMany(sel: { ids?: unknown; all?: unknown }): { queued: number; skipped: number }` — ném `ApiError(400, 'INVALID_SELECTION', …, 'toast')` khi body sai.
- Produces: `POST /api/scrapes/retry-many` body `{ ids: number[] } | { all: true }` → `ok({ queued, skipped })`.
- Produces: `GET /api/scrapes/processed` meta thêm `total: number` (số lượt Completed/Failed chưa xóa).

- [ ] **Step 1: Write the failing tests** (trong `server/scraper.test.ts`, dùng `newScrape`, `savePageItems`, `count`; tạm dừng sàng trong `try/finally` như test ISSUE-009 để hàng đợi không chạy nền)

```ts
test('retry-many queues the chosen finished jobs once and skips the rest', () => {
  // paused config only for the background queue; retryMany itself does not check pause
  const done = newScrape(), failed = newScrape(), queued = newScrape(), gone = newScrape();
  savePageItems(done.id, 1, [post(301, 1, [A])], 1);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Completed, done.id);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Failed, failed.id);
  run('UPDATE scrape SET status=? WHERE id=?', ScrapeStatus.Waiting, queued.id);
  run('UPDATE scrape SET status=?, is_marked_deleted=1 WHERE id=?', ScrapeStatus.Completed, gone.id);
  const r = retryMany({ ids: [done.id, done.id, failed.id, queued.id, gone.id, 999999] });
  assert.deepEqual(r, { queued: 2, skipped: 3 });
  for (const id of [done.id, failed.id]) assert.equal(get<{ status: number }>('SELECT status FROM scrape WHERE id=?', id)!.status, ScrapeStatus.Waiting);
  assert.equal(get<{ run_no: number }>('SELECT run_no FROM scrape WHERE id=?', done.id)!.run_no, /* before + 1 */ …);
  assert.equal(count('scrape_image', done.id), 1); // kept
  assert.equal(get<{ is_marked_deleted: number }>('SELECT is_marked_deleted FROM scrape WHERE id=?', gone.id)!.is_marked_deleted, 1);
});

test('retry-many with all queues every finished job that is not deleted', () => {
  // every Completed/Failed, non-deleted row in the test db becomes Waiting; queued = that count
  // assert no Completed/Failed non-deleted rows remain, and a deleted one is untouched
});

test('retry-many refuses a malformed selection without changing anything', () => {
  for (const bad of [{}, { ids: [] }, { ids: 'x' }, { ids: [1.5] }, { ids: [-1] }, { all: 'yes' }])
    assert.throws(() => retryMany(bad as never), (e: ApiError) => e.status === 400 && e.code === 'INVALID_SELECTION');
});

test('retry-many route is refused while sieving is paused, and processed reports total', async () => {
  // Fastify() + registerScraper(app); paused → inject POST /api/scrapes/retry-many {all:true} → 503 FEATURE_PAUSED
  // GET /api/scrapes/processed?size=1 → json().total equals SELECT COUNT(*) … status IN (Completed, Failed) AND is_marked_deleted=0
});
```

Ghi `run_no` trước khi gọi để so `+1`. Các test dùng `isPaused: true` trong `try/finally` để `kick()` không chạy lượt nào.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -- --test-name-pattern="retry-many"` (hoặc `node --import tsx --import ./server/test/setup.ts --test --test-name-pattern=retry-many server/scraper.test.ts`)
Expected: FAIL — `retryMany` is not exported.

- [ ] **Step 3: Implement `retryMany` và route**

Kiểm body: `all === true`, hoặc `ids` là mảng không rỗng gồm số nguyên dương; ngoài ra ném 400 `INVALID_SELECTION` (["Chưa chọn bài nào để sàng lại.", "No threads chosen to sieve again."]). Khử trùng `ids`; lấy các id đủ điều kiện bằng một `SELECT id FROM scrape WHERE status IN (Completed, Failed) AND is_marked_deleted=0` (thêm `AND id IN (…)` khi có `ids`); với mỗi id: `prepareRerun(id)` rồi `emit(Ev.NewScrape, summary(id), undefined, 'scrape')`; `kick()` một lần nếu `queued > 0`. `skipped = ids ? uniqueIds.length - queued : 0`. Route gọi `assertNotPaused(req, 'scrape')` trước. Thêm `total` vào meta của `/processed`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all pass (gồm `server/test/isolation.test.ts`).

- [ ] **Step 5: Commit** (chỉ khi người dùng bảo commit)

---

### Task 2: Chọn nhiều và "Sàng lại tất cả" ở Kho

**Files:**
- Modify: `web/src/pages/Sieve.tsx` (`LibraryRow`, `SievePage`)
- Modify: `web/src/styles.css` (ô chọn trong `.lib-row`, thanh thao tác)

**Interfaces:**
- Consumes: `POST /scrapes/retry-many` → `{ queued, skipped }`; meta `total` của `/scrapes/processed`.
- Consumes: `useUi()` → `toast(msg, kind?, action?)`, `ask(title, body, okLabel, danger?)` (như `SieveDetail.tsx`).

- [ ] **Step 1: Ô chọn mỗi dòng**

`LibraryRow` nhận `picked: boolean` và `onPick(id, on)`. Ô chọn nằm ngoài `<Link>` (bấm ô không mở bài), có `aria-label` = tiêu đề bài. Ô ở tiêu đề bảng chọn/bỏ hết các bài đang hiện (`items`), trạng thái `indeterminate` khi chọn một phần.

- [ ] **Step 2: Thanh thao tác và nút "Sàng lại tất cả"**

`picked: Set<number>` trong `SievePage`. Khi `picked.size > 0`: thanh "Đã chọn N bài · [Sàng lại] · [Bỏ chọn]" trên bảng. Nút "Sàng lại tất cả" ở hàng tab, ẩn khi Kho rỗng; bấm → `ask('Sàng lại toàn bộ N bài?', 'Mỗi bài đọc lại mọi trang, có thể mất lâu. Dữ liệu đã lưu được giữ.', 'Sàng lại tất cả')` với N = `total` từ `/processed`. Lưu `total` từ lần tải đầu (`r.total`).

- [ ] **Step 3: Sau khi gửi**

Thành công: toast "Đã đưa N bài vào hàng đợi sàng." (thêm " Bỏ qua M bài đang chờ hoặc đã xóa." khi `skipped > 0`) với action "Xem hàng đợi" → `navigate('/hang-doi')` (kiểm đường dẫn Hàng đợi thật trong `web/src/main.tsx`); xóa `picked`; `load(true, null)`. Lỗi: client đã toast, giữ nguyên lựa chọn. Khóa nút trong lúc gửi.

- [ ] **Step 4: Kiểm tra**

Run: `npm run typecheck`, `npm run lint`, `npm test` → sạch.
Trên bản scratch (diễn đàn mẫu): sàng 3 bài, chọn 2 → "Sàng lại" → toast đúng số, 2 dòng rời Kho rồi quay lại khi xong; "Sàng lại tất cả" → hộp xác nhận đúng số; bấm ô chọn không mở bài; chiều rộng điện thoại không tràn ngang. Chụp màn hình làm bằng chứng.

- [ ] **Step 5: Commit** (chỉ khi người dùng bảo commit)
