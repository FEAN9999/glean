# FEATURES — phân tích tính năng của dịch vụ tham chiếu

> Phạm vi: chỉ **tính năng** (luồng nghiệp vụ, dữ liệu, API, realtime, cấu hình). Không phân tích giao diện/CSS.
> Mục tiêu: app **dùng cá nhân, một người dùng, full tính năng**. Phần kiếm tiền (gói, thanh toán, quota, giới hạn theo hạng) và phần phục vụ nhiều người dùng (chat, phân quyền, tracking, multi-tenant…) đã được loại bỏ, xem §7.
> Ngày phân tích: 2026-11-08.

## 0. Phương pháp & độ tin cậy

| Nguồn | Cách lấy | Ghi chú |
|---|---|---|
| Trạng thái trang, storage, script đang chạy | `rea inspect-web-page` qua CDP `127.0.0.1:9222` (evidence `ev_4b8d60c5…`, `ev_02b2039c…`) | Quan sát trực tiếp |
| Phân tích bundle JS | `rea analyze-web-bundle` (`ev_1ad22d66…`) + `rea export-web-scripts` | REA chỉ suy ra 2 route literal; phần lớn route Angular là hằng số → đọc thẳng mã |
| Toàn bộ 50 chunk lazy-load | Tải theo bảng chunk trong `runtime.js` | Tĩnh: có cả module admin chưa từng mở |
| Chuỗi tính năng | `/assets/i18n/vi-VN.json` | Danh sách nhãn của mọi màn hình |
| API thực tế + shape JSON | Duyệt 18 trang khách hàng trong tab mới qua CDP, ghi lại request/response | Quan sát runtime (chỉ trang khách, không đăng nhập admin) |

Quy ước: **[QS]** = đã quan sát runtime · **[TĨNH]** = thấy trong mã, chưa chạy · **[SUY]** = suy luận.

REA MCP không kết nối được (timeout) nên dùng REA CLI 6.8.0 thay thế.

---

## 1. Kiến trúc tổng quát

- **Frontend**: Angular SPA, lưới/form admin dùng DevExtreme, xem ảnh/video bằng Fancybox. Lazy-load theo module.
- **Backend**: REST `https://api.<dịch-vụ-tham-chiếu>/{controller}/…` (ASP.NET: SignalR, Serilog, ElasticAPM). Response chuẩn: `{ success, data, total?, message?, code? }`.
- **Realtime**: SignalR hub `/subscribe`, event duy nhất `ReceiveMessage {type, data, message}`; client gọi `JoinGroup/LeaveGroup` theo trang đang mở [QS+TĨNH].
- **Nguồn dữ liệu**: một diễn đàn bên ngoài (XenForo-like: thread, page, comment `#n`). Backend **đồng bộ định kỳ** bài viết + bình luận vào DB/Elasticsearch, và **cào theo yêu cầu** một bài cụ thể để lấy media.
- **Đa ngôn ngữ**: `vi-VN`, `en-US` (localStorage `lang`, header `Accept-Language`).

---

## 2. Bản đồ route (đã bỏ route kiếm tiền)

### Người dùng
| Route | Tính năng |
|---|---|
| `/` | Trang chủ: lối tắt tới các tính năng |
| `/tim-bai-viet/tu-khoa` · `/tim-bai-viet/nguoi-dang-bai` | Tìm bài viết theo từ khóa / theo tác giả |
| `/tim-binh-luan/tu-khoa` · `/tim-binh-luan/nguoi-dang-bai` | Tìm bình luận theo từ khóa / theo tác giả |
| `/loc-anh` · `/loc-anh/chi-tiet/:id` | Lọc ảnh/video/link/bình luận từ 1 bài viết (scraper) |
| `/change-log/post` · `/change-log/post/:id` · `/change-log/comment` | Nhật ký đồng bộ dữ liệu |

### Quản trị / vận hành
`dang-nhap`, `dong-bo-thu-cong` (đồng bộ thủ công), `cai-dat` (cấu hình hệ thống), `clone-data`, `ho-so-ca-nhan`.

---

## 3. Tính năng chính

