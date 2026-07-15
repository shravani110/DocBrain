/** Collapsed state of the conversation panel: a narrow icon-only rail
 * with the toggle and "new chat" staying one click away. */
export default function ChatSidebarRail({
  onExpand,
  onNew,
}: {
  onExpand: () => void;
  onNew: () => void;
}) {
  return (
    <aside
      className="w-14 h-full glass-surface border-r flex flex-col items-center gap-1.5 pt-3"
      style={{ borderColor: 'var(--glass-border)' }}
    >
      <button
        onClick={onExpand}
        title="Show conversations"
        className="btn-ghost p-2.5 rounded-xl"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="9" y1="3" x2="9" y2="21" />
        </svg>
      </button>
      <button
        onClick={onNew}
        title="New chat"
        className="p-2.5 rounded-xl text-white transition-all duration-200 hover:shadow-glow-sm"
        style={{ background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)' }}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </aside>
  );
}
