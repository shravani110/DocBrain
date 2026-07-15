import { useState } from "react";
import { api } from "../api";
import type { Settings } from "../types";

/** Plain-language summary of the current answer-model setup, shown when the
 * advanced section is collapsed so the average user never needs to open it. */
function modeSummary(settings: Settings): string {
  switch (settings.llm_provider) {
    case "local":
      return `Private mode — answers generated on this device (${settings.ollama_model}).`;
    case "anthropic":
      return settings.has_anthropic_key
        ? "Cloud mode — using Anthropic to generate answers."
        : "Cloud mode selected, but no Anthropic key is set yet.";
    case "openai":
      return settings.has_openai_key
        ? "Cloud mode — using OpenAI to generate answers."
        : "Cloud mode selected, but no OpenAI key is set yet.";
    default:
      return "Search only — questions return matching passages without a generated answer.";
  }
}

export default function SettingsPanel({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: () => void;
}) {
  const [folder, setFolder] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const flash = (m: string) => {
    setMsg(m);
    setErr(null);
    setTimeout(() => setMsg(null), 3000);
  };

  const addFolder = async () => {
    try {
      await api.addFolder(folder.trim());
      setFolder("");
      flash("Folder added — scanning for documents in the background.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-4 sm:p-6 space-y-8">
        {msg && (
          <div className="bg-emerald-50 dark:bg-emerald-900/30 border border-emerald-200 dark:border-emerald-700/50 text-emerald-700 dark:text-emerald-400 rounded-xl px-4 py-2.5 text-sm animate-slide-up">
            <div className="flex items-center gap-2">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              {msg}
            </div>
          </div>
        )}
        {err && (
          <div className="bg-rose-50 dark:bg-rose-900/30 border border-rose-200 dark:border-rose-700/50 text-rose-700 dark:text-rose-400 rounded-xl px-4 py-2.5 text-sm animate-slide-up">
            {err}
          </div>
        )}

        {/* This is the only thing most people ever need to do here: point the
            app at a folder. Everything else is pre-configured. */}
        <section className="glass-card p-5 sm:p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style={{ background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' }}>
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
              </svg>
            </div>
            <div>
              <h2 className="section-heading">Your documents</h2>
              <p className="text-xs" style={{ color: 'rgb(var(--color-text-muted))' }}>
                Add a folder and DocBrain keeps it up to date automatically.
              </p>
            </div>
          </div>
          <ul className="space-y-2 mb-4">
            {settings.watched_folders.map((f) => (
              <li key={f} className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors" style={{
                background: 'rgb(var(--color-surface-hover))',
                border: '1px solid rgb(var(--color-border))',
              }}>
                <svg className="w-4 h-4 shrink-0" style={{ color: 'rgb(var(--color-text-muted))' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                </svg>
                <span className="flex-1 truncate" style={{ color: 'rgb(var(--color-text))' }}>{f}</span>
                <button
                  onClick={() => api.removeFolder(f).then(onSaved)}
                  className="text-rose-500 dark:text-rose-400 hover:text-rose-700 dark:hover:text-rose-300 text-xs font-medium transition-colors"
                >
                  remove
                </button>
              </li>
            ))}
            {settings.watched_folders.length === 0 && (
              <li className="text-sm py-3 text-center" style={{ color: 'rgb(var(--color-text-muted))' }}>
                No folders added yet.
              </li>
            )}
          </ul>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="Click Browse to pick a folder…"
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
              disabled={!folder.trim()}
              className="btn-primary whitespace-nowrap"
            >
              Add folder
            </button>
          </div>
        </section>

        {/* Answers work out of the box; this is tucked away and closed by
            default so it never gets in the way of the one thing users
            actually need to do above. */}
        <section className="glass-card p-5 sm:p-6">
          <button
            onClick={() => setAdvancedOpen((o) => !o)}
            className="flex items-center gap-3 w-full text-left"
          >
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-lg" style={{
              background: advancedOpen ? 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' : 'rgb(var(--color-surface-hover))',
            }}>
              <svg className={`w-5 h-5 transition-colors ${advancedOpen ? 'text-white' : ''}`} style={advancedOpen ? undefined : { color: 'rgb(var(--color-text-muted))' }} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div className="flex-1">
              <span className="text-sm font-semibold" style={{ color: 'rgb(var(--color-text))' }}>
                Advanced: how answers are generated
              </span>
              <p className="text-xs mt-0.5" style={{ color: 'rgb(var(--color-text-muted))' }}>
                {modeSummary(settings)}
              </p>
            </div>
            <svg
              className={`w-5 h-5 transition-transform duration-200 ${advancedOpen ? "rotate-180" : ""}`}
              style={{ color: 'rgb(var(--color-text-muted))' }}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {advancedOpen && (
            <div className="mt-5 pt-5 border-t animate-slide-up" style={{ borderColor: 'rgb(var(--color-border))' }}>
              <AnswerModelSettings settings={settings} onSaved={onSaved} flash={flash} setErr={setErr} />
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

type Mode = "local" | "cloud" | "off";
type CloudProvider = "anthropic" | "openai";

function modeFor(provider: Settings["llm_provider"]): Mode {
  if (provider === "anthropic" || provider === "openai") return "cloud";
  if (provider === "none") return "off";
  return "local";
}

function AnswerModelSettings({
  settings,
  onSaved,
  flash,
  setErr,
}: {
  settings: Settings;
  onSaved: () => void;
  flash: (m: string) => void;
  setErr: (e: string | null) => void;
}) {
  const [mode, setMode] = useState<Mode>(modeFor(settings.llm_provider));
  const [cloudProvider, setCloudProvider] = useState<CloudProvider>(
    settings.llm_provider === "openai" ? "openai" : "anthropic",
  );
  const [apiKey, setApiKey] = useState("");
  const [showConnectionDetails, setShowConnectionDetails] = useState(false);
  const [ollamaUrl, setOllamaUrl] = useState(settings.ollama_url);
  const [ollamaModel, setOllamaModel] = useState(settings.ollama_model);

  const hasKey = cloudProvider === "anthropic" ? settings.has_anthropic_key : settings.has_openai_key;

  const save = async () => {
    try {
      const provider: Settings["llm_provider"] =
        mode === "off" ? "none" : mode === "local" ? "local" : cloudProvider;
      await api.updateSettings({
        llm_provider: provider,
        ollama_url: ollamaUrl,
        ollama_model: ollamaModel,
        ...(mode === "cloud" && apiKey
          ? cloudProvider === "anthropic"
            ? { anthropic_api_key: apiKey }
            : { openai_api_key: apiKey }
          : {}),
      });
      setApiKey("");
      flash("Saved.");
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <ModeOption
        selected={mode === "local"}
        onSelect={() => setMode("local")}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        }
        title="Keep everything on this device"
        desc="The most private option. Answers are generated locally and never leave your computer."
      >
        {mode === "local" && (
          <div className="mt-3">
            <button
              onClick={() => setShowConnectionDetails((s) => !s)}
              className="text-xs hover:underline transition-colors"
              style={{ color: 'rgb(var(--color-text-muted))' }}
            >
              {showConnectionDetails ? "Hide" : "Change"} local AI connection
            </button>
            {showConnectionDetails && (
              <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2 animate-fade-in">
                <input
                  value={ollamaUrl}
                  onChange={(e) => setOllamaUrl(e.target.value)}
                  placeholder="http://localhost:11434"
                  className="input-field"
                />
                <input
                  value={ollamaModel}
                  onChange={(e) => setOllamaModel(e.target.value)}
                  placeholder="model name"
                  className="input-field"
                />
              </div>
            )}
          </div>
        )}
      </ModeOption>

      <ModeOption
        selected={mode === "cloud"}
        onSelect={() => setMode("cloud")}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
          </svg>
        }
        title="Use a cloud AI for faster, sharper answers"
        desc="Your question and the relevant excerpts are sent to the provider you choose below. Everything else stays local."
      >
        {mode === "cloud" && (
          <div className="mt-3 space-y-3 animate-fade-in">
            <div className="flex gap-2">
              {(["anthropic", "openai"] as CloudProvider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setCloudProvider(p)}
                  className={`px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all duration-200 ${
                    cloudProvider === p
                      ? "text-white border-brand-600"
                      : "border-[rgb(var(--color-border))] hover:border-[rgb(var(--color-text-muted))]"
                  }`}
                  style={
                    cloudProvider === p
                      ? { background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' }
                      : { color: 'rgb(var(--color-text-secondary))', background: 'rgb(var(--color-surface))' }
                  }
                >
                  {p === "anthropic" ? "Anthropic" : "OpenAI"}
                </button>
              ))}
            </div>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={hasKey ? "•••••••• (enter to replace)" : "Paste your API key"}
              className="input-field"
            />
            <p className="text-xs" style={{ color: 'rgb(var(--color-text-muted))' }}>
              {hasKey ? "A key is already saved for this provider. " : ""}
              Stored in your OS keychain, never in a file.
            </p>
          </div>
        )}
      </ModeOption>

      <ModeOption
        selected={mode === "off"}
        onSelect={() => setMode("off")}
        icon={
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        }
        title="Search only, no AI answers"
        desc="Questions return the most relevant passages from your documents, without a generated answer."
      />

      <button onClick={save} className="btn-primary mt-2">
        Save changes
      </button>
    </div>
  );
}

function ModeOption({
  selected,
  onSelect,
  icon,
  title,
  desc,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  desc: string;
  children?: React.ReactNode;
}) {
  return (
    <label
      className={`block rounded-xl px-4 py-3.5 cursor-pointer transition-all duration-200 ${
        selected
          ? "ring-2 ring-brand-500/50 border-brand-400 dark:border-brand-500/50 bg-brand-50/50 dark:bg-brand-900/20"
          : "hover:border-[rgb(var(--color-text-muted))]"
      }`}
      style={{
        border: selected ? undefined : '1px solid rgb(var(--color-border))',
        background: selected ? undefined : 'rgb(var(--color-surface))',
      }}
    >
      <div className="flex items-center gap-3">
        <input type="radio" checked={selected} onChange={onSelect} className="accent-brand-600 w-4 h-4" />
        <div
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors ${
            selected ? "text-brand-600 dark:text-brand-400 bg-brand-100 dark:bg-brand-900/40" : ""
          }`}
          style={selected ? undefined : { color: 'rgb(var(--color-text-muted))', background: 'rgb(var(--color-surface-hover))' }}
        >
          {icon}
        </div>
        <span className="font-medium text-sm" style={{ color: 'rgb(var(--color-text))' }}>
          {title}
        </span>
      </div>
      <p className="ml-[3.75rem] text-xs mt-0.5" style={{ color: 'rgb(var(--color-text-muted))' }}>
        {desc}
      </p>
      <div className="ml-[3.75rem]">{children}</div>
    </label>
  );
}
