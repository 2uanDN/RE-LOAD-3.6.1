# Scaffolding: Các bước triển khai (Implementation Phases)

Quá trình lập trình được chia thành 5 Phase để đảm bảo tính an toàn, dễ theo dõi và debug. Mỗi Phase là một bước xây dựng kiến trúc có thể hoạt động độc lập trước khi ráp nối.

## Phase 1: Database Setup & Budget Settings
- Cập nhật `src/core/db.js`: Tăng version của Dexie DB và thêm schema cho bảng `knowledge_docs` và `knowledge_chunks`.
- Thêm biến `KB_RAG_BUDGET` (default 2000) vào `src/core/ai-constants.js` và logic quản lý settings.
- Bổ sung UI vào `src/ui/templates/settings/tab-general.html` để có thanh trượt (slider) điều chỉnh "Knowledge Base RAG Budget".
- Hiệu chỉnh logic tính toán Token Allocations: Số token còn lại cho Narrative = Total - System - RAG Memory - RAG KB - User.

## Phase 2: Wizard UI & File Parsing (Step 6)
- Tạo template HTML mới (ví dụ `step6.html`) cho Wizard.
- Cập nhật `src/ui/components/wizard-ui.js` để render Step 6. Bổ sung logic Nút "Next" ở Step 5 để chuyển sang Step 6.
- Xây dựng vùng Upload File bằng HTML/CSS thuần (drag & drop hoặc thẻ input file).
- Sử dụng JS FileReader để đọc nội dung text của file.
- Gắn 2 nút: "Start Processing" (chuẩn bị dữ liệu) và nút "Enter World" (kết thúc Wizard, vào game).

## Phase 3: Worker Batching & Indexing Logic
- Cập nhật Worker `src/workers/memory.worker.js`.
- Khởi tạo instance Orama thứ 2 mang tên `kbDb` (cùng chung schema dạng document chứa vector như memoryDb). Khôi phục data từ IndexedDB cho `kbDb` khi load session.
- Thiết lập endpoint (lắng nghe message `PROCESS_KB_FILES`):
  - Nhận array các tệp text.
  - Phân mảnh (chunking) text.
  - Phân lô (Batching) các chunks.
  - Gọi API tạo Embedding.
  - Lưu vào Dexie và `insert` vào `kbDb`.
  - Liên tục gửi message `KB_PROGRESS` (kèm % hoàn thành) về main thread.

## Phase 4: UI Progress Hooking
- Quay lại `wizard-ui.js`, lắng nghe event message `KB_PROGRESS`.
- Update chiều dài/width của thanh Progress Bar trên Step 6 theo thời gian thực.
- Mở khóa UI (kích hoạt lại nút "Enter World") và hiển thị trạng thái "Hoàn thành" khi nhận event success từ Worker.

## Phase 5: RAG Search & Prompt Integration
- Trong Worker, cập nhật hàm search/RAG engine: Khi có yêu cầu tạo response, thực hiện tìm kiếm ngữ nghĩa song song trên cả `memoryDb` và `kbDb`.
- Lọc kết quả và đếm số lượng token giới hạn cho 2 luồng độc lập (`RAG_BUDGET` và `KB_RAG_BUDGET`). Trả về kết quả cho Main thread.
- Cập nhật `src/workers/prompt-assembler-core.js` để format mảng kết quả của KB thành block XML `<KNOWLEDGE_BASE>` và gắn nó vào cấu trúc System Prompt.
