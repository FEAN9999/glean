# Nhiều trang trong một Glean Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một Glean quản lý nhiều diễn đàn XenForo. Mỗi trang có kho SQLite và thư mục ảnh riêng. Tìm kiếm và Lưu trữ đã sàng xem gộp được, dòng nào cũng ghi tên trang. Bộ đọc chạy được với rphang.land.

**Architecture:** `db.ts` giữ ngữ cảnh "trang đang làm" bằng `AsyncLocalStorage`. Các hàm `all/get/run/tx` dùng kho của ngữ cảnh đó; nếu không có ngữ cảnh thì ném `NoSiteError`. Bảng dùng chung (tài khoản, cài đặt chung, sao lưu, lịch sử tìm, danh sách trang) đi qua `mainAll/mainGet/mainRun/mainTx`. `site.ts` quản lý danh sách trang và mở kho từng trang. Nó gắn một hook Fastify đọc header `x-glean-site` để chạy mỗi yêu cầu trong đúng ngữ cảnh. Hàng đợi sàng, hẹn giờ đồng bộ và đồng bộ thủ công tách theo mã trang. Xem gộp chạy cùng truy vấn trên từng kho rồi ghép bằng `mergeTop`.

**Tech Stack:** Node ≥ 22.13 (`node:sqlite`, `AsyncLocalStorage`), Fastify 5, cheerio, React 18 + react-router 7, `node --test` + tsx.

**Spec:** `docs/superpowers/specs/2026-11-28-nhieu-trang-design.md`

## Global Constraints

- **Song ngữ:** mọi chữ hiển thị đi qua `t('tiếng Việt', 'English')`. Lỗi server dùng `ApiError(status, code, [vi, en], display)`.
- **Hệ thiết kế:** chỉ một màu nhấn (`--acc`). Phân biệt trang bằng **tên**: nhãn dùng lớp `tag` có sẵn trong `web/src/styles.css`, không gán màu cho từng trang (theo `DESIGN.md`).
- **Không trang mặc định ngầm:** gọi kho trang khi không có ngữ cảnh thì ném `NoSiteError`. Route riêng từng trang thiếu `x-glean-site`, hoặc gửi mã không tồn tại, thì trả 400 với code `SITE_REQUIRED` hoặc `SITE_UNKNOWN`.
- **Kho chính giữ nguyên:**
  - `data/glean.db` và `storage.basePath` (mặc định `data/media`) không di chuyển. Lần chạy đầu của bản mới chỉ thêm (bảng `site`, cột `backup_run.site_code`), không sửa dòng cũ.
  - Link ảnh `/media/scrapes/<id>/…` của trang chính không đổi.
- **Trang thêm sau:** kho `data/sites/<mã>/glean.db`, ảnh `data/sites/<mã>/media/`, URL ảnh `/media/sites/<mã>/scrapes/<id>/…`. Mã khớp `^[a-z0-9][a-z0-9-]{0,31}$`.
- **Mã gộp:** header `x-glean-site: *` nghĩa là mọi trang. Chỉ các route trong `MERGE_ROUTES` (Task 4) nhận giá trị này.
- **Phần cài đặt riêng từng trang:** `source`, `sync`, `scraper`, `maintenance`, cùng `search.semanticSearchUrl` và `search.semanticTopK`. Phần còn lại là chung.
- **An toàn dữ liệu:**
  - Mọi `server/**/*.test.ts` nạp `./test/setup.ts` đầu tiên. Test không gọi mạng thật.
  - Kiểm tra giao diện chỉ trên bản nháp (`GLEAN_DATA_DIR` ngoài repo, cổng khác 4318, mở bằng `http://localhost:<cổng>`).
  - Không khởi động lại bản đang chạy ở 4318 nếu anh chưa yêu cầu.
- **Lệnh kiểm tra:** `npm test`, `npm run typecheck`, `npm run lint`. Cả ba phải xanh ở cuối mỗi task.

## Review Focus

- **Cùng một ID bài trên hai trang, sàng cùng lúc:** mỗi lượt ghi vào kho của trang mình. Sự kiện mang mã trang, nên trang chi tiết của trang A không cập nhật theo sự kiện của trang B dù trùng id. (Task 6: test hai kho; Task 13: test `eventMatches`.)
- **Link có `www.`, chữ hoa, hoặc khác http/https:** vẫn khớp đúng trang, vì so tên máy chủ sau khi viết thường và bỏ `www.` ở đầu. (Task 4: test `siteForHost`.)
- **Gỡ trang khi hàng đợi hay đồng bộ của trang đó đang chạy:** lượt đang chạy kết thúc trong kho của chính nó; không lượt mới nào được lấy; hẹn giờ bị hủy; không ghi gì sang kho khác. (Task 6 và Task 7: test gỡ trang.)
- **Link chi tiết cũ không có `?trang=`** (đánh dấu từ trước khi có nhiều trang): mở ở trang chính. (Task 15: test `detailSite`.)
- **Thêm trang có tên miền trùng địa chỉ hoặc tên miền cũ của trang khác:** bị từ chối, để việc nhận trang theo tên miền không bao giờ mơ hồ. (Task 4: test `addSite`.)

---

### Task 1: Bộ đọc XenForo nhận `/t/`, `/box/` và ảnh `data-url` rỗng

**Files:**
- Modify: `server/source/xenforo.ts` (`parseThreadRef`, `fetchForumIndex`, `parseForumHtml`, `parseThreadHtml`)
- Modify: `web/src/lib/format.ts` (`parseThreadInput`, `isLinkLike`)
- Test: `server/source/xenforo.test.ts`, `web/src/lib/format.test.ts`

**Interfaces:**
- Produces: `parseThreadRef` nhận cả `/threads/<slug>.<id>/` lẫn `/t/<slug>.<id>/`. Bộ đọc chuyên mục nhận `/forums/` và `/box/`. Kiểu trả về không đổi.
- Produces: `parseThreadInput(s)` và `isLinkLike(s)` ở phía web cũng nhận `/t/`.

