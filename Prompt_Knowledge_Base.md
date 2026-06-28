# Chuỗi Prompt Thực Thi Coding (Copy-Paste)

Dưới đây là các prompt được thiết kế sẵn. Hãy copy và paste lần lượt từng khối lệnh này cho AI Coding Agent ở phiên làm việc tiếp theo để thực thi code một cách chính xác nhất.

---

## Prompt 1: Phase 1 - Cấu trúc dữ liệu và Ngân sách
```text
Thực hiện Phase 1 của tính năng Knowledge Base:
1. Mở file `src/core/db.js`. Tăng version của Dexie DB và thêm 2 bảng mới: `knowledge_docs: 'id, sessionId, filename, createdAt'` và `knowledge_chunks: 'id, sessionId, docId, chunkIndex'`. Đảm bảo code tương thích ngược nếu cần.
2. Mở `src/core/ai-constants.js` và `src/core/settings-manager.js`, bổ sung hằng số/cấu hình `RAG_KB_BUDGET` mặc định là 1000 tokens.
3. Cập nhật `src/ui/templates/settings/tab-general.html` để thêm một Range Slider cho "Knowledge Base RAG Budget" (nằm dưới RAG Budget hiện tại).
4. Tìm và cập nhật logic tính toán tổng token (ví dụ trong UI hoặc Prompt Assembler) để tính ra ngân sách Narrative một cách chính xác: Narrative = Total - System - User - RAG Memory - RAG KB.
```

## Prompt 2: Phase 2 - Giao diện Bước 6 (Wizard)
```text
Thực hiện Phase 2 của tính năng Knowledge Base:
1. Tạo một file template HTML mới trong `src/ui/templates/components/wizard/step6.html`. Trong này cần chứa UI cho việc Upload nhiều file (drag & drop hoặc click), danh sách file đã chọn, thanh Progress Bar (ẩn mặc định), một nút "Start Processing" và một nút "Enter World". Giao diện phải phù hợp với class Tailwind chung của dự án.
2. Mở `src/ui/components/wizard-ui.js`, cấu hình mảng step để thêm Step 6 vào cuối chuỗi. Cập nhật logic chuyển step (Nút Next ở Step 5 sẽ nhảy sang Step 6).
3. Trong `wizard-ui.js`, thêm logic bắt sự kiện thay đổi của thẻ input file ở Step 6. Dùng FileReader để lấy text của các file, lưu vào một mảng nội bộ. Nút "Enter World" sẽ kết thúc wizard. Bấm "Start Processing" tạm thời chỉ log mảng nội dung file ra console.
```

## Prompt 3: Phase 3 & 4 - Worker Xử lý và Thanh tiến trình
```text
Thực hiện Phase 3 & 4 của tính năng Knowledge Base:
1. Trong `src/workers/memory.worker.js` (hoặc module RAG tương tự đang có), thêm một Orama instance mới tên là `kbDb`. Khởi tạo lại data từ bảng IndexedDB `knowledge_chunks` khi load session.
2. Viết hàm bắt message `PROCESS_KB_FILES` nhận mảng các file text từ UI. 
3. Thuật toán: Chia mỗi file thành các chunk (VD: ~500 ký tự). Gom chunk thành từng lô (batch size 10). Dùng API client hiện tại để lấy vector embedding cho từng lô.
4. Lưu chunk đã có vector vào Dexie (`knowledge_chunks`) và insert vào `kbDb`. Sau mỗi lô, gửi `postMessage` báo cáo tiến độ % về main thread.
5. Cập nhật `wizard-ui.js`: Bấm "Start Processing" sẽ gửi mảng file xuống worker, lắng nghe tiến độ trả về để thay đổi thanh Progress bar trên UI, disable nút "Enter World" khi đang chạy và mở lại hiển thị "Hoàn tất" khi worker xong.
```

## Prompt 4: Phase 5 - Retrieval và Tích hợp Prompt
```text
Thực hiện Phase 5 của tính năng Knowledge Base:
1. Trong worker (hoặc rag-engine), sửa đổi logic thực hiện lệnh Search (RAG Retrieval). Khi có request lấy context, tiến hành query ngữ nghĩa song song trên cả `memoryDb` (dùng ngân sách `RAG_BUDGET`) và `kbDb` (dùng ngân sách `RAG_KB_BUDGET`). 
2. Payload trả về cho hệ thống phải chứa 2 mảng tách biệt: `memoryContexts` và `kbContexts`.
3. Mở `src/workers/prompt-assembler-core.js`, nhận mảng `kbContexts`, ráp nối các dòng text và bọc trong cặp thẻ XML `<KNOWLEDGE_BASE> ... </KNOWLEDGE_BASE>`.
4. Chèn block Knowledge Base này vào System Prompt ở vị trí liền kề phía trên hoặc dưới block `<RELEVANT_MEMORIES>`, giữ đúng số lượng token giới hạn.
```
