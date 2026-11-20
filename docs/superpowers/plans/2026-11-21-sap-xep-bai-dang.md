# Sắp xếp bài đăng theo like / lượt xem / bình luận — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Trang Tìm kiếm > Bài đăng xếp được theo Nhiều lượt xem và Nhiều like (tổng like cả topic), cạnh Mới nhất và Nhiều bình luận.

**Architecture:** Lượt xem đọc từ trang danh sách diễn đàn khi đồng bộ bài; like đọc từ reactionsBar của từng post khi đồng bộ bình luận, lưu vào `comment.like_count` rồi cộng dồn vào `thread.like_count`. API `/posts/search` sort theo hai cột mới; `Search.tsx` thêm option và hiện số.

**Tech Stack:** Node 22 (`node:sqlite`), Fastify, cheerio, React 18, `node:test` qua `tsx`.

**Spec:** `docs/superpowers/specs/2026-11-21-sap-xep-bai-dang-design.md`

## Global Constraints

- Chạy test bằng `npm test` (có `--import ./server/test/setup.ts`); mọi file `*.test.ts` mới phải import `../test/setup.ts` / `./test/setup.ts` ở dòng đầu. Test và kiểm tra không bao giờ chạm `data/` hay diễn đàn thật.
- Cột mới: `INTEGER NOT NULL DEFAULT 0`, thêm bằng `ensureColumn` trong `migrate()` (DB cũ phải tự nâng cấp).
- Chuỗi giao diện dùng `t('…vi…', '…en…')`; nhãn: "Nhiều lượt xem nhất"/"Most views", "Nhiều like nhất"/"Most likes", "N lượt xem"/"N views", "N like"/"N likes".
- Hòa nhau thì xếp tiếp theo `t.created_at DESC`.
- `ParsedPost.likes` và `ListedThread.views` là trường tùy chọn (`?: number`, thiếu = 0) để fixture test hiện có không phải sửa.

## Review Focus

1. Post không có reactionsBar → 0 like, không lỗi (test ở Task 1).
2. "N người khác" viết dạng rút gọn/có dấu chấm ("1.234 người khác") → dùng `parseCount` (test ở Task 1).
3. Forum listing chỉ có một `dl` (giao diện không có cột Lượt xem) → views = 0, không lấy nhầm số trả lời (test ở Task 1).
4. Chỉ lượt xem thay đổi → vẫn ghi `view_count` nhưng `upsertThread` trả `action: null` (không tính là cập nhật trong lịch sử đồng bộ) (test ở Task 2).
5. Like của một post giảm/tăng khi trang được đọc lại → `comment.like_count` và tổng topic cập nhật theo, kể cả khi nội dung không đổi (test ở Task 2).

---

### Task 1: Đọc lượt xem và like từ HTML diễn đàn

**Files:**
- Modify: `server/source/xenforo.ts` (interfaces `ListedThread`, `ParsedPost`; `fetchForumPage`; `parseThreadHtml`)
- Modify: `server/demo/forum.ts` (thêm `<dl><dt>Lượt xem</dt><dd>…</dd></dl>` vào ô meta và `.reactionsBar` cho một số post, số liệu tất định theo id)
- Test: `server/source/xenforo.test.ts`

**Interfaces:**
- Produces: `ListedThread.views?: number`; `ParsedPost.likes?: number`; `export function parseForumHtml(html: string, pageUrl: string): { threads: ListedThread[]; totalPages: number }` (tách phần parse ra khỏi `fetchForumPage`, `fetchForumPage` gọi lại nó).

- [ ] **Step 1: Viết test hỏng**
  - `parseThreadHtml counts reactions: named users plus "others"` — post có `<div class="reactionsBar"><a class="reactionsBar-link"><bdi>An</bdi>, <bdi>Bình</bdi> và 12 người khác</a></div>` → `likes === 14`; post chỉ có `<bdi>An</bdi>` → `1`; post không có reactionsBar → `0`.
  - `"1.234 người khác"` → `likes === 1235` với một tên; tiếng Anh `"An and 3 others"` → `4`.
  - `parseForumHtml reads views from the second meta pair` — item có hai `dl` (Trả lời 5, Lượt xem 1,2K) → `replies 5`, `views 1200`; item chỉ có một `dl` → `views 0`.
