import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import ChatPane from "./components/ChatPane";
import ChatSidebar from "./components/ChatSidebar";
import ChatSidebarRail from "./components/ChatSidebarRail";
import CitationViewer, { ViewerTarget } from "./components/CitationViewer";
import DocumentLibrary from "./components/DocumentLibrary";
import Login from "./components/Login";
import Onboarding from "./components/Onboarding";
import ProcessingQueue from "./components/ProcessingQueue";
import SettingsPanel from "./components/SettingsPanel";
import * as auth from "./lib/auth";
import {
  Conversation,
  loadConversations,
  newConversation,
  saveConversations,
  titleFromMessages,
} from "./lib/conversations";
import { useTheme } from "./lib/useTheme";
import type { AppStatus, ChatMessage, Settings } from "./types";

type Tab = "chat" | "library" | "settings";

// Unset/"local" for the desktop build (Electron/exe/browser-on-this-machine);
// "hosted" only for the Netlify build, which adds sign-in and file upload
// instead of local folder-watching. Onboarding.tsx stays untouched either way.
const HOSTED_MODE = import.meta.env.VITE_APP_MODE === "hosted";

/** True below Tailwind's `md` breakpoint (768px) -- kept in sync with the
 * `md:` classes used throughout so JS and CSS never disagree. ResizeObserver
 * on the root element reacts to the actual layout box size, so it stays
 * correct even under viewport emulation that doesn't fire a `resize` event
 * (some devtools/automation viewport overrides skip it; real window resizes
 * and orientation changes always fire both, so this is defense in depth). */
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() => document.documentElement.clientWidth <= 767);
  useEffect(() => {
    const check = () => setIsMobile(document.documentElement.clientWidth <= 767);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(document.documentElement);
    window.addEventListener("resize", check);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", check);
    };
  }, []);
  return isMobile;
}

const TAB_ICONS: Record<Tab, JSX.Element> = {
  chat: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  ),
  library: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
    </svg>
  ),
  settings: (
    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
};

