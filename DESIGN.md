# Glean — hệ thiết kế 4b

Tài liệu này mô tả giao diện web của Glean **như đang có trong code**. Bản 4b (11/2026) dựng trên bản 4a, vốn đi từ bản tham chiếu "Glean 4a" (Claude Design) và README bàn giao đi kèm. So với 4a, bản 4b thêm ba thứ:
- **Lớp đêm:** khung đầu trang chủ, trang đăng nhập và đầu mọi màn là các mảng nền tím đêm.
- **Thẻ bo tròn** cho phần phụ.
- **Chuyển động** bằng Motion.

Chỗ nào code khác bản tham chiếu đều ghi ở mục [Khác với bản tham chiếu](#khác-với-bản-tham-chiếu).

| Ở đâu | Chứa gì |
|---|---|
| `web/src/app.css` | Stylesheet vào của app: nạp `styles.css` vào layer `app` và Tailwind (xem [Tailwind](#tailwind)) |
| `web/src/styles.css` | Toàn bộ token, thành phần dùng chung, bố cục từng màn, responsive, hiệu ứng CSS |
| `web/src/components/ui.tsx` | Component dùng chung: `Mesh`, `Donut`, `Switch`, `OtpInput`, `Status`, `Empty`, `Pager`, `Dialog`, `TabMark`, `Highlight`, `Bone`, `Skeleton*`… |
| `web/src/components/magic/` | Component chép từ Magic UI (`NumberTicker`, `BorderBeam`, `MagicCard`) và Aceternity (`Spotlight`), giấy phép MIT, đã chỉnh; đầu mỗi file ghi nguồn và chỗ đã đổi |
| `web/src/components/Icons.tsx` | `Icon` (bộ icon nét mảnh) và `Mark` (logo) |
| `web/src/components/Shell.tsx` | Khung: thanh bên, thanh trên, ô tìm chung, thanh dưới mobile, chế độ sáng/tối, hiệu ứng chuyển trang (`PageEnter`) |
| `web/src/lib/ease.ts` | `EASE_OUT`, đường cong chung của mọi hiệu ứng vào |
| `web/src/lib/cn.ts` | `cn()` ghép class (clsx + tailwind-merge) cho các component trong `magic/` |

## Nguyên tắc

1. **Một màu nhấn trên nền sáng.** Tím (`--acc`) chỉ dùng cho hành động chính, mục đang chọn và tiến trình. Xanh lá và đỏ chỉ để báo trạng thái. Trên mảng đêm có thêm vàng lúa (`--wheat`): phần đang chạy, nhấn phụ.
2. **Đêm ở đầu, thẻ cho phần phụ.**
   - Đầu mỗi màn là một dải đêm (xem [Đầu trang](#đầu-trang)).
   - Cột phụ, từng mục Cài đặt, ô số liệu và thẻ ở Bàn làm việc là thẻ bo tròn, viền 1px `--line`, không nền nổi, không bóng.
   - Trong một vùng, các dòng vẫn tách nhau bằng kẻ.
   - Bóng chỉ có ở gợi ý ô tìm, danh sách chọn trang, toast, hộp thoại, ô ảnh khi rê chuột và quầng sáng của nút chính khi rê chuột.
3. **Chữ mảnh.** Thân chữ Lexend 300; nhấn bằng 400–500, không dùng đậm 700. Chữ lớn trên mảng đêm dùng 300.
4. **Chuyển động có lý do.**
   - Mỗi màn có một nhịp vào: chuyển trang, hoặc danh sách hiện so le.
   - Chuyển động còn lại đáp lại thao tác: vạch chọn trượt theo mục mới, nút lún khi bấm, hộp thoại và toast hiện ra.
   - Người bật "giảm chuyển động" trong hệ điều hành thấy ngay trạng thái cuối (xem [Chuyển động](#chuyển-động)).
5. **Không bịa số.** Khối nào API chưa trả số liệu thì bỏ khối, không tính tạm ở trình duyệt.
6. **Song ngữ.** Mọi chuỗi đi qua `t('tiếng Việt', 'English')`.
7. **Giữ khả năng truy cập.**
   - `:focus-visible` là viền 2px `--acc`. Dùng `aria-*` và `.sr-only` như cũ.
   - Công tắc và ô mã vẫn là `<input>` thật bên dưới.
   - Số đếm chạy có bản `.sr-only` mang giá trị cuối, phần chạy thì `aria-hidden`.

## Màu

Token khai báo trên `:root`. Tối áp dụng khi `<html data-theme="dark">`, hoặc khi không có `data-theme` và hệ điều hành đang tối (`prefers-color-scheme`).

| Token | Sáng | Tối | Dùng cho |
|---|---|---|---|
| `--bg` | `#fff` | `#15161f` | Nền trang, nền ô nhập, nền thẻ, lõi donut |
| `--side` | `#f3f3fa` | `#1b1c28` | Thanh bên |
| `--field` | `#f6f6fb` | `#22232f` | Ô tìm chung, nền phụ (notice, tag, skeleton), nền dòng khi rê chuột |
| `--ink` | `#1f2233` | `#eceef7` | Chữ chính |
| `--dim` | `#565a70` | `#a3a7bd` | Chữ phụ, meta, nhãn |
| `--line` | `#ececf3` | `#2a2c3b` | Kẻ chia vùng, viền thẻ |
| `--line2` | `#f1f1f6` | `#242633` | Kẻ giữa các dòng danh sách |
| `--bd` | `#e3e3ee` | `#34364a` | Viền ô nhập, nút phụ, segmented, chip |
| `--axis` | `#d3d3e0` | `#44465c` | Trục biểu đồ, công tắc tắt, icon chưa chọn, chấm tắt |
| `--acc` | `oklch(0.52 0.19 285)` | `oklch(0.7 0.15 285)` | Nền nút chính, mục đang chọn, phần đã xong của tiến trình |
| `--acc-ink` | `oklch(0.45 0.19 285)` | `oklch(0.8 0.11 285)` | Chữ màu nhấn (nút phụ, link, tab đang chọn) |
| `--tint` | `oklch(0.93 0.04 285)` | `oklch(0.3 0.07 285)` | Nền mục đang chọn, highlight, avatar, vòng focus của ô nhập |
| `--acc2` | `oklch(0.74 0.12 285)` | `oklch(0.5 0.13 285)` | Bậc 2: trang đang quét |
| `--acc3` | `oklch(0.92 0.03 285)` | `oklch(0.3 0.04 285)` | Bậc 3: rãnh thanh tiến độ, trang chưa quét |
| `--ok` / `--ok-ink` | `oklch(0.62 0.15 150)` / `oklch(0.45 0.13 150)` | `oklch(0.72 0.15 150)` / `oklch(0.8 0.13 150)` | Thành công, đang bật |
| `--bad` / `--bad-ink` | `oklch(0.6 0.19 25)` / `oklch(0.48 0.17 25)` | `oklch(0.68 0.17 25)` / `oklch(0.78 0.12 25)` | Lỗi, đã xóa, hành động nguy hiểm |
| `--tip` | `#2b2d42` | `#0c0d14` | Nền toast, khung log |
| `--on-acc` | `#fff` | `#15161f` | Chữ trên nền `--acc` |

**Mảng đêm** giống nhau ở cả hai chế độ:

| Token | Giá trị | Dùng cho |
|---|---|---|
| `--night` | `#1a1440` | Nền dải đầu trang, khung đầu Bàn làm việc, nửa trái trang đăng nhập |
| `--violet` | `#a99bff` | Phần đã quét trên vòng sàng, đầu cuối các dải màu (vạch tab, thanh tiến độ), luồng sáng |
| `--wheat` | `#f2c46d` | Phần đang quét, trạng thái đang chạy trên nền đêm, quầng sáng góc dải đầu trang |
| `--mist` | `#ece9ff` | Chữ trên nền đêm (chữ phụ là `--mist` 60–85%); tiêu đề lớn là `#fff` |

Trên nền đêm, màu trạng thái viết thẳng:
- Thất bại ở đầu trang chi tiết là `#ffb4a8`.
- Chấm của nhãn đồng bộ ở Bàn làm việc: lỗi `oklch(0.68 0.17 25)`, tốt `oklch(0.75 0.15 150)`.

Nút trên nền đêm là kính mờ: nền trắng 8%, viền trắng 16%.

`--mist` ở đây là token mới, không liên quan tới `--mist` của bản cũ trong bảng ánh xạ dưới.

Tailwind thấy các token trên dưới tên `ink`, `dim`, `acc`, `acc-ink`, `line`, `field`, `tint`, `background`, `border` (trỏ về biến của app, nên theo sáng/tối) và `night`, `violet`, `wheat`, `mist`. Khung log dùng chữ `#d5d7e6`, giờ `#9a9db5`.

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
| Tiêu đề trang (trên dải đêm) | `clamp(24px, 2.6vw, 32px)` / 300, `letter-spacing: -0.02em`, `#fff` | `.page-title` trong `.page-head` |
| Tiêu đề trang (chỗ khác, ví dụ khung chờ) | 22px / 500 | `.page-title` |
| Mô tả cạnh tiêu đề | 14px / 300; trên dải đêm là `--mist` 72% | `.page-lede` |
| Số lớn Bàn làm việc | `clamp(56px, 9vw, 112px)` / 300, `letter-spacing: -0.045em` | Tailwind trong `Home.tsx` |
| Câu chào trang đăng nhập | `clamp(30px, 4.4vw, 54px)` / 300, `letter-spacing: -0.03em` | Tailwind trong `AuthPages.tsx` |
| Tiêu đề mục | 16px / 400 | `.section-title`, `.settings legend` |
| Mô tả dưới tiêu đề mục | 13px, `--dim` | `.section-sub` |
| Số trong ô số liệu | 28px / 300, `letter-spacing: -0.02em` | `.figure .num` |
| Tiêu đề kết quả tìm | 15.5px / 400 | `.result-title` |
| Tên dòng | 14px / 400 | `.row-title`, `.line-title`, `.gt-title` |
| Meta | 13px / 300, `--dim` | `.row-meta`, `.muted` |
| Phụ nhỏ, tiêu đề cột | 12.5px, `--dim` | `.line-sub`, `.gtr.head`, `.field small` |
| Nhãn nhóm thanh bên | 11.5px / 400, `letter-spacing: .1em`, chữ hoa | `.rail-group-title` |
| Chữ "GLEAN" | 13px / 600, `letter-spacing: .08em`, `--acc-ink` (trên nền đêm: `--mist`) | `.wordmark` |

## Khoảng cách, bo góc, bóng

- **Thang khoảng cách** `--s1…--s8` = 4, 8, 12, 16, 24, 32, 48, 72px.
- **Bo góc**, từ nhỏ tới lớn:

  | Bo | Dùng cho |
  |---|---|
  | `--r-field` 6px | Chip, log, toast, ô mã, nút trang của `Pager` |
  | 8px | Mục thanh bên, hộp thoại, mã QR |
  | 12px | Ô nhập |
  | 14px | Notice, ô ảnh |
  | 16px | Dòng kết quả tìm |
  | 18px | Ô số liệu |
  | 22px | Khung "Đang sàng" |
  | 24px | Dải đầu trang, cột phụ, mục Cài đặt, thẻ Bàn làm việc |
  | 28px | Khung đầu Bàn làm việc |
  | 999px | Nút, segmented, nhãn trạng thái đồng bộ |
  | 50% | Avatar, chấm, donut, thumbnail |
- **Bóng**:
  - `--shadow-tip` (`0 10px 24px -10px rgba(0,0,0,.5)`): gợi ý ô tìm, danh sách chọn trang, toast.
  - Hộp thoại có bóng riêng.
  - Ô ảnh khi rê chuột: `0 14px 30px -14px rgba(26,20,64,.55)`.
  - Nút chính khi rê chuột: quầng `0 8px 24px -8px` màu `--acc` 70%.
- **Chiều cao thanh trên** `--topbar-h`: 68px (thanh bên dùng cùng số cho hàng logo).

## Chuyển động

Thư viện là **Motion** (`motion/react`). `main.tsx` bọc cả app trong `<MotionConfig reducedMotion="user">`: người bật giảm chuyển động không thấy hiệu ứng `transform` của Motion. Hiệu ứng vào dùng `EASE_OUT` (`[0.22, 1, 0.36, 1]`, ở `lib/ease.ts`). Vạch chọn trượt bằng lò xo `stiffness 500, damping 40`.

| Ở đâu | Hiệu ứng | Làm bằng |
|---|---|---|
| Đổi mục (đoạn đầu của path) | Màn mới trượt lên 10px và hiện dần, 0.35s | `PageEnter` trong `Shell.tsx`, chạy tại chỗ nên màn không bị dựng lại và giữ trạng thái. Hết hiệu ứng thì xóa `transform`, để hộp thoại `position: fixed` bên trong vẫn bám màn hình |
| Thanh bên, tab hệ thống, thanh dưới | Nền (thanh bên) hoặc vạch (hai chỗ còn lại) của mục đang chọn trượt sang mục mới | `motion.span layoutId` (`rail-active`, `systab-active`, `bottomnav-active`) |
| Hàng tab trong màn | Vạch 2px dưới tab đang chọn trượt sang tab mới, màu chuyển `--acc` → `--violet` | `TabMark id` trong tab đang chọn: `search-tabs`, `archive-tabs`, `log-tabs`, `job-tabs` |
| Hộp thoại | Nền mờ hiện dần 0.2s; hộp phóng từ 0.97 và trượt lên 14px, 0.3s | `Dialog` |
| Toast | Vào: trượt lên và phóng từ 0.96. Ra: lướt sang phải. Các toast còn lại tự xếp lại | `AnimatePresence` + `layout` trong `UiProvider` |
| Danh sách | Kết quả tìm, bình luận, dòng bảng, ô ảnh trượt lên 8px và hiện dần, mỗi mục chậm hơn mục trước 30ms (tối đa 240ms) | CSS `@keyframes rise-in`, `animation-fill-mode: backwards` (không để lại `transform`) |
| Nút | Lún còn 0.97 khi bấm | CSS `.btn:active` |
| Ô ảnh, kết quả tìm | Ô ảnh nhấc lên 3px và có bóng; kết quả tìm có nền `--field` | CSS `:hover` |
| Bàn làm việc, đăng nhập | Xem mô tả từng màn ở dưới | Motion + `magic/` |

Hiệu ứng CSS tắt trong `@media (prefers-reduced-motion: reduce)`. `NumberTicker` hiện ngay số cuối và `BorderBeam` ẩn khi người dùng bật giảm chuyển động. Luồng sáng `Spotlight` lắc bằng `transform` nên `MotionConfig` tự dừng nó.

## Tailwind

Tailwind v4 (`@tailwindcss/vite`) chỉ dùng ở các màn và component mới: `Home.tsx`, `AuthPages.tsx`, `components/magic/`, và vài class trong `Shell.tsx` / `ui.tsx`. Các màn khác viết bằng class của `styles.css`.

- `app.css` khai thứ tự layer `theme, base, app, components, utilities`. `styles.css` nằm trong layer `app`, nên một utility đặt trên phần tử luôn thắng rule chung của app (ví dụ `h1 { font-weight }`).
- Không nạp preflight: các màn khác giữ phần reset của app.
- Utility chỉ sinh từ các file liệt kê ở `@source`. Thêm Tailwind vào file khác thì phải thêm file đó vào `@source`.
- Trước khi thêm một file vào `@source`, soát xem class sẵn có trong file có trùng tên utility không (`hidden`, `block`, `flex`, `border`, `truncate`…). Utility sẽ đè rule của app. Lúc thêm `Shell.tsx`, `ui.tsx`, `AuthPages.tsx` chỉ trùng `sr-only`, mà nghĩa giống nhau.

## Khung (Shell)

```
┌────────────┬──────────────────────────────────────────────┐
│ GLEAN      │ [ ô tìm chung …………… ]     [Giao diện tối] (S) │  68px, sticky
│────────────│──────────────────────────────────────────────│
│ MENU       │ ╭──────────────────────────────────────────╮ │
│ Bàn làm việc│ │ dải đêm: tiêu đề · mô tả · nút          │ │
│ Tìm kiếm   │ ╰──────────────────────────────────────────╯ │
│ Kho        │  .main  padding 30px 44px 56px               │
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

Mục (`.rail-link`) cao 44px, bo 8, icon 16px.
- **Đang chọn:** chữ `--acc-ink` 500, icon `--acc`. Nền `--tint` là một `span` nằm sau chữ, trượt theo mục được chọn.
- **Chưa chọn:** chữ `--dim` 400, icon `--axis`; rê chuột thì chữ `--ink`.
- **Chân thanh bên:** chấm 8px (`--ok` khi đang nhận cập nhật trực tiếp, `--axis` khi đang kết nối lại) và nút Đăng xuất.
- Nút đổi ngôn ngữ nằm ở trang Bảo mật.

**Thanh trên** (`.topbar`): ô tìm chung, khoảng trống, nút đổi giao diện, avatar chữ cái + tên đăng nhập (bấm vào mở `/ho-so`). Trên mobile chỉ còn logo 30px, ô tìm, avatar.

**Ô tìm chung** (`Omnibox` trong `Shell.tsx`, `id="omni"`):
- Nhận ra link bài (`…/threads/ten-bai.12345/`) hoặc ID số → gọi `useCreateScrape(v, 'home', { navigate: true })`: đưa vào hàng đợi rồi mở `/sang/:id`. Lỗi hiện ngay dưới ô.
- Chữ thường → tìm. Đang ở trang tìm thì giữ route và bộ lọc hiện tại, chỉ đổi `q`; ở trang khác thì mở `/bai-viet/tu-khoa?q=…`.
- Trên trang tìm, ô hiện lại từ khóa đang tìm; sang trang khác thì ô trống.
- Khi đang gõ, một ô gợi ý nhỏ dưới ô tìm cho biết Enter sẽ làm gì ("Nhận ra bài #3041…", "Nhấn Enter để tìm bài viết.").

## Đầu trang

Màn nào cũng mở đầu bằng `header.page-head` gồm `.page-title`, `.page-lede` và nút nếu có. Khi `header.page-head` là con trực tiếp của `.page`, nó thành **dải đêm**:

| Thuộc tính | Giá trị |
|---|---|
| Kích thước | Padding `28px 32px`, bo 24, cách nội dung dưới 24px |
| Nền | `--night`, kèm hai quầng sáng tĩnh: tím ở góc trên trái, `--wheat` 13% ở góc dưới phải |
| Chữ | Tiêu đề trắng (xem [Chữ](#chữ)), mô tả `--mist` 72% |
| Nút | Kính mờ (`.btn` và `.btn-ghost` như nhau) |
| Khung chờ | `.skeleton` bên trong đổi sang trắng 10% |

`.page-head` lồng bên trong khung chờ của màn khác thì giữ kiểu thường.

Trang chi tiết lượt sàng đặt đầu trang trong cột chính, nên dùng `header.page-head.job-head`:
- Xếp dọc: hàng tiêu đề + nút, dưới là dòng meta.
- Meta ở `--mist` 72%. Nhãn trang (`.tag`) là kính mờ.
- Trạng thái đang chạy là `.st-run` (`--wheat`), thất bại là `.st-bad` (`#ffb4a8`).

`.crumbs` đứng ngay trên dải thì dải cách nó 10px. Khung đầu Bàn làm việc và nửa trái trang đăng nhập là hai mảng đêm riêng, viết bằng Tailwind.

## Bố cục

| Class | Lưới | Dùng ở |
|---|---|---|
| `.cols` > `.col-main` + `.col-side` | `minmax(0,1fr) 360px`; cột trái `padding-right: 28px`; cột phải là thẻ: viền `--line`, bo 24, padding 24, `align-self: start` | Tìm kiếm, Kho, Hàng đợi, Bài đã sàng, Đồng bộ, Sao lưu, Bảo mật |
| `.cols.pad-top` | như trên, thêm `padding-top: 24px` cho cả hai cột | Hàng đợi |
| `.settings` > `.settings-nav` + `.settings-body` | `180px minmax(0,1fr)`; mục lục dính ở `top: calc(var(--topbar-h) + 30px)`, mỗi mục là viên thuốc có nền `--field` khi rê chuột; cột form rộng tối đa 760px, không kẻ | Cài đặt |
| `.page-head` (`.tight`) | flex, wrap; xem [Đầu trang](#đầu-trang) | Đầu mọi trang |
| `.section-head` | tiêu đề mục trái, nút phụ phải | |
| `.crumbs` | 13px `--dim` | Bài đã sàng, chi tiết nhật ký |
| `.rule-below` | kẻ dưới `--line` | |

`.page` không giới hạn chiều rộng.

## Responsive

Làm bằng media query trong `styles.css` và tiền tố Tailwind (`sm:`, `md:`, `xl:`, `max-[879px]:`). `Shell` dùng `matchMedia('(max-width: 879px)')` chỉ để đổi placeholder ô tìm.

| Mức | Điều kiện | Thay đổi |
|---|---|---|
| Rộng | ≥ 1240px | Như mô tả ở trên. Khung "Đang sàng" ở Bàn làm việc chỉ đứng cạnh số lớn khi ≥ 1280px. |
| Vừa | 880–1239px | Thanh bên giữ nguyên. `.cols` thành một cột: thẻ cột phụ xuống dưới, cách 28px, padding 22. Mục lục Cài đặt ẩn. Bàn làm việc: khung "Đang sàng" xuống dưới số lớn; hai thẻ danh sách đứng cạnh nhau từ 768px. |
| Hẹp | < 880px | Ẩn thanh bên. Hiện thanh điều hướng dưới (`.bottomnav`). Trên các trang hệ thống hiện thêm hàng tab ngang (`.systabs`) dưới thanh trên. Thanh trên padding 18px, ẩn nút giao diện và tên. `.main` padding `24px 18px 96px`. Toast đẩy lên 74px, thanh lưu Cài đặt dính ở `bottom: 58px`. Trang đăng nhập: mảng đêm thành một dải trên form, chỉ còn logo và câu chào. Bảng Kho ẩn cột Trang, Video, Sàng lúc. |

**Thanh dưới**: cố định đáy, 5 cột đều, mỗi mục cao tối thiểu 58px, icon 18px + nhãn 11.5px: **Bàn · Tìm · Kho · Hàng đợi · Hệ thống**. "Hệ thống" mở `/dong-bo` và sáng khi đang ở bất kỳ trang hệ thống nào. Mục đang chọn có vạch 2px `--acc` ở mép trên, trượt theo mục. Badge hàng đợi nằm góc trên icon.

## Thành phần

### Nút và link

| Loại | Class | Quy cách |
|---|---|---|
| Nút chính | `.btn.btn-primary` | Nền `--acc`, chữ `--on-acc` 500, không viền; rê chuột sáng lên 5% và có quầng `--acc` |
| Nút phụ | `.btn` | Viên thuốc (bo 999), cao 34px, padding `0 16px`, viền `--bd`, nền trong, chữ `--acc-ink` 500 13px; rê chuột viền `--dim` |
| Cỡ | `.btn-sm` 32px · mặc định 34px · `.btn-lg` 40px (form) · `.btn-xl` 44px (đăng nhập, ô sàng) | |
| Nút trầm | `.btn.btn-ghost` | Không viền, chữ `--dim`; dùng cho "Hủy", "Làm mới" |
| Nguy hiểm | `.btn-danger` | Chỉ là chữ 13px `--bad-ink`, gạch chân khi rê chuột ("Xóa khỏi kho", "Bỏ", "Đăng xuất"). Trong `.dialog-actions` thành nút đặc viên thuốc nền `--bad`. |
| Link dạng chữ | `.link-btn` (`.muted`) | Chữ `--acc-ink` (hoặc `--dim`), gạch chân khi rê chuột |
| Xem thêm | `.more-btn` | 13px / 500 `--acc-ink` |

`.btn` chuyển nền, viền, bóng và `transform` trong 0.15–0.2s, lún còn 0.97 khi bấm. Nút bị tắt mờ 50% và không lún.

### Nhập liệu

| Loại | Class / component | Quy cách |
|---|---|---|
| Trường | `.field` > `span` (nhãn 13px/300) + ô + `small` (gợi ý 12.5px `--dim`) | |
| Ô nhập | `.input` (`.input-lg` 44px), `.select`, `.textarea` | Cao 40px, bo 12, padding `0 14px`, viền `--bd`, nền `--bg`. Focus: viền `--acc` + vòng 4px `--tint`. `.textarea` cao tối thiểu 84px. |
| Ô chọn dạng nút | `select.pick` | Cao 32px, viền `--bd`, mũi tên vẽ bằng SVG; bộ lọc trang Tìm kiếm |
| Segmented | `.seg` > `button`/`a` (`.on`) | Viên thuốc viền `--bd`; mục padding `7px 14px` 13px; đang chọn nền `--tint` chữ `--acc-ink` 500 |
| Công tắc | `Switch` → `label.switch-row` + `input.switch` | 40×22, bo 11, bật `--acc`, tắt `--axis`, núm 18px trắng. Một dòng nhãn + công tắc, kẻ dưới `--line2`. Bên dưới là checkbox thật (`role="switch"`). |
| Chip chọn nhiều | `.chips` > `button.chip[aria-pressed]` | Cao 32px, viền `--bd`; đã chọn nền `--tint`, chữ `--acc-ink` 500, không viền |
| Checkbox | `.check` (nhãn + ô), `.cb` (ô đứng riêng) | 16px, `accent-color: var(--acc)` |
| Mã 6 số | `OtpInput` → `.otp` | Sáu ô 38×46px, bo 6, chữ 18px/500; ô đang gõ viền `--acc`. Bên dưới là một `<input inputmode="numeric" autocomplete="one-time-code">` trong suốt phủ lên sáu ô. |

### Tab

`.tabs` > `button` hoặc `a` (`.on`): hàng flex, gap 28px, kẻ dưới `--line`, cuộn ngang được, ẩn thanh cuộn. Mục padding `10px 0 12px`. Đang chọn: chữ `--ink` 500, có `TabMark` (vạch 2px bo 2, màu chuyển `--acc` → `--violet`, `.tab-mark`). Còn lại: `--dim` 400. Số đếm: `.count` `--dim` 300.

Tab mới phải đặt `<TabMark id="…" />` trong mục đang chọn, mỗi hàng tab một `id`. Không có `TabMark` thì mục đang chọn chỉ còn chữ đậm.

`.tabs-bar` đặt `.tabs` và một nhóm `.filters` (căn phải) trên cùng một kẻ dưới.

### Danh sách và bảng

| Mẫu | Class | Ghi chú |
|---|---|---|
| Dòng chung | `.rows` > `.row` | Padding 12px 0, kẻ dưới `--line2`, không nền |
| Meta | `.row-meta` | 13px `--dim`; tự chèn dấu "·" giữa các con. `.row-meta.plain` để tắt dấu. |
| Hành động trong dòng | `.row-actions` | 13px, các `link-btn` cách nhau 16px |
| Dòng gọn | `.line` > `.thumb`? + `.line-text` (`.line-title` + `.line-sub`) + `.line-value` | Dùng cho "Đang chờ", lịch sử tìm, tệp sao lưu. Có thể là `a.line` hoặc `button.line`. |
| Khóa / giá trị | `.kv` | Khóa `--dim` trái, giá trị 400 phải |
| Kết quả bài viết | `.result` > `.result-text` + trạng thái | Padding `14px 16px`, lề âm 16px hai bên, bo 16; rê chuột nền `--field`. Trạng thái là `Status` hoặc nút chính |
| Bình luận | `.comment` | Lưới `34px 1fr`: avatar + nội dung + `.comment-meta` |
| Bảng lưới | `.gtable` > `.gtr` (`.head`) | Cột đặt bằng class riêng: `.lib-row` (Kho), `.log-row` (Nhật ký). Bọc trong `.gtable-scroll` để cuộn ngang. Mỗi dòng có thể là `a.gtr`. |
| Bảng chọn | `label.table-row` | Lưới `20px 1fr 1fr 80px` (Sao lưu) |
| Bảng HTML | `.table` | Còn giữ cho chỗ cần; hàng tiêu đề 12.5px `--dim`, không kẻ dọc |

`.result`, `.comment`, các ô của `.gallery` và các dòng `.gtr` (trừ `.head`) hiện so le khi vào (xem [Chuyển động](#chuyển-động)).

### Trạng thái và tiến trình

| Thành phần | Class / component | Quy cách |
|---|---|---|
| Chấm trạng thái | `Status tone="ok \| bad \| off \| acc"` → `.status` + `.dot` | Chấm 9px + chữ 13px; `bad` đổi chữ sang `--bad-ink` |
| Ô số liệu | `.figures` > `.figure` | Thẻ viền `--line`, bo 18, padding `16px 20px`, rộng tối thiểu 140px, cách nhau 12px |
| Thanh tiến độ | `.bar` > `span` | Cao 6, bo 3, rãnh `--acc3`, phần chạy màu chuyển `--acc` → `--violet` |
| Khối tiến độ có nhãn | `.progress` | Dòng "Tải ảnh … 38 / 61" + `.bar` |
| Dải trang | `Mesh` → `.pages` > `.page-cell` (`.done`, `.now`) | Mỗi trang một thanh cao 8px bo 2: xong `--acc`, đang quét `--acc2`, chưa `--acc3`. Tới 20 trang: lưới `repeat(n, 1fr)` gap 4px kèm số trang 11.5px. Trên 20 trang (hoặc `size="sm"`): `.dense`, các thanh xuống dòng, không số. |
| Donut | `Donut total done current size` | `conic-gradient(--acc 0 A%, --acc2 A% B%, --acc3 B%)` quanh lõi `--bg`. `lg` 164px vành 26 · `md` 108px vành 17 (chữ 18px/500) · `sm` 96px vành 15 (chữ 17px). Bàn làm việc không dùng donut mà dùng vòng SVG riêng |
| Khung log | `.log` (`time` cho giờ) | Nền `--tip`, 12.5px lh 1.7, cao tối đa 220px, cuộn |

### Ảnh và người

| Thành phần | Class | Quy cách |
|---|---|---|
| Lưới ảnh | `.gallery` + `.size-s` / `.size-m` / `.size-l` | `repeat(auto-fill, minmax(min(var(--tile), 100%), 1fr))`. Nhỏ: `--tile` 150px (hẹp 96px), gap 12px. Vừa (mặc định): 260px (hẹp 150px), gap `18px 14px`. Lớn: một cột, ảnh nguyên khung không cắt, cao tối đa 82vh, nền `--field`. Mỗi ô là `figure.shot` + `figcaption.shot-cap` 12.5px `--dim` ("Trang 3 · bình luận #45"), ẩn ở cỡ Nhỏ |
| Thanh trên tab | `.tab-tools` | Hàng flex: "Hiển thị x–y trong n …" 13px `--dim` bên trái; tùy chọn hiển thị (segmented "Cỡ ảnh") bên phải |
| Ô ảnh | `.tile` (`.on`) | Tỉ lệ 4/3, bo 14, nền sọc khi chưa tải; rê chuột nhấc lên 3px và có bóng. Đang chọn: `box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--acc)` |
| Ảnh lỗi | `.tile-broken` (`.waiting`) | Viền 1px dashed `--axis` (đang chờ: viền liền `--line`), nền `--bg`, chữ 12px `--dim`: "Không tải được" / "Không phải ảnh" / "Đang chờ tải về" |
| Avatar chữ cái | `.avatar` | 34px tròn, nền `--tint`, chữ `--acc-ink` 500 13px |
| Thumbnail | `.thumb` | 38px tròn, sọc `--line` / `--field` (giữ chỗ) |
| Highlight | `mark` | Nền `--tint`, chữ `--acc-ink`, bo 3, padding `0 2px` |
| Mã QR | `.qr` | 132px, bo 8, nền trắng |

### Thông báo

| Thành phần | Class | Quy cách |
|---|---|---|
| Ghi chú | `.notice` | Nền `--field`, bo 14, padding `12px 16px` |
| Tạm dừng / chờ | `.notice-straw` | Nền `--tint`, chữ `--acc-ink` (`PausedNotice`, thứ tự chờ) |
| Lỗi | `.notice-rust` | Nền `--bad` 12% trộn `--bg`, chữ `--bad-ink` (proxy lỗi, bài đã xóa) |
| Trạng thái tốt | `.notice-moss` | Không nền: một dòng có chấm `--ok` |
| Lỗi dưới form | `.error-text` | 13px `--bad-ink` |
| Rỗng | `Empty` → `.empty` | Tiêu đề 16px/400 + mô tả `--dim` |
| Đang tải | `Bone`, `Skeleton`, `SkeletonLines`… → `.skeleton` | Dải nhấp nháy `--field` / `--line2`, theo hình của nội dung sắp hiện |
| Toast | `.toast` (`.error`) | Nền `--tip` (lỗi: `--bad`), bo 6, có bóng; vào ra bằng Motion |
| Banner phiên bản mới | `.banner-straw` | Nền `--tint`, chữ `--acc-ink` |
| Hộp thoại | `Dialog` → `.scrim` + `.dialog` | Nền `--bg`, viền `--line`, bo 8; tiêu đề 18px/500; hiện bằng Motion |
| Trình xem ảnh | `.lightbox` | Nền gần đen, giữ như bản cũ |
| Video | `ul.reels` > `li.reel` | `repeat(auto-fill, minmax(min(380px, 100%), 1fr))`, gap `26px 20px`. Mỗi mục: `.player` (16/9, bo 8, nền đen) chứa `<video controls>` hoặc `<iframe>` nhúng; dưới là `.row-meta` và link "Mở trên <tên miền>" |
| Video không phát được | `.player-off` | Cao tối thiểu 132px, viền 1px dashed `--axis`, chữ 13px `--dim` + link gốc |
| Phân trang | `Pager` → `nav.pager` | Hai hàng căn giữa, kẻ trên `--line`. Hàng 1 `.pager-pages`: "‹ Trước", số trang, "Sau ›"; luôn có trang đầu, trang cuối và trang hai bên trang hiện tại, chỗ bị lược là "…", tổng 7 ô nên nút không nhảy chỗ. Nút `.pg` 34×34 (hẹp 32), viền `--bd`, bo 6; trang hiện tại nền `--tint`, chữ `--acc-ink` 500, `aria-current="page"`. Hàng 2 `.pager-meta`: "Hiển thị x–y trong n …" và ô "Đến trang" (khi trên 7 trang; số vượt quá thì về trang cuối). Hẹp: ẩn chữ "Trước"/"Sau", chỉ còn mũi tên |

`.tag` (`-straw`, `-moss`, `-rust`) còn dùng cho nhãn nhỏ: tên trang, "Không còn trên diễn đàn", hành động trong chi tiết nhật ký.

### Component từ Magic UI và Aceternity

Chép vào `components/magic/`. Đã bỏ phần không dùng và chuyển import sang đường dẫn tương đối.

| Component | Nguồn | Đã đổi | Dùng ở |
|---|---|---|---|
| `NumberTicker value format delay` | Magic UI | Định dạng số qua `format` (dùng `fmtNum`, theo ngôn ngữ); giảm chuyển động thì hiện ngay số cuối | Số ở Bàn làm việc |
| `BorderBeam size duration colorFrom colorTo borderWidth` | Magic UI | Bỏ các prop không dùng; ẩn khi giảm chuyển động | Khung "Đang sàng" khi có lượt chạy |
| `MagicCard` | Magic UI | Chỉ giữ chế độ `gradient` | Hai thẻ danh sách ở Bàn làm việc |
| `Spotlight` | Aceternity (`spotlight-new`) | Mặc định là luồng sáng tím của mảng đêm | Khung đầu Bàn làm việc, trang đăng nhập |

### Icon và logo

`Icon name size` vẽ trên lưới 24px, nét 1.6, màu theo `currentColor`. Tên có sẵn: `desk`, `search`, `archive`, `queue`, `sync`, `log`, `settings`, `backup`, `shield`, `system`. Thanh bên dùng 16px, thanh dưới 18px.

`Mark size` là logo Glean (cùng hình với `web/public/mark.svg`) tô bằng `--acc` và `--on-acc`, nên tự đổi theo sáng/tối. `mark.svg` vẫn là favicon.

## Màn hình

Mọi màn dưới đây (trừ đăng nhập và Bàn làm việc, có mảng đêm riêng) mở đầu bằng dải đêm của [Đầu trang](#đầu-trang).

### 1. Đăng nhập / Thiết lập — `pages/AuthPages.tsx`

Hai cột bằng nhau, cao 100vh.
- **Trái** (`.auth-art`, mảng đêm):
  - `Spotlight` lắc chậm phía sau.
  - Logo + GLEAN chữ `--mist`.
  - Câu "Kho riêng để tìm lại những gì đã trôi qua." hiện từng chữ: mỗi chữ từ mờ (`blur 8px`) và thấp 18px lên, chữ sau chậm hơn chữ trước 0.06s. Thẻ `h1` mang cả câu trong `aria-label`; các chữ con `aria-hidden`.
  - Đoạn mô tả 15px hiện sau câu chào; dưới cùng một dòng nhỏ.
  - Dưới 880px chỉ còn dải đêm phía trên form, gồm logo và câu chào.
- **Phải:** form rộng tối đa 360px, gap 18px, ô cao 42px, nút chính 44px. Form trượt lên sau 0.25s. Bước nhập mã 2 lớp dùng `OtpInput`. `SetupPage` dùng cùng khung.

### 2. Bàn làm việc — `/`, `pages/Home.tsx`

Viết bằng Tailwind và Motion. Có hai tầng: khung đêm ở trên, hai thẻ danh sách ở dưới.

| Khối | Dữ liệu | Giao diện |
|---|---|---|
| **Khung đêm** (bo 28, nền `--night`, `Spotlight`) | Số bài, bình luận, ảnh đã lưu, số bài đã xóa trên diễn đàn còn bản lưu (chỉ khi > 0), lấy từ `/systems/overview` | Khung trượt lên khi vào. "Bàn làm việc" nhỏ ở trên. Số bài viết là số lớn chạy từ 0 (`NumberTicker`); các số khác nhỏ hơn và chạy sau. Khi đồng bộ đem thêm dữ liệu, số chạy lên giá trị mới. |
| **Nạp vào kho** (trong khung đêm) | Trạng thái đồng bộ tự động của từng loại từ `/sync/auto-status` | Mỗi loại một nhãn bo tròn có chấm: đang chạy (`--wheat` nhấp nháy), tốt (xanh), lỗi (đỏ), tắt (trắng mờ); chữ "đồng bộ X trước · mỗi N phút". Link "Xem nhật ký" bên cạnh. |
| **Đang sàng** (thẻ kính trong khung đêm, bo 22) | `useScrapeQueue()` | Tên bài; vòng SVG 160px tự vẽ (đã quét `--violet`, đang quét `--wheat`, rãnh trắng 10%); số ảnh đã tìm thấy chạy lên; chú giải ba chấm; "Đang chờ: …". Có lượt chạy thì `BorderBeam` chạy quanh viền. Không có lượt nào thì là một câu hướng dẫn. Link "Xem hàng đợi". |
| **Vừa lưu vào kho** (`MagicCard`, bo 24) | 3 lượt sàng mới nhất (`/scrapes/processed?size=3`) | Viền đổi màu theo con trỏ (`--violet` → `--wheat`). Mỗi dòng có ô màu chuyển thay ảnh thu nhỏ, bấm mở `/sang/:id`. |
| **Vừa tìm** (`MagicCard`) | 4 từ khóa mới nhất, gộp lịch sử tìm bài viết và tìm bình luận | Cập nhật trực tiếp: từ khóa mới trượt vào, dòng rơi khỏi danh sách mờ đi. |

Hai thẻ trượt lên sau khung đêm (0.25s và 0.35s).

### 3. Tìm kiếm — `/bai-viet/:mode`, `/binh-luan/:mode`, `pages/Search.tsx`

- **URL là nguồn sự thật**: `q`, `exact=1`, `sort=commentCount` (bài viết), `thread=` (bình luận). Ô tìm chung và các bộ lọc chỉ đổi URL; trang tự tìm lại khi URL đổi.
- Đầu trang: `Kết quả cho "…"` + "N kết quả · dữ liệu đồng bộ X trước". Chưa có từ khóa thì là "Tìm bài viết" / "Tìm bình luận" + số trong kho.
- Tab **Bài viết · Bình luận** là link giữa hai route (giữ `q`, `exact`), kèm số; vạch `TabMark` trượt sang tab mới. Số của tab còn lại lấy từ `/posts/search/count` hoặc `/comments/search/count`.
- Bộ lọc bên phải hàng tab: kiểu khớp, chế độ (theo từ khóa / theo người đăng), sắp xếp (bài viết) hoặc "Chỉ trong một bài" (bình luận, mở thêm ô link/ID bài).
- Cột trái:
  - Dòng bài viết: tiêu đề có highlight, meta, bên phải là nút "Sàng bài này" hoặc chấm `--bad` "Đã xóa · còn bản lưu".
  - Dòng bình luận: avatar, nội dung có highlight, meta, "Xem bình luận" / "Sàng bài này".
  - Các dòng hiện so le; dòng bài viết nổi thành thẻ khi rê chuột.
  - Cuối danh sách: "Xem thêm N kết quả".
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

- Cột trái:
  1. Breadcrumb "Kho › Bài #id".
  2. Dải đêm `.job-head`: tiêu đề + "Làm mới" / "Sàng lại" (khi đã xong) / "Mở bài gốc"; meta (trang · trạng thái · số trang · thời điểm).
  3. Các cảnh báo (proxy, bài đã xóa, lỗi, thứ tự chờ); dải trang + tiến trình khi đang sàng.
  4. Tab **Ảnh · Video · Liên kết · Bình luận · Bình luận lưu trữ** có `TabMark`.
  5. Nội dung tab với `Pager`.
- Tab Ảnh: `.tab-tools` với segmented **Cỡ ảnh: Nhỏ · Vừa · Lớn** (mặc định Vừa, nhớ ở `localStorage['imageTileSize']`); 48 ảnh mỗi trang; ô ảnh hiện so le.
- Tab Video: phát ngay trong trang, 12 video mỗi trang.
  - Tệp video dùng bản đã tải về nếu có, không thì phát thẳng từ link gốc.
  - Video nhúng (YouTube…) mở trong `iframe` có `sandbox` và `referrerpolicy="strict-origin-when-cross-origin"` (YouTube cần referrer). Link cùng origin với app không được nhúng.
  - Mỗi lúc chỉ một `<video>` phát. Không phát được thì hiện `.player-off`.
- Đổi trang: chờ trang mới hiện rồi mới cuộn (tức thì) về thanh tab, ngay dưới thanh trên.
- Cột phải (thẻ):
  - **Lượt sàng:** donut 96px "đã quét/tổng trang", số ảnh đã lưu (chấm `--ok`), số ảnh không tải được (chấm `--bad`), tình trạng bài gốc.
  - **Ảnh đang chọn** (tab Ảnh): Vị trí, Nguồn (tên miền), Bản lưu; nút "Phóng to" + "Mở ảnh gốc". Thời điểm tự xóa nếu có.
  - Cuối cùng là "Xóa khỏi kho" (hỏi lại qua `useConfirm`).
- Bấm một ảnh: mở trình xem và đánh dấu ảnh đó là "đang chọn". Chuyển ảnh trong trình xem cũng đổi ảnh đang chọn.

### 7. Đồng bộ — `/dong-bo`, `pages/ManualSync.tsx` (bọc `SudoGate`)

- Cột trái:
  - **Tự động:** hai dòng Bài viết / Bình luận, chỉ đọc (lần gần nhất, chu kỳ, chấm trạng thái), kèm link sang Cài đặt › Đồng bộ tự động để sửa.
  - **Thủ công:** segmented loại dữ liệu; Từ trang / Đến trang (110px), Bản ghi mỗi lần lưu (150px), "Tất cả các trang"; chip chuyên mục; nút chính 40px "Bắt đầu đồng bộ", hoặc nút "Dừng đồng bộ" chữ `--bad-ink` khi đang chạy.
- Cột phải: **Đang chạy / Lần thủ công gần nhất** — phạm vi chạy, hai ô số liệu (bản ghi, thời gian chạy), thanh tiến độ, dòng trạng thái có chấm, khung log.

### 8. Nhật ký — `/nhat-ky/bai-viet`, `/nhat-ky/binh-luan`, `pages/Logs.tsx`

- Một cột. Đầu trang: tiêu đề + "N lần · mỗi dòng là một lần quét một chuyên mục" + nút "Đồng bộ ngay".
- Tab **Bài viết · Bình luận** là link giữa hai route, có `TabMark`.
- Bảng `.log-row` (`minmax(0,1.4fr) 150px 100px 110px 110px`): Chuyên mục (lỗi hiện dưới tên, `--bad-ink`) · Bắt đầu · Thời lượng · Cách chạy · Bài mới / đổi. Các dòng hiện so le; mỗi dòng mở chi tiết. `Pager` ở dưới.
- Chi tiết (`SyncLogDetailPage`): breadcrumb, dải đêm với tên chuyên mục, danh sách bài thay đổi; bài đã xóa trên diễn đàn có chấm `--bad`.

### 9. Cài đặt — `/cai-dat`, `pages/Settings.tsx` (bọc `SudoGate`)

- `.settings`: mục lục dính bên trái + cột form.
  - Mỗi nhóm là một `fieldset` dạng thẻ: viền `--line`, bo 24, padding `24px 26px`, cách nhau 20px.
  - Tiêu đề nhóm là `legend` 16px/400, thả nổi (`float`) để nằm trong thẻ thay vì cắt vào viền. Dưới tiêu đề là mô tả 13px.
- Trường ngắn và số xếp `.form-grid` (`repeat(auto-fill, minmax(160px, 1fr))`, gap 14px 16px); trường bật/tắt là `Switch`; danh sách là `.textarea`.
- Thanh lưu dính đáy: nút chính 40px "Lưu cài đặt" (mờ khi chưa có thay đổi), "Bỏ thay đổi", trạng thái "Đã lưu." / "Có thay đổi chưa lưu."
- Danh sách và thứ tự trường theo `server/config.ts`. Link dạng `/cai-dat#sync` cuộn tới đúng nhóm sau khi cấu hình tải xong.

### 10. Sao lưu — `/sao-luu`, `pages/Backup.tsx` (bọc `SudoGate`)

- Cột trái: **Sao lưu toàn bộ** (ô "Tệp đích" rộng tối đa 420px + nút chính 40px, dòng thư mục lưu ở dưới), kẻ; **Chép từng bảng** (nút phụ "Chép bảng đã chọn" bên phải tiêu đề; mỗi bảng một dòng `.table-row`: checkbox · tên hiển thị · tên bảng · số dòng); khung log khi đã chép.
- Cột phải: **Các tệp sao lưu** (tên, thời điểm, dung lượng).

### 11. Bảo mật & hiển thị — `/ho-so`, `pages/Profile.tsx`

- Cột trái:
  - **Xác thực 2 lớp:** đoạn mô tả. Khi thiết lập: mã QR 132px + `OtpInput` + nút chính "Bật xác thực 2 lớp", khóa nhập tay ở dưới. Khi đang bật: dòng có chấm `--ok` + "Tắt xác thực 2 lớp" (chữ `--bad-ink`, hỏi mã trước khi tắt).
  - Kẻ.
  - **Mật khẩu:** ba ô rộng tối đa 360px + nút phụ "Đổi mật khẩu".
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

### Bản 4b đổi so với 4a

- **Nguyên tắc "Kẻ, không khung" của 4a nhường chỗ cho "Đêm ở đầu, thẻ cho phần phụ":** dải đêm ở đầu mọi màn; cột phụ, mục Cài đặt và ô số liệu thành thẻ.
- **Bàn làm việc:** bỏ ba bong bóng "Trong kho" và hàng ba cột. Các số chuyển lên khung đêm; donut và tooltip của "Đang sàng" thay bằng vòng SVG có số ảnh viết thẳng bên cạnh. CSS của các phần đã bỏ (`.desk-top`, `.cols-3`, `.bubble*`, `.sieve-viz`, `.big-num`, `.tooltip`, `.legend`, `.dot-acc2`, `.dot-acc3`, token `--warm` / `--cool`) cũng đã xóa.
- **Trang đăng nhập:** nửa trái đổi từ nền `--side` sang mảng đêm, và hiện cả trên mobile (dạng dải trên form).
- **Hình khối:** nút và segmented thành viên thuốc; ô nhập, notice, ô ảnh, kết quả tìm bo tròn hơn.
- **Tab:** vạch dưới tab đang chọn là `TabMark` trượt được, thay `box-shadow` tĩnh.
- **Màu và chuyển động:** thêm vàng lúa (`--wheat`) làm nhấn phụ, chỉ trên nền đêm và trong các dải màu chuyển. Thêm chuyển động (xem [Chuyển động](#chuyển-động)).

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

- **Màu:** dùng token, không viết mã màu trực tiếp. Ngoại lệ đã nêu: chữ trong log; trạng thái và kính mờ trên nền đêm.
- **Đầu trang:** `header.page-head` (`.page-title` + `.page-lede`) đặt trực tiếp trong `.page` sẽ tự thành dải đêm. Đầu trang nằm sâu hơn thì thêm class riêng như `.job-head`. Tiêu đề mục dùng `.section-title`.
- **Bố cục:** màn có nội dung phụ thì dùng `.cols` / `.col-main` / `.col-side` (cột phụ tự thành thẻ). Trong một vùng, các dòng tách bằng kẻ; không thêm nền đặc hay bóng.
- **Trạng thái và hành động:** trạng thái dùng `Status`, tiến trình dùng `.bar`, `Mesh`, `Donut`; hành động nguy hiểm dùng `.btn-danger`.
- **Tab:** có `TabMark` với `id` riêng trong mục đang chọn.
- **Chuyển động:** ưu tiên những gì có sẵn (`PageEnter`, `rise-in`, `TabMark`, `Dialog`). Hiệu ứng mới phải đáp lại thao tác hoặc là nhịp vào duy nhất của màn, và phải tắt được khi người dùng bật giảm chuyển động. Đừng để lại `transform` lâu dài trên phần tử bao hộp thoại hay lớp `position: fixed`.
- **Tailwind:** dùng được trong file mới; nhớ thêm file vào `@source` của `app.css` và soát tên class trùng.
- **Chuỗi và số liệu:** mọi chuỗi qua `t(vi, en)`. Khối không có số liệu thật thì bỏ.
- **Kiểm tra:** ở ba mức rộng (≥ 1240, 880–1239, < 880px), trong cả sáng và tối, và với "giảm chuyển động" bật.
