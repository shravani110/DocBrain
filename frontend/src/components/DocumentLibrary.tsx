import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { DocumentRow } from "../types";

const HOSTED_MODE = import.meta.env.VITE_APP_MODE === "hosted";

const DOC_TYPES = ["lease", "insurance", "tax", "contract", "other"];

const TYPE_COLORS: Record<string, { bg: string; text: string; border: string; darkBg: string; darkText: string; darkBorder: string }> = {
  lease:     { bg: "bg-violet-50",  text: "text-violet-700",  border: "border-violet-200",  darkBg: "dark:bg-violet-900/30",  darkText: "dark:text-violet-400",  darkBorder: "dark:border-violet-700/50" },
  insurance: { bg: "bg-sky-50",     text: "text-sky-700",     border: "border-sky-200",     darkBg: "dark:bg-sky-900/30",     darkText: "dark:text-sky-400",     darkBorder: "dark:border-sky-700/50" },
  tax:       { bg: "bg-rose-50",    text: "text-rose-700",    border: "border-rose-200",    darkBg: "dark:bg-rose-900/30",    darkText: "dark:text-rose-400",    darkBorder: "dark:border-rose-700/50" },
  contract:  { bg: "bg-amber-50",   text: "text-amber-700",   border: "border-amber-200",   darkBg: "dark:bg-amber-900/30",   darkText: "dark:text-amber-400",   darkBorder: "dark:border-amber-700/50" },
  other:     { bg: "bg-surface-100", text: "text-surface-500", border: "border-surface-200", darkBg: "dark:bg-surface-700/50", darkText: "dark:text-surface-400", darkBorder: "dark:border-surface-600" },
};

function typeClasses(docType: string): string {
  const c = TYPE_COLORS[docType] ?? TYPE_COLORS.other;
  return `${c.bg} ${c.text} ${c.border} ${c.darkBg} ${c.darkText} ${c.darkBorder}`;
}

const STATUS_COLORS: Record<string, string> = {
  ready: "text-emerald-600 dark:text-emerald-400",
  processing: "text-brand-600 dark:text-brand-400",
  queued: "text-surface-400",
  failed: "text-rose-600 dark:text-rose-400",
};

// A plain photo (no document text at all -- a picture of a planet, a person,
// etc.) legitimately has nothing to extract; that's not a processing error,
// so it shouldn't look like one or offer a "retry" that can never succeed.
function isNoTextPhoto(d: DocumentRow): boolean {
  return d.status === "failed" && d.status_detail === "No extractable text found.";
}

