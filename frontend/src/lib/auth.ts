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

// --- Google Sign-In ------------------------------------------------------
//
// Uses Google Identity Services (a small, official Google script -- not the
// full Firebase JS SDK) to get a Google ID token, then exchanges it for a
// Firebase session via Identity Toolkit's accounts:signInWithIdp, the same
// REST endpoint family as signUp/signInWithPassword above. Loaded lazily
// (only when Login.tsx actually renders the Google button, which only
// happens in hosted mode) so the local desktop build's index.html makes
// zero external network requests, matching its "fully local" design.

declare global {
  interface Window {
    google?: {
      accounts: {
        id: {
          initialize: (config: {
            client_id: string;
            callback: (response: { credential?: string }) => void;
          }) => void;
          renderButton: (parent: HTMLElement, options: Record<string, unknown>) => void;
        };
      };
    };
  }
}

let googleScriptPromise: Promise<void> | null = null;

function loadGoogleScript(): Promise<void> {
  if (googleScriptPromise) return googleScriptPromise;
  googleScriptPromise = new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load Google Sign-In script."));
    document.head.appendChild(script);
  });
  return googleScriptPromise;
}

function googleClientId(): string {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!id) throw new Error("VITE_GOOGLE_CLIENT_ID is not configured.");
  return id;
}

async function signInWithGoogleCredential(googleIdToken: string): Promise<Session> {
  const data = await identityToolkitFetch("signInWithIdp", {
    postBody: `id_token=${googleIdToken}&providerId=google.com`,
    requestUri: window.location.origin,
  });
  const session = toSession(data);
  setSession(session);
  return session;
}

/** Renders Google's own "Sign in with Google" button into `container`
 * (Google's real button, not a custom-styled one -- more reliable than
 * triggering the One Tap prompt from an arbitrary click handler, and users
 * trust Google's own button styling for OAuth). Calls onSuccess/onError as
 * the user completes (or fails/cancels) the flow. */
export async function renderGoogleButton(
  container: HTMLElement,
  onSuccess: (session: Session) => void,
  onError: (message: string) => void,
): Promise<void> {
  try {
    await loadGoogleScript();
    window.google!.accounts.id.initialize({
      client_id: googleClientId(),
      callback: async (response) => {
        if (!response.credential) {
          onError("Google sign-in was cancelled.");
          return;
        }
        try {
          onSuccess(await signInWithGoogleCredential(response.credential));
        } catch (e) {
          onError((e as Error).message);
        }
      },
    });
    window.google!.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      width: 336,
      text: "continue_with",
    });
  } catch (e) {
    onError((e as Error).message);
  }
}
