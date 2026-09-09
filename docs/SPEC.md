# Đặc tả: Ứng dụng quản lý SillyTavern đa nền tảng

> Tài liệu này để giao cho một AI/lập trình viên khác lập kế hoạch và **viết lại từ đầu**.
> Nó chứa các ràng buộc, số đo thực nghiệm và những cái bẫy đã trả giá mới biết.
>
> Quy ước: mục nào ghi **[ĐO]** là đã kiểm chứng bằng thực nghiệm trên máy thật /
> dịch vụ thật. Mục ghi **[GIẢ ĐỊNH]** là suy luận, chưa xác minh — phải tự kiểm tra lại.

---

## 1. Mục tiêu

Một ứng dụng duy nhất giúp người dùng **cài, chạy, mở ra Internet, sao lưu và theo dõi**
[SillyTavern](https://github.com/SillyTavern/SillyTavern) mà không cần dùng terminal
sau lệnh cài đặt đầu tiên.

Chạy được trên: **Windows, Linux/VPS, Android (Termux), Docker, ModelScope Studio (free tier)**
— cùng một codebase.

### Tiêu chí thành công

Một người không rành kỹ thuật, có điện thoại iPhone, phải làm được trọn vẹn:

1. Chạy một lệnh (hoặc deploy 1 file Dockerfile)
2. Mở trang quản trị, đặt mật khẩu
3. Chọn phiên bản SillyTavern từ dropdown → bấm Cài
4. Nhận một link công khai, mở SillyTavern trên iPhone, chat được (có streaming)
5. Bấm một nút để sao lưu; khôi phục lại được từ file `.zip` mà SillyTavern tự xuất ra
6. Khi lỗi, đọc được log SillyTavern ngay trong trình duyệt, không cần terminal

---

## 2. Ràng buộc nền tảng

### 2.1 ModelScope Studio (khó nhất — thiết kế phải xoay quanh nó)

| Ràng buộc | Chi tiết | Nguồn |
|---|---|---|
| Cổng | **Chỉ 7860.** Ô port trong UI bị khoá, ghi rõ "Docker mode port is fixed to 7860" | [ĐO] |
| Lưu trữ | **Chỉ `/mnt/workspace` là bền.** Mọi thứ khác mất khi restart/ngủ | [ĐO] |
| Build | `/mnt/workspace` **không** được mount lúc `docker build`. Biến môi trường **không** có lúc build | Tài liệu ModelScope |
| Tài nguyên free | 2 vCPU / 16 GB RAM, chỉ CPU. Ngủ khi rảnh, thức khi có truy cập | [ĐO] |
| Điều kiện | Docker Studio yêu cầu **liên kết tài khoản Alibaba Cloud + xác thực danh tính thật** | Tài liệu ModelScope |
| Quota | Một tài khoản chỉ tạo được số Studio giới hạn (**5** trên tài khoản đã thử). Vượt → lỗi `create too many studios` | [ĐO] |
| Log | Chỉ bắt được **stdout/stderr của process chính**. Log **bắt đầu ghi trễ vài giây** → các dòng đầu tiên bị nuốt | [ĐO] |
| localhost | Người dùng **không có cách nào truy cập `localhost` của container** | [ĐO] |
| SIGTERM khi ngủ | **Chưa xác minh được** có gửi SIGTERM hay không | [GIẢ ĐỊNH] |

**Hệ quả thiết kế bắt buộc:**

- Không được dựa vào "chỉ cho phép localhost" để bảo vệ thiết lập lần đầu → xem §7.1
- Không được in thông tin quan trọng chỉ **một lần** lúc khởi động → sẽ bị nuốt
- Mọi thứ cần bền phải nằm dưới `/mnt/workspace`
- Không được cho rằng shutdown là "êm ả" → sao lưu định kỳ mới là tuyến phòng thủ chính

### 2.2 Các nền tảng khác

| Nền tảng | Thư mục dữ liệu | Ghi chú |
|---|---|---|
| Windows | `%LOCALAPPDATA%\<App>` | |
| Linux / VPS | `$XDG_DATA_HOME` hoặc `~/.local/share/<app>` | |
| Termux (Android) | `$PREFIX/var/<app>` | **Không được có native module** — không có compiler |
| Docker | `/data` (volume) | |
| macOS | `~/Library/Application Support/<App>` | cloudflared chỉ phát hành dạng `.tgz` → không tự tải được, phải `brew install` |

**Nhận diện nền tảng:** `process.platform === 'android'` hoặc `$PREFIX` chứa `com.termux`
→ termux. `linux` + tồn tại `/mnt/workspace` → modelscope. [ĐO]

---

## 3. Phát hiện thực nghiệm bắt buộc phải biết

> Đây là phần quan trọng nhất của tài liệu. Bỏ qua mục nào cũng sẽ dẫn tới lỗi tốn hàng giờ.

### 3.1 Cloudflare Quick Tunnel và streaming [ĐO]

Tài liệu Cloudflare ghi thẳng: *"Quick Tunnels do not support Server-Sent Events (SSE)."*
Nếu tin nguyên văn thì dự án này bất khả thi, vì SillyTavern stream token bằng
`text/event-stream`.

**Thực tế cụ thể hơn.** Đo qua tunnel trycloudflare thật, lặp 3 lần:

| Transport | Kết quả |
|---|---|
| **POST** + `text/event-stream` | **Stream từng phần bình thường** (chunk về ở 1.1s, 1.8s, 2.5s… 6.1s) |
| **GET** + `text/event-stream` | **Bị gom lại** — cả 8 chunk về cùng lúc ở 6.1s, sau khi server đóng |
| WebSocket | Stream bình thường |

Endpoint sinh nội dung của SillyTavern là `router.post('/generate', …)` trong
`src/endpoints/backends/chat-completions.js` và `text-completions.js` → **POST → streaming chạy tốt**.

**Hệ quả bắt buộc:**
- Proxy **không được** buffer. Phải pipe socket trực tiếp, xoá header `accept-encoding`,
  bật `setNoDelay(true)`, `requestTimeout = 0`.
- Giao diện quản trị **tuyệt đối không dùng `EventSource`** cho log/tiến trình trực tiếp —
  đó là GET SSE, người dùng qua tunnel sẽ thấy màn hình đứng im. Dùng **polling** hoặc WebSocket.

**Giới hạn không né được:** 200 request đồng thời (vượt → HTTP 429), không có SLA,
**hostname đổi mỗi lần khởi động lại**.

### 3.2 Định dạng backup của SillyTavern [ĐO]

Phân tích một file export thật từ nút "Download Backup":
`<email>-20260909-042604.zip`, **2.36 GB nén / 3.80 GB giải nén / 11.266 entry**.

**Gốc của zip chính là *nội dung* thư mục user data** — không bọc trong thư mục `data/`.
Các entry cấp cao nhất:

```
KoboldAI Settings/  NovelAI Settings/  OpenAI Settings/  TextGen Settings/
QuickReplies/  User Avatars/  assets/  backgrounds/  backups/  characters/
chats/  context/  extensions/  group chats/  groups/  instruct/  movingUI/
reasoning/  sysprompt/  themes/  thumbnails/  user/  vectors/  worlds/
content.log  secrets.json  settings.json  stats.json
```

Quy ước tên file: `<user-handle>-<YYYYMMDD>-<HHMMSS>.zip`

**⚠️ `secrets.json` chứa API key của người dùng và nằm trong file backup.**
→ Phải **loại trừ mặc định**, và cảnh báo rõ khi người dùng bật lên để đẩy lên cloud.

**Phân bố dung lượng thật** (dữ liệu người dùng thật, không phải mẫu):

| Thư mục | Dung lượng | Số file |
|---|---:|---:|
| `characters/` | 2.164 MB | 1.200 |
| `extensions/` | 507 MB | 4.475 |
| `worlds/` | 468 MB | 798 |
| `chats/` | 457 MB | 3.121 |
| `OpenAI Settings/` | 96 MB | 36 (có 1 file 85 MB) |
| `backups/` | 55 MB | 101 |
| `thumbnails/` | 32 MB | 1.216 |

**Bài học về profile sao lưu:** ý tưởng "mọi thứ trừ extensions" nghe hợp lý nhưng **vô dụng** —
đo thật chỉ tiết kiệm ~20 MB, vì phần nặng của `extensions/` là thư mục `.git` vốn đã bị loại.
Chỉ có hai mức thực sự khác nhau:

| Profile | Dung lượng | Số file |
|---|---:|---:|
| Toàn bộ (đã lọc rác) | 3,23 GB | 4.700 |
| Chỉ chat + cấu hình (bỏ `characters/`) | 1,03 GB | 3.016 |

**Luôn loại trừ** (tái tạo được hoặc trùng lặp): `thumbnails/`, `vectors/`, `backups/`
(bản sao chat nội bộ của chính SillyTavern), `**/.git/**`, `**/node_modules/**`,
`.DS_Store`, `Thumbs.db`. Riêng việc lọc rác này bỏ được **570 MB và 6.566 file**.

### 3.3 Hai layout dữ liệu của SillyTavern [ĐO]

| Layout | Phiên bản | Vị trí |
|---|---|---|
| `data` | >= 1.12 (04/2024) | `<root>/data/<user-handle>/` — mặc định `default-user`, hỗ trợ nhiều user |
| `public` | < 1.12 | `<root>/public/` — `characters/`, `chats/`… nằm thẳng trong đó, một user |

Phải **tự nhận diện và không được sắp xếp lại file của người dùng**.

### 3.4 Bẫy biến môi trường của SillyTavern [ĐO]

Trong `src/middleware/hostWhitelist.js`:

```js
const hostWhitelistEnabled = !!getConfigValue('hostWhitelist.enabled', false);        // KHÔNG ép kiểu
const hostWhitelistScan    = !!getConfigValue('hostWhitelist.scan', false, 'boolean'); // CÓ ép kiểu
```

Và trong `src/util.js`:

```js
export const keyToEnv = (key) => 'SILLYTAVERN_' + String(key).toUpperCase().replace(/\./g, '_');
// getConfigValue: nếu biến env tồn tại → trả về CHUỖI, trừ khi call site truyền typeConverter
```

**Hệ quả:** đặt `SILLYTAVERN_HOSTWHITELIST_ENABLED=false` sẽ **BẬT** whitelist, vì
`!!"false" === true`. Toàn bộ request bị 403 Forbidden.

**Quy tắc:** chỉ được set qua env những key mà call site có truyền `'boolean'`.
Với các key còn lại, phải ghi vào `config.yaml`.

**Cách tránh triệt để:** proxy nên gửi `Host: 127.0.0.1:<port>` lên SillyTavern
(giữ bản gốc ở `X-Forwarded-Host`). SillyTavern luôn tin loopback/IP, nên
hostWhitelist trở thành vô hại dù cấu hình thế nào.

### 3.5 Hình dạng thông tin token của các nhà cung cấp [ĐO]

Để đếm token phải quét response, mỗi nhà cung cấp một kiểu:

| Nhà cung cấp | Trường |
|---|---|
| OpenAI | `prompt_tokens`, `completion_tokens`, `total_tokens` |
| Anthropic | `input_tokens`, `output_tokens` — **nằm rải ở nhiều chunk khác nhau** trong stream |
| Google | `promptTokenCount`, `candidatesTokenCount`, `totalTokenCount` |

Với Anthropic, `input_tokens` ở `message_start` còn `output_tokens` cuối cùng ở
`message_delta` → phải lấy **giá trị cuối cùng thấy được** cho mỗi trường.

Việc quét **không được làm chậm hoặc sao chép stream** — chỉ nghe qua các chunk đang bay.

---

## 4. Kiến trúc yêu cầu

```
        ┌── điện thoại / máy tính ── URL trycloudflare ──┐
        │                                                │
 trình duyệt ─────────────► :7860 ứng dụng ──────────────┤
                              ├── /manager   bảng điều khiển
                              └── /*         SillyTavern (127.0.0.1:8000)
                                                  │
                                        dữ liệu + backup trên đĩa
                                                  │
                                        S3 / Cloudflare R2
```

**Quyết định bắt buộc:**

- **SillyTavern phục vụ ở `/`**, không phải dưới path prefix. Nó là SPA dùng đường dẫn
  tuyệt đối (`/script.js`, `/api/...`), đặt dưới prefix sẽ phải viết lại HTML.
  Đặt ở `/` cũng khiến **một cổng và một URL tunnel phủ cả app lẫn panel** — hình dạng
  duy nhất chạy được trên ModelScope.
- **Bảng điều khiển ở `/manager`.**
- Ứng dụng **tự cài SillyTavern lúc chạy**, không nướng vào image. Lý do: image nhỏ,
  và người dùng đổi phiên bản SillyTavern mà không phải build lại gì cả.

### Ràng buộc kỹ thuật

- **Node.js**, không có native module (Termux không có compiler).
- Cài SillyTavern từ **zipball GitHub**, không dùng `git clone` — git không chắc có trên
  Windows/Termux, còn giải nén zip thì thư viện thuần JS làm được.
- Mọi thao tác zip phải **streaming**. File thật 2,36 GB — không được nạp vào RAM.
- Upload/download qua HTTP phải **streaming ra/vào đĩa**.
- Việc dài (cài đặt, backup, restore) phải trả về ngay và báo tiến trình qua **job cho UI poll**.
  Không giữ request mở hàng phút — tunnel không nuôi nổi.

---

## 5. Đặc tả chức năng

### 5.1 Thiết lập lần đầu

1. Màn hình điều khoản (ngắn, 3 dòng — xem §6)
2. Đặt mật khẩu bảng điều khiển (xem §7.1 về việc chứng minh quyền sở hữu)
3. Wizard cài đặt:
   - Dropdown phiên bản, lấy **trực tiếp từ GitHub API** của SillyTavern:
     các release (mới nhất trước), cộng nhánh `release` và `staging`.
     Mặc định là `latest`.
   - Công tắc bật/tắt link công khai (tunnel)
   - Nút Cài → hiện thanh tiến trình + **log cài đặt trực tiếp**

**Tiêu chí nghiệm thu:** người dùng thấy từng bước (tải xong bao nhiêu MB, giải nén bao nhiêu
file, npm đang chạy) chứ không phải một thanh quay vô nghĩa.

### 5.2 Bảng điều khiển

- Dải đèn báo trạng thái luôn hiển thị: SillyTavern / link công khai / lưu trữ có bền không / lần backup cuối
- **Cảnh báo to và rõ khi thư mục dữ liệu không bền** (container không mount volume)
- Nút Start / Stop / Restart SillyTavern
- Hiển thị đường dẫn thật của dữ liệu và layout đang dùng

### 5.3 Xem log

Đây là tính năng cốt lõi, không phải phụ. Người dùng trên iPhone hoặc trong ModelScope
**không có terminal**, log là kênh duy nhất để hiểu chuyện gì đang xảy ra.

- Tách theo nguồn: `manager` / `sillytavern` / `cloudflared` / `installer` / `backup`
- Lọc theo mức (info/warn/error), tìm kiếm, bật/tắt chế độ trực tiếp
- Nút tải log về
- **Xoá mã màu ANSI** — SillyTavern in ANSI và ký tự đặt tiêu đề terminal, để nguyên sẽ thành rác
- Giữ trong RAM (ring buffer ~3000 dòng) + ghi ra file có xoay vòng
- Trả về theo **id tăng dần** để UI poll "mọi thứ sau id N" thay vì tải lại toàn bộ

### 5.4 Sao lưu và khôi phục

**Định dạng:** phải **giống hệt** định dạng SillyTavern tự xuất (§3.2), để file đi lại
được cả hai chiều.

**Hai profile:** Toàn bộ / Chỉ chat + cấu hình. **Hiển thị dung lượng đo thật trước khi
người dùng chọn** — đây là tính năng có giá trị nhất trong phần này.

**Lịch sao lưu:**
- Mặc định 60 phút, nhưng **so dấu vân tay trước** (số file + tổng dung lượng + mtime mới nhất);
  không đổi thì bỏ qua. Ngày rảnh không tốn băng thông.
- Sao lưu lúc shutdown: **chỉ profile nhỏ, có timeout**. Một archive vài GB không thể xong
  trong khoảng thời gian ân hạn khi tắt máy.

**Khôi phục:**
- **Luôn chụp bản an toàn trước khi ghi đè.** Một lần restore làm mất bản tốt duy nhất
  còn tệ hơn không có restore.
- Kiểm tra file có đúng là dữ liệu SillyTavern không (tìm marker `settings.json`, `characters/`,
  `chats/`, `worlds/`… ở cấp cao nhất) và **hiện cho người dùng xem trước khi làm gì**
- Cho chọn: ghi đè trộn vào, hay xoá sạch rồi khôi phục
- **Chống zip-slip**: từ chối mọi entry thoát ra ngoài thư mục đích

**Lưu trữ ngoài (S3 / Cloudflare R2):**
- R2 free tier: **10 GB**, egress miễn phí. Ở mức 2,4 GB một bản full thì giữ 3 bản đã hết
  7,2 GB → **giao diện phải tự tính con số này** cạnh ô số bản giữ lại
- File > 64 MB phải dùng **multipart upload**, để mất mạng không phải truyền lại từ đầu
- Ký request AWS SigV4 tự viết (tránh phụ thuộc AWS SDK cho Termux)

### 5.5 Sửa `config.yaml`

- Form trực quan cho các mục hay dùng: basic auth, user accounts, port, proxy,
  server plugins, thumbnail…
- **Giữ nguyên comment và thứ tự key của người dùng** → phải dùng API Document của thư viện
  YAML (parse → sửa → stringify), không được parse rồi ghi đè lại
- Có tab sửa YAML thô, kiểm tra cú pháp trước khi ghi
- Ghi nguyên tử + giữ một bản `.bak` để hoàn tác
- **Cảnh báo khi SillyTavern chưa có mật khẩu nào** mà link công khai đang bật

### 5.6 Thống kê sử dụng

- Đếm tại chỗ khi request đi qua proxy
- Biểu đồ: request/ngày, token/ngày, theo model, theo nhà cung cấp
- Số liệu: tổng request, tổng token (vào/ra), độ trễ trung bình, số lỗi
- **Không dùng thư viện biểu đồ từ CDN** — ứng dụng phải chạy được khi không có Internet.
  Vẽ SVG thủ công.

---

## 6. Thu thập dữ liệu (bắt buộc, không cho tắt)

Đây là điều kiện đánh đổi của một phần mềm miễn phí. Màn hình đầu tiên nói rõ trong 3 dòng,
**không viết dài** — người dùng sẽ bỏ qua và nó cũng không quan trọng với họ.

**Được gửi:** install ID ẩn danh (UUID sinh tại máy), nền tảng, và với mỗi lần sinh nội dung:
nhà cung cấp, tên model, **hostname** của endpoint, cờ streaming, số token, mã trạng thái, thời lượng.

**Tuyệt đối không gửi:** API key, prompt, tin nhắn, nội dung model trả về, character card,
persona, lorebook, tên file, **đường dẫn hoặc query string của URL**, địa chỉ IP, tên tài khoản.

**Cách bảo đảm — bằng cấu trúc, không bằng lời hứa:**

- Sự kiện được dựng **từng trường một theo danh sách cho phép cố định**.
  **Không bao giờ** copy nguyên object request. Nhờ vậy một trường mới của SillyTavern
  không thể vô tình rò rỉ.
- URL phải được rút về `hostname[:port]` **trước khi** lưu — chính đường dẫn và query
  là chỗ token hay nấp.
- Phải có test đưa vào một body chứa API key thật, prompt, tên người dùng và URL có token,
  rồi khẳng định không thứ nào xuất hiện ở đầu ra.

**Hợp đồng với server thu thập** (server viết sau, cứ chuẩn bị sẵn API gửi đi):

```
POST {endpoint}/v1/events
Headers: content-type: application/json
         x-stm-install: <install uuid>
         x-stm-version: <phiên bản app>
Body:    { schema, installId, app:{name,version},
           platform:{kind,container,os,arch,node},
           sentAt, events: [ { ts, provider, model, endpointHost, stream,
                               maxTokens, promptTokens, completionTokens,
                               totalTokens, status, durationMs } ] }
Trả về:  2xx = đã nhận. Khác đi thì bỏ lô đó — báo cáo không bao giờ được
         làm chậm hay chặn người dùng.

POST {endpoint}/v1/install   (một lần, lần chạy đầu)
Body:    { schema, installId, app, platform, firstSeenAt }
```

Endpoint cấu hình được qua biến môi trường.

**Về giấy phép:** không giấy phép nào ngăn được người khác gỡ bỏ phần thu thập rồi tự build.
Chỉ có kiểm tra phía server mới làm được. Đừng kỳ vọng nhầm vào AGPL hay bất kỳ license nào.

---

## 7. Bảo mật

### 7.1 Chiếm quyền sở hữu lần đầu — ⚠️ CHỖ ĐÃ TỪNG THỦNG [ĐO]

**Lỗi đã mắc:** dùng "chỉ cho phép request từ loopback" để bảo vệ lúc chưa có mật khẩu.

**Vì sao sai:** cloudflared kết nối tới ứng dụng **qua `127.0.0.1`**. Nên khi có tunnel,
**mọi request trên toàn Internet đều đến từ loopback**. Đã kiểm chứng bằng cách chiếm
quyền panel từ Internet mà không cần mã nào.

**Cách đúng:** một request chỉ được coi là "tại chỗ" khi peer là loopback **VÀ** không mang
bất kỳ header chuyển tiếp nào: `x-forwarded-for`, `x-real-ip`, `forwarded`,
`cf-connecting-ip`, `cf-ray`, `cf-ipcountry`, `x-forwarded-host`, `x-forwarded-proto`.

**Và vì ModelScope không có localhost cho người dùng**, phải có đường thứ hai:
in một **mã thiết lập ngẫu nhiên ra log mỗi lần khởi động** khi chưa có mật khẩu.
Ai đọc được log thì người đó là chủ. Mã mới mỗi lần khởi động; có mật khẩu rồi thì mã hết tác dụng.

Phải có test hồi quy cho cả hai điều này.

### 7.2 Các quy tắc khác

- Mật khẩu panel: băm bằng `scrypt` + salt, so sánh bằng `timingSafeEqual`, làm chậm khi sai
- Session token trong RAM, mất khi khởi động lại — chấp nhận được
- Panel tách biệt hoàn toàn với đăng nhập của SillyTavern
- API key S3/R2 phải được **che khi trả về trình duyệt**; khi lưu lại mà nhận `********`
  thì giữ nguyên giá trị cũ
- Khôi phục mật khẩu trên máy không có shell: một biến môi trường xoá mật khẩu **một lần**
  (ghi nhớ token đã dùng, để nguyên biến đó cũng không xoá lại ở lần khởi động sau)

---

## 8. Các lỗi đã mắc — đừng lặp lại

### 8.1 Coi npm install đang chạy dở là đã cài xong ⚠️ [ĐO]

**Triệu chứng:** SillyTavern crash liên tục với `ERR_MODULE_NOT_FOUND` ở `yargs`, `yaml`.

**Nguyên nhân:** kiểm tra "đã cài chưa" bằng
`fs.existsSync('server.js') && fs.existsSync('node_modules')`.
Nhưng **npm tạo thư mục `node_modules` trong vài giây rồi mất nhiều phút mới đổ file vào**.
Giữa chừng, ứng dụng tưởng xong, khởi động SillyTavern trên dependency dở dang.

**Tệ hơn:** supervisor thấy chết thì restart → vòng lặp crash **giành CPU và đĩa với chính
tiến trình npm mà nó đang chờ**, trên máy 2 vCPU.

**Cách đúng:**
- Chỉ coi là xong khi **ghi được file marker**, sau khi npm thoát với mã 0
- Xoá marker ở **đầu** mỗi lần cài
- Có `node_modules` nhưng thiếu marker → báo "lần cài trước chưa xong", **không khởi động**
- Chặn nút Start khi job cài đặt còn chạy

### 8.2 npm trên network storage rất chậm [ĐO]

`/mnt/workspace` của ModelScope là network storage. npm ghi hàng chục nghìn file nhỏ.
→ Đặt `npm_config_cache` và `TMPDIR` sang **ổ đĩa local của container**.
(Sau khi tách ra: 667 package trong ~5 phút.)

### 8.3 Log của tiến trình con không tới được ModelScope [ĐO]

ModelScope chỉ bắt stdout của process chính. Nếu chỉ gom log SillyTavern vào bộ đệm nội bộ,
người dùng **không thấy gì trong log Studio**. Phải quyết định rõ: cái gì mirror ra stdout,
cái gì chỉ nằm trong panel — và đừng để thông tin sống còn (mã thiết lập, lỗi khởi động)
chỉ nằm ở một nơi.

### 8.4 Log Studio bắt đầu ghi trễ [ĐO]

Các dòng đầu tiên sau khi container khởi động bị nuốt. **Đừng in thông tin quan trọng
đúng một lần.** In lại định kỳ, hoặc in lại sau ~30 giây.

### 8.5 Trình soạn thảo web của ModelScope (Monaco) [ĐO]

Nếu phải tạo file qua giao diện web ModelScope:
- Gõ **một lần vào editor rỗng** thì chính xác
- Gõ đè / sửa nội dung có sẵn thì **hỏng** (Ctrl+A không ăn, nội dung xen kẽ lẫn nhau)
- Phím Enter riêng lẻ không tạo dòng mới; ký tự `\n` **bên trong** chuỗi gõ thì được
- → Muốn sửa: **xoá file rồi tạo lại**, đừng sửa tại chỗ
- Viết Dockerfile mỗi lệnh `RUN` trên **một dòng dài**, tránh dấu `\` nối dòng

### 8.6 Nhớ đặt cache-busting cho asset của panel

Không có nó, người dùng nâng cấp ứng dụng vẫn chạy JS cũ trong cache và gặp lỗi khó hiểu.
Đóng dấu phiên bản vào URL script.

### 8.7 Xử lý lỗi ở tầng giao diện

Một handler gắn vào phần tử chưa tồn tại (dữ liệu chưa tải xong) ném exception và
**làm kẹt luôn cả điều hướng**. Mọi hàm gắn sự kiện phải thoát sớm khi thiếu dữ liệu,
và lời gọi phải nằm trong `try/catch`.

---

## 9. Kiểm thử bắt buộc

| Nhóm | Nội dung |
|---|---|
| Quyền riêng tư | Đưa vào body chứa API key/prompt/tên/URL có token → khẳng định đầu ra sạch |
| | Trường lạ chưa từng biết không được đi qua |
| | URL bị rút về hostname |
| Token | Đọc đúng cả 3 hình dạng OpenAI / Anthropic (rải nhiều chunk) / Google |
| Backup | `secrets.json` bị loại mặc định |
| | Rác (`thumbnails/`, `vectors/`, `backups/`, `.git`, `node_modules`) luôn bị loại |
| | Nhận diện đúng file export của SillyTavern, từ chối zip lạ |
| Zip | Round-trip unicode và đường dẫn lồng nhau |
| | Chặn zip-slip (`../`, đường dẫn tuyệt đối, `C:/`) |
| | Liệt kê file 2,3 GB **không làm phình heap** |
| Ký request | SigV4 khớp test vector chính thức của AWS |
| | Key có dấu cách được escape mà không hỏng dấu `/` |
| Sở hữu | Request loopback thật = tại chỗ |
| | **Request qua tunnel KHÔNG phải tại chỗ** dù đến từ 127.0.0.1 |
| | Panel chưa cấu hình chỉ chiếm được tại chỗ hoặc bằng mã đúng |
| Cài đặt | **Trạng thái npm chạy dở KHÔNG được tính là đã cài** |
| Cấu hình | Sửa `config.yaml` giữ nguyên comment |

Nên có thêm cờ để chạy test với **một file export SillyTavern thật** khi có sẵn.

---

## 10. Phi mục tiêu / câu hỏi mở

- **Chưa kiểm chứng trên Termux thật.** Code viết theo ràng buộc "không native module"
  nhưng chưa chạy trên thiết bị Android nào. Đây là rủi ro lớn nhất còn lại.
- **Chưa quan sát được một chu kỳ ngủ/thức của ModelScope Studio.** Chưa biết chắc có
  SIGTERM không, và `node_modules` trên `/mnt/workspace` có sống sót nguyên vẹn không.
- **Server thu thập dữ liệu chưa tồn tại.** Chỉ có hợp đồng API ở §6.
- **macOS chưa hỗ trợ tự tải cloudflared.**
- Tunnel quick không có hostname cố định. Muốn cố định phải có tài khoản Cloudflare +
  tên miền (named tunnel) — cân nhắc hỗ trợ như một tuỳ chọn nâng cao.
- Chưa xử lý nhiều user của SillyTavern (`data/<handle>/`) ngoài việc nhận diện.

---

## 11. Ghi chú về vận hành ModelScope

- Studio ngủ khi rảnh. Khi ngủ, **tunnel chết** và mở link tunnel **không đánh thức được** —
  chỉ trang Studio mới đánh thức. Người dùng cần **cả hai link**.
- Thức dậy thì hostname tunnel **đổi mới hoàn toàn** → nên có webhook (Discord/Slack)
  tự báo URL mới mỗi lần khởi động.
- `/mnt/workspace` vẫn **mất khi Studio bị đổi tên, chuyển chủ hoặc xoá** → backup ngoài
  mới là phương án cứu hộ thật.
- Dùng nền tảng host demo AI miễn phí làm nơi chạy app qua tunnel **nhiều khả năng vi phạm
  điều khoản**. Kịch bản xấu là hàng loạt Studio giống nhau bị chặn cùng lúc. Đừng xây thứ
  không chấp nhận được mất theo cách đó; bật backup ngoài mặc định để người dùng luôn
  mang được dữ liệu đi.

---

# Phụ lục A — Tài liệu ModelScope Docker Studio

Tổng hợp từ tài liệu chính thức (`modelscope.ai/docs/studios/*`) và từ việc triển khai thật.
Trích dẫn nguyên văn để trong ngoặc kép.

## A.1 Điều kiện sử dụng

> "According to relevant regulatory requirements, Docker Studios are only available to users
> who have completed real-name verification. Before use, please first bind your Alibaba Cloud
> account and complete cloud account real-name verification."

→ Kế hoạch "ai cũng deploy miễn phí trong một click" vướng ngay bước này. Với đối tượng
người dùng của SillyTavern, yêu cầu gắn giấy tờ tuỳ thân vào tài khoản host là một rào cản
đáng kể. **Phải cân nhắc trước khi xây phễu người dùng quanh nền tảng này.**

**Quota:** một tài khoản chỉ tạo được số Studio hữu hạn. Tài khoản đã thử dừng ở **5**;
vượt quá thì API trả về lỗi `create_studio_failed,err:create too many studios`. [ĐO]

## A.2 Cổng mạng

> "When deploying to Docker Studio, we need to expose the service on 0.0.0.0 and specify the
> default service port as 7860. **Port modification is currently not supported.**"

> "Inside the container, you can open any number of ports. For example, you can install
> Elasticsearch in the Studio and call it internally through its default port 9200.
> If you want to expose services running on multiple ports to the external network,
> a workaround is to use a reverse proxy like Nginx to distribute requests from the public
> network (single port) to different internal ports."

Trong giao diện Deployment settings, ô Port bị **disable**, ghi chú `Docker模式端口固定为7860`
("chế độ Docker cố định cổng 7860"). [ĐO]

→ Đây chính là lý do kiến trúc bắt buộc phải gộp cả app lẫn bảng điều khiển sau **một cổng duy nhất**.

## A.3 Lưu trữ bền — mục quan trọng nhất

> "**By default, data written to disk is lost each time a Docker Studio restarts.**
> If persistent storage is needed, you can use the `/mnt/workspace` directory to store data.
> This directory is mounted on a persistent volume, meaning data written to this directory
> will be retained after restarts. **However, data will still be lost when users transfer or
> rename the Studio.** For higher requirements, we recommend using external storage solutions
> in your Studio code, such as Alibaba Cloud OSS storage or managed databases."

> "**Note: The `/mnt/workspace` volume can only be used at runtime and is not available
> during the Dockerfile build phase.**"

**Kiểm chứng thực tế [ĐO]:** sau một lần redeploy hoàn chỉnh, ứng dụng đọc lại được đúng
`install id` cũ và không seed lại cấu hình → volume thật sự sống sót.

**Hệ quả thiết kế:**
- Mọi thứ cần bền (mã SillyTavern, `node_modules`, dữ liệu người dùng, backup, state của app)
  phải nằm dưới `/mnt/workspace`
- Không thể chuẩn bị sẵn nội dung của `/mnt/workspace` trong Dockerfile → phải khởi tạo
  **lúc chạy**, ở lần khởi động đầu tiên
- `/mnt/workspace` **không cứu được** khi Studio bị đổi tên / chuyển chủ / xoá
  → backup ra ngoài (R2/S3) mới là phương án cứu hộ thật

**Cảnh báo hiệu năng [ĐO]:** `/mnt/workspace` là network storage. `npm install` ghi hàng chục
nghìn file nhỏ lên đó rất chậm. Phải trỏ `npm_config_cache` và `TMPDIR` sang ổ đĩa local
của container. Xem §8.2.

## A.4 Biến môi trường

> "Docker Studios are currently in Beta testing, and **variables are not yet supported during
> Docker image building**."

> "Variables will be injected into the environment when the container is running."

> "Studios support creating environment variables to store sensitive fields that you don't want
> to write plainly in Studio project code files, such as API keys or tokens. **Note that after
> adding and saving environment variables, you cannot query the variable values.**"

> "Environment variables must be accompanied by a **Studio restart** to take effect after
> creation or update."

Trong UI: **Settings → Adjust deployment settings → Variables**, dạng cặp key/value; ngoài ra
có mục **Secrets management** riêng. Sau khi lưu, giao diện hiện cảnh báo *"The settings have
been updated and are inconsistent with the deployed content. Redeployment is required for the
changes to take effect."* [ĐO]

## A.5 Tài nguyên

> "For each new user using Studios, ModelScope provides basic CPU machines (**2v CPU/16GB**)
> to run application code deployed to Studios."

> "**If an instance remains unused for a period of time, it will enter sleep mode and will be
> activated upon re-access.**"

Tài nguyên trả phí do Alibaba Cloud PAI-EAS cung cấp, tính tiền theo giờ, không tính khi ngủ.
Lưu ý: *"If set as a public Studio, any user's access will keep the Studio running or trigger
it to go online, resulting in charges."* → với Studio trả phí, để public là tốn tiền.

## A.6 Quy trình tạo và triển khai [ĐO]

1. **Tạo Studio** qua trang web: điền English name, Owner, Visibility (Public/Private/Public
   experience), License, Description. **SDK được chọn ở bước cấu hình triển khai, không phải
   qua YAML trong README** (khác với Hugging Face Spaces).
2. **Đưa file lên** — hai cách:
   - Git: `git clone https://oauth2:<ACCESS_TOKEN>@www.modelscope.ai/studios/<owner>/<name>.git`
     (token lấy ở Personal Center → Access Token)
   - Web UI: **Add files → Upload / Create a new file / Create new directory**
3. **Deployment settings**: chọn Deployment Framework = `docker`, Resources = Free CPU,
   Port (khoá ở 7860), Variables, Secrets, OAuth
4. **Confirm and deploy** — có màn hình xác nhận liệt kê thay đổi file + thay đổi cấu hình,
   và kiểm tra `Deployment entry file: Dockerfile — Inspection passed`

**Trạng thái Studio:** `Not deployed` → `Building` → `Deploying` → `Running`.
Thời gian build thực tế cho image Node + clone từ GitHub: **khoảng 3–6 phút**. [ĐO]

**Nút Redeploy** nằm ở hai chỗ: mục *Deployment settings* và mục *Studio Management*.

## A.7 Xem log [ĐO]

**Settings → View log**, có hai tab: **Build log** và **Run log**.
Có ô tìm kiếm, nút Refresh, tuỳ chọn tự làm mới mỗi 5 giây, và nút Download Logs.

> "Logs are saved for up to 10,000 lines or 7 days."

**Ba điều phải biết:**
- Run log **chỉ bắt stdout/stderr của process chính**. Output của tiến trình con không tự
  động xuất hiện — phải chủ động chuyển tiếp ra stdout.
- **Log bắt đầu ghi trễ vài giây** sau khi container khởi động → các dòng đầu tiên bị mất.
  Đừng in thông tin sống còn đúng một lần.
- Ô tìm kiếm chỉ quét phần log **đang tải trong khung nhìn**, không quét toàn bộ.

## A.8 URL và cách truy cập [ĐO]

- Trang Studio: `https://www.modelscope.ai/studios/<owner>/<name>`
- Ứng dụng thật chạy ở subdomain riêng: `https://<owner>-<name>.ms.fun/`
- Trang Studio nhúng ứng dụng trong **iframe**, kèm tham số
  `?t=<timestamp>&__theme=light&studio_token=<uuid>&backend_url=/`
- Mở thẳng `https://<owner>-<name>.ms.fun/` **bị chuyển hướng về** trang modelscope.ai
  (kèm `?mode=full&app_path=<đường dẫn>`). Muốn xem một đường dẫn cụ thể của ứng dụng,
  dùng tham số `app_path`.
- **Người dùng không có cách nào truy cập `localhost` của container.**

**Chưa xác minh:** SillyTavern có render được bên trong iframe của ModelScope hay không
(có khả năng bị chặn bởi header chống nhúng). Trong quá trình thử, iframe hiện trắng, nhưng
lúc đó còn một lỗi khác chồng lên nên **không kết luận được**. Nếu bản làm lại muốn dùng
đường ModelScope thay vì tunnel thì **phải kiểm tra lại điểm này**. [GIẢ ĐỊNH]

## A.9 Studio card (README.md)

File `README.md` ở gốc repo Studio chứa YAML header, thuần **metadata** — không chọn SDK,
không cấu hình triển khai:

```yaml
---
domain:          # cv / nlp / audio / multi-modal / AutoML
  - nlp
tags:
  - sillytavern
models:          # model liên kết (tuỳ chọn)
datasets:        # dataset liên kết (tuỳ chọn)
license: AGPL-3.0
# deployspec:
#   entry_file: app.py     # chỉ dùng cho SDK Gradio/Streamlit/Static
---
```

## A.10 Dockerfile mẫu của ModelScope

Base image họ khuyến nghị nằm trên registry Alibaba Cloud:

```dockerfile
FROM modelscope-registry.cn-beijing.cr.aliyuncs.com/modelscope-repo/python:3.10
WORKDIR /home/user/app
COPY ./ /home/user/app
RUN pip install -r requirements.txt
ENTRYPOINT ["python", "-u", "app.py"]
```

**Kiểm chứng quan trọng [ĐO]:** builder của ModelScope **truy cập được `github.com`** —
đã build thành công một image `FROM node:22-bookworm-slim` có `git clone` từ GitHub và
tải binary từ GitHub Releases. Đây từng là ẩn số rủi ro cao nhất, nay đã loại bỏ.
(Vẫn nên giữ phương án dự phòng mirror sang Alibaba Cloud ACR nếu về sau bị chặn.)

## A.11 Vận hành: ngủ, thức và tunnel

- Studio ngủ khi không dùng, thức khi có truy cập **vào trang Studio**
- Khi ngủ, container chết → **tunnel chết theo**
- Mở URL tunnel **không đánh thức** được Studio. Chỉ trang Studio mới đánh thức.
  → Người dùng phải giữ **cả hai link**, và hiểu trang Studio là "công tắc nguồn"
- Thức dậy thì cloudflared cấp **hostname hoàn toàn mới**
  → cần webhook (Discord/Slack) tự báo URL mới mỗi lần khởi động
- Có hai kiểu khởi động lại: **Restart** thường và **Deep restart** (dựng lại toàn bộ môi
  trường, dùng khi cần cài lại package)

## A.12 Rủi ro điều khoản dịch vụ

Dùng một nền tảng host demo AI miễn phí làm nơi chạy ứng dụng chung qua tunnel **không phải
mục đích nó sinh ra**, và một loạt Studio giống hệt nhau cùng chạy Cloudflare tunnel rất dễ
bị nhận diện. Kịch bản hỏng thực tế là **mẫu hình này bị chặn và toàn bộ Studio của người
dùng chết cùng lúc**.

Không phải lý do để không làm, nhưng là lý do để:
- Bật backup ra ngoài **mặc định**, để người dùng luôn mang được dữ liệu đi
- Giữ đường di cư sang nền tảng khác (VPS/Termux) luôn mở — đó cũng là lý do ứng dụng phải
  đa nền tảng ngay từ đầu, chứ không phải chỉ chạy trên ModelScope

---

# Phụ lục B — Tham chiếu nhanh

## B.1 Số liệu đã đo

| Hạng mục | Giá trị |
|---|---|
| File backup SillyTavern thật | 2,36 GB nén / 3,80 GB giải nén / 11.266 entry |
| Sau khi lọc rác | 3,23 GB / 4.700 file (tiết kiệm 570 MB, 6.566 file) |
| Profile chỉ chat+cấu hình | 1,03 GB / 3.016 file |
| Liệt kê central directory của file 2,3 GB | ~0,7 giây, không phình heap |
| Tải SillyTavern 1.18.0 (zipball) | 38,4 MB, 988 file |
| `npm install` SillyTavern | 667 package |
| npm trên ổ local (ModelScope) | ~5 phút |
| Build image ModelScope | ~3–6 phút |
| Tài nguyên free ModelScope | 2 vCPU / 16 GB |
| R2 free tier | 10 GB, 1M Class A + 10M Class B ops/tháng, egress miễn phí |
| Quick tunnel | 200 request đồng thời, không SLA, hostname đổi mỗi lần chạy |

## B.2 Đường dẫn quan trọng

```
/mnt/workspace/<app>/                    gốc trên ModelScope
  ├── sillytavern/                       checkout SillyTavern
  │     ├── server.js
  │     ├── node_modules/
  │     ├── config.yaml
  │     └── data/default-user/           dữ liệu người dùng (layout mới)
  │           ├── characters/  chats/  worlds/  extensions/
  │           ├── settings.json
  │           └── secrets.json           ⚠️ chứa API key
  ├── state/                             state của app (install id, mật khẩu băm, usage)
  ├── backups/                           archive .zip
  ├── logs/                              log xoay vòng
  ├── bin/                               cloudflared tải về
  └── tmp/                               scratch
```

## B.3 Endpoint sinh nội dung của SillyTavern (để đo lường)

```
POST /api/backends/chat-completions/generate
POST /api/backends/text-completions/generate
POST /api/backends/kobold/generate
```

Trường trong request body cần đọc (chỉ những trường này):

| Mục đích | Tên trường |
|---|---|
| Nhà cung cấp | `chat_completion_source`, `api_type`, `api_server_type` |
| Model | `model`, `chat_completion_model` |
| URL (chỉ lấy hostname) | `custom_url`, `api_server`, `reverse_proxy`, `server_urls` |
| Khác | `stream`, `max_tokens` |

## B.4 Nguồn tham khảo

- Tài liệu Docker Studio: `https://www.modelscope.ai/docs/studios/docker`
- Tạo Studio: `https://www.modelscope.ai/docs/studios/create`
- Tài nguyên: `https://www.modelscope.ai/docs/studios/resource-selections`
- Studio card: `https://www.modelscope.ai/docs/studios/studio-card`
- Giới hạn quick tunnel: `https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/`
- Vấn đề SSE qua quick tunnel: `github.com/cloudflare/cloudflared` issue #1449
- Cấu hình SillyTavern: `https://docs.sillytavern.app/administration/config-yaml/`