### 3.1 Tìm kiếm bài viết [QS+TĨNH]
- **Theo từ khóa**: `POST /posts/search` `{page, keyword, isSearchByAuthor:false, sortDescendingField (ngày đăng | số bình luận), isExactMatch (khớp từ | chứa từ)}`. Tối thiểu 3 ký tự.
- **Theo tác giả**: cùng endpoint, `isSearchByAuthor:true`.
- **Phân trang** kiểu "Trang tiếp theo" (`nextPage`), hiển thị "Đang hiển thị X / Y", **không giới hạn số kết quả**.
- **Phát hiện tìm nhầm chế độ**: khi 0 kết quả, tự gọi `POST /posts/search/count` với chế độ ngược lại (từ khóa ↔ tác giả); có kết quả → "Có thể bạn đang tìm nhầm mục: N kết quả — Xem".
- **Gợi ý liên quan** (semantic): `GET /posts/search/suggestions?q=&topK=8` (backend gọi dịch vụ sentence-transformers).
- **Độ tươi dữ liệu**: `GET /posts/search/meta` → `{postCount, postUpdatedAt}` ("Dữ liệu được đồng bộ lúc…").
- **Lịch sử tìm kiếm gần đây**: `GET /posts/search/recent-keywords|recent-authors?cursor=` → `{keyword, resultCount, createdAt}`, cuộn vô hạn theo cursor, cập nhật realtime (`NewSearch`, `NewSearchByAuthor`). Bấm vào để tìm lại.
- **Deep-link**: `?q=` tự chạy tìm kiếm khi mở trang.
- **Nút "Lọc ảnh" trên mỗi kết quả**: tạo ngay yêu cầu scrape cho bài đó (§3.3) rồi hỏi chuyển sang tab Lọc ảnh.
- Kết quả hiển thị: tiêu đề, tác giả, forum, ngày đăng, số bình luận, link bài gốc.

### 3.2 Tìm kiếm bình luận [QS+TĨNH]
- `POST /comments/search` `{page, keyword, isExactMatch, threadId?}`. Phạm vi **toàn bộ** hoặc **một bài cụ thể** (nhập link hoặc ID bài → client tự tách `threadId`).
- `POST /comments/search-by-author` (theo người đăng), `POST /comments/search/count` (phát hiện tìm nhầm chế độ), `GET /comments/search/meta` → `{commentUpdatedAt}`.
- Lịch sử tìm kiếm gần đây + realtime `NewCommentSearch`, `NewCommentSearchByAuthor`.
- Kết quả: nội dung, tác giả, thời gian, link tới bình luận gốc ("Xem bình luận").
- Hiển thị tiến trình "Đang quét dữ liệu bình luận…".

### 3.3 Lọc ảnh / video từ bài viết (Scraper), tính năng lõi [QS+TĨNH]
Luồng:
1. Nhập **link bài hoặc ID** → `POST /scrapes/create-scrape` `{url, source}` (`source` = nơi khởi tạo: tìm bài / tìm bình luận / trực tiếp).
2. **Hàng đợi xử lý**: `GET /scrapes/unprocessed`, `GET /scrapes/{id}/rank` → "Số thứ tự: r / đang chờ: n". Vẫn hữu ích khi dùng một mình vì có thể đẩy nhiều bài cùng lúc.
3. **Tiến trình realtime** qua SignalR: `NewScrape` → `UpdateScrapeProcess {scrapeId, currentPage, totalPages}` ("Scan bài x/y") → `UpdateDownloadImageProcess` ("Download ảnh x/y") → `UpdateScrape` → `FinishScrape`.
4. **Danh sách đã xử lý** (cursor): `GET /scrapes/processed?cursor=`. Mỗi mục: `threadId, threadTitle, threadUrl, totalPages, totalImages/Videos/Comments/Links, …BeforeLastPage, handlingSeconds, status, isThreadDeleted, syncedCommentCount, createdAt`.
5. **Chi tiết** `GET /scrapes/{id}` + 5 tab phân trang `?page&size`:
   - `/images` (`originUrl, currentUrl, externalUrl, imageEndpoint, page, isBin, isDownloadFailed, displayByOriginUrl`): ảnh được **tải về và lưu trên server** (`/media/...`), lỗi thì mở link gốc.
   - `/videos`, `/links`
   - `/comments?minLength=`: lọc bình luận rác/quá ngắn ("Đã loại bỏ N bình luận không có giá trị").
   - `/synced-comments`: bình luận lưu trữ từ hệ thống đồng bộ (§3.4).
   - Mỗi item ghi "Ở trang N" của bài gốc.
