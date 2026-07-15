import type { AppStatus, AskResponse, DocumentRow, Settings } from "./types";

// In dev, Vite proxies /api to the sidecar. In the packaged Electron app the
// page is served from disk (file://), so we must target the sidecar directly.
const BASE =
  window.location.protocol === "file:" ? "http://127.0.0.1:8756/api" : "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new Error(detail);
  }
  return res.json();
}

export const api = {
  status: () => req<AppStatus>("/status"),
  settings: () => req<Settings>("/settings"),
  updateSettings: (updates: Partial<Settings> & { anthropic_api_key?: string; openai_api_key?: string }) =>
    req<Settings>("/settings", { method: "POST", body: JSON.stringify(updates) }),
  documents: () => req<DocumentRow[]>("/documents"),
  retag: (id: number, doc_type: string) =>
    req(`/documents/${id}/retag`, { method: "POST", body: JSON.stringify({ doc_type }) }),
  reprocess: (id: number) => req(`/documents/${id}/reprocess`, { method: "POST" }),
  deleteDocument: (id: number) => req(`/documents/${id}`, { method: "DELETE" }),
  pickFolder: () => req<{ path: string | null }>("/pick-folder", { method: "POST" }),
  addFolder: (path: string) =>
    req<{ watched_folders: string[]; queued: number | null }>("/folders", {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  removeFolder: (path: string) =>
    req<{ watched_folders: string[] }>("/folders", {
      method: "DELETE",
      body: JSON.stringify({ path }),
    }),
  ask: (question: string) =>
    req<AskResponse>("/ask", { method: "POST", body: JSON.stringify({ question }) }),
  pageImageUrl: (docId: number, page: number, scale = 2) =>
    `${BASE}/documents/${docId}/page/${page}?scale=${scale}`,
  chunkUrl: (chunkId: number) => `${BASE}/chunks/${chunkId}`,
  documentTextUrl: (docId: number, page: number) => `${BASE}/documents/${docId}/text?page=${page}`,
};
