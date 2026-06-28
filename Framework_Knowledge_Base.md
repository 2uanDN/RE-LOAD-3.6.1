# Framework: Logic & Component Design cho Knowledge Base

## 1. Core Logic Modules
### A. Storage Module (IndexedDB / Dexie)
- `knowledge_docs`: `{ id, sessionId, filename, size, status, createdAt }`
- `knowledge_chunks`: `{ id, sessionId, docId, chunkIndex, text, embedding (VectorCodec), tokenCount }`

### B. Upload & Parsing Module (Main Thread)
- Bắt sự kiện file upload tại giao diện Wizard Step 6 (hỗ trợ `.txt`, `.md`, `.json`...).
- FileReader API đọc nội dung text của từng file.
- Truyền mảng các object `{ filename, rawText }` xuống Worker.

### C. Chunking & Embedding Module (Worker Thread)
- **Chunking**: Thuật toán trượt (Sliding Window) hoặc cắt theo đoạn văn. Ví dụ: max 500 tokens/chunk.
- **Batching**: Để tránh API Rate Limit từ LLM, gom các chunks thành các mảng nhỏ (Batch size: 10-20), gửi đi lấy Embedding.
- **Indexing**: Nhận array vector về, nén (dùng `VectorCodec`), lưu vào Dexie, đồng thời `insert` vào `kbDb` (Orama instance riêng biệt).
- **Progress Reporting**: Dùng `postMessage` báo cáo tiến độ `(processedChunks / totalChunks) * 100` để UI hiển thị.

### D. RAG Retrieval Module
- Khi nhận yêu cầu tạo AI Reply, hệ thống Worker thực hiện 2 truy vấn RAG độc lập:
  1. `memoryDb.search(query)` -> Giới hạn text trả về bởi `RAG Budget`.
  2. `kbDb.search(query)` -> Giới hạn text trả về bởi `RAG Knowledge Base Budget`.
- Trả về payload chứa 2 mảng kết quả riêng biệt cho Prompt Assembler.

### E. Prompt Assembly Module
- Định hình cấu trúc Prompt mới, chèn block tri thức vào trước hoặc sau bộ nhớ ngắn hạn:
  ```
  <SYSTEM_INSTRUCTIONS>...
  
  <KNOWLEDGE_BASE>
  [Nội dung trích xuất từ KB RAG]
  </KNOWLEDGE_BASE>
  
  <RELEVANT_MEMORIES>
  [Nội dung trích xuất từ Memory RAG]
  </RELEVANT_MEMORIES>
  
  <CURRENT_CONTEXT>...
  ```

## 2. UI/UX Flow (Wizard Step 6)
1. **State 1 (Idle)**: Hiển thị vùng Drag & Drop hoặc nút "Select Files". Liệt kê danh sách file đã chọn. Hiển thị nút "Start Processing". Nút "Enter World" luôn mở (optional - user có thể bấm vào game luôn mà không cần tải file).
2. **State 2 (Processing)**: Disable nút upload và nút "Enter World". Hiển thị Progress Bar. Cập nhật phần trăm liên tục từ Worker.
3. **State 3 (Completed)**: Hiển thị thông báo thành công. Mở lại nút "Enter World" để chính thức vào game.
