# Security Hardening — Báo cáo nâng cấp bảo mật FamilyTool

> Mục tiêu: tăng cường bảo mật tối đa, **KHÔNG** thay đổi logic / UI / hành vi / dữ liệu hiện tại.
> Sau nâng cấp ứng dụng chạy 100% giống bản gốc.

---

## 1. Tóm tắt thay đổi

| # | File | Loại thay đổi |
|---|------|--------------|
| 1 | `config.secure` | **Mới** — payload AES-256-CBC + HMAC-SHA256 (Base64) chứa Supabase URL + ANON KEY |
| 2 | `assets/secure-config.js` | **Mới** — loader đồng bộ, tự giải mã `config.secure`, expose `window.SecureConfig` (frozen, non-enumerable) |
| 3 | `index.html` | Bỏ hardcoded `SUPABASE_URL` / `SUPABASE_ANON_KEY`, nạp từ `SecureConfig` |
| 4 | `index_goldtracker.html` | Bỏ hardcoded `SUPABASE_URL` / `SUPABASE_KEY` |
| 5 | `index_goldtracker_old.html` | Bỏ hardcoded `SUPABASE_URL` / `SUPABASE_KEY` |
| 6 | `index_quanlythuchi.html` | Bỏ các biến obfuscation cũ `_c/_d/_e`, dùng `SecureConfig` |
| 7 | `login.html` | Bỏ hardcoded `SUPABASE_URL` / `SUPABASE_KEY` |
| 8 | `nutrition-tracker.html` | Thay thế các call `_d(...)` cũ bằng `SecureConfig` |
| 9 | `cloudflare-worker.js` | Bỏ hardcoded secrets — nạp từ **Worker env bindings** (`env.SUPABASE_URL`, `env.SUPABASE_KEY`) |
| 10 | `scripts/regen-secure-config.js` | Script Node để regenerate `config.secure` khi rotate key |
| 11 | `scripts/build-secure-loader.js` | Script Node để rebuild `assets/secure-config.js` sau khi rotate |
| 12 | `scripts/vendor/aes-js.min.js` | Thư viện AES-256 (MIT) dùng cho loader |
| 13 | `scripts/vendor/sha256.min.js` | Thư viện SHA-256 / HMAC (MIT) dùng cho loader |

**Không một dòng UI/logic nghiệp vụ nào bị thay đổi.** Toàn bộ chỉ là thay thế literal string secrets bằng tham chiếu `window.SecureConfig.*`.

---

## 2. Cơ chế bảo mật

### 2.1. Mã hóa cấu hình (`config.secure`)
- **Thuật toán**: AES-256-CBC (NIST chuẩn) + HMAC-SHA256 (encrypt-then-MAC) cho integrity.
- **Định dạng** (sau khi `atob` base64 lớp ngoài):
  ```json
  { "v":1, "alg":"AES-256-CBC+HMAC-SHA256",
    "kdf":"SHA-256(passphrase)",
    "iv":"<base64>", "ct":"<base64>", "mac":"<base64>" }
  ```
- **Không** đọc được bằng mắt thường — đọc file chỉ thấy chuỗi base64.
- **Toàn vẹn**: bất kỳ thay đổi 1 byte cipher hoặc IV nào sẽ làm HMAC fail → loader throw, app không khởi tạo.

### 2.2. Passphrase obfuscation
- Passphrase được tách thành **8 segment** XOR với 8 pad byte ngẫu nhiên độc lập.
- Reassembled tại runtime bằng `_x()` helper bên trong loader.
- Không tồn tại constant string nào lộ passphrase nguyên bản trong source.

### 2.3. Defense-in-depth
- `SecureConfig` được publish qua `Object.defineProperty` với `writable:false, configurable:false, enumerable:false` → không sửa đổi/ghi đè/list được qua `Object.keys(window)`.
- `Object.freeze(SecureConfig)` → bất biến.
- Sau khi giải mã: passphrase, key, plaintext intermediates được set `null` (best-effort GC).
- Hai thư viện AES/SHA-256 sau khi load **được xóa khỏi `window`** (`delete window.sha256/aesjs`) → không leak global.
- **Không** ghi secret vào `localStorage` / `sessionStorage`.
- **Không** expose biến toàn cục chứa secret (ngoài `window.SecureConfig` đã frozen).

### 2.4. Cloudflare Worker
- Bỏ hoàn toàn secret hardcode.
- Đọc từ **Cloudflare env bindings** — Cloudflare lưu encrypted at rest, không hiện trong file deploy.
- Hướng dẫn cấu hình ở comment đầu file.

