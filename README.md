# Glean

Công cụ cá nhân (một người dùng) để **tìm lại bài viết và bình luận** trên một diễn đàn kiểu XenForo, **đồng bộ** chúng về kho riêng, và **sàng ảnh / video / liên kết / bình luận** ra khỏi những chủ đề dài. Dữ liệu đã sàng được lưu trên máy nên vẫn xem được khi bài gốc bị xóa.

Bộ tính năng dựng lại theo bản phân tích [FEATURES.md](FEATURES.md) (đã bỏ phần kiếm tiền và phần nhiều người dùng). Giao diện, tên và biểu tượng là thiết kế mới.

## Chạy

Cần Node.js ≥ 22.13 (dùng `node:sqlite` có sẵn, không cần cài cơ sở dữ liệu).

```bash
npm install
```

```bash
npm run dev
```

Mở http://localhost:5318. Lần đầu sẽ hiện trang tạo tài khoản. API chạy ở cổng 4318.

Chạy bản production (một tiến trình phục vụ cả giao diện):

```bash
npm run build
```

```bash
npm start
```

Rồi mở http://127.0.0.1:4318.

Biến môi trường: `GLEAN_PORT` (mặc định 4318), `GLEAN_HOST` (mặc định 127.0.0.1, đặt `0.0.0.0` để mở ra mạng LAN), `GLEAN_DATA_DIR` (mặc định `./data`), `GLEAN_LOG`. Tên cũ `SANG_*` vẫn được nhận.

Nâng cấp từ bản tên "Sàng": lần chạy đầu tiên tự đổi `data/sang.db` thành `data/glean.db` và giữ nguyên phiên đăng nhập.

## Diễn đàn mẫu

Mặc định nguồn dữ liệu là một diễn đàn mẫu chạy ngay trong server (`/demo-forum`), sinh nội dung tiếng Việt có tính tất định: 4 chuyên mục, gần 200 chủ đề, ảnh SVG, ảnh hỏng, ảnh "không phải ảnh", ảnh từ tên miền quảng cáo, video nhúng, liên kết ngoài, trích dẫn và bình luận rác. Bài viết mới "xuất hiện" dần theo thời gian thực; một số chủ đề bị xóa giữa chừng.

Để thử tính năng lưu trữ khi bài bị xóa: `POST /demo-forum/_toggle-delete/<threadId>` rồi sàng lại bài đó.

Để thử theo dõi sửa/xóa từng bình luận (ID bài lấy từ link "Xem bình luận gốc", phần `post-<id>`):

- `POST /demo-forum/_edit-post/<postId>`: sửa bài (thêm " (đã sửa)" vào cuối; gửi `{"text": "..."}` để thay toàn bộ nội dung).
- `POST /demo-forum/_toggle-post-delete/<postId>`: xóa bài, gọi lần nữa để khôi phục. Không xóa được bài #1 (xóa cả chủ đề bằng `_toggle-delete`).

Rồi bấm "Đồng bộ ngay" bình luận ở Nhật ký đồng bộ, hoặc sàng lại chủ đề.

## Giữ dữ liệu

- **Bình luận bị sửa**: bản cũ được giữ lại; bình luận mang nhãn "đã sửa · N lần", bấm vào để xem các bản trước.
- **Bình luận bị xóa trên diễn đàn**: vẫn còn trong kho, mang nhãn "đã xóa trên diễn đàn". Glean nhận ra nhờ đọc lại vài trang cuối của các chủ đề có hoạt động gần đây (Cài đặt → Đồng bộ: mặc định 2 trang, bài có hoạt động trong 48 giờ) và khi sàng cả chủ đề. Nếu một trang đọc về trống, có bài không có ID, hoặc quá nhiều bình luận cùng biến mất, Glean bỏ qua bước đánh dấu và ghi lý do vào nhật ký thay vì báo nhầm.
- **Sàng lại** không xóa gì: ảnh, video, liên kết và bình luận không còn trên diễn đàn vẫn được giữ, mang nhãn "Không còn trên diễn đàn"; ảnh đã tải được dùng lại. Chủ đề bị xóa hẳn thì lượt sàng giữ nguyên bản đã có.
- **Sao lưu tự động** (trang Sao lưu): mặc định mỗi 24 giờ, giữ 7 bản `glean-auto-YYYYMMDD-HHmmss.db` gần nhất. Khi đã chọn thư mục sao lưu riêng (nên ở ổ đĩa khác), Glean chép thêm thư mục ảnh vào đó (chỉ chép tệp mới, không bao giờ xóa); để trống thì chỉ sao lưu kho dữ liệu vào `data/backups`. Tệp ảnh nào không chép được thì bỏ qua và báo lại, bản sao kho dữ liệu vẫn được tính là thành công. Bản sao lưu tay không bị xóa tự động. Lỗi sao lưu được báo qua Telegram nếu đã cấu hình.