6. **Bài gốc đã bị xóa trên diễn đàn**: vẫn xem được dữ liệu đã lưu trữ (ảnh đã tải, bình luận đã đồng bộ), có nhãn "Đã bị xóa trên diễn đàn".
7. **Quản lý**: xóa (`DELETE /scrapes/{id}/mark-delete`), thử lại (`POST /scrapes/{id}/retry`), làm mới; dữ liệu có lịch tự xóa ("Dữ liệu sẽ bị xóa lúc…"), nên cấu hình được hoặc tắt cho bản cá nhân.
8. **Trạng thái proxy cào**: `GET /scrapes/check-proxy` ("Proxy bị gián đoạn, đang kết nối lại…").
9. Bỏ qua ảnh từ các domain cấu hình sẵn; cảnh báo khi diễn đàn nguồn đổi domain; xác nhận trước khi mở link ngoài.

Trạng thái scrape: `None 0, Waiting 1, Processing 2, Completed 3, Failed 4, NotProcessed 5`.

### 3.4 Đồng bộ dữ liệu & nhật ký cập nhật [QS+TĨNH]
- **Đồng bộ tự động** (nền): theo chu kỳ cấu hình, quét N trang mới nhất của từng forum cho bài viết và bình luận → nạp vào kho tìm kiếm.
- **Nhật ký**: `GET /sync-histories/posts|comments?page=` → `{forum, forumName, syncCount, syncStartedAt, syncFinishedAt}`; đếm `…/count`; chi tiết một lần đồng bộ = danh sách bài mới/cập nhật (tác giả, tiêu đề) `GET /sync-histories/posts/{id}/items`.
- **Đồng bộ thủ công** (admin): chọn loại (bài/bình luận), khoảng trang hoặc tất cả, batch size, danh sách forum (trống = tất cả); start/stop; tiến trình realtime (forum, trang hiện tại, tổng đã đồng bộ, thời gian chạy, "Đang lưu N bản ghi…") + log. API `POST /manual-syncs/start|stop`, `GET /manual-syncs/status`; SignalR `ManualSyncProgress/Complete/Failed`.

### 3.5 Tiện ích hệ thống
- **Tạm dừng theo tính năng**: `GET /systems/maintenance` → `{scrape, searchPost, searchComment}: {isPaused, message}`; dùng khi nguồn lỗi/đang đồng bộ lớn. Mã lỗi `FEATURE_PAUSED` thì client không retry.
- **Thông báo hệ thống** realtime (`SystemNotification`), **buộc tải lại** khi có phiên bản mới (`NeedReload`, `GET /systems/version`).
- **Clone dữ liệu**: liệt kê bảng, clone từng bảng sang DB khác, thực thi (`/clone/tables`, `/clone/table`, `/clone/execute`), dùng để sao lưu/di chuyển.
- **Đăng nhập** một tài khoản bằng mật khẩu (+ mã 2FA nếu bật), JWT + refresh token.
- **Hồ sơ cá nhân**: đổi mật khẩu, **2FA TOTP** (QR + khóa thủ công) `/auth/2fa/setup|enable|disable|verify-code`; trang cài đặt yêu cầu nhập lại mã 2FA.

---

## 4. Cấu hình hệ thống động (lưu DB, reload nóng)