export default function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [viewer, setViewer] = useState<ViewerTarget | null>(null);
  const [backendDown, setBackendDown] = useState(false);
  const [authed, setAuthed] = useState(() => !HOSTED_MODE || !!auth.getSession());
  const isMobile = useIsMobile();
  const { isDark, toggleTheme } = useTheme();

  // Whether the conversation panel is shown. On desktop it's a persistent
  // column you can collapse for more room; on phone/tablet it's an overlay
  // drawer -- both toggled by the same header button, like Claude/Gemini.
  const [panelOpen, setPanelOpen] = useState(() => document.documentElement.clientWidth > 767);

  const [conversations, setConversations] = useState<Conversation[]>(() => {
    const loaded = loadConversations();
    return loaded.length > 0 ? loaded : [newConversation()];
  });
  const [activeId, setActiveId] = useState<string>(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0].id,
  );

  useEffect(() => {
    saveConversations(conversations);
  }, [conversations]);

  const active = conversations.find((c) => c.id === activeId) ?? conversations[0];

  const setActiveMessages = useCallback(
    (messages: ChatMessage[]) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === activeId
            ? { ...c, messages, title: titleFromMessages(messages), updatedAt: Date.now() }
            : c,
        ),
      );
    },
    [activeId],
  );

  const handleNewChat = useCallback(() => {
    // Don't stack up empty conversations if the user is already on one.
    if (active && active.messages.length === 0) return;
    const conv = newConversation();
    setConversations((prev) => [conv, ...prev]);
    setActiveId(conv.id);
  }, [active]);

  const handleDeleteConversation = useCallback(
    (id: string) => {
      setConversations((prev) => {
        const rest = prev.filter((c) => c.id !== id);
        if (id === activeId) {
          if (rest.length > 0) {
            setActiveId([...rest].sort((a, b) => b.updatedAt - a.updatedAt)[0].id);
          } else {
            const conv = newConversation();
            setActiveId(conv.id);
            return [conv];
          }
        }
        return rest;
      });
    },
    [activeId],
  );

  const refreshSettings = useCallback(() => {
    // Hosted mode has no per-user /api/settings endpoint (no per-user LLM
    // config in this MVP -- see plan) -- only the local desktop build has one.
    if (HOSTED_MODE) return;
    api.settings().then(setSettings).catch(() => {});
  }, []);

  const refreshStatus = useCallback(() => {
    api.status().then((s) => {
      setStatus(s);
      setBackendDown(false);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (HOSTED_MODE && !authed) return; // nothing to poll before sign-in
    refreshSettings();
    let alive = true;
    const poll = async () => {
      try {
        const s = await api.status();
        if (alive) {
          setStatus(s);
          setBackendDown(false);
        }
      } catch {
        if (alive) setBackendDown(true);
      }
    };
    poll();
    const iv = setInterval(poll, 1500);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [refreshSettings, authed]);

  if (HOSTED_MODE && !authed) {
    return <Login onAuthenticated={() => setAuthed(true)} />;
  }

  if (backendDown && !status) {
    return (
      <div className="h-full flex flex-col items-center justify-center bg-app p-6">
        <div className="animate-glow-pulse w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' }}>
          <span className="text-white text-2xl">◈</span>
        </div>
        <p className="text-sm animate-pulse" style={{ color: 'rgb(var(--color-text-muted))' }}>
          Waiting for the local processing engine to start&hellip;
        </p>
      </div>
    );
  }

  // Hosted mode never shows a forced first-run screen -- land on Chat
  // immediately after sign-in, same as returning to the local desktop app
  // past its own first run. Uploading documents happens from the Library
  // tab instead (see DocumentLibrary.tsx), reachable anytime, not gated.
  if (status && !status.onboarded && !HOSTED_MODE && settings) {
    return (
      <Onboarding
        settings={settings}
        onDone={() => {
          refreshSettings();
          refreshStatus();
        }}
      />
    );
  }

  const localOnly = status?.privacy_mode === "Local only";

  return (
    <div className="h-full flex flex-col bg-app">
      <header
        className="relative flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 border-b glass-surface z-10"
        style={{ borderColor: 'var(--glass-border)' }}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-sm" style={{ background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' }}>
            ◈
          </div>
          <span className="font-bold text-sm" style={{ color: 'rgb(var(--color-text))' }}>
            Doc<span className="gradient-text">Brain</span>
          </span>
        </div>

        {/* Centered tab navigation */}
        <nav className="absolute left-1/2 -translate-x-1/2 flex gap-0.5 p-1 rounded-xl" style={{ background: 'rgb(var(--color-bg-secondary))' }}>
          {/* No per-user settings UI in hosted mode yet (see plan) -- nothing to configure there. */}
          {(HOSTED_MODE ? (["chat", "library"] as Tab[]) : (["chat", "library", "settings"] as Tab[])).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`tab-btn flex items-center gap-1.5 capitalize ${tab === t ? "active" : ""}`}
            >
              {TAB_ICONS[t]}
              <span className="hidden sm:inline">{t}</span>
            </button>
          ))}
        </nav>

        <div className="flex-1" />

        {/* Processing queue */}
        <div className="hidden sm:block">
          <ProcessingQueue status={status} />
        </div>

        {/* Dark mode toggle */}
        <button
          onClick={toggleTheme}
          className="btn-ghost p-2 rounded-xl"
          title={isDark ? "Switch to light mode" : "Switch to dark mode"}
        >
          {isDark ? (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
            </svg>
          )}
        </button>

        {/* Privacy badge */}
        <span
          title={`Embeddings: ${status?.embedding_backend ?? "?"} · OCR: ${status?.ocr_engine ?? "not installed"}`}
          className={`badge whitespace-nowrap ${localOnly ? "badge-success" : "badge-warning"}`}
        >
          {localOnly ? (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 15a4 4 0 004 4h9a5 5 0 10-.1-9.999 5.002 5.002 0 10-9.78 2.096A4.001 4.001 0 003 15z" />
            </svg>
          )}
          <span className="hidden sm:inline">{status?.privacy_mode ?? "…"}</span>
        </span>

        {HOSTED_MODE && (
          <button
            onClick={() => {
              auth.signOut();
              setAuthed(false);
            }}
            className="btn-ghost text-sm whitespace-nowrap"
            title="Sign out"
          >
            Sign out
          </button>
        )}
      </header>

      <main className="flex-1 flex min-h-0 relative">
        {tab === "chat" && !isMobile && (
          panelOpen ? (
            <div className="h-full w-60 shrink-0 animate-slide-in-left">
              <ChatSidebar
                conversations={conversations}
                activeId={activeId}
                onSelect={setActiveId}
                onNew={handleNewChat}
                onDelete={handleDeleteConversation}
                onClose={() => setPanelOpen(false)}
              />
            </div>
          ) : (
            <div className="h-full w-14 shrink-0">
              <ChatSidebarRail onExpand={() => setPanelOpen(true)} onNew={handleNewChat} />
            </div>
          )
        )}
        {/* Phone/tablet: slide-over panel above the chat */}
        {tab === "chat" && isMobile && panelOpen && (
          <div className="absolute inset-0 z-40 animate-fade-in" onClick={() => setPanelOpen(false)}>
            <div className="absolute inset-0" style={{ background: 'var(--overlay-bg)' }} />
            <div
              className="absolute left-0 top-0 bottom-0 w-[82%] max-w-xs shadow-2xl animate-slide-in-left"
              onClick={(e) => e.stopPropagation()}
            >
              <ChatSidebar
                conversations={conversations}
                activeId={activeId}
                onSelect={(id) => {
                  setActiveId(id);
                  setPanelOpen(false);
                }}
                onNew={() => {
                  handleNewChat();
                  setPanelOpen(false);
                }}
                onDelete={handleDeleteConversation}
                onClose={() => setPanelOpen(false)}
              />
            </div>
          </div>
        )}
        <div className="flex-1 min-w-0">
          {tab === "chat" && (
            <ChatPane
              key={activeId}
              status={status}
              messages={active?.messages ?? []}
              onMessagesChange={setActiveMessages}
              onOpenCitation={setViewer}
              onOpenPanel={isMobile && !panelOpen ? () => setPanelOpen(true) : undefined}
            />
          )}
          {tab === "library" && <DocumentLibrary onOpenDocument={(d) => setViewer({ documentId: d.id, filename: d.filename, page: 0, bboxes: [] })} />}
          {tab === "settings" && settings && (
            <SettingsPanel settings={settings} onSaved={refreshSettings} />
          )}
        </div>
        {viewer && <CitationViewer target={viewer} onClose={() => setViewer(null)} />}
      </main>
    </div>
  );
}