- [ ] **Step 1: Viết test hỏng.** Thêm vào `server/source/xenforo.test.ts`:
  - `test('parseThreadRef reads /t/ links')`: `parseThreadRef('https://rphang.land/t/chao-ae.200791/').threadId === 200791`; `parseThreadRef('/t/abc.5/page-2').threadId === 5`.
  - `test('forum list and breadcrumbs accept /box/')`: gọi `parseForumHtml` trên HTML mẫu có `.structItem--thread` với `<div class="structItem-title"><a href="/t/bai-a.77/">Bài A</a></div>` → `threads[0].id === 77`. Gọi `parseThreadHtml` trên HTML có `.p-breadcrumbs a[href="/box/hang.127/"]` → `forumId === 127`.
  - `test('an empty data-url falls back to src')`: bài có `<div class="bbWrapper"><img class="bbImage" data-url="" src="https://rphang.land/attachments/a-jpeg.1/"></div>` → `posts[0].images` deep-equals `['https://rphang.land/attachments/a-jpeg.1/']`.
  - `test('internal /t/ and /box/ links are not counted as links')`: bài có `<a href="https://rphang.land/t/khac.9/">x</a>` → `links.length === 0`.

  Thêm vào `web/src/lib/format.test.ts`: `parseThreadInput('https://rphang.land/t/a.123/') === 123`; `isLinkLike('rphang.land/t/a.1/') === true`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/source/xenforo.test.ts web/src/lib/format.test.ts`. Expected: 5 test mới FAIL.
- [ ] **Step 3: Sửa các regex và bộ chọn.**
  - Trong các regex: `\/threads\/` thành `\/(?:threads|t)\/`, `\/forums\/` thành `\/(?:forums|box)\/`.
  - Bộ chọn `a[href*="/threads/"]` thành `a[href*="/threads/"], a[href*="/t/"]`. Breadcrumbs và `fetchForumIndex` làm tương tự với `/box/`.
  - Bộ lọc link nội bộ: `/(threads|t|box|forums|members|posts|goto)/`.
  - Ảnh: đổi chuỗi `??` thành một hàm `firstNonEmpty(...vals)` trả về giá trị đầu tiên khác rỗng.
  - `threadUrl` và `forumUrl` vẫn dựng `/threads/`, `/forums/`.
- [ ] **Step 4: Chạy lại.** Cùng lệnh ở Step 2. Expected: PASS, gồm cả các test XenForo cũ.
- [ ] **Step 5: Commit.** `git add server/source web/src/lib/format.ts web/src/lib/format.test.ts && git commit -m "fix(reader): read forums that use /t/ and /box/ links and images with an empty data-url"`

---

### Task 2: Ngữ cảnh trang trong `db.ts`

**Files:**
- Modify: `server/db.ts`, `server/test/setup.ts`
- Modify: `server/auth.ts` (bảng `app_user` và `refresh_token` đổi sang `main*`)
- Test: `server/db.test.ts`

**Interfaces:**
- Produces (`server/db.ts`):
  - `export interface StoreCtx { code: string; db: DatabaseSync }`
  - `export class NoSiteError extends Error`
  - `export const mainDb: DatabaseSync`. Giữ `export const db = mainDb` cho test cũ.
  - `export function openStore(file: string): DatabaseSync`: tạo thư mục, đặt PRAGMA, chạy lược đồ và `migrate`. `mainDb` cũng được mở bằng hàm này.
  - `export function runInSite<T>(ctx: StoreCtx, fn: () => T): T`
  - `export function siteCtxOrNull(): StoreCtx | null`: ngữ cảnh ALS, hoặc ngữ cảnh dự phòng của test.
  - `export function siteDb(): DatabaseSync`: ném `NoSiteError` khi không có ngữ cảnh.
  - `all/get/run/tx` giữ chữ ký cũ, nhưng chạy trên `siteDb()`.
  - `mainAll/mainGet/mainRun/mainTx` có chữ ký giống hệt, nhưng luôn chạy trên `mainDb`.
  - `export function setTestFallback(fn: (() => StoreCtx) | null): (() => StoreCtx) | null`: trả về fallback cũ. Ném lỗi nếu không có `NODE_TEST_CONTEXT` và `NODE_ENV !== 'test'`.
- Produces (lược đồ):
  - `CREATE TABLE IF NOT EXISTS site (code TEXT PRIMARY KEY, name TEXT NOT NULL, is_main INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, removed_at TEXT)`
  - Bước `migrate` thứ 4: `ensureColumn(d, 'backup_run', 'site_code', 'TEXT')`.

- [ ] **Step 1: Viết test hỏng.** Thêm vào `server/db.test.ts`:
  - `test('site helpers use the store of the current site')`: `openStore(<tmp>/b.db)`; `runInSite({code:'b', db: b}, () => run("INSERT INTO forum(id,name) VALUES(1,'B')"))`. Sau đó `mainGet("SELECT name FROM forum WHERE id=1")` là `undefined`, còn `runInSite(b, () => get(...)).name === 'B'`.
  - `test('without a site the helpers throw NoSiteError')`: `const prev = setTestFallback(null)`; trong `try`, `assert.throws(() => get('SELECT 1'), NoSiteError)`; trong `finally`, `setTestFallback(prev)`.
  - `test('the context follows async work and timers')`: `await runInSite(bCtx, async () => { await new Promise(r => setTimeout(r, 5)); return siteCtxOrNull()!.code })` → `'b'`.
  - `test('migrate step 4 adds backup_run.site_code')`: kho mới có cột `site_code`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/db.test.ts`. Expected: FAIL (`openStore`/`runInSite` chưa có).
- [ ] **Step 3: Cài đặt trong `server/db.ts`.**
  - Bộ đệm câu lệnh đã chuẩn bị tách theo kho: `WeakMap<DatabaseSync, Map<string, StatementSync>>`, giới hạn 300 câu mỗi kho như cũ.
  - `tx(fn)` và `mainTx(fn)` dùng `BEGIN/COMMIT/ROLLBACK` trên đúng kho.
  - `server/test/setup.ts`: sau khi đặt `GLEAN_DATA_DIR`, nạp động `../db.ts` và `../site.ts`, rồi gọi `setTestFallback(() => mainSite())`. `mainSite` có từ Task 4; cho tới lúc đó tạm dùng `() => ({ code: 'main', db: mainDb })`, và Task 4 thay lại.
  - `server/auth.ts`: đổi mọi truy vấn bảng `app_user` và `refresh_token` sang `mainGet/mainRun/mainAll`.
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS, test cũ chạy nhờ ngữ cảnh dự phòng.
- [ ] **Step 5: Commit.** `git commit -am "feat(db): run queries in the store of the current site"`

---

### Task 3: Tách cài đặt chung và riêng từng trang

**Files:**
- Modify: `server/config.ts`, `server/net.ts`
- Test: `server/config.test.ts`

**Interfaces:**
- Consumes: `runInSite`, `siteCtxOrNull`, `mainAll/mainRun` (Task 2).
- Produces (`server/config.ts`):
  - `export const SITE_SECTIONS = ['source', 'sync', 'scraper', 'maintenance'] as const`
  - `export const SITE_SEARCH_FIELDS = ['semanticSearchUrl', 'semanticTopK'] as const`
  - `export type SharedConfig = Omit<AppConfig, (typeof SITE_SECTIONS)[number]>`
  - `cfg(): AppConfig`:
    - Trong ngữ cảnh trang: trả về cài đặt chung ghép với phần riêng của trang đó, có cache theo mã trang.
    - Ngoài ngữ cảnh: trả về một đối tượng mà truy cập phần chung bình thường, còn truy cập `source`, `sync`, `scraper` hay `maintenance` thì ném `NoSiteError`.
  - `loadConfig(port): AppConfig`: chữ ký không đổi. Nạp phần chung từ kho chính, và phần riêng của trang chính (cũng nằm ở kho chính). Trả về cài đặt đã ghép của trang chính.
  - `export function loadSiteConfig(ctx: StoreCtx, init?: { baseUrl: string }): AppConfig`:
    - Đọc phần riêng từ bảng `config` của kho trang, bổ sung chỗ thiếu bằng mặc định (`source.forums = []`).
    - Lần đầu, khi có `init`, ghi `source.baseUrl = init.baseUrl`.
  - `updateConfig(patch, port)`:
    - Phần riêng ghi vào kho của ngữ cảnh. Thiếu ngữ cảnh thì ném `NoSiteError`.
    - Phần chung ghi vào kho chính.
    - Mục `search`: hai trường trong `SITE_SEARCH_FIELDS` đi về kho trang, các trường còn lại về kho chính.
  - `onConfigChange(l: (c: AppConfig, prev: AppConfig) => void)`: gọi **trong ngữ cảnh** của từng trang có cài đặt đã ghép thay đổi. Sửa phần riêng thì chỉ trang đó; sửa phần chung thì mọi trang đã nạp.
  - `export function onSharedConfigChange(l: (c: SharedConfig, prev: SharedConfig) => void)`
  - `export function forgetSiteConfig(code: string)`: bỏ cache khi gỡ trang.
