import type { Conversation } from "../lib/conversations";

export default function ChatSidebar({
  conversations,
  activeId,
  onSelect,
  onNew,
  onDelete,
  onClose,
}: {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Collapses/hides this panel. */
  onClose: () => void;
}) {
  return (
    <aside className="w-full h-full glass-surface border-r flex flex-col" style={{ borderColor: 'var(--glass-border)' }}>
      <div className="flex items-center justify-between px-3 pt-3 pb-1">
        <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'rgb(var(--color-text-muted))' }}>
          History
        </span>
        <button
          onClick={onClose}
          title="Hide conversations"
          className="btn-ghost p-1.5 rounded-lg"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      </div>
      <div className="px-3 pb-3 pt-1">
        <button
          onClick={onNew}
          className="w-full flex items-center gap-2 justify-center rounded-xl px-3 py-2.5 text-sm font-medium transition-all duration-200 text-white"
          style={{ background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)', boxShadow: '0 2px 8px rgba(99,102,241,0.25)' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
        </button>
      </div>
      <div className="flex-1 overflow-y-auto pb-2">
        {conversations.length === 0 && (
          <div className="text-xs px-3 py-8 text-center" style={{ color: 'rgb(var(--color-text-muted))' }}>
            No conversations yet
          </div>
        )}
        {conversations
          .slice()
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((c) => (
            <div
              key={c.id}
              className={`group flex items-center gap-1 mx-2 mb-0.5 rounded-xl transition-all duration-150 ${
                c.id === activeId
                  ? "bg-brand-500/10 dark:bg-brand-500/15"
                  : "hover:bg-[rgb(var(--color-surface-hover))]"
              }`}
            >
              <button
                onClick={() => onSelect(c.id)}
                title={c.title}
                className={`flex-1 min-w-0 text-left px-3 py-2.5 text-sm truncate transition-colors duration-150 ${
                  c.id === activeId
                    ? "text-brand-600 dark:text-brand-400 font-semibold"
                    : ""
                }`}
                style={c.id !== activeId ? { color: 'rgb(var(--color-text-secondary))' } : undefined}
              >
                {c.title}
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(c.id);
                }}
                title="Delete conversation"
                className="opacity-0 group-hover:opacity-100 hover:text-rose-500 dark:hover:text-rose-400 px-2 text-xs shrink-0 transition-opacity duration-150"
                style={{ color: 'rgb(var(--color-text-muted))' }}
              >
                ✕
              </button>
            </div>
          ))}
      </div>
    </aside>
  );
}
