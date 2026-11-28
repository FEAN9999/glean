# Nhiều trang trong một Glean — thiết kế

## Ý định

Hiện Glean chỉ đọc một diễn đàn (xamvn). Anh muốn thêm rphang.land, và sau này có thể thêm trang khác, nhưng vẫn dùng **một Glean**: một tài khoản, một giao diện. Mỗi trang có **kho dữ liệu riêng**, nên dữ liệu không bao giờ lẫn vào nhau. Giao diện phải cho biết rõ ràng mỗi thứ thuộc trang nào.

Anh thường muốn xem cả hai trang cùng lúc cho hai việc: **tìm một từ khóa trên cả hai** và **xem lại các bài đã sàng chung một chỗ**. Khi sàng, anh tự chọn trang nào, hoặc sàng cả hai cùng lúc.

## Mục tiêu

- Thêm, đổi tên và gỡ trang ngay trong Glean. Mỗi trang có kho (tệp SQLite) và thư mục ảnh riêng.
- Đồng bộ và sàng chạy riêng cho từng trang. **Lượt sàng của các trang chạy song song**: trang này không phải chờ hàng đợi của trang kia.
- Ô chọn trang ở thanh bên. Mọi màn hình chỉ hiện dữ liệu của trang đang chọn.
- Ô chọn trang có thêm mục **"Cả hai trang"** (khi có từ 3 trang trở lên thì gọi là "Tất cả trang"). Ở chế độ này, **Tìm kiếm** (bài viết và bình luận) và **Lưu trữ đã sàng** gộp kết quả của mọi trang, và **dòng nào cũng ghi tên trang**.
- Dán link vào ô sàng: Glean tự nhận ra trang theo tên miền. Dán chỉ số ID thì dùng trang đang chọn; nếu đang ở "Cả hai trang" thì hỏi anh chọn trang nào.
- Bộ đọc XenForo đọc được rphang.land (xem mục 0).

## Không làm (đợt này)

- Xem gộp cho Bàn làm việc, Nhật ký đồng bộ, Hàng đợi, Đồng bộ thủ công, Cài đặt nguồn: các màn này luôn là của một trang.
- Gộp hay khử trùng bài giữa các trang.
- Tài khoản hay quyền riêng cho từng trang.
- Chuyển kho xamvn hiện có sang thư mục mới.
- Diễn đàn không phải XenForo.
- Cài đặt tên đường dẫn (`/t/`, `/box/`…) riêng cho từng trang. Đợt này chỉ thêm các tên đã biết vào bộ đọc.

## Tuyệt đối tránh

Những điều sau là thất bại, dù tính năng có chạy được:

- Dữ liệu của trang A xuất hiện trong kho hay trên màn hình của trang B. Mọi lệnh ghi đều phải vào đúng kho.
- Một chỗ nào đó **lặng lẽ dùng trang mặc định** khi không biết đang làm cho trang nào. Thiếu thông tin trang thì phải báo lỗi.
- Sửa, viết lại hay di chuyển dữ liệu xamvn đang có. Lần chạy đầu của bản mới chỉ được **thêm** dữ liệu, không đụng các dòng cũ.
- Làm hỏng link ảnh đã lưu, hoặc làm cách khôi phục sao lưu hiện tại (README) không dùng được nữa.
- Danh sách gộp có dòng mà nhìn vào không biết thuộc trang nào.

## Ràng buộc

- Node ≥ 22.13 với `node:sqlite`. Server Fastify, giao diện React (`web/`). Theo hệ thiết kế `DESIGN.md`: chỉ có một màu nhấn (tím), nên **phân biệt trang bằng tên**, không gán màu cho từng trang. Mọi chuỗi chữ đều song ngữ `t('…', '…')`.
- Test không bao giờ chạm `data/` hay diễn đàn thật: mọi `server/**/*.test.ts` phải nạp `server/test/setup.ts` đầu tiên. Bộ đọc được test bằng HTML mẫu, không gọi mạng.
- Bản Glean đang chạy (cổng 4318) dùng `data/glean.db`. Chỉ khởi động lại bản đó khi anh yêu cầu rõ. Kiểm tra giao diện trên bản nháp (thư mục và cổng riêng, mở bằng `localhost`).

## Cách làm

