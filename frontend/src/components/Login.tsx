import { useEffect, useRef, useState } from "react";
import * as auth from "../lib/auth";

export default function Login({ onAuthenticated }: { onAuthenticated: () => void }) {
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const googleButtonRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!googleButtonRef.current) return;
    auth.renderGoogleButton(
      googleButtonRef.current,
      () => onAuthenticated(),
      (message) => setError(message),
    );
    // Intentionally runs once -- Google's button is rendered into the div
    // directly by the script, not re-rendered on every keystroke/mode toggle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setBusy(true);
    setError(null);
    setCheckEmail(false);
    try {
      if (mode === "signup") {
        const session = await auth.signUp(email.trim(), password);
        if (!session) {
          setCheckEmail(true);
          return;
        }
      } else {
        await auth.signIn(email.trim(), password);
      }
      onAuthenticated();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center bg-app p-6">
      <div className="max-w-md w-full glass-card p-8 space-y-6 animate-scale-in relative overflow-hidden">
        <div className="absolute -top-20 -right-20 w-40 h-40 bg-gradient-brand rounded-full opacity-20 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-16 -left-16 w-32 h-32 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full opacity-10 blur-3xl pointer-events-none" />

        <div className="relative">
          <div className="w-14 h-14 rounded-2xl bg-gradient-brand flex items-center justify-center text-white text-2xl shadow-glow mb-4">
            ◈
          </div>
          <h1 className="text-2xl font-bold" style={{ color: "rgb(var(--color-text))" }}>
            {mode === "signin" ? "Welcome back to" : "Create your"}{" "}
            <span className="gradient-text">DocBrain</span>
          </h1>
          <p className="mt-2 text-sm leading-relaxed" style={{ color: "rgb(var(--color-text-secondary))" }}>
            Sign in to access your own private document library and chat history &mdash;
            only you can see what you upload.
          </p>
        </div>

        <div className="relative flex justify-center">
          <div ref={googleButtonRef} />
        </div>

        <div className="relative flex items-center gap-3">
          <div className="h-px flex-1" style={{ background: "rgb(var(--color-border))" }} />
          <span className="text-xs" style={{ color: "rgb(var(--color-text-muted))" }}>or</span>
          <div className="h-px flex-1" style={{ background: "rgb(var(--color-border))" }} />
        </div>

        <form onSubmit={submit} className="relative space-y-3">
          <div>
            <label className="text-sm font-medium" style={{ color: "rgb(var(--color-text))" }}>
              Email
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              className="input-field w-full mt-1"
              required
            />
          </div>
          <div>
            <label className="text-sm font-medium" style={{ color: "rgb(var(--color-text))" }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === "signup" ? "At least 6 characters" : "••••••••"}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              className="input-field w-full mt-1"
              required
              minLength={6}
            />
          </div>

          {error && (
            <p className="text-sm text-rose-500 dark:text-rose-400 animate-fade-in">{error}</p>
          )}
          {checkEmail && (
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 animate-slide-up">
              <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
              Check your email to confirm your account, then sign in.
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full">
            {mode === "signin" ? "Sign in" : "Sign up"}
          </button>
        </form>

        <div className="relative text-center">
          <button
            onClick={() => {
              setMode(mode === "signin" ? "signup" : "signin");
              setError(null);
              setCheckEmail(false);
            }}
            className="text-sm btn-ghost"
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </div>
      </div>
    </div>
  );
}