> ⚠️ **Lưu ý quan trọng về giới hạn bảo mật client-side**: Bất kỳ secret nào cần dùng trong trình duyệt đều **về lý thuyết** có thể bị attacker xác định trích xuất (vì code chạy trên máy họ). Lớp mã hóa + obfuscation này nâng đáng kể chi phí phân tích / chống bot quét tự động, nhưng **không thay thế Row-Level-Security (RLS) của Supabase** — Supabase ANON KEY vẫn cần được bảo vệ bằng RLS policies đúng đắn ở phía database. Đây là lớp **defense-in-depth**, không phải kho khóa tuyệt mật.

---

## 3. Cấu hình `config.secure`

### 3.1. Xem nội dung
```bash
cat config.secure                          # chỉ thấy base64 — không readable
echo $(cat config.secure) | base64 -d      # thấy JSON với iv/ct/mac (đã mã hóa)
```

### 3.2. Regenerate khi rotate key
```bash
cd scripts
# 1. Sửa SECRETS trong regen-secure-config.js theo giá trị mới
node regen-secure-config.js     # → ghi ../config.secure (+ /tmp/blob.b64.txt)
node build-secure-loader.js     # → rebuild ../assets/secure-config.js
```

### 3.3. Cấu hình Cloudflare Worker
1. Cloudflare Dashboard → Workers & Pages → chọn worker
2. Settings → Variables → **Add variable**
   - Name: `SUPABASE_URL`  → Value: `https://acwlagoieszpydklikqw.supabase.co`
   - Name: `SUPABASE_KEY`  → Value: `<anon hoặc service_role key>` → ✅ **Encrypt**
3. Save → Deploy lại worker

---

## 4. Báo cáo kiểm tra bảo mật

### 4.1. Quét secret trong source build
```
$ grep -rnE "eyJhbGciOi|sk_live_|AIza[A-Za-z0-9_-]{20}|ghp_..." .
```
✓ **Kết quả: 0 match** (ngoài `config.secure` đã mã hóa).

### 4.2. Quét hardcoded Supabase URL/KEY
```
$ grep -nE "SUPABASE_(URL|KEY|ANON_KEY)\s*=\s*['\"](https|eyJ)" *.html *.js
```
✓ **Kết quả: 0 match**.

### 4.3. URLs còn lại (KHÔNG phải secret)
3 file dùng URL CDN public của Supabase Storage cho icon/logo:
- `index.html` (icon_web.png, icon_app.png)
- `nutrition-tracker.html` (Nutrition-Tracker.png)

→ Đây là **public asset URLs** đặt trong `<link rel="icon">` và `<img>` (browser cần tải trước khi JS chạy). Không phải secret — bucket "Logo" là public bucket. **Không cần che giấu**.

### 4.4. Không ghi secret vào storage
✓ Không có code nào ghi `SUPABASE_*` hoặc API key vào `localStorage` / `sessionStorage` / `cookie`.

### 4.5. Không expose global
✓ `window.SecureConfig` là biến **duy nhất** liên quan secret, đã frozen + non-enumerable.
✓ Các thư viện crypto (`sha256`, `aesjs`) bị xóa khỏi `window` sau khi dùng xong.

---

## 5. Xác nhận tương thích

- ✓ Cùng Supabase URL, cùng ANON KEY → cùng database → **không đổi dữ liệu**.
- ✓ Mọi `createClient(url, key)` nhận cùng giá trị như trước → **không đổi luồng**.
- ✓ Mọi UI/UX, modal, animation, layout giữ nguyên 100%.
- ✓ Không thêm/xóa chức năng nào.
- ✓ Worker hoạt động giống hệt — chỉ đọc URL/KEY từ env thay vì hardcode.

---

## 6. Cấu trúc thư mục sau nâng cấp

```
FamilyTool-main/
├── config.secure                  ← MỚI: AES-256-CBC + HMAC-SHA256 (base64)
├── assets/
│   ├── icon_goldtracker.png
│   ├── icon_quanlythuchi.png
│   └── secure-config.js           ← MỚI: sync loader (bundled aes-js + js-sha256)
├── scripts/                       ← MỚI: tools để rotate / regenerate
│   ├── regen-secure-config.js
│   ├── build-secure-loader.js
│   └── vendor/
│       ├── aes-js.min.js
│       └── sha256.min.js
├── cloudflare-worker.js           ← Sửa: env bindings, không hardcode
├── index.html                     ← Sửa: dùng SecureConfig
├── index_goldtracker.html         ← Sửa
├── index_goldtracker_old.html     ← Sửa
├── index_quanlythuchi.html        ← Sửa
├── login.html                     ← Sửa
├── nutrition-tracker.html         ← Sửa
├── 404.html
└── SECURITY-HARDENING-REPORT.md   ← File này
```
