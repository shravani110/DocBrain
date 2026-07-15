import type { AppStatus, AskResponse, DocumentRow, Settings } from "./types";
import { getSession, refreshSession } from "./lib/auth";

// In dev, Vite proxies /api to the sidecar. In the packaged Electron app the
// page is served from disk (file://), so we must target the sidecar
// directly. Hosted-mode (Netlify) builds set VITE_API_BASE_URL since the
// frontend and backend live on different origins there.
const BASE = import.meta.env.VITE_API_BASE_URL
  ? `${import.meta.env.VITE_API_BASE_URL.replace(/\/$/, "")}/api`
  : window.location.protocol === "file:"
    ? "http://127.0.0.1:8756/api"
    : "/api";

function authToken(): string | null {
  return getSession()?.access_token ?? null;
}

async function req<T>(path: string, init?: RequestInit, _retried = false): Promise<T> {
  const token = authToken();
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
  });
  if (res.status === 401 && token && !_retried) {
    // Access token likely expired -- one silent refresh attempt before
    // surfacing an error (App.tsx routes to Login if this fails).
    const refreshed = await refreshSession();
    if (refreshed) return req<T>(path, init, true);
  }
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

async function reqForm<T>(path: string, form: FormData): Promise<T> {
  const token = authToken();
  const res = await fetch(BASE + path, {
    method: "POST",
    // No Content-Type here -- the browser must set the multipart boundary.
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
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

// Appended to page-image/chunk/text URLs since those are also consumed by
// <img src="..."> (CitationViewer.tsx), which can't send a custom
// Authorization header -- the backend accepts this as a fallback (see
// backend/app/auth.py::get_current_user).
function authQuery(): string {
  const token = authToken();
  return token ? `token=${encodeURIComponent(token)}` : "";
}

export const api = {
  status: () => req<AppStatus>("/status"),
  settings: () => req<Settings>("/settings"),
  updateSettings: (
    updates: Partial<Settings> & {
      anthropic_api_key?: string;
      openai_api_key?: string;
      gemini_api_key?: string;
    },
  ) => req<Settings>("/settings", { method: "POST", body: JSON.stringify(updates) }),
  documents: () => req<DocumentRow[]>("/documents"),
  uploadDocuments: (files: FileList | File[]) => {
    const form = new FormData();
    Array.from(files).forEach((f) => form.append("files", f));
    return reqForm<{ document_ids: string[] }>("/documents/upload", form);
  },
  retag: (id: number | string, doc_type: string) =>
    req(`/documents/${id}/retag`, { method: "POST", body: JSON.stringify({ doc_type }) }),
  reprocess: (id: number | string) => req(`/documents/${id}/reprocess`, { method: "POST" }),
  deleteDocument: (id: number | string) => req(`/documents/${id}`, { method: "DELETE" }),
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
  pageImageUrl: (docId: number | string, page: number, scale = 2) => {
    const q = authQuery();
    return `${BASE}/documents/${docId}/page/${page}?scale=${scale}${q ? `&${q}` : ""}`;
  },
  chunkUrl: (chunkId: number | string) => {
    const q = authQuery();
    return `${BASE}/chunks/${chunkId}${q ? `?${q}` : ""}`;
  },
  documentTextUrl: (docId: number | string, page: number) => {
    const q = authQuery();
    return `${BASE}/documents/${docId}/text?page=${page}${q ? `&${q}` : ""}`;
  },
};
