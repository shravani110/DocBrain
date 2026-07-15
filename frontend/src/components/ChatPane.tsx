import { FormEvent, useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { AppStatus, AskResponse, ChatMessage, Citation } from "../types";
import type { ViewerTarget } from "./CitationViewer";

export default function ChatPane({
  status,
  messages,
  onMessagesChange,
  onOpenCitation,
  onOpenPanel,
}: {
  status: AppStatus | null;
  messages: ChatMessage[];
  onMessagesChange: (messages: ChatMessage[]) => void;
  onOpenCitation: (t: ViewerTarget) => void;
  /** Present only while the conversation panel is hidden -- reopens it. */
  onOpenPanel?: () => void;
}) {
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, asking]);

  // Local models can take a minute or two: show elapsed time, not a bare spinner.
  useEffect(() => {
    if (!asking) return;
    setElapsed(0);
    const iv = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(iv);
  }, [asking]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = input.trim();
    if (!q || asking) return;
    setInput("");
    const withQuestion: ChatMessage[] = [...messages, { role: "user", text: q }];
    onMessagesChange(withQuestion);
    setAsking(true);
    try {
      const res = await api.ask(q);
      onMessagesChange([...withQuestion, { role: "assistant", text: res.answer ?? "", response: res }]);
    } catch (err) {
      onMessagesChange([
        ...withQuestion,
        { role: "assistant", text: `Something went wrong: ${(err as Error).message}` },
      ]);
    } finally {
      setAsking(false);
    }
  };

  const empty = messages.length === 0;

  return (
    <div className="h-full flex flex-col">
      {onOpenPanel && (
        <div className="px-2 pt-2">
          <button
            onClick={onOpenPanel}
            title="Show conversations"
            className="btn-ghost p-1.5 rounded-lg"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 space-y-4 min-h-full flex flex-col justify-end">
        {empty && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 animate-fade-in">
            <div
              className="w-20 h-20 rounded-3xl flex items-center justify-center text-3xl text-white shadow-glow"
              style={{ background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)' }}
            >
              ◈
            </div>
            <div>
              <h2 className="text-xl font-semibold mb-2" style={{ color: 'rgb(var(--color-text))' }}>
                Ask about your documents
              </h2>
              <p className="max-w-md text-sm leading-relaxed" style={{ color: 'rgb(var(--color-text-muted))' }}>
                "When does my lease renew?", "What's my insurance deductible?" —
                answers cite the exact spot in the original file.
              </p>
            </div>
            {status && status.corpus.documents === 0 && (
              <div className="badge badge-warning animate-slide-up">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                No documents indexed yet — add a folder in Settings
              </div>
            )}
          </div>
        )}
        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end animate-slide-up">
              <div
                className="max-w-xl rounded-2xl rounded-br-sm px-4 py-2.5 text-white text-sm shadow-lg"
                style={{ background: 'var(--chat-user-bg)' }}
              >
                {m.text}
              </div>
            </div>
          ) : (
            <AssistantMessage key={i} msg={m} onOpenCitation={onOpenCitation} />
          ),
        )}
        {asking && (
          <div className="flex items-center gap-3 animate-fade-in px-1" style={{ color: 'rgb(var(--color-text-muted))' }}>
            <div className="flex gap-1">
              <span className="w-2 h-2 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-2 h-2 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-2 h-2 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-sm">
              {elapsed < 8
                ? "Searching your documents…"
                : `Thinking with the local model… ${elapsed}s (first question after a break is slowest)`}
            </span>
          </div>
        )}
        <div ref={bottomRef} />
        </div>
      </div>
      <form
        onSubmit={submit}
        className="border-t"
        style={{ background: 'rgb(var(--color-surface))', borderColor: 'rgb(var(--color-border))' }}
      >
        <div className="max-w-3xl mx-auto p-3 sm:p-4 flex gap-2 items-center">
          {messages.length > 0 && !asking && (
            <button
              type="button"
              onClick={() => onMessagesChange([])}
              title="Clear this conversation"
              className="btn-ghost text-xs px-2 py-1 shrink-0"
            >
              Clear
            </button>
          )}
          <div className="flex-1 relative">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask a question about your documents…"
              className="input-field pr-4"
            />
          </div>
          <button
            disabled={asking || !input.trim()}
            className="btn-primary"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
            </svg>
          </button>
        </div>
      </form>
    </div>
  );
}

