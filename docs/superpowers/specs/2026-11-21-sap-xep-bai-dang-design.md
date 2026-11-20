# Sắp xếp bài đăng theo like, lượt xem, bình luận — thiết kế

Ngày: 2026-11-21 · Trạng thái: đã duyệt (thiết kế ngắn)

## Mục đích

Ở trang Tìm kiếm > Bài đăng, anh muốn xếp kết quả theo độ "hot" của bài: nhiều like nhất, nhiều lượt xem nhất, nhiều bình luận nhất. Hiện chỉ có "Mới nhất" và "Nhiều bình luận nhất"; DB chưa lưu lượt xem và like.

## Mục tiêu

- Ô "Sắp xếp" có 4 lựa chọn: Mới nhất, Nhiều bình luận, Nhiều lượt xem, Nhiều like.
- Mỗi dòng kết quả hiện số lượt xem và số like cạnh số bình luận.
- "Like" = **tổng like của mọi post trong topic** (anh chọn).

## Không làm

- Định kỳ đọc lại toàn bộ trang cũ của topic để cập nhật like (cách 2, anh không chọn).
- Sort trong phần tìm bình luận.
- Phân loại reaction (chỉ đếm tổng).

## Cách tiếp cận (đã chọn cách 1)

| Cách | Đổi lại |
|------|---------|
| **1. Lưu like từng bình luận, cộng dồn vào topic** (chọn) | Rẻ, sort nhanh. Like ở trang cũ chỉ cập nhật khi trang đó được đọc lại (đồng bộ chỉ đọc lại vài trang cuối), nên topic cũ có thể thấp hơn thực tế. Topic chưa đồng bộ bình luận = 0 like. |
| 2. Như 1 + định kỳ đọc lại toàn bộ trang | Chính xác hơn nhưng request tăng nhiều lần, dễ bị chặn chống bot. |

Lượt xem chỉ có một cách hợp lý: đọc ô "Lượt xem" ở trang danh sách diễn đàn khi đồng bộ bài.

## Thiết kế

- **DB** (thêm cột qua `ensureColumn` trong `migrate`): `thread.view_count`, `thread.like_count`, `comment.like_count`, đều `INTEGER NOT NULL DEFAULT 0`; index giảm dần cho hai cột của `thread`.
- **Đọc lượt xem** (`fetchForumPage`): ô `dd` của `dl` thứ hai trong `.structItem-cell--meta`; không có thì 0. Lưu khi thêm/cập nhật topic trong `sync.ts`. Lượt xem đổi liên tục nên chỉ đổi lượt xem cũng phải được ghi, nhưng không tính là "cập nhật" topic trong lịch sử đồng bộ (tránh làm nhiễu số liệu đồng bộ).
- **Đọc like** (`parseThreadHtml`): trong `.reactionsBar` của mỗi post, số tên người (`bdi`, hoặc link `.username`) cộng số "N người khác"/"N others". Không có reactionsBar → 0.
- **Cộng dồn**: `upsertComments` ghi `comment.like_count` rồi cập nhật `thread.like_count = SUM(comment.like_count)`, cùng chỗ với `synced_comment_count`.
- **API** `/posts/search`: `sortDescendingField` nhận thêm `viewCount`, `likeCount`; trả thêm `viewCount`, `likeCount`. Hòa nhau thì xếp theo `created_at DESC`.
- **Giao diện** `Search.tsx`: thêm 2 option và hiện số; tham số URL `sort` nhận thêm 2 giá trị.
- **Diễn đàn mẫu**: thêm ô Lượt xem và reactionsBar để test và chạy thử.

## Giả định (việc của người làm)

- Cấu trúc HTML theo XenForo 2 chuẩn, chưa kiểm tra trên diễn đàn thật; nếu giao diện khác thì chỉnh bộ đọc.