Đã xét:
- **Một kho chung có cột đánh dấu trang:** loại, vì anh muốn mỗi trang một kho riêng. Cách này còn phải viết lại khóa của các bảng bài và bình luận trên dữ liệu thật.
- **Mỗi trang một Glean con chạy ngầm, một Glean chính đứng trước chuyển tiếp:** code của từng trang gần như không đổi và các trang cách ly tốt. Nhưng phải điều phối nhiều thứ: bật/tắt các bản con, đăng nhập giữa bản chính và bản con, gộp thông báo trực tiếp, sao lưu nhiều nơi. Xem gộp phải gọi API của từng bản con rồi ghép.
- **Một kho chính và gắn (ATTACH) kho các trang vào cùng một kết nối:** phải sửa mọi câu SQL để ghi tiền tố kho. Loại.

**Đã chọn (anh duyệt): một Glean, mỗi trang một tệp kho.** Mỗi yêu cầu, mỗi lượt đồng bộ và mỗi lượt sàng đều biết mình đang làm cho trang nào, và chỉ đọc/ghi kho của trang đó. Xem gộp thì đọc từng kho rồi ghép kết quả trong server.

## Thiết kế

### 0. Sửa bộ đọc XenForo (làm đầu tiên, độc lập)

Đã chạy thử trên rphang.land ngày 2026-11-28. Bài và bình luận đọc đúng, nhưng có hai chỗ hỏng:

- **Đường dẫn:** bài là `/t/<slug>.<id>/`, chuyên mục là `/box/<slug>.<id>/`. Đường dẫn chuẩn `/threads/<id>/`, `/forums/<id>/` vẫn được chuyển hướng (301) sang dạng mới. Các chỗ trong `server/source/xenforo.ts` cần nhận cả hai dạng:
  - `parseThreadRef`
  - regex chuyên mục trong `fetchForumIndex`
  - bộ chọn `.structItem-title a[href*="/threads/"]` trong `parseForumHtml`
  - breadcrumbs `a[href*="/forums/"]` trong `parseThreadHtml`
  - bộ lọc link nội bộ `/(threads|members|posts|goto)/`

  Dựng URL vẫn dùng `/threads/<id>/` và để diễn đàn tự chuyển hướng. Mỗi trang tốn thêm một lượt chuyển hướng; chấp nhận được.
- **Ảnh:** rphang ghi `<img class="bbImage" data-url="" src="…">`. Code đang dùng `attr('data-url') ?? …`, nên lấy chuỗi rỗng và bỏ ảnh. Sửa thành: bỏ qua giá trị rỗng, đọc tiếp `data-src` rồi `src`. Ảnh `/attachments/…` tải về được khi chưa đăng nhập.

Test: HTML mẫu rút gọn theo cấu trúc rphang (link `/t/`, `/box/`, ảnh có `data-url` rỗng). Các test XenForo hiện có vẫn phải qua.

### 1. Trang và nơi lưu

- **Trang chính** là kho hiện tại: `data/glean.db` và thư mục ảnh `storage.basePath` (mặc định `data/media`), giữ nguyên chỗ cũ. Kho này còn chứa phần dùng chung: tài khoản, phiên đăng nhập, cài đặt chung, lịch sử sao lưu và danh sách các trang. Không thể gỡ trang chính.
- **Trang thêm sau** có thư mục `data/sites/<mã>/`, chứa `glean.db` và `media/`. `<mã>` là chuỗi ngắn gồm chữ thường, số và gạch ngang, duy nhất, không đổi sau khi tạo. Mã được gợi ý từ tên miền (`rphang.land` → `rphang`), và dùng trong đường dẫn, tên thư mục, header.
- Mọi kho dùng **cùng một lược đồ và cùng các bước nâng cấp** (`migrate`). Ở kho của trang thêm sau, các bảng dùng chung để trống và không dùng tới.
- Danh sách trang lưu trong kho chính, mỗi trang gồm mã, tên hiển thị và thời điểm tạo. Lần đầu chạy bản mới, Glean tạo mục cho trang chính: mã và tên lấy theo tên miền của `source.baseUrl` hiện tại (diễn đàn mẫu thì là `demo`). Tên đổi được.
- **Gỡ trang:** chỉ xóa khỏi danh sách và dừng đồng bộ/sàng của trang đó. Thư mục trên ổ đĩa giữ nguyên. Thêm lại trang với đúng mã cũ thì dùng lại kho cũ.

### 2. Cài đặt: phần riêng và phần chung