- `Ev.ConfigReloaded` được phát trong ngữ cảnh của trang vừa đổi.
- `server/net.ts`:
  - `initNet` dùng `onSharedConfigChange` để dựng lại proxy.
  - `checkProxies` lấy đích kiểm tra từ `cfg().proxy.healthCheckUrl`. Nếu trống thì lấy `source.baseUrl` của trang chính qua `withSite(mainSite(), …)`. Cho tới Task 4: `runInSite` với kho chính.

- [ ] **Step 1: Viết test hỏng.** Thêm vào `server/config.test.ts`:
  - `test('site sections are stored in the store of the site')`: tạo kho B, `loadSiteConfig(bCtx, { baseUrl: 'http://b.test' })`. Trong `runInSite(bCtx)`: `updateConfig({ source: { postsPerPage: 33 } }, 0)`. Sau đó:
    - `runInSite(bCtx, () => cfg().source.postsPerPage) === 33`
    - `cfg().source.postsPerPage` (dự phòng là trang chính) vẫn bằng 20
    - `mainGet("SELECT value FROM config WHERE key='source'")` không chứa `33`
  - `test('shared sections are shared by every site')`: `updateConfig({ telegram: { chatId: 'x' } }, 0)` ngoài ngữ cảnh B → `runInSite(bCtx, () => cfg().telegram.chatId) === 'x'`.
  - `test('semantic search settings belong to each site')`: đổi `search.semanticSearchUrl` và `search.pageSize` trong ngữ cảnh B → B thấy URL mới, trang chính không thấy; `pageSize` mới cả hai cùng thấy.
  - `test('site sections outside a site throw')`: `const prev = setTestFallback(null)` → `assert.throws(() => cfg().source, NoSiteError)`, còn `cfg().auth.issuer === 'glean'`. Trong `finally`, `setTestFallback(prev)`.
  - `test('onConfigChange runs in the context of the changed site only')`: đăng ký listener ghi `siteCtxOrNull()?.code`. Đổi phần riêng của B → ghi được `['b']`. Đổi `telegram` → mỗi trang đã nạp được ghi một lần.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.** Kiểm tra kiểu và giới hạn số (`assertPatchTypes`, `cleanNumbers`, `NUMBER_MIN`) giữ nguyên trên toàn `AppConfig`. `unmaskPatch` và `maskedConfig` chạy trên cài đặt đã ghép.
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(config): keep source, sync and sieve settings in each site's store"`

---

### Task 4: Danh sách trang, hook `x-glean-site` và API `/api/sites`

**Files:**
- Create: `server/site.ts`
- Modify: `server/index.ts` (gọi `initSites()` sau `loadConfig`; `registerSites(app)` ngay sau `registerApiGuard`), `server/test/setup.ts` (fallback đổi sang `mainSite`)
- Test: `server/site.test.ts`

**Interfaces:**
- Consumes: Task 2, Task 3.
- Produces (`server/site.ts`):
  - `export interface Site extends StoreCtx { name: string; isMain: boolean; dir: string | null; dbPath: string }`: `dir` là `null` với trang chính.
  - `export function mainSite(): Site`:
    - Lười: lần đầu thì tạo dòng `site` với `is_main = 1` nếu chưa có.
    - Mã và tên lấy bằng `suggestSite(<source.baseUrl đọc thẳng từ bảng config của kho chính>)`. Không có giá trị nào hoặc là diễn đàn mẫu thì dùng `demo`.
    - Không gọi `cfg()`.
  - `export function initSites(): void`: mở kho và nạp cài đặt cho mọi dòng `site` chưa gỡ.
  - `export function sites(): Site[]`: trang chính đứng đầu, sau đó theo `created_at`.
  - `export function siteByCode(code: string): Site | undefined`
  - `export function currentSite(): Site`: ném `NoSiteError`.
  - `export function currentSiteOrNull(): Site | null`
  - `export function withSite<T>(s: Site | string, fn: () => T): T`
  - `export async function forEachSite<T>(fn: (s: Site) => T | Promise<T>): Promise<{ site: Site; value: T }[]>`: chạy lần lượt, mỗi trang trong ngữ cảnh của nó.
  - `export function normalizeHost(host: string): string`: viết thường, bỏ `www.` ở đầu.
  - `export function siteForHost(host: string): Site | undefined`: so với `source.baseUrl` và `source.previousBaseUrls` của mọi trang.
  - `export function suggestSite(baseUrl: string): { code: string; name: string }`
  - `export function assertHostFree(url: string, exceptCode?: string): void`: ném lỗi 409 `SITE_HOST_TAKEN` khi tên máy chủ (đã qua `normalizeHost`) trùng địa chỉ hoặc tên miền cũ của một trang khác `exceptCode`.
  - `export function addSite(input: { baseUrl: string; code: string; name: string }): Site`:
    - Kiểm tra mã hợp lệ.
    - Từ chối mã đang dùng, với lỗi 409 `SITE_CODE_TAKEN`.
    - Gọi `assertHostFree(input.baseUrl)`.
    - Mã trùng một dòng đã gỡ thì gắn lại kho cũ và xóa `removed_at`.
    - Tạo `data/sites/<mã>/`, `openStore` rồi `loadSiteConfig(…, { baseUrl })`.
  - `export function renameSite(code: string, name: string): Site`
  - `export function removeSite(code: string): void`:
    - Trang chính thì lỗi 400 `SITE_MAIN`.
    - Đặt `removed_at`, `forgetSiteConfig`, gọi các listener gỡ trang. Thư mục giữ nguyên.
    - **Không đóng kho**, để lượt đang chạy của trang đó kết thúc trong chính kho của nó. Handle được giữ trong một `Map` theo mã, và dùng lại khi thêm lại cùng mã.
  - `export function onSiteAdded(l: (s: Site) => void)` và `export function onSiteRemoved(l: (s: Site) => void)`
  - `export function siteMediaRoot(s = currentSite()): string`: trang chính dùng `cfg().storage.basePath`, trang khác dùng `<dir>/media`.
  - `export function siteMediaPrefix(s = currentSite()): string`: `'/media'` hoặc `` `/media/sites/${code}` ``.
  - `export function siteInfo(s: Site): { code: string; name: string; isMain: boolean; baseUrl: string; dir: string | null }`
  - `export function requestSite(req: FastifyRequest): Site | null`: `null` nghĩa là `*`.
  - `export function registerSites(app: FastifyInstance): void`
- Hook `onRequest` dạng callback, `(req, reply, done) => …`:
  - URL không bắt đầu bằng `/api/` thì bỏ qua.
  - `SHARED_ROUTES` thì không gắn ngữ cảnh. Gồm: `/api/auth/`, `/api/events`, `/api/backups/`, `/api/sites`, `/api/search-history/`, `/api/posts/search/recent-`, `/api/comments/recent-`, `/api/scrapes/check-proxy`, và `/api/systems/` với `version`, `environment`, `notify`, `force-reload`, `test-telegram`.
  - `MERGE_ROUTES` nhận mã hoặc `*`. Gồm: `POST /api/posts/search`, `POST /api/posts/search/count`, `GET /api/posts/search/suggestions`, `POST /api/comments/search`, `POST /api/comments/search-by-author`, `POST /api/comments/search/count`, `GET /api/scrapes/processed`, `POST /api/scrapes/create-scrape`, `PUT /api/systems/config`.
  - Mọi route `/api/` khác cần một mã cụ thể. Có mã thì chạy `runInSite(site, done)`. Với `*`, gán `req.site = null` và gọi `done()`.
