import React from "react";
import { useAuth } from "@/_core/hooks/useAuth";

/**
 * Appearance: light, dark, or system (match the device). The choice is saved
 * on the account and cached on the device so the first paint already has it.
 */
export type Theme = "light" | "dark" | "system";

const KEY = "ld.theme";
const mq = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null);

export function resolveTheme(t: Theme): "light" | "dark" {
  return t === "system" ? (mq()?.matches ? "dark" : "light") : t;
}

/** Sets the theme on <html> and remembers it on this device. */
export function applyTheme(t: Theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = resolveTheme(t);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolveTheme(t) === "dark" ? "#121715" : "#12211d");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}

export function cachedTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" || t === "system" ? t : "system";
  } catch {
    return "system";
  }
}

/** Keeps <html data-theme> in step with the account's choice and the device's setting. */
export function useTheme() {
  const { user } = useAuth();
  const theme: Theme = (user as { theme?: Theme } | null)?.theme ?? cachedTheme();
  React.useEffect(() => {
    applyTheme(theme);
    const m = mq();
    if (!m || theme !== "system") return;
    const on = () => applyTheme("system");
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [theme]);
  return theme;
}