Khôi phục từ bản sao lưu:

1. Dừng Glean.
2. Chép tệp `glean-auto-….db` muốn dùng thành `data/glean.db`, rồi xóa `data/glean.db-wal` và `data/glean.db-shm` nếu có.
3. Chép thư mục `media/` trong thư mục sao lưu vào `data/media`.
4. Chạy lại Glean.

## Dùng với diễn đàn thật

1. **Cài đặt → Nguồn dữ liệu**: đổi "Địa chỉ diễn đàn" (ví dụ `https://forum.example.com`).
2. Bấm **Lấy chuyên mục từ diễn đàn**, tick các chuyên mục muốn đồng bộ, bấm "Dùng … chuyên mục đã chọn".
3. Bấm **Lưu cài đặt**. Đồng bộ tự động chạy theo chu kỳ; muốn có dữ liệu ngay thì vào Nhật ký đồng bộ → "Đồng bộ ngay".
4. Nếu diễn đàn có nhiều tên miền (ví dụ `forum.example.net`, `forum.example.org`), thêm chúng vào "Tên miền cũ" để dán link từ các tên miền đó vẫn sàng được.

Đã chạy thử với một diễn đàn XenForo thật (2026-11-08): lấy danh sách chuyên mục, đồng bộ bài viết và bình luận, tìm kiếm, sàng các bài nhiều trang (ảnh i.ibb.co tải về được).

Giới hạn đã biết:
- Ảnh trên host có lớp chống bot (ví dụ voz.vn qua Cloudflare) không tải về được; Glean không vượt các lớp này. Giao diện vẫn hiển thị ảnh bằng link gốc, nên chỉ mất khi ảnh gốc biến mất.
- Host không kết nối được từ mạng của bạn (ví dụ zpi.cx tại thời điểm thử) cũng chỉ còn link gốc.
- Bài chỉ dành cho thành viên đăng nhập báo lỗi HTTP 403; Glean không đăng nhập vào diễn đàn.

## Đối chiếu với FEATURES.md

