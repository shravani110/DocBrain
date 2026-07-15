import type { AppStatus } from "../types";

export default function ProcessingQueue({ status }: { status: AppStatus | null }) {
  if (!status) return null;
  const { queue, corpus } = status;
  const busy = queue.current !== null || queue.pending > 0;

  if (!busy) {
    return (
      <span className="text-xs" style={{ color: 'rgb(var(--color-text-muted))' }}>
        {corpus.documents} document{corpus.documents === 1 ? "" : "s"} indexed
      </span>
    );
  }
  return (
    <span className="flex items-center gap-2 text-xs badge badge-info animate-fade-in">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-2 w-2 bg-brand-500" />
      </span>
      {queue.current ? (
        <span>
          Reading <b className="font-semibold">{queue.current.filename}</b>
          <span className="ml-1 opacity-70">({queue.current.stage})</span>
        </span>
      ) : (
        <span>Preparing…</span>
      )}
      {queue.pending > 0 && (
        <span style={{ color: 'rgb(var(--color-text-muted))' }}>+{queue.pending} queued</span>
      )}
    </span>
  );
}