- Route dùng chung:
  - `GET /api/sites` → `siteInfo[]`
  - `GET /api/sites/suggest?baseUrl=` → `{ code, name }`
  - `POST /api/sites` (`requireSudo`) → `siteInfo`
  - `PATCH /api/sites/:code` với body `{ name }` → `siteInfo`
  - `DELETE /api/sites/:code` (`requireSudo`) → `true`

- [ ] **Step 1: Viết test hỏng** trong `server/site.test.ts` (nạp `./test/setup.ts` đầu file; `loadConfig(0)`):
  - `test('the main site is created from the configured address and keeps data/glean.db')`: `mainSite().isMain === true`, `mainSite().dbPath === DB_PATH`, `mainSite().code === 'demo'`.
  - `test('addSite creates its own folder and store')`: `addSite({ baseUrl: 'https://rphang.land', code: 'rphang', name: 'rphang' })` → tồn tại `<DATA_DIR>/sites/rphang/glean.db`; `withSite('rphang', () => cfg().source.baseUrl) === 'https://rphang.land'`.
  - `test('addSite refuses a taken code or a host another site already uses')`: thêm `x1` với `https://x.test`. Thêm `x2` với `https://www.X.test` → `ApiError` `SITE_HOST_TAKEN`. Thêm `x1` với `https://y.test` → `SITE_CODE_TAKEN`. Mã `Bad Code` → 400.
  - `test('siteForHost ignores case and a leading www')`: `siteForHost('WWW.RPHANG.LAND')?.code === 'rphang'`; tên miền cũ của một trang cũng khớp.
  - `test('suggestSite turns a host into a code')`: `suggestSite('https://rphang.land').code === 'rphang'`.
  - `test('removeSite keeps the folder and re-adding the code reattaches it')`: ghi một dòng `forum` vào kho `rm1`, `removeSite('rm1')` → `siteByCode('rm1') === undefined`, thư mục vẫn còn. `addSite` lại `rm1` → dòng `forum` vẫn còn.
  - `test('site routes need x-glean-site and merge routes accept *')`: tạo `Fastify()`, `registerSites(app)`, thêm route thử `GET /api/threads/x` trả về `currentSite().code` và route `GET /api/scrapes/processed` trả về `requestSite(req)?.code ?? '*'`. Kiểm tra:
    - Không header → 400 `SITE_REQUIRED`
    - `x-glean-site: nope` → 400 `SITE_UNKNOWN`
    - `rphang` → `'rphang'`
    - `*` trên `/api/threads/x` → 400; trên `/api/scrapes/processed` → `'*'`
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/site.test.ts`. Expected: FAIL (thiếu module).
- [ ] **Step 3: Cài đặt `server/site.ts` theo Interfaces.**
  - Đưa `index.ts` vào: `initSites()` sau `loadConfig(PORT)`; `registerSites(app)` sau `registerApiGuard(app)`.
  - `setup.ts` chuyển fallback sang `mainSite`; `net.ts` chuyển sang `withSite(mainSite(), …)`.
  - Giải mã lỗi `NoSiteError` thoát ra từ handler thành `ApiError(400, 'SITE_REQUIRED', …)` trong `setErrorHandler`.
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add server/site.ts server/site.test.ts && git commit -am "feat(sites): a list of sites, each request runs in the site it names"`

---

### Task 5: Sự kiện, Telegram, ảnh và lịch sử tìm kiếm theo trang

**Files:**
- Modify: `server/events.ts`, `server/notify.ts`, `server/media.ts`, `server/search.ts` (`record`, `history`, route `DELETE /api/search-history/:kind`)
- Test: `server/events.test.ts` (tạo mới), `server/notify.test.ts`, `server/media.test.ts`, `server/search.test.ts`

**Interfaces:**
- Produces:
  - `emit(type, data, message?, group?)` gửi `{ type, data, message, site }`, trong đó `site = siteCtxOrNull()?.code ?? null`.
  - `telegram(text, force?)` thêm `` `[${currentSiteOrNull().name}] ` `` vào đầu tin khi đang trong ngữ cảnh trang.
  - Route `GET /media/sites/:code/*` đọc từ `siteMediaRoot(siteByCode(code))`. Cần cookie đăng nhập như `/media/*`. Mã lạ thì 404. `/media/*` giữ nguyên cho trang chính.
  - `search_history` luôn đọc/ghi qua `mainAll/mainRun`.

- [ ] **Step 1: Viết test hỏng.**
  - `test('events carry the site code')`: client giả qua `addClient`. `withSite('rphang', () => emit(Ev.NewScrape, {}))` → payload có `"site":"rphang"`; phát ngoài ngữ cảnh → `"site":null`.
  - `test('telegram messages start with the site name')`: chặn `fetch`. Gửi trong `withSite('rphang', …)` → `text` bắt đầu bằng `[rphang] `.
  - `test('/media/sites/:code serves that site's folder')`: ghi tệp `<dir rphang>/media/scrapes/1/a.jpg`, gọi kèm cookie hợp lệ → 200. `/media/sites/khong-co/…` → 404.
  - `test('search history is shared by all sites')`: tìm trong ngữ cảnh `rphang` → từ khóa xuất hiện trong `mainAll('SELECT keyword FROM search_history')`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `npm test`. Expected: các test mới FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sites): events, telegram, media and search history know the site"`

---

### Task 6: Sàng theo trang: hàng đợi song song, ảnh riêng, nhận trang theo tên miền

**Files:**
- Modify: `server/scraper.ts`
- Test: `server/scraper.test.ts`

**Interfaces:**
- Consumes: `currentSite`, `withSite`, `sites`, `siteForHost`, `siteInfo`, `siteMediaRoot`, `siteMediaPrefix`, `onSiteAdded`, `onSiteRemoved`, `requestSite` (Task 4).
- Produces:
  - **Hàng đợi:** `working` và `currentId` thành `Map<string, { working: boolean; currentId: number | null }>` theo mã trang. `kick()` khởi động hàng đợi của `currentSite()`. Vòng `work()` dừng khi trang đã bị gỡ (`!siteByCode(code)`).
  - `export function setThreadReader(fn: typeof fetchThreadPage): void`: chỉ để test thay bộ đọc trang mà hàng đợi dùng.
  - `initScraper()`: với mỗi trang, trong ngữ cảnh của nó, đặt lại các lượt `Processing` về `Waiting`, chạy `sweepExpired()` rồi `kick()`.
    - Dọn định kỳ chạy `forEachSite(sweepExpired)`.
    - `onSiteAdded` → `withSite(s, kick)`.
  - **Đường dẫn ảnh:** `scrapeDir(id)` dùng `siteMediaRoot()`. Mọi chuỗi `/media/scrapes/` thành `` `${siteMediaPrefix()}/scrapes/` ``, kể cả trong `copyArchive`.
  - `createScrape(input, source)` trả về `{ scrape, reused, rerun, domainWarning, site }`, với `site = siteInfo(...)`:
    - Link có tên máy chủ: `siteForHost(host)`. Không khớp trang nào → `ApiError(409, 'UNKNOWN_SITE', [...], 'inline')`, nói rõ tên miền và gợi ý "Cài đặt → Trang". Khớp thì chạy phần còn lại trong `withSite(target, …)`.
    - Chỉ số ID khi không có ngữ cảnh (`*`) → `ApiError(400, 'SITE_REQUIRED', …)`.
    - `domainWarning` chỉ còn trường hợp tên miền cũ của chính trang đó.
    - Bỏ lỗi `SOURCE_MISMATCH`.
  - `GET /api/scrapes/processed` và `GET /api/scrapes/:id` thêm `site: { code, name }` vào mỗi lượt.