| Mục | Trạng thái | Ghi chú |
|---|---|---|
| 3.1 Tìm bài viết (từ khóa / tác giả, khớp cụm / chứa từ, sắp xếp, "Trang tiếp theo", "Đang hiển thị X / Y") | Có | |
| 3.1 Phát hiện tìm nhầm chế độ, gợi ý liên quan, độ tươi dữ liệu, lịch sử cuộn vô hạn + realtime, deep-link `?q=`, nút "Lọc ảnh" | Có | Gợi ý dùng dịch vụ semantic nếu cấu hình, nếu không thì so khớp từ (bm25) |
| 3.2 Tìm bình luận (toàn kho hoặc một bài qua link/ID, theo tác giả, đếm chéo, lịch sử) | Có | |
| 3.3 Sàng: hàng đợi + thứ hạng, tiến trình realtime theo trang và theo ảnh, 5 tab phân trang, "Ở trang N" | Có | |
| 3.3 Ảnh tải về máy (giữ link gốc để dự phòng, đánh dấu ảnh hỏng `isBin`), bài bị xóa vẫn xem bản lưu trữ | Có | |
| 3.3 Xóa / sàng lại / làm mới, lịch tự xóa (cấu hình được, 0 = giữ mãi), trạng thái proxy, bỏ qua tên miền, cảnh báo đổi tên miền, hỏi trước khi mở link ngoài | Có | |
| 3.4 Đồng bộ tự động theo chu kỳ, nhật ký + chi tiết từng lần, đồng bộ thủ công (loại, khoảng trang / tất cả, batch, chuyên mục, start/stop, tiến trình + log realtime) | Có | |
| 3.5 Tạm dừng theo tính năng, thông báo hệ thống, buộc tải lại khi có phiên bản mới, clone/sao lưu, đăng nhập + 2FA TOTP, JWT + refresh token, đổi mật khẩu, trang quản trị hỏi lại mã 2FA | Có | |
| 4 Cấu hình động lưu DB, nạp nóng | Có | Khóa bí mật được che khi gửi về trình duyệt |
| 5.8 HTTP interceptor (Bearer, refresh single-flight, header `error-message-type`, retry có điều kiện) | Có | |
| 5.9 Upload thường + upload theo phần | Có (API) | Chưa có màn hình nào cần tải tệp lên |
| Video chuyển HLS bằng FFmpeg | Có, tùy chọn | Chỉ chạy khi bật và máy có FFmpeg |

Thay thế công nghệ so với hệ thống gốc: Elasticsearch → SQLite FTS5 (bỏ dấu khi "chứa từ", giữ dấu khi "đúng cụm từ"); SignalR → Server-Sent Events (cùng mã sự kiện, có join/leave group); Redis, Serilog, ElasticAPM không cần cho bản cá nhân. Khóa AI được lưu nhưng, giống bản gốc, chưa tính năng nào dùng tới. Ảnh thu nhỏ chưa được tạo (giao diện dùng ảnh gốc với `loading="lazy"`).

## Cấu trúc

```
server/            Fastify + node:sqlite
  index.ts         khởi động, xác thực, SSE
  db.ts            schema + FTS5
  config.ts        cấu hình động
  auth.ts          JWT, refresh, TOTP
  search.ts        tìm bài viết / bình luận, lịch sử, gợi ý
  sync.ts          đồng bộ tự động + thủ công, nhật ký
  scraper.ts       hàng đợi sàng, tải ảnh/video, lưu trữ
  system.ts        bảo trì, phiên bản, cấu hình, sao lưu
  media.ts         phục vụ /media, upload
  net.ts           fetch qua proxy xoay vòng, health-check
  source/xenforo.ts  bộ đọc HTML kiểu XenForo
  demo/forum.ts    diễn đàn mẫu
web/src/           React + Vite
```

## Thiết kế

Tên "Glean" nghĩa là mót lúa: nhặt lại những gì còn sót trên ruộng sau mùa gặt, như ứng dụng giữ lại bài viết, ảnh và bình luận trước khi chúng biến mất. "Sàng" vẫn là tên tính năng chính: sàng một chủ đề dài để giữ lại thứ có giá trị. Giao diện theo hướng **4a**: nền trắng, thanh bên tím nhạt, một màu nhấn tím duy nhất, các vùng tách nhau bằng đường kẻ mảnh thay cho thẻ hay khung. Tiến trình sàng hiện bằng **dải trang** (mỗi thanh là một trang của chủ đề, tô tím khi đã quét) và vòng tròn tiến độ. Một ô tìm chung trên thanh trên: gõ chữ để tìm, dán link hoặc ID bài để đưa vào hàng đợi sàng. Chữ: một họ Lexend (300–600, có bộ ký tự tiếng Việt, đóng gói sẵn, không tải từ CDN). Có chế độ sáng/tối/theo máy; dưới 1240px các bố cục nhiều cột xếp thành một cột, dưới 880px thanh bên nhường chỗ cho thanh điều hướng dưới. Song ngữ Việt/Anh.

Chi tiết token màu, cỡ chữ, thành phần dùng chung và nguồn dữ liệu của từng màn hình nằm trong [DESIGN.md](DESIGN.md).
