# Roadmap: Knowledge Base (Wizard Step 6)

## 1. Mục tiêu và Tầm nhìn
Bổ sung một tính năng (optional) "Knowledge Base" (Cơ sở tri thức) tại Bước 6 của luồng khởi tạo thế giới (Wizard - Define Your World). Tính năng này cho phép người dùng tải lên nhiều tệp tài liệu văn bản, hệ thống sẽ tiến hành chia nhỏ (chunking), tạo vector (embedding) thông qua batching, và lưu trữ vào một cơ sở dữ liệu độc lập. Khi vào game, hệ thống RAG sẽ truy xuất đồng thời từ Ký ức (Memory RAG) và Tri thức (Knowledge Base RAG) với 2 ngân sách (budgets) hoàn toàn tách biệt.

## 2. Phân tích Kiến trúc & Tác động
- **Wizard UI**: Thêm Step 6. Cung cấp giao diện File Uploader (hỗ trợ nhiều file), nút "Start Processing", thanh tiến trình (Progress Bar), và nút "Enter World".
- **Database (Dexie)**: Thêm 2 bảng mới `knowledge_docs` (quản lý file) và `knowledge_chunks` (quản lý các đoạn text và vector).
- **Vector Engine (Orama)**: Tạo một instance Orama độc lập (ví dụ: `kbDb`) chuyên lưu trữ và search các chunk của Knowledge Base, không trộn lẫn với `memoryDb`.
- **Token Budgets**: Bổ sung "RAG Knowledge Base Budget" trong Settings. Cập nhật công thức tính toán Remaining Budget cho Narrative.
- **RAG & Worker Pipeline**:
  - Viết luồng xử lý riêng trong Worker để nhận danh sách file, chia chunk (ví dụ: 500-1000 ký tự/chunk), batching (ví dụ: 10 chunks/lần) để gọi Embedding API.
  - Khi tạo Prompt, hệ thống gọi search trên `kbDb` và chèn vào một block mới `<KNOWLEDGE_BASE>` độc lập với `<RELEVANT_MEMORIES>`.

## 3. Các File Chịu Tác Động Chính
- `src/core/db.js`: Khai báo schema mới.
- `src/ui/components/wizard-ui.js` & templates: Thêm Step 6, xử lý UI events.
- `src/workers/memory.worker.js`: Xử lý chunking, batching, embedding và index KB.
- `src/core/rag-engine.js`: Cập nhật cấu hình Orama.
- `src/workers/prompt-assembler-core.js`: Tích hợp KB RAG vào quá trình lắp ráp prompt.
- `src/ui/templates/settings/tab-general.html`: Thêm slider cho KB Budget.
