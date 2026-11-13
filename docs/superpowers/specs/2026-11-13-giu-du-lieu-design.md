# Giữ dữ liệu — thiết kế

Ngày: 2026-11-13 · Trạng thái: đã duyệt

## Mục đích

Glean tồn tại để giữ lại bài viết, bình luận và ảnh trước khi chúng biến mất khỏi diễn đàn. Hiện app vẫn để mất dữ liệu ở bốn chỗ:

1. Bình luận bị sửa trên diễn đàn thì bản cũ bị ghi đè (`upsertComments`, [server/sync.ts](../../../server/sync.ts)).
2. Bình luận bị xóa lẻ không được đánh dấu; chỉ biết khi cả chủ đề bị xóa.
3. "Sàng lại" xóa ảnh và bình luận của lượt sàng trước khi quét lại ([server/scraper.ts](../../../server/scraper.ts), route `retry`). Nếu bài đã bị xóa trên diễn đàn và đây là lượt sàng duy nhất, ảnh mất hẳn.
4. Sao lưu phải bấm tay, chỉ có file DB (không có ảnh), và nằm cùng ổ đĩa với dữ liệu gốc.

Thêm nữa, đồng bộ tự động chỉ đi tiếp từ trang cuối đã có, nên sửa/xóa ở trang cũ không bao giờ được thấy nếu không sàng lại.

## Mục tiêu

- Không bao giờ mất nội dung đã thu về vì diễn đàn sửa, xóa, hoặc vì thao tác "Sàng lại".
- Thấy được bình luận nào đã bị sửa (kèm các bản trước) và bình luận nào đã bị xóa trên diễn đàn.
- Sao lưu tự động, có cả ảnh, đặt được ở ổ đĩa khác.

## Không làm (lần này)

- Tìm kiếm trong nội dung các bản cũ (chỉ xem được, không tìm được).
- Lịch sử đổi tiêu đề chủ đề.
- Quét lại toàn bộ trang cũ của mọi chủ đề (đã chọn cách "vài trang cuối"; trang cũ hơn chỉ được đối chiếu khi sàng).
- Khôi phục từ bản sao lưu ngay trong app (vẫn khôi phục bằng cách chép file, có hướng dẫn trong README).
- Sao lưu lên dịch vụ đám mây.

## Điều tuyệt đối tránh

- Đánh dấu nhầm "đã xóa" vì lỗi mạng, trang lỗi, hay bộ đọc HTML hỏng. Báo nhầm hàng loạt còn tệ hơn không báo.
- Tự động xóa bất kỳ dữ liệu lưu trữ nào.
- Gửi dồn request tới diễn đàn thật đến mức bị chặn.

## Cách tiếp cận

Đọc lại trang cũ, ba cách đã cân nhắc:

| Cách | Đổi lại | |
|---|---|---|
| Chỉ khi sàng | Không thêm request; bỏ sót phần lớn chỉnh sửa | |
| **Vài trang cuối của bài đang sôi nổi** | Thêm ~2 request mỗi bài mỗi lượt; bắt được phần lớn vì người ta thường sửa/xóa ngay sau khi đăng | **Đã chọn** |
| Quét xoay vòng toàn bộ | Không sót; tốn request nhất, dễ bị chặn | |

"Sàng lại" không mất dữ liệu, hai cách đã cân nhắc (lựa chọn của em):

- **Gộp vào chính lượt sàng đó (đã chọn):** không xóa gì trước khi quét; mục nào quét lại vẫn thấy thì cập nhật, mục mới thì thêm, mục không còn thấy thì giữ và gắn nhãn "không còn trên diễn đàn". Ảnh đã tải được dùng lại, không tải lại. Mỗi chủ đề vẫn một dòng trong danh sách.
- Mỗi lần sàng lại tạo một lượt mới, giữ lượt cũ: đơn giản hơn nhưng danh sách bị trùng, và ảnh của bài đã xóa nằm rải ở các lượt cũ.

## Thiết kế