- [ ] **Step 1: Viết test hỏng.**
  - `test('the same thread id is sieved into each site's own store')`: tạo lượt cho thread 4242 trong trang chính và trong `rphang`, chạy `processScrape` với bộ đọc giả. Kiểm tra `count('scrape_comment', idMain)` và `withSite('rphang', () => count('scrape_comment', idB))`; bình luận của mỗi kho mang chữ của trang mình.
  - `test('queues of two sites run at the same time')`: `setThreadReader` với một bộ đọc chờ một promise. Tạo lượt Waiting ở hai trang và `kick()` từng trang. Chờ tới khi cả hai lượt có `status === Processing` (kiểm tra bằng `get` trong từng ngữ cảnh), rồi mới thả promise.
  - `test('a link is queued on the site of its domain')`: đang ở trang chính, `createScrape('https://rphang.land/t/a.77/', 'direct')` → `r.site.code === 'rphang'`; dòng có trong kho `rphang`, không có trong kho chính.
  - `test('a link of an unknown domain is refused')`: `https://khong-co.test/threads/1/` → `UNKNOWN_SITE`.
  - `test('media of a non-main site is saved under its own folder and URL')`: bật tải ảnh với `fetchRaw` giả, chạy một lượt trong `rphang` → `current_url` bắt đầu bằng `/media/sites/rphang/scrapes/` và tệp nằm dưới `<dir>/media/scrapes/`.
  - `test('removing a site stops its queue')`: hai lượt Waiting ở trang `rm2`, bộ đọc giả. `removeSite('rm2')` trong lúc lượt đầu chạy → lượt thứ hai vẫn Waiting trong kho của nó; kho chính không có dòng nào mới.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/scraper.test.ts`. Expected: các test mới FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.** Sửa các test cũ đang mong lỗi `SOURCE_MISMATCH` sang `UNKNOWN_SITE`.
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sieve): each site has its own queue, media folder and is chosen by the link's domain"`

---

### Task 7: Đồng bộ theo trang

**Files:**
- Modify: `server/sync.ts`
- Test: `server/sync.test.ts`

**Interfaces:**
- Produces:
  - `autoRunning`, `timers`, `lastAuto` và đối tượng `manual` thành bản riêng theo mã trang. Dùng một hàm `syncState(code = currentSite().code)` trả về `{ autoRunning, timers, lastAuto, manual }`.
  - `runAutoSync(type)`, `schedule(type)`, `runManual(o)` và `manualStatus()` chạy trên trạng thái của trang hiện tại. Hẹn giờ được tạo trong ngữ cảnh, nên callback chạy đúng trang.
  - `initAutoSync()`: với mỗi trang, chạy lượt đầu và `schedule` trong ngữ cảnh. `onSiteAdded` khởi động cho trang mới. `onSiteRemoved` hủy hẹn giờ và yêu cầu dừng lượt thủ công của trang đó.
  - Mỗi trang tối đa một lượt đồng bộ thủ công; hai trang chạy cùng lúc được.
  - Route `/api/sync*`, `/api/sync-histories/*` và `/api/manual-syncs/*` dùng ngữ cảnh của yêu cầu.

- [ ] **Step 1: Viết test hỏng.**
  - `test('manual syncs of two sites can run together')`: khởi động lượt thủ công ở trang chính và ở `rphang`, bộ đọc chuyên mục giả chờ một promise. Lượt thứ hai không bị từ chối 409. `manualStatus()` của mỗi trang thấy `running: true`.
  - `test('auto sync of a site writes only to its store')`: `runAutoSync('posts')` trong `rphang` với bộ đọc giả trả về thread 5 → `thread` 5 có trong kho `rphang`, không có trong kho chính.
  - `test('removing a site clears its timers')`: `schedule('posts')` trong `rm3`, `removeSite('rm3')` → bộ hẹn giờ của `rm3` đã bị xóa (kiểm tra qua một hàm xuất chỉ dùng cho test, `syncTimersForTests(code)`).
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/sync.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.** Bộ đọc giả dùng cơ chế tiêm sẵn có của `sync.ts`. Nếu chưa có, thêm `setForumReader(fn)` giống `setThreadReader`.
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sync): auto and manual sync run per site"`

---

### Task 8: Tìm kiếm, cài đặt và tổng quan theo trang; tìm bình luận trong một bài

**Files:**
- Modify: `server/search.ts`, `server/system.ts`
- Test: `server/search.test.ts`, `server/system.test.ts`

**Interfaces:**
- Produces:
  - **Tìm trong một bài:** các route tìm bình luận nhận `threadId` là chuỗi link hoặc ID.
    - Link: `siteForHost(host)`. Không khớp → 400 `UNKNOWN_SITE`. Khớp trang khác trang của yêu cầu, hoặc yêu cầu là `*` → tìm trong `withSite(target)`, meta có `site: siteInfo(target)`.
    - ID khi là `*` → 400 `SITE_REQUIRED`.
  - `PUT /api/systems/config`: là `*` mà patch có mục riêng từng trang → 400 `SITE_REQUIRED`. Patch chỉ có phần chung thì lưu được ở chế độ `*`.
  - `GET /api/systems/config`, `overview`, `maintenance`, `discover-forums`, `reload-config`: theo ngữ cảnh trang. `GET /api/systems/config` thêm `site: siteInfo(currentSite())`.
  - Đổi `source.baseUrl`, hoặc thêm vào `source.previousBaseUrls` một tên miền đang thuộc trang khác → 409 `SITE_HOST_TAKEN`, qua `assertHostFree(url, currentSite().code)` (Task 4).

- [ ] **Step 1: Viết test hỏng.**
  - `test('a thread link of another site searches that site')`: comment 9 của thread 300 nằm trong kho `rphang`. Yêu cầu có header là trang chính, body `threadId: 'https://rphang.land/t/a.300/'` → trả về comment 9, meta `site.code === 'rphang'`.
  - `test('a bare thread id with * is refused')` → 400 `SITE_REQUIRED`.
  - `test('settings of one site do not reach another')`: `PUT /api/systems/config` với header `rphang`, body `{ source: { postsPerPage: 25 } }` → `GET` với header trang chính vẫn là 20.
  - `test('shared settings can be saved with *')`: `{ backup: { keep: 9 } }` với `*` → 200. `{ source: {...} }` với `*` → 400.
  - `test('a source address another site uses is refused')` → 409 `SITE_HOST_TAKEN`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `npm test`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(sites): search, settings and overview per site; thread links pick their site"`

---

