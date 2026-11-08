# Sàng

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

Biến môi trường: `SANG_PORT` (mặc định 4318), `SANG_HOST` (mặc định 127.0.0.1, đặt `0.0.0.0` để mở ra mạng LAN), `SANG_DATA_DIR` (mặc định `./data`), `SANG_LOG`.

## Diễn đàn mẫu

Mặc định nguồn dữ liệu là một diễn đàn mẫu chạy ngay trong server (`/demo-forum`), sinh nội dung tiếng Việt có tính tất định: 4 chuyên mục, gần 200 chủ đề, ảnh SVG, ảnh hỏng, ảnh "không phải ảnh", ảnh từ tên miền quảng cáo, video nhúng, liên kết ngoài, trích dẫn và bình luận rác. Bài viết mới "xuất hiện" dần theo thời gian thực; một số chủ đề bị xóa giữa chừng.

Để thử tính năng lưu trữ khi bài bị xóa: `POST /demo-forum/_toggle-delete/<threadId>` rồi sàng lại bài đó.

## Dùng với diễn đàn thật

1. **Cài đặt → Nguồn dữ liệu**: đổi "Địa chỉ diễn đàn" (ví dụ `https://xamvn.work`).
2. Bấm **Lấy chuyên mục từ diễn đàn**, tick các chuyên mục muốn đồng bộ, bấm "Dùng … chuyên mục đã chọn".
3. Bấm **Lưu cài đặt**. Đồng bộ tự động chạy theo chu kỳ; muốn có dữ liệu ngay thì vào Nhật ký đồng bộ → "Đồng bộ ngay".
4. Nếu diễn đàn có nhiều tên miền (ví dụ `xamvn.bond`, `xamvn.cyou`), thêm chúng vào "Tên miền cũ" để dán link từ các tên miền đó vẫn sàng được.

Đã chạy thử với xamvn.work (2026-11-08): lấy danh sách chuyên mục, đồng bộ bài viết và bình luận, tìm kiếm, sàng các bài nhiều trang (ảnh i.ibb.co tải về được).

Giới hạn đã biết:
- Ảnh trên host có lớp chống bot (ví dụ voz.vn qua Cloudflare) không tải về được; Sàng không vượt các lớp này. Giao diện vẫn hiển thị ảnh bằng link gốc, nên chỉ mất khi ảnh gốc biến mất.
- Host không kết nối được từ mạng của bạn (ví dụ zpi.cx tại thời điểm thử) cũng chỉ còn link gốc.
- Bài chỉ dành cho thành viên đăng nhập báo lỗi HTTP 403; Sàng không đăng nhập vào diễn đàn.

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

Tên "Sàng" lấy từ cái sàng tre: công việc chính của ứng dụng là sàng một chủ đề dài để giữ lại thứ có giá trị. Điểm nhấn duy nhất là **lưới sàng**: mỗi lỗ là một trang của chủ đề, lấp vàng khi đã quét. Phần còn lại giữ yên: nền xám sương lạnh, chữ chàm, vàng tre chỉ dùng cho tiến trình và vị trí đang đứng. Chữ: Bricolage Grotesque cho tiêu đề và số, Be Vietnam Pro cho nội dung (cả hai có bộ ký tự tiếng Việt, đóng gói sẵn, không tải từ CDN). Có chế độ sáng/tối, hiển thị tốt trên điện thoại, song ngữ Việt/Anh.
