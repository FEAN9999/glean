# Sàng lại hàng loạt — thiết kế ngắn

## Ý định
Làm mới nhiều bài đã sàng tới thời điểm hiện tại mà không phải mở từng bài bấm "Sàng lại".

## Mục tiêu / không làm
- Có: chọn nhiều bài trong Kho để sàng lại; nút "Sàng lại tất cả" cho toàn bộ Kho.
- Không: lọc theo ngày sàng, lịch tự sàng lại, sàng nối tiếp (chỉ trang mới).

## Cách làm (đã chọn)
- Đã xét: trình duyệt gọi `/retry` cho từng bài — loại vì Kho tải dần 20 bài/lần nên không làm được "tất cả", và nhiều lệnh gọi khó báo lỗi rõ.
- Chọn: một endpoint server `POST /api/scrapes/retry-many` nhận `{ ids }` hoặc `{ all: true }`.

## Thiết kế
- Server: chỉ sàng lại lượt Completed/Failed, chưa xóa; lượt Waiting/Processing bỏ qua. Trả `{ queued, skipped }`.
  Từ chối khi sàng đang tạm dừng (`assertNotPaused`). Mỗi bài qua `prepareRerun` (giữ dữ liệu cũ),
  phát `NewScrape` cho từng bài, `kick()` một lần.
- Kho: ô chọn mỗi dòng, ô "chọn hết các bài đang hiện" ở tiêu đề; thanh "Đã chọn N bài · Sàng lại · Bỏ chọn".
  Nút "Sàng lại tất cả" cạnh tab "Đã sàng", hỏi xác nhận kèm số bài. Xong: toast "Đã đưa N bài vào hàng đợi"
  + "Xem hàng đợi", bỏ chọn, tải lại Kho (bài đang chờ tạm vắng khỏi Kho tới khi sàng xong).
- Kiểm tra: test server trước; xem giao diện trên bản scratch, không đụng `data/` thật.

## Để người làm tự quyết
Vị trí/kiểu dáng thanh chọn theo `styles.css` sẵn có; cách lấy số bài cho hộp xác nhận.