- [ ] **Step 2: `npm test` — các test mới FAIL** (`parseForumHtml` chưa có, `likes` undefined).
- [ ] **Step 3: Cài đặt.** Like: trong `.reactionsBar` của article, đếm `bdi` (nếu không có thì `.username`), cộng `parseCount` của số đứng trước "người khác|others" (regex trên text). Views: `item.find('.structItem-cell--meta dl').eq(1).find('dd').first().text()`, rỗng → 0. Diễn đàn mẫu: thêm ô lượt xem và reactionsBar.
- [ ] **Step 4: `npm test` — PASS; `npm run typecheck` — sạch.**
- [ ] **Step 5: Commit** `Read view and like counts from forum pages`

### Task 2: Lưu và cộng dồn số liệu

**Files:**
- Modify: `server/db.ts` (`migrate`: 3 cột + `CREATE INDEX IF NOT EXISTS ix_thread_views ON thread(view_count DESC)`, `ix_thread_likes ON thread(like_count DESC)`)
- Modify: `server/sync.ts` (`upsertThread`, `upsertComments`)
- Test: `server/sync.test.ts`

**Interfaces:**
- Consumes: `ListedThread.views`, `ParsedPost.likes` (Task 1).
- Produces: cột `thread.view_count`, `thread.like_count`, `comment.like_count`.

- [ ] **Step 1: Viết test hỏng**
  - `upsertThread stores views; a views-only change is saved but not counted as an update` — insert với `views: 10` → `view_count 10`; gọi lại cùng dữ liệu, `views: 25` → trả `{ action: null }`, `view_count 25`.
  - `upsertComments keeps per-post likes and sums them on the thread` — 2 post likes 3 và 4 → `thread.like_count 7`; gọi lại cùng nội dung, likes 3 và 1 → `comment.like_count` của post 2 là 1, `thread.like_count 4`.
- [ ] **Step 2: `npm test` — FAIL.**
- [ ] **Step 3: Cài đặt.** `upsertThread`: thêm `view_count` vào INSERT và UPDATE; nhánh "không đổi" chạy `UPDATE thread SET view_count=? WHERE id=? AND view_count<>?` rồi vẫn trả `action: null`. `upsertComments`: INSERT kèm `like_count`; với post đã có, `UPDATE comment SET like_count=? WHERE id=? AND like_count<>?`; câu cập nhật cuối thêm `like_count=(SELECT COALESCE(SUM(like_count),0) FROM comment WHERE thread_id=?)`.
- [ ] **Step 4: `npm test` — PASS; typecheck sạch.**
- [ ] **Step 5: Commit** `Keep view and like counts for threads`

### Task 3: Sort trong API và giao diện

**Files:**
- Modify: `server/search.ts` (`PostSearchBody.sortDescendingField`, `searchPosts`)
- Modify: `web/src/pages/Search.tsx` (`PostItem`, `sort`, `tabQuery`, `<select>`, dòng kết quả)
- Test: `server/search.test.ts`

**Interfaces:**
- Consumes: cột Task 2.
- Produces: `sortDescendingField?: 'createdAt' | 'commentCount' | 'viewCount' | 'likeCount'`; mỗi item trả thêm `viewCount`, `likeCount`.

- [ ] **Step 1: Viết test hỏng** `searchPosts sorts by views and by likes` — 3 thread khớp từ khóa với (views, likes) = (5, 9), (50, 1), (20, 4) → `viewCount` cho thứ tự views 50, 20, 5; `likeCount` cho 9, 4, 1; item có `viewCount`, `likeCount`.
- [ ] **Step 2: `npm test` — FAIL.**
- [ ] **Step 3: Cài đặt.** Server: map field → `t.comment_count` / `t.view_count` / `t.like_count` + `DESC, t.created_at DESC`; giá trị lạ → `t.created_at DESC`; SELECT thêm hai cột. Web: `sort` nhận 4 giá trị từ URL (ngoài 3 giá trị kia → `createdAt`); `tabQuery` và `onChange` giữ mọi giá trị khác `createdAt`; thêm 2 `<option>`; dòng kết quả thêm `<span>` lượt xem và like sau số bình luận.
- [ ] **Step 4: `npm test` PASS, `npm run typecheck` sạch, `npm run build` thành công.**
- [ ] **Step 5: Kiểm tra trên trình duyệt** với dev server dùng thư mục dữ liệu tạm và diễn đàn mẫu (không dùng `data/`): đồng bộ bài + bình luận, chọn từng kiểu sort, thấy thứ tự đổi đúng và số hiện trên từng dòng; chụp màn hình.
- [ ] **Step 6: Commit** `Sort posts by views and likes`
