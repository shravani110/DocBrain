import { useState } from "react";
import { api } from "../api";
import type { Settings } from "../types";

export default function Onboarding({
  settings,
  onDone,
}: {
  settings: Settings;
  onDone: () => void;
}) {
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const addFolder = async () => {
    if (!folder.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.addFolder(folder.trim());
      setAdded(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    await api.updateSettings({ onboarded: true });
    onDone();
  };

  return (
    <div className="h-full flex items-center justify-center bg-app p-6">
      <div className="max-w-lg w-full glass-card p-8 space-y-6 animate-scale-in relative overflow-hidden">
        {/* Decorative gradient orb */}
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-gradient-brand rounded-full opacity-20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full opacity-10 blur-3xl pointer-events-none" />

        <div className="relative">
          <div className="w-14 h-14 rounded-2xl bg-gradient-brand flex items-center justify-center text-white text-2xl shadow-glow mb-4">
            ◈
          </div>
          <h1 className="text-2xl font-bold" style={{ color: 'rgb(var(--color-text))' }}>
            Welcome to <span className="gradient-text">DocBrain</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: 'rgb(var(--color-text-secondary))' }}>
            Your documents are read, OCR&rsquo;d, and indexed <b style={{ color: 'rgb(var(--color-text))' }}>entirely on this computer</b> &mdash; nothing
            leaves your machine unless you later choose a cloud answer model in Settings (and the
            app will always show which mode you&rsquo;re in).
          </p>
        </div>

        <div className="relative">
          <label className="text-sm font-medium" style={{ color: 'rgb(var(--color-text))' }}>
            Pick a folder with your documents
          </label>
          <p className="text-xs mt-0.5 mb-2" style={{ color: 'rgb(var(--color-text-muted))' }}>
            PDFs, scans, Word files, spreadsheets, and more
          </p>
          <div className="flex gap-2">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Click Browse, or type a folder path"
              className="input-field flex-1"
            />
            <button
              onClick={() => api.pickFolder().then((r) => r.path && setFolder(r.path))}
              className="btn-secondary whitespace-nowrap"
            >
              Browse…
            </button>
            <button
              onClick={addFolder}
              disabled={busy || !folder.trim()}
              className="btn-primary whitespace-nowrap"
            >
              Add
            </button>
          </div>
          {error && (
            <p className="mt-2 text-sm text-rose-500 dark:text-rose-400 animate-fade-in">{error}</p>
          )}
          {added && (
            <div className="mt-3 flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 animate-slide-up">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Watching this folder &mdash; documents are being found and processed in the background.
            </div>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2 relative">
          <button onClick={finish} className="btn-ghost">
            Skip for now
          </button>
          <button
            onClick={finish}
            disabled={!added}
            className="btn-primary"
          >
            Get started →
          </button>
        </div>
      </div>
    </div>
  );
}