### 1. Lịch sử sửa và phát hiện xóa (bảng `comment`)

- Bảng mới `comment_revision(id, comment_id, content, captured_at, replaced_at)`: mỗi khi nội dung một bình luận đổi, bản cũ được chép vào đây trước khi ghi đè. `captured_at` là lúc bản đó được lưu, `replaced_at` là lúc phát hiện thay đổi.
- Cột mới trên `comment`: `edit_count` (số bản cũ, để hiện nhãn nhanh), `edited_at` (giờ "Sửa lần cuối" do diễn đàn ghi, nếu đọc được từ `.message-lastEdit`), `deleted_at` (lúc Glean phát hiện bình luận không còn).
- So sánh nội dung sau khi gộp khoảng trắng, để thay đổi chỉ do khoảng trắng không tạo bản sửa.
- **Quy tắc phát hiện xóa** (hàm thuần, có test): khi đọc một dải trang liền nhau [a..b] của một chủ đề, lấy khoảng ID bài viết từ bài đầu trang a tới bài cuối trang b (mở về −∞ nếu a = 1, mở về +∞ nếu b là trang cuối). Bình luận đã lưu có ID trong khoảng đó mà không xuất hiện → đặt `deleted_at`. Bình luận đang có `deleted_at` mà xuất hiện lại (được khôi phục) → xóa nhãn. Dựa vào ID bài, không dựa vào số trang hay #n, vì khi một bài bị xóa các bài sau dồn trang.
- **Chốt an toàn:** bỏ qua phát hiện xóa cho dải trang nếu có trang trả về 0 bài, nếu có bài thiếu ID thật (ID giả `threadId*100000+postNo`), hoặc nếu số bị đánh dấu vượt quá nửa số bình luận đã lưu trong khoảng (ghi cảnh báo vào nhật ký thay vì đánh dấu).
- Khi cả chủ đề bị xóa (HTTP 404/403), giữ nguyên cách cũ: đánh dấu chủ đề, không đánh dấu từng bình luận.

### 2. Đọc lại vài trang cuối khi đồng bộ bình luận

- Cấu hình mới trong `sync.comments`: `recheckPages` (mặc định 2, 0 = tắt) và `recheckWithinHours` (mặc định 48).
- Danh sách chủ đề mỗi lượt = chủ đề có bình luận mới (như hiện tại) cộng với chủ đề có `last_post_at` trong `recheckWithinHours` giờ qua, vẫn giới hạn bởi `maxThreadsPerRun`.
- Với mỗi chủ đề: bắt đầu đọc từ `max(1, trangCuốiĐãLưu − recheckPages + 1)` rồi đi tiếp như cũ (trang mới vẫn giới hạn bởi `pagesPerRun`). Không đọc trùng trang trong cùng lượt. Áp quy tắc phát hiện xóa cho dải vừa đọc.
- Đồng bộ thủ công bình luận dùng chung đường này.
- Nhật ký đồng bộ ghi thêm số bình luận sửa/xóa theo chủ đề (dòng log và mục chi tiết với `action` = `edited` / `deleted`).

### 3. "Sàng lại" gộp thay vì xóa

- Thêm `run_no` cho `scrape`; thêm `post_id`, `last_seen_run`, `missing_since` cho `scrape_image`, `scrape_video`, `scrape_link`, `scrape_comment`.
- Route `retry` không xóa dòng và tệp nữa; chỉ tăng `run_no`, đặt lại trạng thái và bộ đếm tiến trình.
- Khi lưu mục của một trang: nếu đã có mục cùng khóa trong lượt sàng → cập nhật trang/#n/nội dung và `last_seen_run`; chưa có → thêm. Khóa: ảnh/video = (`post_id`, URL gốc), liên kết = (`post_id`, URL), bình luận = `post_id`; dùng #n thay `post_id` khi thiếu ID.
- Hoàn tất thành công: mục không thấy trong lượt này → đặt `missing_since` (nếu chưa có); mục thấy lại → xóa `missing_since`.
- Tải ảnh vẫn chỉ lấy dòng chưa có tệp, nên ảnh đã tải được dùng lại; ảnh lần trước tải lỗi được thử lại.
- Bài bị xóa trên diễn đàn khi sàng lại: giữ nguyên toàn bộ dữ liệu của chính lượt sàng này; chỉ chép từ lượt sàng khác khi lượt này chưa có gì (như hiện tại).
- Lượt sàng lỗi giữa chừng: giữ nguyên mọi mục (cũ và mới thêm). Nhờ upsert nên không bị trùng; mục thiếu chỉ được đánh dấu khi lượt sàng hoàn tất.
- "Xóa" lượt sàng do người dùng bấm vẫn xóa hẳn như hiện tại.

