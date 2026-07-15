# DocBrain

A privacy-first desktop app: drag in a folder of PDFs and scans — leases, insurance
policies, tax documents, contracts — and ask questions in plain English. Answers come
with clickable citations that jump to the exact highlighted spot in the original
document. **Nothing leaves your machine unless you explicitly configure a cloud
answer model.**

## Architecture

One Python process serves everything at `http://127.0.0.1:8756` — the API and
the built React UI. Open it in any browser; nothing is reachable from the
network.

```
Python engine (FastAPI, 127.0.0.1:8756)
 ├─ serves the React+TS+Tailwind UI (frontend/dist)
 └─ pipeline: folder watcher → extraction → OCR (scans) →
    layout-aware chunking → embeddings → SQLite (+sqlite-vec) →
    hybrid retrieval → re-ranking → LLM w/ forced citations
```

| Layer | Choice | Notes |
|---|---|---|
| Shell | **Browser app served by the engine** | No Electron/Tauri: the FastAPI process serves the built UI, so runtime needs only Python. (An unused `electron/` shell from an earlier iteration remains in the repo and can be deleted.) |
| Extraction | PyMuPDF (native PDFs), python-docx, openpyxl (.xlsx), python-pptx (.pptx), striprtf (.rtf), stdlib (.eml/.odt/.ods/.odp), plus .txt/.md/.csv/.json/.xml/.log/.html | Native text is never OCR'd; scanned PDFs/images go through OCR. Legacy .doc/.xls/.ppt show a "re-save as modern format" notice. |
| OCR | PaddleOCR preferred → Tesseract fallback → clear "not installed" status | Skew/contrast auto-correction runs *before* OCR. Bounding boxes preserved per line. |
| Chunking | Layout-aware (paragraph/heading boundaries), ~200–500 tokens, ~15 % overlap | Every chunk carries page + bboxes + section heading + doc type. |
| Embeddings | `bge-small-en-v1.5` via fastembed (ONNX, CPU) | Falls back to a hashed BoW embedder if models can't load; status endpoint reports which backend is active. |
| Store | SQLite: `documents`, `chunks`, FTS5 index, sqlite-vec (numpy brute-force fallback) | Single file, easy backup. |
| Retrieval | Hybrid vector + BM25 (FTS5), reciprocal rank fusion, top-20 → cross-encoder re-rank → top-6 | Doc-type filters inferred from the query ("my insurance…" → insurance docs), with unfiltered retry if the filter empties results. |
| Answering | BYOK Anthropic/OpenAI (keys in OS keychain) or Ollama (fully local) | Structured JSON output `{answer, citations:[{chunk_id, quoted_span}]}`; every quoted span is validated against the chunk text (fuzzy, OCR-tolerant). Unsupported claims degrade to "no clear answer found". |
| Confidence | Structural, never a fake percentage | "Found in 1 document" / "Found in N documents — check each source" / "No clear answer found". Cross-document conflicts are surfaced by prompt rule, not silently resolved. |

### Citation → highlight rendering

The sidecar rasterizes the requested page (`GET /api/documents/{id}/page/{n}`) and
returns the page's coordinate-space dimensions in `X-Page-Width/Height` headers. The
viewer scales the stored per-line bounding boxes onto the rendered image and
auto-scrolls to the first highlight. Server-side rasterization was chosen over pdf.js
because it gives one code path for PDFs *and* scanned images, and guarantees the
highlight coordinate space always matches extraction (both PyMuPDF).

## Running

DocBrain runs on **Windows, macOS, and Linux** — the app is a local web UI
served by a Python engine, so any platform with Python 3.9+ works.

Everyday use:
- **Windows**: double-click **`Start DocBrain.bat`**
- **macOS / Linux**: run **`./start-docbrain.sh`** (first time: `chmod +x start-docbrain.sh`)

Both start the engine and open the app in your default browser.

Manual / first-time setup (Python 3.9+ required; Node 18+ only for UI development):

```bash
# 1. Engine deps
python -m pip install -r backend/requirements.txt

# 2. OCR engine for scanned documents (pick your platform):
#   Windows:  pip install pytesseract  +  winget install UB-Mannheim.TesseractOCR
#   macOS:    pip install pytesseract  +  brew install tesseract
#   Linux:    pip install pytesseract  +  sudo apt install tesseract-ocr   (or your distro's package)
#   Any OS:   pip install paddleocr paddlepaddle   (heavier, better on dense layouts)

# 3. Local answers (optional): install Ollama from https://ollama.com, then
#   ollama pull qwen2.5:3b

# 4. Start the app (serves UI + API on one port)
python backend/main.py
# then open http://127.0.0.1:8756

# UI development only (hot reload):
npm --prefix frontend install
npm --prefix frontend run dev        # Vite on :5173, proxies /api to :8756
npm --prefix frontend run build      # rebuild frontend/dist for production
```

## Phone & tablet

The UI is fully responsive (phone, tablet, desktop). To use DocBrain from a
phone or tablet, start the engine in LAN mode **on a network you trust**:

```bash
python backend/main.py --lan
```

It prints the address to open on your other device (e.g. `http://192.168.1.5:8756`).
Your documents stay on the computer — the phone is just a remote screen.
Without `--lan`, the server is reachable only from the computer itself
(127.0.0.1), which is the default and the recommended everyday mode.

Per-platform notes:
- **Data location**: `%APPDATA%\LocalDocumentBrain` (Windows),
  `~/Library/Application Support/LocalDocumentBrain` (macOS),
  `$XDG_DATA_HOME` or `~/.local/share/LocalDocumentBrain` (Linux).
- **API keys** go to the native keychain via `keyring` (Credential Manager /
  Keychain / Secret Service). On minimal Linux installs you may need
  `gnome-keyring` or `kwallet` for key storage.
- **Folder picker** uses tkinter; on Linux install `python3-tk` if the Browse
  button does nothing (you can always type/paste the path instead).

First indexing run downloads the embedding model (~90 MB) once; everything after that
is offline. If you switch embedding backends (e.g. fastembed becomes available after
documents were indexed with the fallback), re-process affected documents from the
Library view so query and chunk vectors live in the same space.

## Privacy model

- Extraction, OCR, chunking, embedding, storage, retrieval: **always local**.
- Only the final question + retrieved excerpts go to a cloud LLM, and only if you
  chose one; the header badge always shows the current mode ("🔒 Local only" vs
  "☁ Using … API").
- API keys live in the OS keychain (Windows Credential Manager / macOS Keychain),
  never in files.
- The API binds to 127.0.0.1 only. No telemetry of any kind.

## Deliberate MVP scope cuts (from the spec's open decisions)

- **SQLCipher encryption at rest**: not wired in. `backend/app/db.py` is the single
  connection point; swapping `sqlite3` for `pysqlcipher3` with a keychain-held key is
  the planned path.
- **Cloud OCR fallback** (Azure/Google Document AI): settings flag exists
  (`cloud_ocr_enabled`, default off) but no provider is implemented — local OCR only.
- **Conflict handling**: always surface both values (prompt rule 3); no
  "most-recent-wins" heuristics.
- **Scale target**: hundreds to low thousands of documents (brute-force vector
  fallback is O(n) per query; sqlite-vec picks up beyond that).