- **Riêng từng trang** (lưu ở bảng `config` trong kho của trang đó):
  - `source`: địa chỉ, tên miền cũ, chuyên mục, số bình luận mỗi trang, user agent, thời gian chờ
  - `sync`
  - `scraper`: tên miền bỏ qua, tải ảnh/video, thời gian giữ, độ dài bình luận tối thiểu, số luồng
  - cờ tạm dừng trong `maintenance` (sàng, tìm bài, tìm bình luận)
  - `search.semanticSearchUrl` và `search.semanticTopK` *(em quyết)*: dịch vụ gợi ý trả về ID bài của diễn đàn mà nó đã lập chỉ mục, nên dùng chung sẽ gợi ý nhầm bài trên trang khác. Trang chính giữ giá trị hiện có. Trang mới để trống, tức là gợi ý theo từ khóa như khi chưa cấu hình dịch vụ.

  Trang chính đã có sẵn các mục này trong `data/glean.db`, nên không cần chuyển gì.
- **Chung** (trong kho chính): `proxy`, `storage` trừ thư mục ảnh, phần còn lại của `search` (cỡ trang, độ dài từ khóa tối thiểu), `auth`, `telegram`, `backup`.
- Trang mới được tạo với cài đặt mặc định, địa chỉ là địa chỉ anh nhập, danh sách chuyên mục để trống. Đồng bộ không có gì để chạy cho tới khi anh bấm "Lấy chuyên mục" và chọn chuyên mục.
- `cfg()` trả về cài đặt chung cộng phần riêng của trang đang làm, nên code hiện có đọc `cfg().source…` vẫn chạy được. Lưu cài đặt thì phần riêng ghi vào kho của trang, phần chung ghi vào kho chính. Khi cài đặt của một trang đổi, chỉ đồng bộ và sàng của trang đó được nạp lại.

### 3. Server biết "đang làm cho trang nào"

- Mỗi trang có một ngữ cảnh: kho (`DatabaseSync`), cài đặt, thư mục ảnh. Các hàm `all`, `get`, `run`, `tx` trong `db.ts` lấy kho từ ngữ cảnh của yêu cầu hoặc công việc đang chạy, qua `AsyncLocalStorage` và `withSite(mã, fn)` (em chọn cách này để không phải truyền tham số trang qua mọi hàm). Code chạm bảng dùng chung (auth, cài đặt chung, sao lưu, danh sách trang) gọi thẳng kho chính bằng hàm riêng.
- **Không có trang mặc định ngầm.** Gọi hàm của kho trang khi không có ngữ cảnh thì ném lỗi. Có test chứng minh điều này.
- **Giao diện gửi trang trong header** `x-glean-site: <mã>` cho mọi API riêng từng trang. Thiếu header hoặc mã không tồn tại thì trả 400, kèm thông báo song ngữ. API dùng chung (đăng nhập, cài đặt chung, sao lưu, danh sách trang) không cần header.
- **Thông báo trực tiếp (SSE):** mỗi sự kiện mang thêm mã trang. Trình duyệt chỉ dùng sự kiện của trang đang chọn, hoặc dùng tất cả ở chế độ gộp.

### 4. Đồng bộ và sàng theo trang

- **Đồng bộ tự động:** mỗi trang có bộ hẹn giờ riêng cho bài viết và bình luận, chạy trong ngữ cảnh của trang. Một trang lỗi không chặn trang khác.
- **Đồng bộ thủ công:** mỗi trang tối đa một lượt tại một thời điểm. Hai trang có thể chạy cùng lúc.
- **Hàng đợi sàng:** mỗi trang một hàng đợi. Trong một trang, mỗi lúc vẫn sàng một bài như hiện nay. Các trang chạy song song. Dọn lượt sàng hết hạn chạy theo từng trang.
- **Tạo lượt sàng** (`create-scrape`):
  - Link: đối chiếu tên miền với địa chỉ và tên miền cũ của **mọi** trang. Khớp trang nào thì tạo lượt sàng trong kho của trang đó, kể cả khi trang đang chọn là trang khác. Kết quả trả về cho biết trang nào để giao diện báo đúng.
  - Không khớp trang nào: báo lỗi và gợi ý thêm trang trong Cài đặt. Lỗi `SOURCE_MISMATCH` hiện nay đổi theo.
  - Chỉ số ID: dùng trang trong header. Ở "Cả hai trang" thì giao diện hỏi trang trước khi gửi.
