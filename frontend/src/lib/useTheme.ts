import { useCallback, useEffect, useState } from "react";

type Theme = "light" | "dark" | "system";

const STORAGE_KEY = "docbrain-theme";

function getSystemTheme(): "light" | "dark" {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyTheme(resolved: "light" | "dark") {
  if (resolved === "dark") {
    document.documentElement.classList.add("dark");
  } else {
    document.documentElement.classList.remove("dark");
  }
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => {
    const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
    return stored ?? "system";
  });

  const resolved = theme === "system" ? getSystemTheme() : theme;
  const isDark = resolved === "dark";

  useEffect(() => {
    applyTheme(resolved);
  }, [resolved]);

  // Listen for system preference changes when in system mode
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => applyTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  const setAndStore = useCallback((t: Theme) => {
    setTheme(t);
    if (t === "system") {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, t);
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setAndStore(isDark ? "light" : "dark");
  }, [isDark, setAndStore]);

  return { theme, setTheme: setAndStore, toggleTheme, isDark };
}