### 4. Sao lưu tự động

- Cấu hình mới `backup`: `enabled` (mặc định bật), `intervalHours` (24), `keep` (7), `targetDir` (trống = `data/backups`), `includeMedia` (bật), `notifyOnFail` (bật, qua Telegram nếu đã cấu hình).
- Mỗi lượt: `VACUUM INTO <targetDir>/glean-auto-YYYYMMDD-HHmm.db`, rồi xóa bớt bản `glean-auto-*` cũ hơn `keep` bản gần nhất. Bản sao lưu tay (tên khác) không bao giờ bị xóa tự động.
- Ảnh: chép `data/media` sang `<targetDir>/media`, chỉ chép tệp chưa có hoặc khác kích thước. Không xóa tệp trong bản chép (bản sao ảnh chỉ tăng dần).
- Trạng thái lượt gần nhất (giờ, dung lượng, số tệp ảnh đã chép, lỗi) hiện ở trang Sao lưu, kèm nút "Sao lưu ngay" và phần cài đặt. Đổi `targetDir` cần xác nhận lại 2FA như các cài đặt khác.
- Lượt đầu chạy sau khi khởi động một lúc nếu chưa có bản nào trong `intervalHours` giờ qua.

### 5. Giao diện

- Thẻ bình luận (kết quả tìm bình luận, tab "Bình luận lưu trữ" của trang sàng): nhãn "đã sửa · N lần" bấm để mở các bản trước (kèm giờ); nhãn "đã xóa trên diễn đàn" kèm giờ phát hiện.
- Tìm bình luận: thêm bộ lọc "Chỉ bình luận đã sửa/xóa".
- Trang chi tiết sàng: mục có `missing_since` mang nhãn "không còn trên diễn đàn"; đầu trang ghi số mục như vậy.
- Trang Sao lưu: khối "Sao lưu tự động" như mục 4.
- Cài đặt → Đồng bộ: hai ô `recheckPages`, `recheckWithinHours`.
- Song ngữ Việt/Anh như phần còn lại.

### 6. Hạ tầng

- Nâng cấp DB đã có: thêm cột bằng `ALTER TABLE … ADD COLUMN` sau khi kiểm tra `pragma table_info` (vì `CREATE TABLE IF NOT EXISTS` không thêm cột vào DB cũ). DB thật của người dùng phải nâng cấp được mà không mất gì.
- Diễn đàn mẫu thêm `POST /demo-forum/_edit-post/:postId` và `POST /demo-forum/_toggle-post-delete/:postId` để thử offline; README ghi cách dùng.
- Thêm `npm test` (`node --test` qua `tsx`) với test cho: quy tắc phát hiện xóa và các chốt an toàn, ghi bản sửa khi nội dung đổi, gộp mục khi sàng lại, xoay vòng bản sao lưu.

## Để người làm tự quyết

- Tên cột/bảng cụ thể, cách chia hàm, vị trí đặt bộ hẹn giờ sao lưu.
- Cách hiển thị chi tiết các bản cũ (mở rộng tại chỗ hay hộp thoại), miễn hợp với phong cách giao diện hiện có.
- Ngưỡng an toàn "quá nửa" có thể chỉnh nếu test cho thấy cần.