- **Ảnh tải về:** trang chính vẫn lưu ở `/media/scrapes/<id>/…` như cũ, nên link đã lưu không đổi. Trang thêm sau lưu ở `/media/sites/<mã>/scrapes/<id>/…`, và route `/media/sites/<mã>/*` đọc từ thư mục ảnh của trang đó.
- **Telegram:** tin nhắn thêm tên trang ở đầu, ví dụ `[rphang] Glean: lượt sàng #12 thất bại — …`.

### 5. Xem gộp: Tìm kiếm và Lưu trữ đã sàng

- Gửi `x-glean-site: *` cho các API tìm bài, tìm bình luận, đếm kết quả và `scrapes/processed` nghĩa là "mọi trang". Mỗi dòng trả về có thêm `site: { code, name }`. Các API khác nhận `*` thì trả 400.
- **Tìm kiếm** (phân trang theo số trang, kiểu sắp xếp như hiện có: ngày tạo, số bình luận, lượt xem, lượt thích; bình luận theo ngày): chạy cùng điều kiện trên từng kho, lấy `trang × cỡ trang` dòng đầu của mỗi kho, ghép theo khóa sắp xếp (hòa thì xếp theo mã trang rồi id), rồi cắt lấy trang cần xem. Tổng số là tổng của các kho. Dùng một người, phân trang sâu chậm hơn một chút cũng chấp nhận được.
- **Lưu trữ đã sàng:** gộp theo thời điểm tạo lượt sàng, mới nhất trước. Con trỏ phân trang gồm thời điểm, mã trang và id. Tổng là tổng của các kho.
- **Sàng lại hàng loạt trong Lưu trữ gộp** *(em quyết)*:
  - Chọn từng dòng vẫn dùng được. Lựa chọn nhớ cả mã trang lẫn id, vì id lượt sàng trùng nhau giữa các trang. Bấm "Sàng lại" thì giao diện gửi `retry-many` riêng cho từng trang, mỗi trang chỉ nhận id của nó.
  - "Sàng lại tất cả" cũng chạy cho mọi trang, nhưng hộp xác nhận ghi số bài của **từng trang** (ví dụ "xamvn 120 bài · rphang 3.400 bài") để anh thấy trước khi đồng ý.
  - `retry-many` vẫn là API riêng từng trang; nhận `*` thì trả 400.
- **Tìm bình luận trong một bài** (`?thread=` nhận link hoặc ID) *(em quyết)*:
  - Link: chọn trang theo tên miền, giống ô sàng, kể cả khi trang đang chọn là trang khác. Lúc đó kết quả ghi rõ đang tìm trong trang nào. Link không khớp trang nào thì báo lỗi. Hiện nay tên miền bị bỏ qua và tìm nhầm bài cùng ID ở trang hiện tại; lỗi này hết.
  - Chỉ số ID: dùng trang đang chọn. Ở "Cả hai trang" thì hỏi trang trước.
  - Nút "bình luận của bài này" trên kết quả tìm bài mang mã trang của dòng đó.
- **Lịch sử tìm kiếm** (từ khóa gần đây): dùng chung, lưu ở kho chính, không tách theo trang.
- **Mở chi tiết** (một bài, một lượt sàng, lịch sử sửa bình luận) luôn gọi API của đúng trang đó, lấy từ `site.code` của dòng. Tên trang hiện ở đầu trang chi tiết.

### 6. Giao diện

- **Ô chọn trang** ở đầu thanh bên (và trên thanh trên ở mobile) hiện tên trang đang chọn. Danh sách gồm các trang, đường kẻ, rồi "Cả hai trang". Lựa chọn được nhớ trong `localStorage`. Mặc định là trang chính.
- **Đường dẫn chi tiết mang mã trang** (ví dụ `/sang/12?trang=rphang`), để mở trong tab mới hay đánh dấu trang vẫn vào đúng kho. Trang chi tiết lấy dữ liệu theo mã trong đường dẫn, không theo ô chọn. **Mở chi tiết không làm đổi ô chọn** *(em quyết)*: đang ở "Cả hai trang" mà mở một dòng thì vẫn ở "Cả hai trang", tên trang hiện ở đầu trang chi tiết, bấm Quay lại thì về đúng danh sách gộp.
- **Dòng trong danh sách gộp:** có nhãn tên trang ở đầu dòng, dạng `tag` trung tính có sẵn trong `styles.css`, không dùng màu riêng.
- **Màn không hỗ trợ gộp** (Bàn làm việc, Hàng đợi, Nhật ký, Đồng bộ thủ công, Cài đặt nguồn): khi đang ở "Cả hai trang" thì hiện một dòng "Màn này xem từng trang", kèm nút cho từng trang.
- **Ô tìm chung trên thanh trên:** dán link thì sàng theo tên miền (mục 4). Gõ từ khóa thì tìm trong phạm vi đang chọn, kể cả "Cả hai trang".
- **Cài đặt:**
  - Phần riêng (Nguồn dữ liệu, Đồng bộ, Sàng) có tiêu đề "Cài đặt cho trang: <tên>".
  - Phần chung có nhãn "Chung cho mọi trang".
  - Thêm mục **Trang**: danh sách trang; "Thêm trang" (nhập địa chỉ, Glean gợi ý mã và tên, sửa được, rồi chuyển sang trang mới để lấy chuyên mục); đổi tên; gỡ (hỏi xác nhận, nói rõ kho vẫn nằm trên ổ đĩa ở thư mục nào).
