import { useRef, useState } from "react";
import { api } from "../api";

export default function UploadOnboarding({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploaded, setUploaded] = useState(0);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.uploadDocuments(files);
      setUploaded((n) => n + res.document_ids.length);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = () => onDone();

  return (
    <div className="h-full flex items-center justify-center bg-app p-6">
      <div className="max-w-lg w-full glass-card p-8 space-y-6 animate-scale-in relative overflow-hidden">
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-gradient-brand rounded-full opacity-20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full opacity-10 blur-3xl pointer-events-none" />

        <div className="relative">
          <div className="w-14 h-14 rounded-2xl bg-gradient-brand flex items-center justify-center text-white text-2xl shadow-glow mb-4">
            ◈
          </div>
          <h1 className="text-2xl font-bold" style={{ color: "rgb(var(--color-text))" }}>
            Welcome to <span className="gradient-text">DocBrain</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "rgb(var(--color-text-secondary))" }}>
            Upload documents to your own private library &mdash; only your account can see or
            search what you upload here.
          </p>
        </div>

        <div className="relative">
          <label className="text-sm font-medium" style={{ color: "rgb(var(--color-text))" }}>
            Upload your documents
          </label>
          <p className="text-xs mt-0.5 mb-2" style={{ color: "rgb(var(--color-text-muted))" }}>
            PDFs, scans, Word files, spreadsheets, and more
          </p>
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
            onClick={() => inputRef.current?.click()}
            className={`rounded-xl border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
              dragOver ? "border-brand-500 bg-brand-50 dark:bg-brand-900/20" : ""
            }`}
            style={dragOver ? undefined : { borderColor: "rgb(var(--color-border))" }}
          >
            <p className="text-sm" style={{ color: "rgb(var(--color-text-secondary))" }}>
              Drag &amp; drop files here, or click to browse
            </p>
            <input
              ref={inputRef}
              type="file"
              multiple
              hidden
              onChange={(e) => upload(e.target.files)}
              accept=".pdf,.docx,.doc,.xlsx,.xls,.pptx,.ppt,.txt,.md,.rtf,.png,.jpg,.jpeg,.tif,.tiff,.bmp,.webp"
            />
          </div>
          {error && (
            <p className="mt-2 text-sm text-rose-500 dark:text-rose-400 animate-fade-in">{error}</p>
          )}
          {busy && (
            <p className="mt-2 text-sm" style={{ color: "rgb(var(--color-text-muted))" }}>
              Uploading…
            </p>
          )}
          {uploaded > 0 && !busy && (
            <div className="mt-3 flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 animate-slide-up">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {uploaded} file{uploaded === 1 ? "" : "s"} uploaded &mdash; processing in the background.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2 relative">
          <button onClick={finish} className="btn-ghost">
            Skip for now
          </button>
          <button onClick={finish} disabled={uploaded === 0} className="btn-primary">
            Get started →
          </button>
        </div>
      </div>
    </div>
  );
}
