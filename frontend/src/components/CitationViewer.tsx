import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { BBox } from "../types";

export interface ViewerTarget {
  documentId: number;
  filename: string;
  page: number;
  bboxes: BBox[];
  quotedSpan?: string;
  chunkId?: number;
}

type Mode = "loading" | "pages" | "text" | "error";

/**
 * Document viewer side panel.
 *
 * PDFs and images render as a continuously scrollable stack of
 * server-rasterized pages (lazy-loaded, so 100-page reports stay fast).
 * The cited page draws highlight rectangles from stored bounding boxes and
 * auto-scrolls into view.
 *
 * Formats without a printable page (docx/xlsx/pptx/txt/...) fall back to a
 * text view with the quoted span highlighted, navigable page-by-page.
 */
export default function CitationViewer({
  target,
  onClose,
}: {
  target: ViewerTarget;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<Mode>("loading");
  const [pageCount, setPageCount] = useState(1);
  const [textPage, setTextPage] = useState(target.page);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Determine mode: probe the cited page's image; 415 means text-only format.
  useEffect(() => {
    let alive = true;
    setMode("loading");
    setError(null);
    setTextPage(target.page);
    (async () => {
      try {
        const [docs, probe] = await Promise.all([
          api.documents(),
          fetch(api.pageImageUrl(target.documentId, target.page), { method: "GET" }),
        ]);
        if (!alive) return;
        const doc = docs.find((d) => d.id === target.documentId);
        setPageCount(Math.max(1, doc?.page_count ?? 1));
        if (probe.ok) {
          probe.body?.cancel?.();
          setMode("pages");
          return;
        }
        if (probe.status === 415) {
          setMode("text");
          return;
        }
        const detail = await probe.json().catch(() => null);
        throw new Error(detail?.detail ?? `Could not open document (${probe.status})`);
      } catch (e) {
        if (alive) {
          setError((e as Error).message);
          setMode("error");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [target]);

  // Text mode: load the cited chunk (on its own page) or the page's full text.
  useEffect(() => {
    if (mode !== "text") return;
    let alive = true;
    setTextContent(null);
    const url =
      target.chunkId && textPage === target.page
        ? api.chunkUrl(target.chunkId)
        : api.documentTextUrl(target.documentId, textPage);
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive) setTextContent(data?.text ?? "No text on this page.");
      })
      .catch(() => {
        if (alive) setTextContent("Could not load text.");
      });
    return () => {
      alive = false;
    };
  }, [mode, textPage, target]);

  return (
    <aside
      className="fixed inset-0 z-50 w-full flex flex-col shadow-2xl md:static md:z-auto md:w-[46%] md:max-w-3xl md:border-l animate-slide-in-right"
      style={{
        background: 'rgb(var(--color-surface))',
        borderColor: 'rgb(var(--color-border))',
      }}
    >
      <div
        className="flex items-center gap-3 px-4 py-3 border-b"
        style={{ borderColor: 'rgb(var(--color-border))' }}
      >
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' }}>
          <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-sm truncate" style={{ color: 'rgb(var(--color-text))' }}>
            {target.filename}
          </div>
          <div className="text-xs" style={{ color: 'rgb(var(--color-text-muted))' }}>
            {mode === "text" ? `Page ${textPage + 1} of ${pageCount}` : `${pageCount} page${pageCount === 1 ? "" : "s"}`}
          </div>
        </div>
        {mode === "text" && pageCount > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => setTextPage((p) => Math.max(0, p - 1))}
              disabled={textPage === 0}
              className="btn-ghost p-1.5 rounded-lg disabled:opacity-30"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => setTextPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={textPage >= pageCount - 1}
              className="btn-ghost p-1.5 rounded-lg disabled:opacity-30"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
        <button
          onClick={onClose}
          className="btn-ghost p-1.5 rounded-lg"
        >
          <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {target.quotedSpan && (
        <div
          className="px-4 py-2.5 border-b text-sm"
          style={{
            background: 'rgba(250, 204, 21, 0.1)',
            borderColor: 'rgba(250, 204, 21, 0.3)',
          }}
        >
          <span className="font-semibold text-yellow-700 dark:text-yellow-400">Cited: </span>
          <span style={{ color: 'rgb(var(--color-text-secondary))' }}>"{target.quotedSpan}"</span>
        </div>
      )}

      <div className="flex-1 overflow-auto p-4" style={{ background: 'rgb(var(--color-bg-secondary))' }}>
        {mode === "loading" && (
          <div className="flex items-center gap-2 p-4 animate-fade-in" style={{ color: 'rgb(var(--color-text-muted))' }}>
            <div className="flex gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-brand-500 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
            <span className="text-sm">Opening document…</span>
          </div>
        )}

        {mode === "error" && (
          <div className="text-sm glass-card p-4" style={{ color: 'rgb(var(--color-text-secondary))' }}>
            {error}
          </div>
        )}

        {mode === "text" && (
          <div
            className="glass-card p-5 text-sm whitespace-pre-wrap leading-relaxed"
            style={{ color: 'rgb(var(--color-text-secondary))' }}
          >
            <div className="text-xs uppercase font-semibold mb-3 tracking-wider" style={{ color: 'rgb(var(--color-text-muted))' }}>
              Source text (this file type has no page view)
            </div>
            {textContent === null ? (
              <span style={{ color: 'rgb(var(--color-text-muted))' }}>Loading…</span>
            ) : (
              <HighlightedText
                text={textContent}
                quote={textPage === target.page ? target.quotedSpan : undefined}
              />
            )}
          </div>
        )}

        {mode === "pages" && (
          <div className="space-y-4">
            {Array.from({ length: pageCount }, (_, p) =>
              p === target.page && target.bboxes.length > 0 ? (
                <CitedPage key={p} target={target} page={p} />
              ) : (
                <LazyPage
                  key={p}
                  documentId={target.documentId}
                  page={p}
                  filename={target.filename}
                  scrollTo={p === target.page && target.bboxes.length === 0}
                />
              ),
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

/** A plain page image, lazy-loaded so long documents don't fetch everything. */
function LazyPage({
  documentId,
  page,
  filename,
  scrollTo,
}: {
  documentId: number;
  page: number;
  filename: string;
  scrollTo?: boolean;
}) {
  const [loaded, setLoaded] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollTo && ref.current) {
      ref.current.scrollIntoView({ block: "start" });
    }
  }, [scrollTo]);

  return (
    <div ref={ref} className="rounded-xl overflow-hidden shadow-card" style={{ background: 'rgb(var(--color-surface))' }}>
      {/* The placeholder size must be on the <img> itself: Chrome never
          lazy-loads a zero-size image. */}
      <img
        src={api.pageImageUrl(documentId, page)}
        alt={`${filename} page ${page + 1}`}
        loading="lazy"
        className="block w-full"
        style={loaded ? undefined : { minHeight: 700 }}
        onLoad={() => setLoaded(true)}
      />
      <div className="text-center text-[10px] py-1.5" style={{ color: 'rgb(var(--color-text-muted))' }}>
        page {page + 1}
      </div>
    </div>
  );
}

/** The cited page: fetched with geometry headers so highlight rectangles can
 * be scaled onto it; auto-scrolls to the first highlight. */
function CitedPage({ target, page }: { target: ViewerTarget; page: number }) {
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [pageDims, setPageDims] = useState<{ w: number; h: number } | null>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);
  const firstHighlightRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let revoke: string | null = null;
    let alive = true;
    (async () => {
      const res = await fetch(api.pageImageUrl(target.documentId, page));
      if (!res.ok || !alive) return;
      const w = parseFloat(res.headers.get("X-Page-Width") ?? "0");
      const h = parseFloat(res.headers.get("X-Page-Height") ?? "0");
      const blob = await res.blob();
      if (!alive) return;
      revoke = URL.createObjectURL(blob);
      setPageDims(w > 0 && h > 0 ? { w, h } : null);
      setImgUrl(revoke);
    })();
    return () => {
      alive = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [target.documentId, page]);

  useEffect(() => {
    if (imgSize) {
      (firstHighlightRef.current ?? wrapRef.current)?.scrollIntoView({ block: "center" });
    }
  }, [imgSize]);

  const boxes = selectHighlightBoxes(target.bboxes, page, target.quotedSpan);

  return (
    <div
      ref={wrapRef}
      className="relative rounded-xl overflow-hidden shadow-card"
      style={imgUrl ? { background: 'rgb(var(--color-surface))' } : { minHeight: 700, background: 'rgb(var(--color-surface))' }}
    >
      {imgUrl && (
        <img
          src={imgUrl}
          alt={`${target.filename} page ${page + 1} (cited)`}
          className="block max-w-full"
          onLoad={(e) => {
            const el = e.currentTarget;
            setImgSize({ w: el.clientWidth, h: el.clientHeight });
          }}
        />
      )}
      {imgSize &&
        pageDims &&
        boxes.map((b, i) => {
          const sx = imgSize.w / pageDims.w;
          const sy = imgSize.h / pageDims.h;
          const [, x0, y0, x1, y1] = b;
          return (
            <div
              key={i}
              ref={i === 0 ? firstHighlightRef : undefined}
              className="absolute bg-yellow-300/40 border border-yellow-500/60 rounded-sm pointer-events-none"
              style={{
                left: x0 * sx - 2,
                top: y0 * sy - 2,
                width: (x1 - x0) * sx + 4,
                height: (y1 - y0) * sy + 4,
              }}
            />
          );
        })}
      <div className="text-center text-[10px] py-1.5" style={{ color: 'rgb(var(--color-text-muted))' }}>
        page {page + 1} · <span className="text-yellow-600 dark:text-yellow-400 font-medium">cited</span>
      </div>
    </div>
  );
}

const normalize = (s: string) =>
  s
    .replace(/&amp;/g, "&")
    .replace(/[^\w\s&]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Choose which highlight rectangles to draw. A chunk may cover a large region
 * (e.g. a two-column page merged into one chunk), so when we know the cited
 * quote and the boxes carry per-line text (6th element), keep only the lines
 * that are actually part of the quote. Falls back to all boxes on the page for
 * older data or when nothing matches.
 */
// Words this short (or purely numeric under 4 digits, e.g. table indices,
// times like "10"/"45") are too generic to prove a line belongs to the
// quote -- two unrelated lines sharing "10" (a table row "1-10" vs. a time
// "10:00 PM") must not count as a match.
const isMeaningfulWord = (w: string) => w.length >= 3 && !(/^\d+$/.test(w) && w.length < 4);

function selectHighlightBoxes(bboxes: BBox[], page: number, quote?: string): BBox[] {
  const onPage = bboxes.filter((b) => b[0] === page);
  const haveText = onPage.some((b) => typeof b[5] === "string" && b[5]);
  if (!quote || !haveText) return onPage;

  const q = normalize(quote);
  const qWords = new Set(q.split(" ").filter(isMeaningfulWord));
  const matched = onPage.filter((b) => {
    const lineText = normalize(String(b[5] ?? ""));
    if (!lineText) return false;
    // A short line (e.g. a single table cell) can coincidentally be a
    // substring of a long quote; require real length so this only fires
    // for genuine phrase matches.
    if (q.includes(lineText) && lineText.length > 8) return true;
    const words = lineText.split(" ").filter(isMeaningfulWord);
    if (words.length === 0) return false;
    const hits = words.filter((w) => qWords.has(w)).length;
    // Require both a healthy ratio and at least two real word matches, so
    // a single generic word shared by chance can't tag an unrelated line.
    return hits >= 2 && hits / words.length >= 0.6;
  });
  return matched.length > 0 ? matched : onPage;
}

/** Renders text with the quoted span highlighted (whitespace/punct-tolerant). */
function HighlightedText({ text, quote }: { text: string; quote?: string }) {
  if (!quote) return <>{text}</>;
  const words = quote
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (words.length === 0) return <>{text}</>;
  try {
    const re = new RegExp(words.join("[\\s\\S]{0,6}?"), "i");
    const m = text.match(re);
    if (!m || m.index === undefined) return <>{text}</>;
    return (
      <>
        {text.slice(0, m.index)}
        <mark className="bg-yellow-200 dark:bg-yellow-500/30 rounded px-0.5">{m[0]}</mark>
        {text.slice(m.index + m[0].length)}
      </>
    );
  } catch {
    return <>{text}</>;
  }
}
