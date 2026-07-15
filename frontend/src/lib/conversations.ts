import type { ChatMessage } from "../types";

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
}

const STORAGE_KEY = "docbrain-conversations";
const LEGACY_KEY = "docbrain-chat-history"; // single flat thread, pre-history-sidebar
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 50;

function makeId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function titleFromMessages(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = firstUser?.text.trim();
  if (!text) return "New conversation";
  return text.length > 48 ? text.slice(0, 48) + "…" : text;
}

export function newConversation(): Conversation {
  return { id: makeId(), title: "New conversation", messages: [], updatedAt: Date.now() };
}

/** Loads saved conversations, migrating the old single-thread format (if
 * present and non-empty) into the first entry so nobody's history vanishes
 * when this feature ships. */
export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    /* fall through to migration / empty */
  }

  try {
    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    const legacy = legacyRaw ? JSON.parse(legacyRaw) : [];
    if (Array.isArray(legacy) && legacy.length > 0) {
      const migrated: Conversation = {
        id: makeId(),
        title: titleFromMessages(legacy),
        messages: legacy,
        updatedAt: Date.now(),
      };
      localStorage.removeItem(LEGACY_KEY);
      return [migrated];
    }
  } catch {
    /* no legacy history to migrate */
  }

  return [];
}

export function saveConversations(convos: Conversation[]): void {
  try {
    const trimmed = convos
      .slice(0, MAX_CONVERSATIONS)
      .map((c) => ({ ...c, messages: c.messages.slice(-MAX_MESSAGES) }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* storage full or unavailable -- chat still works, just not persisted */
  }
}