### Task 9: Xem gộp: Tìm kiếm và Lưu trữ đã sàng

**Files:**
- Create: `server/merge.ts`
- Modify: `server/search.ts`, `server/scraper.ts` (route `/api/scrapes/processed`)
- Test: `server/merge.test.ts`, `server/search.test.ts`, `server/scraper.test.ts`

**Interfaces:**
- Produces (`server/merge.ts`): `export function mergeTop<T>(lists: T[][], cmp: (a: T, b: T) => number, skip: number, take: number): T[]`. Mỗi danh sách con đã sắp theo `cmp`.
- Produces (`server/search.ts`):
  - `searchPosts(b, win?: { limit: number; offset: number })` và `searchComments(b, byAuthor, win?)` nhận thêm cửa sổ tùy chọn. Mặc định giữ cách tính trang như cũ.
  - Khi `requestSite(req) === null`:
    - Với mỗi trang: nếu `maintenance.searchPost` (hay `searchComment`) đang bật thì trả 503 `FEATURE_PAUSED`, ghi tên trang.
    - Lấy `page * pageSize` dòng đầu và số đếm của mỗi kho, gắn `site`, rồi `mergeTop`.
    - Thứ tự bài: cột đang chọn giảm dần, rồi `createdAt` giảm dần, rồi mã trang tăng dần, rồi `id` giảm dần.
    - Thứ tự bình luận: `createdAt` giảm dần, rồi mã trang tăng dần, rồi `id` giảm dần.
    - `total` là tổng các kho. `nextPage` tính theo tổng.
  - Mỗi dòng kết quả (cả chế độ một trang) có `site: { code, name }`.
  - `/count` gộp bằng tổng. Gợi ý ở chế độ `*`: lấy `topK` gợi ý của mỗi trang, gắn `site`, xen kẽ lần lượt từng trang, cắt còn `topK`.
- Produces (`/api/scrapes/processed` với `*`):
  - Thứ tự: `created_at` giảm dần, rồi mã trang tăng dần, rồi `id` giảm dần.
  - Con trỏ là chuỗi `${createdAt}|${code}|${id}`. Mỗi kho lọc các dòng đứng sau con trỏ theo đúng thứ tự đó, lấy `size` dòng, rồi `mergeTop(…, 0, size)`.
  - Meta: `{ nextCursor: string | null, total, totalBySite: Record<code, number> }`.
  - Chế độ một trang giữ con trỏ số như cũ, và cũng thêm `totalBySite`.

- [ ] **Step 1: Viết test hỏng.**
  - `merge.test.ts`: `mergeTop([[9,5,1],[8,2]], (a,b)=>b-a, 1, 3)` deep-equals `[8,5,2]`.
  - `test('merged post search pages through both stores without gaps or repeats')`: 25 bài có từ "xe" ở trang chính và 17 ở `rphang`, `pageSize = 20`. Ba trang `*` có tổng 42 dòng duy nhất (khóa `${site.code}:${id}`), đúng thứ tự `createdAt` giảm dần; `total === 42`.
  - `test('every merged row names its site')`: dòng nào cũng có `site.code` thuộc `{demo, rphang}`.
  - `test('merged archive pages by cursor')`: 3 lượt sàng xong ở mỗi trang, `size=2` → ba trang ghép lại đủ 6, không trùng. Meta `totalBySite` là `{ demo: 3, rphang: 3 }`.
  - `test('a paused site stops merged search')`: bật `maintenance.searchPost` của `rphang` → `*` trả 503, thông báo có `rphang`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `npm test`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add server/merge.ts server/merge.test.ts && git commit -am "feat(sites): search and the archive can list every site together"`

---

### Task 10: Sao lưu mọi kho, theo dõi riêng từng kho

**Files:**
- Modify: `server/backup.ts`, `README.md` (mục "Khôi phục từ bản sao lưu")
- Test: `server/backup.test.ts`

**Interfaces:**
- Produces:
  - `vacuumInto(src: string, dest: string)`.
  - `doBackup(trigger, site: Site)` chạy trong `withSite(site)` để Telegram ghi đúng tên trang:
    - Trang chính: tệp `glean-auto-…db` ở thư mục sao lưu, ảnh vào `<dir>/media`, giữ y như cũ.
    - Trang khác: kho vào `<dir>/sites/<mã>/glean-auto-…db`, ảnh vào `<dir>/sites/<mã>/media`.
    - Dòng `backup_run` ghi `site_code`: `NULL` cho trang chính, mã trang cho trang khác.
  - `pruneAutoBackups` chạy riêng cho từng thư mục.
  - `isBackupDue(at, site)` và `lastSuccessAt(site)` tính riêng theo `site_code`.
  - `runBackup(trigger): Promise<BackupRun[]>`:
    - `auto`: chỉ các kho đến hạn.
    - `manual`: mọi kho.
    - Chạy lần lượt.
  - `POST /api/backups/run` → `ok(<run của trang chính>, { runs })`.
  - `backupStatus()` thêm `sites: { code, name, last, lastSuccessAt, nextDueAt }[]` cho các trang không phải trang chính.
  - `validateBackupDir` từ chối thư mục nằm trong thư mục ảnh của **bất kỳ** trang nào.

- [ ] **Step 1: Viết test hỏng.**
  - `test('a manual backup copies every store with the main file name unchanged')`: thư mục đích tạm → có `glean-auto-*.db` ở gốc và `sites/rphang/glean-auto-*.db`.
  - `test('a failing site is retried alone')`: làm hỏng nguồn của `rphang` (đóng kho hoặc trỏ `dbPath` tới tệp không tồn tại) → run của nó có `error`; `isBackupDue(new Date(), mainSite()) === false` ngay sau đó, và `isBackupDue(+2h, rphang) === true`. Số tệp `glean-auto-*` của trang chính không tăng khi chạy lại `auto`.
  - `test('a backup folder inside any site media folder is refused')` → `INVALID_BACKUP_DIR`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test server/backup.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.** Thêm vào README cách khôi phục một trang thêm sau: dừng Glean; chép `sites/<mã>/glean-auto-….db` thành `data/sites/<mã>/glean.db`, xóa `-wal` và `-shm`; chép `sites/<mã>/media` vào `data/sites/<mã>/media`; chạy lại.
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(backup): back up every site's store and retry only the one that failed"`

---

### Task 11: Diễn đàn mẫu thứ hai và kiểm tra nâng cấp

**Files:**
- Modify: `server/demo/forum.ts`, `server/index.ts`
- Test: `server/demo/forum.test.ts`, `server/site.test.ts`

**Interfaces:**
- Produces:
  - `registerDemoForum(app: FastifyInstance, opts?: { prefix?: string; titleTag?: string })`. Mặc định `prefix = '/demo-forum'`, `titleTag = ''`.
  - Mọi chuỗi `/demo-forum` cố định trong HTML sinh ra đổi thành `prefix`. `titleTag` thêm vào đầu tiêu đề chủ đề khi hiển thị.
  - ID và dữ liệu dùng chung với diễn đàn mẫu thứ nhất, nên ID bài trùng nhau giữa hai diễn đàn.
  - `index.ts` đăng ký thêm `registerDemoForum(app, { prefix: '/demo-forum-2', titleTag: '[B] ' })`.