function AssistantMessage({
  msg,
  onOpenCitation,
}: {
  msg: ChatMessage;
  onOpenCitation: (t: ViewerTarget) => void;
}) {
  const res = msg.response;

  const open = (c: Citation) =>
    onOpenCitation({
      documentId: c.document_id,
      filename: c.filename,
      page: c.page_number,
      bboxes: c.bboxes,
      quotedSpan: c.quoted_span,
      chunkId: c.chunk_id,
    });

  return (
    <div className="flex justify-start animate-slide-up">
      <div
        className="max-w-2xl rounded-2xl rounded-bl-sm px-4 py-3 space-y-3 shadow-sm"
        style={{
          background: 'var(--chat-bot-bg)',
          border: '1px solid var(--chat-bot-border)',
          backdropFilter: 'blur(8px)',
        }}
      >
        {res?.llm_error ? (
          <>
            <div className="text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700/50 rounded-xl px-3 py-2 text-sm">
              {res.llm_error}
            </div>
            {res.retrieved_passages && res.retrieved_passages.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgb(var(--color-text-muted))' }}>
                  Most relevant passages found
                </div>
                {res.retrieved_passages.map((p) => (
                  <button
                    key={p.chunk_id}
                    onClick={() =>
                      onOpenCitation({
                        documentId: p.document_id,
                        filename: p.filename,
                        page: p.page_number,
                        bboxes: p.bboxes,
                        chunkId: p.chunk_id,
                      })
                    }
                    className="block w-full text-left text-sm rounded-xl px-3 py-2.5 transition-all duration-200 hover:scale-[1.01]"
                    style={{
                      background: 'rgb(var(--color-surface-hover))',
                      border: '1px solid rgb(var(--color-border))',
                    }}
                  >
                    <div className="text-xs text-brand-600 dark:text-brand-400 font-medium mb-1">
                      {p.filename} · page {p.page_number + 1}
                    </div>
                    <div className="line-clamp-3" style={{ color: 'rgb(var(--color-text-secondary))' }}>{p.text}</div>
                  </button>
                ))}
              </div>
            )}
            <FileHints res={res} onOpenCitation={onOpenCitation} />
          </>
        ) : (
          <>
            <AnswerWithMarkers text={msg.text} citations={res?.citations ?? []} onOpen={open} />
            {res && <ConfidenceSignal res={res} />}
            {res && res.citations.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-2 border-t" style={{ borderColor: 'rgb(var(--color-border))' }}>
                {res.citations.map((c, i) => (
                  <button
                    key={i}
                    onClick={() => open(c)}
                    title={`"${c.quoted_span}"`}
                    className="text-xs bg-brand-50 dark:bg-brand-900/30 hover:bg-brand-100 dark:hover:bg-brand-900/50 text-brand-700 dark:text-brand-400 border border-brand-200 dark:border-brand-700/50 rounded-full px-2.5 py-1 transition-all duration-150 hover:shadow-sm"
                  >
                    <sup className="mr-1">{i + 1}</sup>
                    {c.filename} · p.{c.page_number + 1}
                  </button>
                ))}
              </div>
            )}
            <FileHints res={res} onOpenCitation={onOpenCitation} />
          </>
        )}
      </div>
    </div>
  );
}

/** Files with no readable text whose filename matches the question. */
function FileHints({
  res,
  onOpenCitation,
}: {
  res: AskResponse | undefined;
  onOpenCitation: (t: ViewerTarget) => void;
}) {
  if (!res?.file_hints || res.file_hints.length === 0) return null;
  return (
    <div className="pt-2 border-t space-y-1.5" style={{ borderColor: 'rgb(var(--color-border))' }}>
      <div className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgb(var(--color-text-muted))' }}>
        Matching file{res.file_hints.length > 1 ? "s" : ""} with no readable text
      </div>
      {res.file_hints.map((h) => (
        <button
          key={h.document_id}
          onClick={() =>
            onOpenCitation({ documentId: h.document_id, filename: h.filename, page: 0, bboxes: [] })
          }
          className="block w-full text-left text-sm rounded-xl px-3 py-2.5 transition-all duration-200"
          style={{
            background: 'rgb(var(--color-surface-hover))',
            border: '1px solid rgb(var(--color-border))',
          }}
        >
          <div className="text-brand-600 dark:text-brand-400 font-medium">{h.filename}</div>
          <div className="text-xs" style={{ color: 'rgb(var(--color-text-muted))' }}>{h.reason} — click to view the file</div>
        </button>
      ))}
    </div>
  );
}

function AnswerWithMarkers({
  text,
  citations,
  onOpen,
}: {
  text: string;
  citations: Citation[];
  onOpen: (c: Citation) => void;
}) {
  return (
    <div className="text-sm whitespace-pre-wrap leading-relaxed" style={{ color: 'rgb(var(--color-text))' }}>
      {text}
      {citations.map((c, i) => (
        <sup
          key={i}
          onClick={() => onOpen(c)}
          className="ml-0.5 cursor-pointer text-brand-600 dark:text-brand-400 hover:text-brand-800 dark:hover:text-brand-300 font-semibold transition-colors"
        >
          [{i + 1}]
        </sup>
      ))}
    </div>
  );
}

/** Structural confidence signal — never a made-up percentage. */
function ConfidenceSignal({ res }: { res: AskResponse }) {
  if (res.no_answer) {
    return (
      <div className="text-xs rounded-xl px-3 py-1.5 inline-flex items-center gap-1.5" style={{
        background: 'rgb(var(--color-surface-hover))',
        color: 'rgb(var(--color-text-muted))',
      }}>
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        No clear answer found in your documents
      </div>
    );
  }
  const n = res.found_in_documents;
  if (n === 0) return null;
  return (
    <div
      className={`text-xs rounded-xl px-3 py-1.5 inline-flex items-center gap-1.5 ${
        n > 1
          ? "bg-sky-50 dark:bg-sky-900/30 text-sky-700 dark:text-sky-400"
          : "bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400"
      }`}
    >
      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
      {n === 1 ? "Found in 1 document" : `Found in ${n} documents — check each source below`}
    </div>
  );
}