- Khi chỉ có một trang, ô chọn trang vẫn hiện tên trang, nhưng ẩn mục "Cả hai trang".

### 7. Sao lưu

- Mỗi lượt sao lưu chép **mọi kho**:
  - Kho chính vẫn theo tên và chỗ cũ (`glean-auto-YYYYMMDD-HHmmss.db` ở thư mục sao lưu), nên cách khôi phục trong README không đổi.
  - Kho trang thêm sau chép vào `sites/<mã>/glean-auto-….db` trong thư mục sao lưu.
  - Ảnh: thư mục ảnh của trang chính chép vào `media/` như cũ; ảnh của trang khác chép vào `sites/<mã>/media/`.
  - Số bản giữ lại áp dụng cho từng kho.
- Một kho chép lỗi thì ghi lỗi cho kho đó, các kho khác vẫn chép. Báo Telegram ghi tên trang bị lỗi.
- **Kết quả theo dõi riêng từng kho** *(em quyết)*: thời điểm sao lưu thành công gần nhất và lần thử lại sau một giờ đều tính riêng cho từng kho. Chỉ kho bị lỗi được thử lại. Nếu tính chung, một kho cứ lỗi mãi sẽ khiến kho chính được chép lại mỗi giờ, và 7 bản giữ lại sẽ bị đẩy hết trong vòng 7 giờ.
- README thêm cách khôi phục một trang thêm sau.

### 8. Kiểm tra

- **Bộ đọc:** test HTML mẫu (mục 0).
- **Cách ly:**
  - Hai kho nháp: ghi trong ngữ cảnh trang B không xuất hiện ở trang A, và ngược lại.
  - Gọi kho trang khi không có ngữ cảnh thì ném lỗi.
  - API riêng từng trang không có header thì trả 400.
- **Sàng:**
  - Link của trang B được đưa vào kho B dù trang đang chọn là A.
  - Link không khớp trang nào thì báo lỗi.
  - Hai trang có lượt sàng chạy song song.
- **Gộp:** thứ tự và phân trang của tìm kiếm gộp và Lưu trữ gộp (đủ, không trùng, không sót dòng khi qua trang); mỗi dòng có `site`.
- **Nâng cấp:**
  - Kho tạo bằng bản cũ (diễn đàn mẫu), chạy bản mới: mọi dòng cũ giữ nguyên, có thêm mục trang chính, link ảnh cũ vẫn mở được.
  - Thử trên **bản sao** của `data/glean.db` thật chỉ khi anh đồng ý.
- **Sao lưu:** chép đủ mọi kho và ảnh; tên tệp của kho chính không đổi.
- **Giao diện:** xem trên bản nháp với hai trang: trang mẫu và một trang mẫu thứ hai. Diễn đàn mẫu cần chạy được ở hai địa chỉ, ví dụ thêm `/demo-forum-2`, với ID bài trùng nhau để làm lộ chỗ lẫn dữ liệu.

## Để người làm tự quyết

- Tên bảng hoặc khóa cài đặt chứa danh sách trang. Cách gợi ý mã từ tên miền.
- Cách sắp xếp lại `config.ts` để tách phần chung và phần riêng, miễn đúng như mục 2.
- Gợi ý tìm kiếm (ô tìm chung) ở chế độ "Cả hai trang": gộp thế nào cũng được, miễn mỗi gợi ý ghi tên trang.
- Bố cục và chữ chính xác của ô chọn trang, nhãn trang và mục Trang trong Cài đặt, theo `DESIGN.md` và `styles.css`.
- Thứ tự các bước trong kế hoạch, miễn mục 0 làm trước và mỗi bước để lại test xanh.