- [ ] **Step 1: Viết test hỏng.**
  - `test('the second demo forum shares ids but tags titles')`: `GET /demo-forum-2/threads/x.1/` → `h1` bắt đầu bằng `[B] `, mọi link trong trang dùng `/demo-forum-2/`.
  - `test('upgrading an old database only adds')`:
    - Giả một kho bản cũ: `openStore(<tmp>/old.db)`, rồi `DROP TABLE site`, `ALTER TABLE backup_run DROP COLUMN site_code`, `PRAGMA user_version = 3`.
    - Ghi một thread, một scrape và một `scrape_image` có `current_url = '/media/scrapes/1/a.jpg'`, rồi đóng kho.
    - Mở lại bằng `openStore` → các dòng đó không đổi, có bảng `site`, có cột `site_code`.
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `npm test`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy toàn bộ test.** Run: `npm test`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "test(sites): a second sample forum with the same ids, and an upgrade check"`

---

### Task 12: Giao diện: danh sách trang, header, ô chọn trang, màn chỉ một trang

**Files:**
- Create: `web/src/lib/site.tsx`
- Modify: `web/src/lib/api.ts`, `web/src/components/Shell.tsx`, `web/src/main.tsx`, `web/src/styles.css`
- Test: `web/src/lib/site.test.ts`

**Interfaces:**
- Produces (`web/src/lib/site.tsx`):
  - `export interface SiteInfo { code: string; name: string; isMain: boolean; baseUrl: string; dir: string | null }`
  - `export const ALL = '*'`
  - `export function resolveSelected(stored: string | null, list: SiteInfo[]): string`:
    - Mã đã lưu còn tồn tại thì giữ.
    - `'*'` chỉ giữ khi có từ 2 trang trở lên.
    - Các trường hợp còn lại về trang chính.
  - `export function selectedSite(): string`: không phải hook; `api.ts` và `realtime.ts` dùng.
  - `export function useSites(): { sites: SiteInfo[]; selected: string; select(code: string): void; reload(): Promise<void>; nameOf(code: string): string }`: store dùng chung theo kiểu `useTheme` trong `Shell.tsx`, lưu ở `localStorage['site']` (đọc/ghi trong `try/catch`).
  - `export function SitePicker()`: nút mang tên trang đang chọn, mở danh sách trang, đường kẻ, rồi mục "Cả hai trang" (hoặc "Tất cả trang" khi có từ 3 trang). Ẩn mục gộp khi chỉ có một trang.
  - `export function SiteTag({ code }: { code: string })`: `<span className="tag">{tên}</span>`.
  - `export function SingleSiteOnly({ children }: { children: ReactNode })`: đang ở `'*'` thì hiện "Màn này xem từng trang" kèm một nút cho mỗi trang; ngược lại hiện `children`.
- Produces (`web/src/lib/api.ts`): `ReqOpts.site?: string`. Mọi yêu cầu gửi `x-glean-site: opts.site ?? selectedSite()`.
- `Shell.tsx`:
  - Nạp `GET /api/sites` trước khi hiện nội dung; trong lúc chờ, hiện khung trống như lúc tải trang.
  - `SitePicker` đặt trên đầu `<nav>` của thanh bên, và trên thanh trên khi màn hẹp.
- `main.tsx`: bọc `HomePage`, `QueuePage`, `SyncLogPage`, `SyncLogDetailPage`, `ManualSyncPage` và `SettingsPage` bằng `SingleSiteOnly`.

- [ ] **Step 1: Viết test hỏng** trong `web/src/lib/site.test.ts`:
  - `resolveSelected('rphang', [main, rphang]) === 'rphang'`
  - `resolveSelected('xoa', [main, rphang]) === main.code`
  - `resolveSelected('*', [main]) === main.code`
  - `resolveSelected('*', [main, rphang]) === '*'`
  - `resolveSelected(null, [main, rphang]) === main.code`
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test web/src/lib/site.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.** Bố cục ô chọn trang theo `DESIGN.md` (kẻ, không khung; chữ Lexend 300/400); dùng lại thành phần sẵn có trong `ui.tsx` nếu hợp.
- [ ] **Step 4: Chạy kiểm tra.** Run: `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add web/src/lib/site.tsx web/src/lib/site.test.ts && git commit -am "feat(web): pick the site to view; requests and screens follow it"`

---

### Task 13: Giao diện: sự kiện theo trang và tạo lượt sàng có trang

**Files:**
- Modify: `web/src/lib/realtime.ts`, `web/src/components/Scrape.tsx`, `web/src/components/Shell.tsx` (`Omnibox`), `web/src/pages/Home.tsx` (lịch sử tìm)
- Test: `web/src/lib/realtime.test.ts`

**Interfaces:**
- Produces (`realtime.ts`):
  - `RtMessage.site: string | null`
  - `export function eventMatches(msgSite: string | null, want: string): boolean`: đúng khi `msgSite == null`, khi `want === '*'`, hoặc khi `msgSite === want`.
  - `useEvent(types, handler, opts?: { site?: string })`: lọc bằng `eventMatches(m.site, opts?.site ?? selectedSite())`.
  - Nơi nghe sự kiện lịch sử tìm kiếm (`Home.tsx`, `Search.tsx`) truyền `{ site: '*' }`.
- Produces (`Scrape.tsx`):
  - `useCreateScrape()` nhận `opts.site?: string`, gửi qua `ReqOpts.site`.
  - Kết quả có `site: { code; name }`. Toast nói "Đã đưa bài vào hàng đợi sàng của {name}".
  - Điều hướng tới `` `/sang/${scrape.id}?trang=${site.code}` ``.
  - `domainWarning` chỉ còn trường hợp tên miền cũ.
  - `export function useAskSite(): (reason: string) => Promise<string | null>`: hộp thoại chọn trang, dùng `Dialog` trong `ui.tsx`.
- `Omnibox` và `SieveForm`: nhập chỉ số ID khi đang ở `'*'` thì gọi `useAskSite()` trước, rồi `create(v, …, { site })`. Bấm hủy thì không làm gì.

- [ ] **Step 1: Viết test hỏng** trong `web/src/lib/realtime.test.ts`:
  - `eventMatches('rphang', 'demo') === false`
  - `eventMatches('rphang', '*') === true`
  - `eventMatches(null, 'demo') === true`
  - `eventMatches('demo', 'demo') === true`
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test web/src/lib/realtime.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy kiểm tra.** Run: `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -am "feat(web): live updates and new sieve jobs follow their site"`

---

### Task 14: Giao diện: Tìm kiếm gộp và tìm bình luận trong một bài

**Files:**
- Modify: `web/src/pages/Search.tsx`
- Test: `web/src/pages/Search.test.ts` (tạo nếu chưa có)

**Interfaces:**
- Consumes: `useSites`, `SiteTag` (Task 12); `useCreateScrape` với `site` (Task 13).
- Produces:
  - `export function searchSiteOf(params: URLSearchParams, selected: string): string`: trả về `params.get('trang') ?? selected`. Trang tìm kiếm gửi mọi yêu cầu với `{ site: searchSiteOf(...) }`.
  - Khi đang ở `'*'`: mỗi dòng bài và dòng bình luận hiện `<SiteTag code={row.site.code} />` ở đầu dòng.
  - Link "bình luận của bài này": `` `/binh-luan/tu-khoa?thread=${p.id}&trang=${p.site.code}` ``.
  - Nút sàng trên dòng: `createScrape(String(id), source, { site: row.site.code, askNavigate: true })`.
  - Tìm bình luận gửi `threadId: thread`, tức chuỗi gốc người dùng nhập, không phải số đã tách.
  - Khi meta có `site` khác trang đang chọn: hiện dòng "Đang tìm trong trang {name}".
  - Đang ở `'*'` mà ô `thread` chỉ là số: hỏi trang bằng `useAskSite()`, rồi đặt `trang` lên URL.

- [ ] **Step 1: Viết test hỏng:**
  - `searchSiteOf(new URLSearchParams('trang=rphang'), '*') === 'rphang'`
  - `searchSiteOf(new URLSearchParams(''), 'demo') === 'demo'`
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test web/src/pages/Search.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy kiểm tra.** Run: `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add web/src/pages/Search.test.ts && git commit -am "feat(web): search every site at once, each row names its site"`

---

### Task 15: Giao diện: Lưu trữ gộp, sàng lại theo trang, trang chi tiết theo `?trang=`

**Files:**
- Modify: `web/src/pages/Sieve.tsx`, `web/src/pages/SieveDetail.tsx`, `web/src/components/Scrape.tsx` (link `NowSieving` và hàng đợi mang `trang`)
- Test: `web/src/pages/Sieve.test.ts`, `web/src/pages/SieveDetail.test.ts`

**Interfaces:**
- Produces (`Sieve.tsx`):
  - `withIds<T>(set: ReadonlySet<T>, ids: T[], on: boolean): Set<T>`: tổng quát hóa, test cũ vẫn qua.
  - `export const pickKey = (s: { id: number; site: { code: string } }) => \`${s.site.code}:${s.id}\``. Lựa chọn lưu bằng khóa này.
  - `export function groupPicks(keys: Iterable<string>): Record<string, number[]>`
  - "Sàng lại": mỗi trang gửi một `POST /scrapes/retry-many` với `{ ids }` và `{ site: code }`. Một toast tổng kết số đã đưa vào hàng đợi và số bỏ qua.
  - "Sàng lại tất cả" ở `'*'`:
    - Lấy `totalBySite` từ `GET /scrapes/processed?size=1`.
    - Hộp xác nhận ghi số bài của từng trang, ví dụ "demo 3 bài · rphang 3.400 bài".
    - Đồng ý thì gửi `{ all: true }` cho từng trang có số bài lớn hơn 0.
  - Dòng ở `'*'` có `SiteTag`. Link dòng là `` `/sang/${id}?trang=${code}` ``. Ẩn biểu đồ chuyên mục khi đang ở `'*'`.
