# Glean — hệ thiết kế 4a

Tài liệu này mô tả giao diện web của Glean **như đang có trong code**. Nguồn gốc là bản tham chiếu "Glean 4a" (Claude Design) và README bàn giao đi kèm. Chỗ nào code khác bản tham chiếu đều ghi ở mục [Khác với bản tham chiếu](#khác-với-bản-tham-chiếu).

| Ở đâu | Chứa gì |
|---|---|
| `web/src/styles.css` | Toàn bộ token, thành phần dùng chung, bố cục từng màn, responsive |
| `web/src/components/ui.tsx` | Component dùng chung: `Mesh`, `Donut`, `Switch`, `OtpInput`, `Status`, `Empty`, `Pager`, `Dialog`, `Highlight`… |
| `web/src/components/Icons.tsx` | `Icon` (bộ icon nét mảnh) và `Mark` (logo) |
| `web/src/components/Shell.tsx` | Khung: thanh bên, thanh trên, ô tìm chung, thanh dưới mobile, chế độ sáng/tối |

## Nguyên tắc

1. **Một màu nhấn.** Tím (`--acc`) chỉ dùng cho hành động chính, mục đang chọn và tiến trình. Xanh lá và đỏ chỉ để báo trạng thái.
2. **Kẻ, không khung.** Các vùng tách nhau bằng đường kẻ 1px. Không có thẻ, panel nền nổi hay bóng đổ (trừ tooltip, gợi ý ô tìm, toast, hộp thoại).
3. **Chữ mảnh.** Thân chữ Lexend 300; nhấn bằng 400–500, không dùng đậm 700.
4. **Không bịa số.** Khối nào API chưa trả số liệu thì bỏ khối, không tính tạm ở trình duyệt.
5. **Song ngữ.** Mọi chuỗi đi qua `t('tiếng Việt', 'English')`.
6. **Giữ khả năng truy cập.** `:focus-visible` (viền 2px `--acc`), `aria-*`, `.sr-only`; công tắc và ô mã vẫn là `<input>` thật bên dưới.

## Màu

Token khai báo trên `:root`. Tối áp dụng khi `<html data-theme="dark">`, hoặc khi không có `data-theme` và hệ điều hành đang tối (`prefers-color-scheme`).

| Token | Sáng | Tối | Dùng cho |
|---|---|---|---|
| `--bg` | `#fff` | `#15161f` | Nền trang, nền ô nhập, lõi donut |
| `--side` | `#f3f3fa` | `#1b1c28` | Thanh bên, cột trái trang đăng nhập |
| `--field` | `#f6f6fb` | `#22232f` | Ô tìm chung, nền phụ (notice, tag, skeleton) |
| `--ink` | `#1f2233` | `#eceef7` | Chữ chính |
| `--dim` | `#565a70` | `#a3a7bd` | Chữ phụ, meta, nhãn |
| `--line` | `#ececf3` | `#2a2c3b` | Kẻ chia vùng |
| `--line2` | `#f1f1f6` | `#242633` | Kẻ giữa các dòng danh sách |
| `--bd` | `#e3e3ee` | `#34364a` | Viền ô nhập, nút phụ, segmented, chip |
| `--axis` | `#d3d3e0` | `#44465c` | Trục biểu đồ, công tắc tắt, icon chưa chọn, chấm tắt |
| `--acc` | `oklch(0.52 0.19 285)` | `oklch(0.7 0.15 285)` | Nền nút chính, mục đang chọn, phần đã xong của tiến trình |
| `--acc-ink` | `oklch(0.45 0.19 285)` | `oklch(0.8 0.11 285)` | Chữ màu nhấn (nút phụ, link, tab đang chọn) |
| `--tint` | `oklch(0.93 0.04 285)` | `oklch(0.3 0.07 285)` | Nền mục đang chọn, highlight, avatar |
| `--acc2` | `oklch(0.74 0.12 285)` | `oklch(0.5 0.13 285)` | Bậc 2: trang đang quét |
| `--acc3` | `oklch(0.92 0.03 285)` | `oklch(0.3 0.04 285)` | Bậc 3: rãnh thanh tiến độ, trang chưa quét |
| `--ok` / `--ok-ink` | `oklch(0.62 0.15 150)` / `oklch(0.45 0.13 150)` | `oklch(0.72 0.15 150)` / `oklch(0.8 0.13 150)` | Thành công, đang bật |
| `--bad` / `--bad-ink` | `oklch(0.6 0.19 25)` / `oklch(0.48 0.17 25)` | `oklch(0.68 0.17 25)` / `oklch(0.78 0.12 25)` | Lỗi, đã xóa, hành động nguy hiểm |
| `--tip` | `#2b2d42` | `#0c0d14` | Nền tooltip, toast, khung log |
| `--on-acc` | `#fff` | `#15161f` | Chữ trên nền `--acc` |
| `--warm` | `oklch(0.78 0.15 75)` | như sáng | Bong bóng "bình luận" |
| `--cool` | `oklch(0.78 0.11 200)` | như sáng | Bong bóng "bài viết" |

Chữ trên `--warm` / `--cool` luôn là `#1f2233` ở cả hai chế độ. Khung log dùng chữ `#d5d7e6`, giờ `#9a9db5`.

**Chế độ hiển thị** có ba giá trị `auto | light | dark`, lưu ở `localStorage['theme']`. `useTheme()` trong `Shell.tsx` là một store dùng chung, nên nút trên thanh trên và bộ chọn ở trang Bảo mật luôn đồng bộ với nhau. Nút trên thanh trên đọc chế độ đang hiện thực tế (kể cả khi `auto`) và chuyển sang chế độ ngược lại.

### Ánh xạ từ token cũ

| Cũ | Mới |
|---|---|
| `--mist` | `--bg` |
| `--rail-bg` | `--side` |
| `--sheet`, `--sheet-2` | `--field` |
| `--ink`, `--text` | `--ink` |
| `--steel`, `--text-2`, `--rail-text` | `--dim` |
| `--line-soft` | `--line` |
| `--line` | `--bd` |
| `--straw`, `--focus` | `--acc` |
| `--straw-ink` | `--acc-ink` |
| `--straw-soft` | `--tint` |
| `--hole` | `--acc3` |
| `--moss` | `--ok` / `--ok-ink` |
| `--rust` | `--bad` / `--bad-ink` |
| `--r-panel` | bỏ |

## Chữ

Một họ duy nhất: **Lexend** 300 / 400 / 500 / 600, gói `@fontsource/lexend` (bộ `vietnamese` + `latin`), đóng gói cùng app, không tải từ CDN. `--font-display` và `--font-ui` cùng trỏ về Lexend. `.num` chỉ bật `font-variant-numeric: tabular-nums`.

| Vai trò | Cỡ / đậm | Class |
|---|---|---|
| Thân | 14px / 300 / lh 1.5 | `body` |
| Tiêu đề trang | 22px / 500 | `.page-title` |
| Mô tả cạnh tiêu đề | 14px / 300, `--dim`, cùng baseline | `.page-lede` |
| Tiêu đề mục | 16px / 400 | `.section-title` |
| Mô tả dưới tiêu đề mục | 13px, `--dim` | `.section-sub` |
| Số lớn | 24px / 500 / lh 1.2 | `.big-num`, `.figure .num` |
| Tiêu đề kết quả tìm | 15.5px / 400 | `.result-title` |
| Tên dòng | 14px / 400 | `.row-title`, `.line-title`, `.gt-title` |
| Meta | 13px / 300, `--dim` | `.row-meta`, `.muted` |
| Phụ nhỏ, tiêu đề cột | 12.5px, `--dim` | `.line-sub`, `.gtr.head`, `.field small` |
| Nhãn nhóm thanh bên | 11.5px / 400, `letter-spacing: .1em`, chữ hoa | `.rail-group-title` |
| Chữ "GLEAN" | 13px / 600, `letter-spacing: .08em`, `--acc-ink` | `.wordmark` |

## Khoảng cách, bo góc, bóng

- **Thang khoảng cách** `--s1…--s8` = 4, 8, 12, 16, 24, 32, 48, 72px (giữ từ bản cũ).
- **Bo góc**: `--r-field` 6px cho nút, ô nhập, segmented, chip, tooltip, log, notice, toast; 8px cho mục thanh bên, ô ảnh, hộp thoại, mã QR; 50% cho avatar, chấm, donut, thumbnail.
- **Bóng**: chỉ `--shadow-tip` (`0 10px 24px -10px rgba(0,0,0,.5)`) cho tooltip, gợi ý ô tìm, toast. Hộp thoại có bóng riêng. Không có bóng ở thẻ hay khung.
- **Chiều cao thanh trên** `--topbar-h`: 68px (thanh bên dùng cùng số cho hàng logo).

## Khung (Shell)

```
┌────────────┬──────────────────────────────────────────────┐
│ GLEAN      │ [ ô tìm chung …………… ]     [Giao diện tối] (S) │  68px, sticky
│────────────│──────────────────────────────────────────────│
│ MENU       │                                              │
│ Bàn làm việc│  .main  padding 30px 44px 56px               │
│ Tìm kiếm   │                                              │
│ Kho        │                                              │
│ Hàng đợi ⑥ │                                              │
│ HỆ THỐNG   │                                              │
│ Đồng bộ …  │                                              │
│ ● trực tiếp│                                              │
│ Đăng xuất  │                                              │
└────────────┴──────────────────────────────────────────────┘
  236px
```

**Thanh bên** (`.rail`): nền `--side`, padding `0 16px 20px`, dính trên, cao 100vh.

| Nhóm | Mục | Route | Sáng khi path |
|---|---|---|---|
| MENU | Bàn làm việc | `/` | đúng `/` |
| | Tìm kiếm | `/bai-viet/tu-khoa` | bắt đầu `/bai-viet` hoặc `/binh-luan` |
| | Kho | `/sang` | `/sang` và `/sang/:id` |
| | Hàng đợi sàng | `/hang-doi` | `/hang-doi`; badge = số lượt đang chờ + đang chạy |
| HỆ THỐNG | Đồng bộ | `/dong-bo` | |
| | Nhật ký | `/nhat-ky/bai-viet` | bắt đầu `/nhat-ky` |
| | Cài đặt | `/cai-dat` | |
| | Sao lưu | `/sao-luu` | |
| | Bảo mật | `/ho-so` | |

Mục (`.rail-link`) cao 44px, bo 8, icon 16px. Đang chọn: nền `--tint`, chữ `--acc-ink` 500, icon `--acc`. Chưa chọn: chữ `--dim` 400, icon `--axis`; rê chuột thì chữ `--ink`. Chân thanh bên: chấm 8px (`--ok` khi đang nhận cập nhật trực tiếp, `--axis` khi đang kết nối lại) và nút Đăng xuất. Nút đổi ngôn ngữ nằm ở trang Bảo mật.

**Thanh trên** (`.topbar`): ô tìm chung, khoảng trống, nút đổi giao diện, avatar chữ cái + tên đăng nhập (bấm vào mở `/ho-so`). Trên mobile chỉ còn logo 30px, ô tìm, avatar.

**Ô tìm chung** (`Omnibox` trong `Shell.tsx`, `id="omni"`):
- Nhận ra link bài (`…/threads/ten-bai.12345/`) hoặc ID số → gọi `useCreateScrape(v, 'home', { navigate: true })`: đưa vào hàng đợi rồi mở `/sang/:id`. Lỗi hiện ngay dưới ô.
- Chữ thường → tìm. Đang ở trang tìm thì giữ route và bộ lọc hiện tại, chỉ đổi `q`; ở trang khác thì mở `/bai-viet/tu-khoa?q=…`.
- Trên trang tìm, ô hiện lại từ khóa đang tìm; sang trang khác thì ô trống.
- Khi đang gõ, một ô gợi ý nhỏ dưới ô tìm cho biết Enter sẽ làm gì ("Nhận ra bài #3041…", "Nhấn Enter để tìm bài viết.").

## Bố cục

| Class | Lưới | Dùng ở |
|---|---|---|
| `.cols` > `.col-main` + `.col-side` | `minmax(0,1fr) 360px`; cột trái `padding-right: 40px`; cột phải kẻ trái `--line`, `padding-left: 36px` | Tìm kiếm, Kho, Hàng đợi, Bài đã sàng, Đồng bộ, Sao lưu, Bảo mật |
| `.cols.pad-top` | như trên, thêm `padding-top: 24px` cho cả hai cột | Hàng đợi |
| `.desk-top` | như `.cols`, kẻ dưới, `padding-bottom: 28px` | Hàng trên Bàn làm việc |
| `.cols-3` | `250px minmax(0,1fr) 330px`, ngăn bằng kẻ trái, `padding-top: 26px` | Hàng dưới Bàn làm việc |
| `.settings` > `.settings-nav` + `.settings-body` | `180px minmax(0,1fr)`; mục lục dính ở `top: calc(var(--topbar-h) + 30px)`; cột form kẻ trái, rộng tối đa 760px | Cài đặt |
| `.page-head` (`.tight`) | flex, căn baseline, wrap; khoảng dưới 22px (18px) | Đầu mọi trang |
| `.section-head` | tiêu đề mục trái, nút phụ phải | |
| `.crumbs` | 13px `--dim` | Bài đã sàng, chi tiết nhật ký |
| `.rule-below` | kẻ dưới `--line` | |

`.page` không còn giới hạn chiều rộng.

## Responsive

Làm bằng media query trong `styles.css`; `Shell` dùng `matchMedia('(max-width: 879px)')` chỉ để đổi placeholder ô tìm.

| Mức | Điều kiện | Thay đổi |
|---|---|---|
| Rộng | ≥ 1240px | Như mô tả ở trên |
| Vừa | 880–1239px | Thanh bên giữ nguyên. `.cols`, `.cols-3`, `.desk-top` thành một cột: cột phải xuống dưới, bỏ kẻ trái, thêm `padding-top: 28px`. Mục lục Cài đặt ẩn, cột form bỏ kẻ trái. |
| Hẹp | < 880px | Ẩn thanh bên. Hiện thanh điều hướng dưới (`.bottomnav`). Trên các trang hệ thống hiện thêm hàng tab ngang (`.systabs`) dưới thanh trên. Thanh trên padding 18px, ẩn nút giao diện và tên. `.main` padding `24px 18px 96px`. Toast đẩy lên 74px, thanh lưu Cài đặt dính ở `bottom: 58px`. Trang đăng nhập chỉ còn cột form. Bảng Kho ẩn cột Trang, Video, Sàng lúc. |

**Thanh dưới**: cố định đáy, 5 cột đều, mỗi mục cao tối thiểu 58px, icon 18px + nhãn 11.5px: **Bàn · Tìm · Kho · Hàng đợi · Hệ thống**. "Hệ thống" mở `/dong-bo` và sáng khi đang ở bất kỳ trang hệ thống nào. Badge hàng đợi nằm góc trên icon.

## Thành phần

### Nút và link

| Loại | Class | Quy cách |
|---|---|---|
| Nút chính | `.btn.btn-primary` | Nền `--acc`, chữ `--on-acc` 500, không viền; rê chuột `filter: brightness(.94)` |
| Nút phụ | `.btn` | Cao 34px, padding `0 16px`, viền `--bd`, nền trong, chữ `--acc-ink` 500 13px; rê chuột viền `--dim` |
| Cỡ | `.btn-sm` 32px · mặc định 34px · `.btn-lg` 40px (form) · `.btn-xl` 44px (đăng nhập, ô sàng) | |
| Nút trầm | `.btn.btn-ghost` | Không viền, chữ `--dim`; dùng cho "Hủy", "Làm mới" |
| Nguy hiểm | `.btn-danger` | Chỉ là chữ 13px `--bad-ink`, gạch chân khi rê chuột ("Xóa khỏi kho", "Bỏ", "Đăng xuất"). Trong `.dialog-actions` thành nút đặc nền `--bad`. |
| Link dạng chữ | `.link-btn` (`.muted`) | Chữ `--acc-ink` (hoặc `--dim`), gạch chân khi rê chuột |
| Xem thêm | `.more-btn` | 13px / 500 `--acc-ink` |

`transition: background .12s, border-color .12s` giữ trên `.btn`. Nút bị tắt mờ 50%.

### Nhập liệu

| Loại | Class / component | Quy cách |
|---|---|---|
| Trường | `.field` > `span` (nhãn 13px/300) + ô + `small` (gợi ý 12.5px `--dim`) | |
| Ô nhập | `.input` (`.input-lg` 44px), `.select`, `.textarea` | Cao 40px, bo 6, viền `--bd`, nền `--bg`. Focus: viền + vòng 1px `--acc`. `.textarea` cao tối thiểu 84px. |
| Ô chọn dạng nút | `select.pick` | Cao 32px, viền `--bd`, mũi tên vẽ bằng SVG; bộ lọc trang Tìm kiếm |
| Segmented | `.seg` > `button`/`a` (`.on`) | Viền `--bd`, bo 6; mục padding `7px 14px` 13px; đang chọn nền `--tint` chữ `--acc-ink` 500 |
| Công tắc | `Switch` → `label.switch-row` + `input.switch` | 40×22, bo 11, bật `--acc`, tắt `--axis`, núm 18px trắng. Một dòng nhãn + công tắc, kẻ dưới `--line2`. Bên dưới là checkbox thật (`role="switch"`). |
| Chip chọn nhiều | `.chips` > `button.chip[aria-pressed]` | Cao 32px, viền `--bd`; đã chọn nền `--tint`, chữ `--acc-ink` 500, không viền |
| Checkbox | `.check` (nhãn + ô), `.cb` (ô đứng riêng) | 16px, `accent-color: var(--acc)` |
| Mã 6 số | `OtpInput` → `.otp` | Sáu ô 38×46px, bo 6, chữ 18px/500; ô đang gõ viền `--acc`. Bên dưới là một `<input inputmode="numeric" autocomplete="one-time-code">` trong suốt phủ lên sáu ô. |

### Tab

`.tabs` > `button` hoặc `a` (`.on`): hàng flex, gap 28px, kẻ dưới `--line`, cuộn ngang được, ẩn thanh cuộn. Mục padding `10px 0 12px`. Đang chọn: `box-shadow: inset 0 -2px 0 var(--acc)`, chữ `--ink` 500. Còn lại: `--dim` 400. Số đếm: `.count` `--dim` 300.

`.tabs-bar` đặt `.tabs` và một nhóm `.filters` (căn phải) trên cùng một kẻ dưới.

### Danh sách và bảng

| Mẫu | Class | Ghi chú |
|---|---|---|
| Dòng chung | `.rows` > `.row` | Padding 12px 0, kẻ dưới `--line2`, không nền |
| Meta | `.row-meta` | 13px `--dim`; tự chèn dấu "·" giữa các con. `.row-meta.plain` để tắt dấu. |
| Hành động trong dòng | `.row-actions` | 13px, các `link-btn` cách nhau 16px |
| Dòng gọn | `.line` > `.thumb`? + `.line-text` (`.line-title` + `.line-sub`) + `.line-value` | Dùng cho "Vừa lưu", "Vừa tìm", "Đang chờ", lịch sử tìm, tệp sao lưu. Có thể là `a.line` hoặc `button.line`. |
| Khóa / giá trị | `.kv` | Khóa `--dim` trái, giá trị 400 phải |
| Kết quả bài viết | `.result` > `.result-text` + trạng thái | Trạng thái là `Status` hoặc nút chính |
| Bình luận | `.comment` | Lưới `34px 1fr`: avatar + nội dung + `.comment-meta` |
| Bảng lưới | `.gtable` > `.gtr` (`.head`) | Cột đặt bằng class riêng: `.lib-row` (Kho), `.log-row` (Nhật ký). Bọc trong `.gtable-scroll` để cuộn ngang. Mỗi dòng có thể là `a.gtr`. |
| Bảng chọn | `label.table-row` | Lưới `20px 1fr 1fr 80px` (Sao lưu) |
| Bảng HTML | `.table` | Còn giữ cho chỗ cần; hàng tiêu đề 12.5px `--dim`, không kẻ dọc |

### Trạng thái và tiến trình

| Thành phần | Class / component | Quy cách |
|---|---|---|
| Chấm trạng thái | `Status tone="ok \| bad \| off \| acc"` → `.status` + `.dot` | Chấm 9px + chữ 13px; `bad` đổi chữ sang `--bad-ink` |
| Chú giải | `.legend` + `.dot-acc` / `.dot-acc2` / `.dot-acc3` | |
| Thanh tiến độ | `.bar` > `span` | Cao 6, bo 3, rãnh `--acc3`, phần chạy `--acc` |
| Khối tiến độ có nhãn | `.progress` | Dòng "Tải ảnh … 38 / 61" + `.bar` |
| Dải trang | `Mesh` → `.pages` > `.page-cell` (`.done`, `.now`) | Mỗi trang một thanh cao 8px bo 2: xong `--acc`, đang quét `--acc2`, chưa `--acc3`. Tới 20 trang: lưới `repeat(n, 1fr)` gap 4px kèm số trang 11.5px. Trên 20 trang (hoặc `size="sm"`): `.dense`, các thanh xuống dòng, không số. Props giữ như bản cũ. |
| Donut | `Donut total done current size` | `conic-gradient(--acc 0 A%, --acc2 A% B%, --acc3 B%)` quanh lõi `--bg`. `lg` 164px vành 26 · `md` 108px vành 17 (chữ 18px/500) · `sm` 96px vành 15 (chữ 17px) |
| Tooltip | `.tooltip` (`.tt-head`, `.tt-sub`, `.tt-big`) | Nền `--tip`, chữ trắng, bo 6, có bóng |
| Khung log | `.log` (`time` cho giờ) | Nền `--tip`, 12.5px lh 1.7, cao tối đa 220px, cuộn |

### Ảnh và người

| Thành phần | Class | Quy cách |
|---|---|---|
| Lưới ảnh | `.gallery` | `repeat(auto-fill, minmax(118px, 1fr))`, gap 12px |
| Ô ảnh | `.tile` (`.on`) | Tỉ lệ 4/3, bo 8, nền sọc khi chưa tải. Đang chọn: `box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--acc)` |
| Ảnh lỗi | `.tile-broken` (`.waiting`) | Viền 1px dashed `--axis` (đang chờ: viền liền `--line`), nền `--bg`, chữ 12px `--dim`: "Không tải được" / "Không phải ảnh" / "Đang chờ tải về" |
| Avatar chữ cái | `.avatar` | 34px tròn, nền `--tint`, chữ `--acc-ink` 500 13px |
| Thumbnail | `.thumb` | 38px tròn, sọc `--line` / `--field` (giữ chỗ) |
| Highlight | `mark` | Nền `--tint`, chữ `--acc-ink`, bo 3, padding `0 2px` |
| Mã QR | `.qr` | 132px, bo 8, nền trắng |

### Thông báo

| Thành phần | Class | Quy cách |
|---|---|---|
| Ghi chú | `.notice` | Nền `--field`, bo 6 |
| Tạm dừng / chờ | `.notice-straw` | Nền `--tint`, chữ `--acc-ink` (`PausedNotice`, thứ tự chờ) |
| Lỗi | `.notice-rust` | Nền `--bad` 12% trộn `--bg`, chữ `--bad-ink` (proxy lỗi, bài đã xóa) |
| Trạng thái tốt | `.notice-moss` | Không nền: một dòng có chấm `--ok` |
| Lỗi dưới form | `.error-text` | 13px `--bad-ink` |
| Rỗng | `Empty` → `.empty` | Tiêu đề 16px/400 + mô tả `--dim` |
| Đang tải | `Spinner` → `.skeleton` | Dải nhấp nháy `--field` / `--line2` |
| Toast | `.toast` (`.error`) | Nền `--tip` (lỗi: `--bad`), bo 6, có bóng |
| Banner phiên bản mới | `.banner-straw` | Nền `--tint`, chữ `--acc-ink` |
| Hộp thoại | `Dialog` → `.scrim` + `.dialog` | Nền `--bg`, viền `--line`, bo 8; tiêu đề 18px/500 |
| Trình xem ảnh | `.lightbox` | Nền gần đen, giữ như bản cũ |

`.tag` (`-straw`, `-moss`, `-rust`) còn dùng cho nhãn nhỏ: loại video, HLS, hành động trong chi tiết nhật ký.

### Icon và logo

`Icon name size` vẽ trên lưới 24px, nét 1.6, màu theo `currentColor`. Tên có sẵn: `desk`, `search`, `archive`, `queue`, `sync`, `log`, `settings`, `backup`, `shield`, `system`. Thanh bên dùng 16px, thanh dưới 18px.

`Mark size` là logo Glean (cùng hình với `web/public/mark.svg`) tô bằng `--acc` và `--on-acc`, nên tự đổi theo sáng/tối. `mark.svg` vẫn là favicon.

## Màn hình

### 1. Đăng nhập / Thiết lập — `pages/AuthPages.tsx`

Hai cột bằng nhau, cao 100vh; dưới 880px chỉ còn cột form.
- Trái (`.auth-art`): logo + GLEAN; câu "Kho riêng để tìm lại những gì đã trôi qua." 34px/500 và đoạn mô tả 15px; dưới cùng một dòng nhỏ.
- Phải: form rộng tối đa 360px, gap 18px, ô cao 42px, nút chính 44px. Bước nhập mã 2 lớp dùng `OtpInput`. `SetupPage` dùng cùng khung.

### 2. Bàn làm việc — `/`, `pages/Home.tsx`

| Khối | Dữ liệu |
|---|---|
| **Nạp vào kho** + nút "Xem nhật ký" | Số bài và số bình luận từ `/systems/overview`; trạng thái đồng bộ tự động của từng loại từ `/sync/auto-status` (đang chạy / tắt / lỗi / "đồng bộ X trước · mỗi N phút") |
| **Đang sàng** + nút "Xem hàng đợi" | `useScrapeQueue()`: tên bài, donut 164px (đã quét / đang quét / còn lại), tooltip "Đang quét · trang X trên Y · N ảnh" hoặc "Đang tải ảnh", chú giải ba chấm, "Đang chờ: …". Không có lượt nào chạy → `Empty`. |
| **Trong kho** | Ba bong bóng: bình luận 148px `--warm`, ảnh đã lưu 100px `--acc`, bài viết 88px `--cool`; số từ `ov.comments / ov.images / ov.threads`. Dòng phụ: số bài đã xóa trên diễn đàn còn bản lưu. |
| **Vừa lưu vào kho** | 3 lượt sàng mới nhất (`/scrapes/processed?size=3`), bấm mở `/sang/:id` |
| **Vừa tìm** | 4 từ khóa mới nhất, gộp lịch sử tìm bài viết và tìm bình luận, cập nhật trực tiếp |

### 3. Tìm kiếm — `/bai-viet/:mode`, `/binh-luan/:mode`, `pages/Search.tsx`

- **URL là nguồn sự thật**: `q`, `exact=1`, `sort=commentCount` (bài viết), `thread=` (bình luận). Ô tìm chung và các bộ lọc chỉ đổi URL; trang tự tìm lại khi URL đổi.
- Đầu trang: `Kết quả cho "…"` + "N kết quả · dữ liệu đồng bộ X trước". Chưa có từ khóa thì là "Tìm bài viết" / "Tìm bình luận" + số trong kho.
- Tab **Bài viết · Bình luận** là link giữa hai route (giữ `q`, `exact`), kèm số. Số của tab còn lại lấy từ `/posts/search/count` hoặc `/comments/search/count`.
- Bộ lọc bên phải hàng tab: kiểu khớp, chế độ (theo từ khóa / theo người đăng), sắp xếp (bài viết) hoặc "Chỉ trong một bài" (bình luận, mở thêm ô link/ID bài).
- Cột trái: dòng bài viết (tiêu đề có highlight, meta, bên phải là nút "Sàng bài này" hoặc chấm `--bad` "Đã xóa · còn bản lưu"); dòng bình luận (avatar, nội dung có highlight, meta, "Xem bình luận" / "Sàng bài này"). Cuối danh sách: "Xem thêm N kết quả".
- Cột phải: **Đã tìm gần đây** (cuộn vô hạn, "Xóa lịch sử") và **Có thể liên quan** (chỉ khi tìm bài viết theo từ khóa và có gợi ý).
- Hai route render `SearchPage` với `key` khác nhau để trạng thái không lẫn giữa bài viết và bình luận.

### 4. Kho — `/sang`, `SievePage` trong `pages/Sieve.tsx`

- Đầu trang: "Kho" + tổng bài viết / bình luận / ảnh đã lưu.
- Tab **Đã sàng** (số = `ov.scrapes`).
- Cột trái: bảng `.lib-row` — thumbnail, tiêu đề + dòng phụ ("Bài #id"; bài đã xóa hoặc thất bại thì chữ `--bad-ink`), Trang, Ảnh, Video, Bình luận, Sàng lúc. Cuộn vô hạn theo cursor. Bấm dòng mở `/sang/:id`.
- Cột phải: **Theo chuyên mục** — tên + số bài + thanh tỉ lệ so với chuyên mục nhiều bài nhất (`ov.forums`); ghi chú thời hạn giữ dữ liệu đọc từ `scraper.retentionHours` của `/systems/config`.

### 5. Hàng đợi sàng — `/hang-doi`, `QueuePage` trong `pages/Sieve.tsx`

- Đầu trang + mô tả; `PausedNotice feature="scrape"`; cảnh báo proxy; ô "Dán link bài viết hoặc nhập ID" 44px + nút chính 44px (`SieveForm`); dòng ví dụ; kẻ dưới.
- Cột trái: **Đang xử lý** (`NowSieving`: donut 108px "5/9", tên bài, "Bài #id · bắt đầu hh:mm · đã thấy N ảnh", dải trang, thanh "Tải ảnh") và **Đang chờ** (số thứ tự trong vòng tròn 28px, tiêu đề, "thêm X trước từ …", nút "Bỏ").
- Cột phải: **Vừa xong** (5 lượt mới nhất, số ảnh, thời lượng) và **Kết nối** (Proxy từ `/scrapes/check-proxy`; "Quét song song" từ `scraper.concurrentPages` và `scraper.concurrentImageDownloads`).

### 6. Bài đã sàng — `/sang/:id`, `pages/SieveDetail.tsx`

- Cột trái: breadcrumb "Kho › Bài #id"; tiêu đề + "Làm mới" / "Sàng lại" (khi đã xong) / "Mở bài gốc"; meta (trạng thái · số trang · thời điểm); các cảnh báo (proxy, bài đã xóa, lỗi, thứ tự chờ); dải trang + tiến trình khi đang sàng; tab **Ảnh · Video · Liên kết · Bình luận · Bình luận lưu trữ**; nội dung tab với `Pager`.
- Cột phải: **Lượt sàng** — donut 96px "đã quét/tổng trang", số ảnh đã lưu (chấm `--ok`), số ảnh không tải được (chấm `--bad`), tình trạng bài gốc. **Ảnh đang chọn** (tab Ảnh) — Vị trí, Nguồn (tên miền), Bản lưu; nút "Phóng to" + "Mở ảnh gốc". Thời điểm tự xóa nếu có. Cuối cùng là "Xóa khỏi kho" (hỏi lại qua `useConfirm`).
- Bấm một ảnh: mở trình xem và đánh dấu ảnh đó là "đang chọn". Chuyển ảnh trong trình xem cũng đổi ảnh đang chọn.

### 7. Đồng bộ — `/dong-bo`, `pages/ManualSync.tsx` (bọc `SudoGate`)

- Cột trái: **Tự động** — hai dòng Bài viết / Bình luận, chỉ đọc (lần gần nhất, chu kỳ, chấm trạng thái), kèm link sang Cài đặt › Đồng bộ tự động để sửa. **Thủ công** — segmented loại dữ liệu; Từ trang / Đến trang (110px), Bản ghi mỗi lần lưu (150px), "Tất cả các trang"; chip chuyên mục; nút chính 40px "Bắt đầu đồng bộ" hoặc nút "Dừng đồng bộ" chữ `--bad-ink` khi đang chạy.
- Cột phải: **Đang chạy / Lần thủ công gần nhất** — phạm vi chạy, hai số lớn (bản ghi, thời gian chạy), thanh tiến độ, dòng trạng thái có chấm, khung log.

### 8. Nhật ký — `/nhat-ky/bai-viet`, `/nhat-ky/binh-luan`, `pages/Logs.tsx`

- Một cột. Đầu trang: tiêu đề + "N lần · mỗi dòng là một lần quét một chuyên mục" + nút "Đồng bộ ngay".
- Tab **Bài viết · Bình luận** là link giữa hai route.
- Bảng `.log-row` (`minmax(0,1.4fr) 150px 100px 110px 110px`): Chuyên mục (lỗi hiện dưới tên, `--bad-ink`) · Bắt đầu · Thời lượng · Cách chạy · Bài mới / đổi. Mỗi dòng mở chi tiết. `Pager` ở dưới.
- Chi tiết (`SyncLogDetailPage`): breadcrumb, tiêu đề chuyên mục, danh sách bài thay đổi; bài đã xóa trên diễn đàn có chấm `--bad`.

### 9. Cài đặt — `/cai-dat`, `pages/Settings.tsx` (bọc `SudoGate`)

- `.settings`: mục lục dính bên trái + cột form. Mỗi nhóm là một `fieldset` (tiêu đề 16px/400 + mô tả 13px), kết thúc bằng kẻ `--line` cách trên dưới 28px.
- Trường ngắn và số xếp `.form-grid` (`repeat(auto-fill, minmax(160px, 1fr))`, gap 14px 16px); trường bật/tắt là `Switch`; danh sách là `.textarea`.
- Thanh lưu dính đáy: nút chính 40px "Lưu cài đặt" (mờ khi chưa có thay đổi), "Bỏ thay đổi", trạng thái "Đã lưu." / "Có thay đổi chưa lưu."
- Danh sách và thứ tự trường theo `server/config.ts`. Link dạng `/cai-dat#sync` cuộn tới đúng nhóm sau khi cấu hình tải xong.

### 10. Sao lưu — `/sao-luu`, `pages/Backup.tsx` (bọc `SudoGate`)

- Cột trái: **Sao lưu toàn bộ** (ô "Tệp đích" rộng tối đa 420px + nút chính 40px, dòng thư mục lưu ở dưới), kẻ; **Chép từng bảng** (nút phụ "Chép bảng đã chọn" bên phải tiêu đề; mỗi bảng một dòng `.table-row`: checkbox · tên hiển thị · tên bảng · số dòng); khung log khi đã chép.
- Cột phải: **Các tệp sao lưu** (tên, thời điểm, dung lượng).

### 11. Bảo mật & hiển thị — `/ho-so`, `pages/Profile.tsx`

- Cột trái: **Xác thực 2 lớp** — đoạn mô tả; khi thiết lập: mã QR 132px + `OtpInput` + nút chính "Bật xác thực 2 lớp", khóa nhập tay ở dưới; khi đang bật: dòng có chấm `--ok` + "Tắt xác thực 2 lớp" (chữ `--bad-ink`, hỏi mã trước khi tắt). Kẻ. **Mật khẩu** — ba ô rộng tối đa 360px + nút phụ "Đổi mật khẩu".
- Cột phải: **Hiển thị** — "Giao diện" (Tự động · Sáng · Tối) và "Ngôn ngữ" (Tiếng Việt · English) dạng segmented; "Đăng xuất" chữ `--bad-ink`.

`SudoGate` (Đồng bộ, Cài đặt, Sao lưu khi đã bật 2 lớp) dùng cùng `OtpInput` và nút chính 40px.

## Khác với bản tham chiếu

### Khối đã bỏ vì API chưa có số liệu

| Khối trong thiết kế | Thiếu gì | Thay bằng |
|---|---|---|
| Biểu đồ "12 lần đồng bộ gần nhất" và dòng "↑ 6 bài và 41 bình luận…" (Bàn làm việc) | Số bài và số bình luận theo từng lần chạy | Trạng thái đồng bộ tự động của từng loại |
| Tab "Tất cả bài viết", "Đã xóa trên diễn đàn" (Kho) | API lọc lượt sàng theo các nhóm này | Chỉ còn tab "Đã sàng" |
| "M đã sàng" trong Theo chuyên mục (Kho) | Số lượt sàng theo chuyên mục | Thanh thể hiện số bài so với chuyên mục nhiều bài nhất |
| Chuyên mục, người đăng, ảnh thu nhỏ của lượt sàng | Lượt sàng không mang các trường này | "Bài #id"; thumbnail giữ chỗ |
| Tab "Tất cả" (Tìm kiếm) | Một API gộp bài viết + bình luận | Hai tab, mỗi tab có số |
| "Ảnh theo trang" và dòng "Người đăng" của Ảnh đang chọn (Bài đã sàng) | Số ảnh theo trang; người đăng của ảnh | Bỏ biểu đồ; Ảnh đang chọn còn Vị trí, Nguồn, Bản lưu |
| Hàng ba số ở trang đăng nhập | Số liệu cần đăng nhập mới đọc được | Một dòng chữ nhỏ |
| Công tắc và ô sửa chu kỳ ở "Tự động" (Đồng bộ) | Các khóa này đang nằm trong Cài đặt | Hiển thị chỉ đọc + link sang Cài đặt |

### Thay đổi nhỏ về hành vi

- Ô tìm và dán link chuyển từ Bàn làm việc lên thanh trên, có mặt ở mọi trang.
- Phần sàng tách thành hai mục: Kho (`/sang`) và Hàng đợi sàng (route mới `/hang-doi`).
- Lượt đang chờ có nút "Bỏ" (dùng API xóa sẵn có).
- Dòng trong Kho không còn nút "Sàng lại" / "Xóa" riêng; hai việc này nằm ở trang chi tiết.
- Bấm ảnh vẫn mở trình xem, đồng thời điền bảng "Ảnh đang chọn".
- Nút đổi ngôn ngữ chuyển từ thanh bên sang trang Bảo mật.

### Lệch nhỏ có chủ ý

- `mark` padding `0 2px` thay vì `0 3px`: tìm không dấu có thể khớp giữa từ ("s**anh**"), padding 3px làm chữ bị tách rõ.
- Logo dùng hình `mark.svg` sẵn có, tô lại bằng màu nhấn, thay cho vòng tròn chữ "g" giữ chỗ.
- Bộ chọn giao diện ở trang Bảo mật có thêm "Tự động" (theo máy), vì app vẫn giữ chế độ `auto`.
- Trang chi tiết giữ nút "Làm mới"; trang Tìm kiếm giữ link "Tìm bình luận trong bài" và nút "Sàng bài này" cho từng bình luận.

## Khi thêm hoặc sửa màn hình

- Dùng token, không viết mã màu trực tiếp (ngoại lệ đã nêu: chữ trên `--warm`/`--cool`, chữ trong log và tooltip).
- Màn có nội dung phụ thì dùng `.cols` / `.col-main` / `.col-side`; tách vùng bằng kẻ, không thêm nền hay bóng.
- Tiêu đề trang dùng `.page-head` + `.page-title` + `.page-lede`; tiêu đề mục dùng `.section-title`.
- Trạng thái dùng `Status`, tiến trình dùng `.bar`, `Mesh`, `Donut`; hành động nguy hiểm dùng `.btn-danger`.
- Mọi chuỗi qua `t(vi, en)`. Khối không có số liệu thật thì bỏ.
- Kiểm tra ở ba mức rộng (≥ 1240, 880–1239, < 880px) trong cả sáng và tối.
