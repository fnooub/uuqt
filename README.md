# Công Cụ Dịch Thuật `uuqt` trên Termux (Android)

Tài liệu này hướng dẫn chi tiết cách cài đặt, cấu hình sửa lỗi hệ điều hành và khởi chạy công cụ dịch thuật `uuqt` (được chuyển đổi từ môi trường Windows) trên ứng dụng Termux của Android chỉ trong một lần duy nhất.

---

## 🛠️ Hướng dẫn cài đặt nhanh (Trọn gói từ A-Z)

Mở ứng dụng Termux lên, sao chép toàn bộ chuỗi lệnh bên dưới, dán vào màn hình và nhấn **Enter**:

```bash
pkg update && pkg upgrade -y && pkg install git nodejs curl -y && ln -s \((which curl)\)PREFIX/bin/curl.exe && git clone https://github.com && cd uuqt && npm install && npm install cors cheerio request chinese-conv
```

---

## 📋 Chi tiết từng bước thực hiện

Nếu không muốn chạy chuỗi lệnh gộp ở trên, bạn có thể thực hiện thủ công theo từng bước sau để dễ quản lý:

### Bước 1: Cập nhật hệ thống và cài đặt môi trường gốc
```bash
pkg update && pkg upgrade -y
pkg install git nodejs curl -y
```
*(Nếu Termux hiển thị câu hỏi `[Y/n]` trong lúc quét gói, hãy nhấn **Enter** để chọn mặc định).*

### Bước 2: Khắc phục lỗi tương thích hệ điều hành (Sửa lỗi `curl.exe`)
Mã nguồn gốc của công cụ gọi tệp tin hệ thống của Windows (`curl.exe`). Chạy lệnh sau để tạo liên kết giả lập giúp Termux hiểu và chuyển hướng sang lệnh `curl` của Linux/Android:
```bash
ln -s \((which curl)\)PREFIX/bin/curl.exe
```

### Bước 3: Tải mã nguồn từ GitHub về máy
```bash
git clone https://github.com
```

### Bước 4: Di chuyển vào thư mục và cài đặt đầy đủ các thư viện
Di chuyển vào thư mục vừa tải, tiến hành cài đặt các gói dependencies gốc cùng các thư viện bổ sung bị thiếu (`cors`, `cheerio`, `request`, `chinese-conv`):
```bash
cd uuqt
npm install
npm install cors cheerio request chinese-conv
```

---

## 🚀 Cách khởi chạy ứng dụng

Sau khi hoàn tất các bước cài đặt trên, khởi động công cụ bằng lệnh:
```bash
node app.js
```
Khi màn hình hiển thị dòng thông báo:
> `Từ diễn sẵn sàng.`  
> `Server đang chạy tại http://localhost:3000`

Bạn mở trình duyệt web trên điện thoại lên, truy cập vào địa chỉ `http://localhost:3000` để bắt đầu sử dụng công cụ.

---

## 🔄 Hướng dẫn bảo trì & Cập nhật

Khi muốn cập nhật hệ thống sau một thời gian sử dụng, bạn không cần phải xóa đi cài lại từ đầu. Hãy dùng các lệnh sau:

* **Cập nhật các thư viện Node.js lên bản mới nhất:**
  ```bash
  cd ~/uuqt && npm update
  ```
* **Cập nhật mã nguồn mới nhất từ tác giả (Git Pull):**
  ```bash
  cd ~/uuqt && git pull
  ```
* **Xóa sạch hoàn toàn để cài mới lại từ đầu (Nếu ứng dụng bị lỗi nặng):**
  ```bash
  rm -rf ~/uuqt
  ```
  Sau đó, bạn chạy lại **Chuỗi lệnh cài đặt nhanh** ở mục đầu tiên của tài liệu này.