- Produces (`SieveDetail.tsx`):
  - `export function detailSite(param: string | null, mainCode: string): string`: trả về `param ?? mainCode`, vì link cũ không có `trang` là của trang chính.
  - Mọi `api.*` truyền `{ site }`; mọi `useEvent` truyền `{ site }`. Tên trang hiện ở đầu trang chi tiết. Ô chọn trang không đổi.

- [ ] **Step 1: Viết test hỏng:**
  - `groupPicks(['demo:1', 'rphang:1', 'demo:7'])` deep-equals `{ demo: [1, 7], rphang: [1] }`
  - `pickKey({ id: 1, site: { code: 'rphang' } }) === 'rphang:1'`
  - `detailSite(null, 'demo') === 'demo'`
  - `detailSite('rphang', 'demo') === 'rphang'`
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test web/src/pages/Sieve.test.ts web/src/pages/SieveDetail.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy kiểm tra.** Run: `npm test && npm run typecheck && npm run lint`. Expected: PASS.
- [ ] **Step 5: Commit.** `git add web/src/pages/SieveDetail.test.ts && git commit -am "feat(web): the archive lists every site together; detail pages open the right site"`

---

### Task 16: Giao diện: mục Trang trong Cài đặt, sao lưu theo trang, kiểm tra trên bản nháp

**Files:**
- Modify: `web/src/pages/Settings.tsx`, `web/src/pages/Backup.tsx`, `web/src/styles.css`
- Test: `web/src/pages/Settings.test.ts` (tạo nếu chưa có)

**Interfaces:**
- Consumes: `/api/sites*` (Task 4), `backupStatus().sites` (Task 10), `useSites().reload/select` (Task 12).
- Produces (`Settings.tsx`):
  - Tiêu đề "Cài đặt cho trang: {name}" đặt trước các mục `src`, `sync`, `sieve` và `pause`, cùng hai trường gợi ý tìm kiếm.
  - Các mục `proxy`, `storage`, `search` (phần chung), `auth` và `tg` có nhãn "Chung cho mọi trang".
  - Mục mới `<Section id="sites" title={t('Trang', 'Sites')}>`:
    - Danh sách trang có nút đổi tên và nút gỡ. Trang chính không gỡ được.
    - Hộp xác nhận gỡ nói rõ kho vẫn nằm ở `{dir}`.
    - Ô "Thêm trang": nhập địa chỉ → `GET /sites/suggest` điền sẵn mã và tên (sửa được) → `POST /sites` (qua `SudoGate` như khi lưu cài đặt) → `reload()`, `select(code)`, cuộn tới `#src`.
  - `export function validSiteCode(s: string): boolean`: khớp `^[a-z0-9][a-z0-9-]{0,31}$`, để báo lỗi ngay trên ô nhập.
- Produces (`Backup.tsx`): dưới trạng thái hiện có, liệt kê `sites[]`, mỗi trang gồm tên, lần thành công gần nhất, lỗi gần nhất và lần chạy tới.

- [ ] **Step 1: Viết test hỏng:**
  - `validSiteCode('rphang') === true`
  - `validSiteCode('Rphang') === false`
  - `validSiteCode('-a') === false`
  - `validSiteCode('a'.repeat(33)) === false`
- [ ] **Step 2: Chạy và xác nhận hỏng.** Run: `node --import tsx --import ./server/test/setup.ts --test web/src/pages/Settings.test.ts`. Expected: FAIL.
- [ ] **Step 3: Cài đặt theo Interfaces.**
- [ ] **Step 4: Chạy kiểm tra tự động.** Run: `npm test && npm run typecheck && npm run lint && npm run build`. Expected: PASS.
- [ ] **Step 5: Kiểm tra trên bản nháp.** Làm theo cách trong bộ nhớ dự án:
  - Build web vào thư mục nháp, chạy `server/index.ts` với `GLEAN_DATA_DIR` và cổng nháp, mở `http://localhost:<cổng>`.
  - Thêm trang thứ hai với địa chỉ `http://127.0.0.1:<cổng>/demo-forum-2`.
  - Kiểm tra các điểm sau:
    - Đồng bộ hai trang; bài cùng ID có tiêu đề `[B]` chỉ ở trang thứ hai.
    - Tìm kiếm ở "Cả hai trang" thấy cả hai, dòng nào cũng có nhãn tên trang.
    - Sàng cùng một ID ở hai trang, hai lượt chạy song song.
    - Lưu trữ gộp: chọn hai dòng của hai trang rồi sàng lại.
    - Mở chi tiết từ danh sách gộp vẫn giữ "Cả hai trang".
    - Màn chỉ một trang hiện đúng thông báo.
    - Sao lưu tạo `sites/<mã>/`.
  - Chụp màn hình làm bằng chứng. Không mở tab của bản đang chạy ở 4318.
- [ ] **Step 6: Commit.** `git commit -am "feat(web): add, rename and remove sites in Settings; backup status per site"`
