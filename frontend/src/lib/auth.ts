// Plain fetch against Firebase's Identity Toolkit / Secure Token REST APIs --
// no SDK, matching the rest of this app's "raw fetch, no client libraries"
// style (see api.ts). This only needs sign-up/sign-in/refresh/sign-out/
// session-read; pulling in the Firebase JS SDK would add real-time/session
// machinery and bundle weight for a handful of well-documented REST calls.

const STORAGE_KEY = "docbrain-auth";

export interface Session {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  user: { id: string; email: string };
}

function apiKey(): string {
  const key = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  if (!key) throw new Error("VITE_FIREBASE_API_KEY is not configured.");
  return key;
}

export function getSession(): Session | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

function setSession(session: Session | null): void {
  if (session) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } else {
    localStorage.removeItem(STORAGE_KEY);
  }
}

// accounts:signUp / accounts:signInWithPassword -- response fields are
// camelCase (idToken, refreshToken, expiresIn, localId), verified live.
async function identityToolkitFetch(method: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${apiKey()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, returnSecureToken: true }),
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || "Authentication failed.");
  }
  return data;
}

function toSession(body: any, fallbackEmail?: string): Session {
  return {
    access_token: body.idToken,
    refresh_token: body.refreshToken,
    expires_at: Math.floor(Date.now() / 1000) + Number(body.expiresIn ?? 3600),
    user: { id: body.localId, email: body.email ?? fallbackEmail ?? "" },
  };
}

export async function signUp(email: string, password: string): Promise<Session | null> {
  const data = await identityToolkitFetch("signUp", { email, password });
  // Firebase issues a usable idToken immediately regardless of email
  // verification status -- unlike a Supabase project with "confirm email"
  // on, this branch won't trigger unless email-verification enforcement is
  // added separately (not part of this MVP).
  if (!data.idToken) return null;
  const session = toSession(data);
  setSession(session);
  return session;
}

export async function signIn(email: string, password: string): Promise<Session> {
  const data = await identityToolkitFetch("signInWithPassword", { email, password });
  const session = toSession(data);
  setSession(session);
  return session;
}

export async function refreshSession(): Promise<Session | null> {
  const current = getSession();
  if (!current?.refresh_token) return null;
  try {
    // securetoken.googleapis.com uses snake_case response fields
    // (id_token/refresh_token/expires_in/user_id) -- a DIFFERENT casing
    // convention than the Identity Toolkit endpoints above, verified live.
    // It also doesn't return the email, so the cached one is reused.
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${apiKey()}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error?.message || "Refresh failed.");
    }
    const session: Session = {
      access_token: data.id_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + Number(data.expires_in ?? 3600),
      user: { id: data.user_id, email: current.user.email },
    };
    setSession(session);
    return session;
  } catch {
    setSession(null);
    return null;
  }
}

export function signOut(): void {
  setSession(null);
}