Admin sửa trên `/quan-tri/cai-dat` → `PUT /systems/config`, `POST /systems/reload-config`:
- **Đồng bộ** bài/bình luận: bật/tắt, số trang mỗi lượt, chu kỳ (ms), URL comment-service.
- **Scraper**: số trang cào song song, số ảnh tải song song, delay giữa batch, **domain bỏ qua**.
- **Proxy**: danh sách `host:port:user:pass`, bật/tắt.
- **Lưu trữ file**: base path, thư mục thumbnail, giới hạn kích thước/chunk, upload đồng thời, **chuyển mã video sang HLS bằng FFmpeg**.
- **Tìm kiếm**: Elasticsearch (URI, user, bật ghi ES), Semantic Search URL.
- **AI**: ChatGPT / Gemini API key (bật/tắt), hiện chưa thấy tính năng phía người dùng dùng tới.
- **Auth**: JWT (issuer, audience, secret, hạn).
- **Tích hợp khác**: Telegram bot (thông báo), Redis, Serilog, ElasticAPM.
- **Tạm dừng tính năng**: `scrape` / `searchPost` / `searchComment` kèm thông điệp.

---

## 5. Cơ chế kỹ thuật đáng tái sử dụng

1. **Hàng đợi job + tiến trình realtime**: job cào có trạng thái, thứ hạng hàng đợi, sự kiện tiến trình theo trang và theo ảnh, đẩy qua SignalR group.
2. **Cào song song có kiểm soát**: N trang cùng lúc, M ảnh tải cùng lúc, delay giữa batch, proxy xoay vòng + health-check, domain blacklist.
3. **Lưu trữ media cục bộ**: tải ảnh về server, giữ `originUrl` để fallback; video chuyển HLS; ảnh nhị phân hỏng đánh dấu `isBin`.
4. **Lưu trữ khi nguồn bị xóa**: dữ liệu đã cào + bình luận đã đồng bộ vẫn xem được khi bài gốc biến mất.
5. **Lọc bình luận rác** theo độ dài tối thiểu.
6. **Tìm kiếm kép**: full-text (Elasticsearch, khớp từ/chứa từ, sort) + semantic (gợi ý liên quan) + đếm chéo chế độ để phát hiện tìm nhầm.
7. **Đồng bộ tăng dần theo chu kỳ** + đồng bộ thủ công theo khoảng trang, có nhật ký từng lần.
8. **HTTP interceptor**: gắn Bearer, refresh token khi 401 (single-flight), header `error-message-type` điều khiển cách hiển thị lỗi, retry có điều kiện.
9. **Upload chunk**: `chunks-init` / `chunks-upload` cho file lớn, `media/upload` có nén ảnh.
10. **Feature flag tạm dừng** theo từng tính năng + **force reload** khi deploy.

---

## 6. Danh mục API giữ lại (base `https://api.<dịch-vụ-tham-chiếu>`)

```
auth:        POST login | logout | refresh/{userId}/{token} ; GET validate-token | me
             2fa/{setup,enable,disable,verify-code} ; verify-2fa
accounts:    GET me ; PUT change-password
systems:     GET maintenance | version | config ; PUT config ; POST reload-config
posts:       POST search | search/count ; GET search/meta | search/recent-keywords | search/recent-authors | search/suggestions?q&topK
comments:    POST search | search-by-author | search/count ; GET search/meta | recent-keywords | recent-authors
scrapes:     POST create-scrape | {id}/retry ; GET unprocessed | processed?cursor | {id} | {id}/rank
             | {id}/images|videos|links|comments(minLength)|synced-comments?page&size | check-proxy ; DELETE {id}/mark-delete
sync-histories: GET posts|comments?page | posts/count | comments/count | posts/{id}/items
manual-syncs: POST start|stop ; GET status
media:       POST upload | chunks-init | chunks-upload ; GET {file}
clone:       GET tables ; POST table | execute
SignalR:     /subscribe: ReceiveMessage{type}: 1000 SystemNotification, 2000 NeedReload,
             3001 NewSearch, 3002 NewSearchByAuthor, 3003 NewCommentSearch, 3004 NewCommentSearchByAuthor,
             4001 NewScrape, 4002 UpdateScrape, 4003 UpdateScrapeProcess, 4004 UpdateDownloadImageProcess, 4005 FinishScrape,
             5001 ManualSyncProgress, 5002 ManualSyncComplete, 5003 ManualSyncFailed
             invoke: JoinGroup(name), LeaveGroup(name)
```

---

## 7. Đã loại bỏ (không triển khai)