export default function DocumentLibrary({
  onOpenDocument,
}: {
  onOpenDocument: (d: DocumentRow) => void;
}) {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [search, setSearch] = useState("");
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const load = () => api.documents().then(setDocs).catch(() => {});
  useEffect(() => {
    load();
    const iv = setInterval(load, 2500);
    return () => clearInterval(iv);
  }, []);

  const SUPPORTED_EXTS = [
    ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".txt", ".md",
    ".rtf", ".csv", ".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp", ".webp",
  ];

  const upload = async (files: FileList | File[] | null) => {
    if (!files) return;
    // A folder selection sweeps in everything, so keep only document types
    // the backend can actually process rather than erroring on the rest.
    const usable = Array.from(files).filter((f) =>
      SUPPORTED_EXTS.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    if (usable.length === 0) {
      setUploadError("No supported documents found in the selection.");
      return;
    }
    setUploadBusy(true);
    setUploadError(null);
    try {
      await api.uploadDocuments(usable);
      load();
    } catch (e) {
      setUploadError((e as Error).message);
    } finally {
      setUploadBusy(false);
    }
  };

  const filtered = docs.filter(
    (d) =>
      d.filename.toLowerCase().includes(search.toLowerCase()) ||
      d.doc_type.includes(search.toLowerCase()),
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-3 mb-5">
          <div>
            <h2 className="section-heading">Documents</h2>
            <p className="text-xs mt-0.5" style={{ color: 'rgb(var(--color-text-muted))' }}>
              {docs.length} document{docs.length === 1 ? "" : "s"} in your library
            </p>
          </div>
          <div className="sm:ml-auto w-full sm:w-72 relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4" style={{ color: 'rgb(var(--color-text-muted))' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name or type…"
              className="input-field pl-10"
            />
          </div>
        </div>

        {HOSTED_MODE && (
          <div className="mb-5">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                upload(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={`rounded-xl border-2 border-dashed p-4 text-center cursor-pointer transition-colors ${
                dragOver ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" : ""
              }`}
              style={dragOver ? undefined : { borderColor: "rgb(var(--color-border))" }}
            >
              <p className="text-sm" style={{ color: "rgb(var(--color-text-secondary))" }}>
                {uploadBusy ? "Uploading…" : "Drag & drop files here, or click to upload"}
              </p>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  folderInputRef.current?.click();
                }}
                className="mt-1 text-xs btn-ghost"
              >
                Or select an entire folder to upload every file in it
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(e) => upload(e.target.files)}
                accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.md,.rtf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp"
              />
              {/* webkitdirectory: uploads every file in a chosen folder in one
                  action -- the closest a hosted app can get to "point at a
                  folder." This is a one-time grab, not continuous watching
                  like the local app's folder-watcher, since a remote server
                  has no ongoing access to your device's filesystem. The
                  attribute is set imperatively in the ref callback: it isn't
                  part of React's typed input attributes, and setting it on
                  the real DOM node is the most reliable cross-browser path. */}
              <input
                ref={(el) => {
                  folderInputRef.current = el;
                  if (el) {
                    el.setAttribute("webkitdirectory", "");
                    el.setAttribute("directory", "");
                  }
                }}
                type="file"
                multiple
                hidden
                onChange={(e) => upload(e.target.files)}
              />
            </div>
            {uploadError && (
              <p className="mt-2 text-sm text-rose-500 dark:text-rose-400 animate-fade-in">{uploadError}</p>
            )}
          </div>
        )}

        {filtered.length === 0 && (
          <div className="text-sm py-16 text-center animate-fade-in" style={{ color: 'rgb(var(--color-text-muted))' }}>
            <svg className="w-12 h-12 mx-auto mb-3 opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
            </svg>
            {docs.length === 0
              ? HOSTED_MODE
                ? "No documents yet. Upload some above to get started."
                : "No documents yet. Add a watched folder in Settings."
              : "No documents match your search."}
          </div>
        )}

        <div className="grid grid-cols-2 xl:grid-cols-3 gap-2 sm:gap-3">
          {filtered.map((d, idx) => (
            <div
              key={d.id}
              className="glass-card p-3 sm:p-4 animate-slide-up group min-w-0"
              style={{ animationDelay: `${Math.min(idx * 30, 300)}ms`, animationFillMode: 'both' }}
            >
              {/* Filename */}
              <button
                onClick={() => onOpenDocument(d)}
                className="block w-full font-medium text-left break-words leading-snug text-sm sm:text-base transition-colors duration-150 hover:text-brand-600 dark:hover:text-brand-400"
                style={{ color: 'rgb(var(--color-text))' }}
                title={d.filename}
              >
                <div className="flex items-start gap-2 min-w-0">
                  <svg className="w-5 h-5 shrink-0 mt-0.5 opacity-50" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" />
                  </svg>
                  <span className="min-w-0 break-words">{d.filename}</span>
                </div>
              </button>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs">
                {/* Manual re-classification */}
                <select
                  value={d.doc_type}
                  onChange={(e) => api.retag(d.id, e.target.value).then(load)}
                  className={`text-xs rounded-full border px-2.5 py-0.5 cursor-pointer transition-colors ${typeClasses(d.doc_type)}`}
                  title={d.doc_type_source === "manual" ? "Tagged by you" : "Auto-classified — click to correct"}
                >
                  {DOC_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <span
                  className={`font-medium ${
                    isNoTextPhoto(d) ? "text-surface-400" : STATUS_COLORS[d.status] ?? "text-surface-400"
                  }`}
                >
                  {isNoTextPhoto(d)
                    ? "no text found"
                    : d.status === "processing" && d.status_detail
                      ? d.status_detail
                      : d.status}
                </span>
                {d.page_count > 0 && (
                  <span style={{ color: 'rgb(var(--color-text-muted))' }}>{d.page_count}p</span>
                )}
                {d.used_ocr === 1 && (
                  <span className="badge badge-info text-[10px] px-1.5 py-0">OCR</span>
                )}
                {d.status === "failed" && !isNoTextPhoto(d) && (
                  <button
                    onClick={() => api.reprocess(d.id).then(load)}
                    className="text-brand-600 dark:text-brand-400 hover:underline font-medium"
                  >
                    retry
                  </button>
                )}
                <button
                  onClick={() => {
                    if (window.confirm(`Remove "${d.filename}" from the index? The file on disk is not touched.`)) {
                      api.deleteDocument(d.id).then(load);
                    }
                  }}
                  className="ml-auto opacity-0 group-hover:opacity-100 hover:text-rose-500 dark:hover:text-rose-400 transition-all duration-150"
                  style={{ color: 'rgb(var(--color-text-muted))' }}
                  title="Remove from index (file on disk is kept)"
                >
                  ✕
                </button>
              </div>
              {d.status === "failed" && d.status_detail && !isNoTextPhoto(d) && (
                <div className="mt-1.5 text-xs text-rose-500 dark:text-rose-400 break-words">{d.status_detail}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