Ghi lại để truy vết.

### 7.1 Kiếm tiền
- **Gói đăng ký & thanh toán**: gói Free/Quota/VIP/Ultra, khuyến mãi, đơn hàng, QR chuyển khoản, webhook SePay, Stripe, lịch sử đơn, đối soát giao dịch, chuyển gói ẩn danh → tài khoản. (`/subscriptions`, `/subscription-payment/*`, `/subscription-packages`, `/payment-settings/*`, SignalR `SubscriptionOrderUpdated 6001`.)
- **Quota & phân hạng**: giới hạn lượt theo cửa sổ thời gian, giới hạn số kết quả, độ trễ nhân tạo cho gói free, khóa "tìm theo tác giả" cho VIP, khóa "xem bài đã xóa" cho Ultra, hàng ưu tiên VIP, popup nâng cấp/nudge. (`/quotas/*`.) → Mọi tính năng mở **không giới hạn**.
- **Nhiệm vụ đổi lượt (bounty)**: bình luận theo nội dung yêu cầu để nhận lượt, admin duyệt claim. (`/nhan-luot-tim-kiem`, `/bounties/*`.)
- **Từ khóa cấm tìm kiếm**: chỉ là cơ chế ép nâng cấp Ultra. (`/search-banned-words`, mã lỗi `SEARCH_KEYWORD_BANNED`.)
- **Dịch vụ xóa bài/bình luận trả phí**: người dùng trả tiền để nhà vận hành xóa nội dung trên diễn đàn. (`/xoa-bai-viet`, `/xoa-binh-luan`, `/subscription-payment/lookup`.)
- **Danh sách identity theo hạng & thẻ "người tìm"** (gói, SĐT, thiết bị, fingerprint). (`/identity`, `/identity/searcher`.)
- Module bán hàng F&B kế thừa từ template (giỏ hàng, size/topping, tích điểm, QR đặt món tại bàn), vốn không dùng ngay cả trên site gốc.

### 7.2 Nhiều người dùng / vận hành dịch vụ
- **Định danh ẩn danh** bằng FingerprintJS + header `X-Client-Info` (`/identity/me`, SignalR negotiate `?fp=`).
- **Chat hỗ trợ khách ↔ nhân viên** (`/chat`, `/chats/customer/*`, `/chats/staff/*`, SignalR `ChatMessage 2001`, `ChatReadReceipt 2002`).
- **Góp ý, Liên hệ, thông báo chạy chữ, cấu hình cửa hàng** (`/phan-hoi`, `/lien-he`, `/feedbacks`, `/stores/config`).
- **Quản lý khách hàng / nhân viên / vai trò & phân quyền** (`/customers`, `/employees`, `/roles`).
- **Tracking & analytics**: gom sự kiện theo lô (`POST /trackings/events`), dashboard thống kê và hành trình người dùng (`/trackings/analytics/*`, `/quan-tri/dashboard`), số người online (SignalR `Online 100`).
- **Multi-tenant**: subdomain qua Cloudflare DNS, 2FA riêng cho khu vực tenant.
- **Đăng nhập Google / Zalo OAuth** (`/auth/login/with-google`, `/with-zalo`, `/systems/oauth-config`).
- **Envelope mã hóa payload** (AES-CBC + RSA-OAEP + chữ ký RSA, timestamp, nonce): vốn để chống bot lạm dụng quota. Site gốc còn để lộ private key ký trong JS.
- **Lịch sử tìm kiếm công khai** của mọi người dùng: thu lại thành lịch sử cá nhân (§3.1–3.2).

---

## 8. Giới hạn của phân tích

- Không đăng nhập admin → module quản trị chỉ phân tích **tĩnh** (API & form), chưa quan sát response thật.
- Không chạy tìm kiếm hay tạo scrape trên site gốc → payload các lệnh đó lấy từ mã, chưa quan sát qua mạng; shape response kết quả tìm kiếm chưa thấy trực tiếp.
- Logic server (thuật toán cào diễn đàn, đồng bộ tăng dần, lọc bình luận rác, semantic search) chỉ suy ra từ tên trường, nhãn và cấu hình.
