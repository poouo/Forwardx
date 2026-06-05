import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from "react";

type Theme = "dark" | "light" | "system";

interface ThemeProviderProps {
  children: ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
}

interface ThemeProviderState {
  theme: Theme;
  resolvedTheme: "dark" | "light";
  setTheme: (theme: Theme) => void;
}

const ThemeProviderContext = createContext<ThemeProviderState>({
  theme: "light",
  resolvedTheme: "light",
  setTheme: () => null,
});

const THEME_TRANSITION_CLASS = "theme-transitioning";
const THEME_TRANSITION_MS = 760;

function getResolvedTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  storageKey = "forwardx-theme",
}: ThemeProviderProps) {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  );

  const resolvedTheme = getResolvedTheme(theme);

  useLayoutEffect(() => {
    const root = window.document.documentElement;
    const appliedTheme = root.classList.contains("dark")
      ? "dark"
      : root.classList.contains("light")
        ? "light"
        : null;
    const shouldAnimate =
      appliedTheme !== null &&
      appliedTheme !== resolvedTheme &&
      !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let transitionTimer: number | undefined;

    if (shouldAnimate) {
      root.classList.add(THEME_TRANSITION_CLASS);
      transitionTimer = window.setTimeout(() => {
        root.classList.remove(THEME_TRANSITION_CLASS);
      }, THEME_TRANSITION_MS);
    }

    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);

    return () => {
      if (transitionTimer !== undefined) {
        window.clearTimeout(transitionTimer);
      }
      root.classList.remove(THEME_TRANSITION_CLASS);
    };
  }, [resolvedTheme]);

  const value = {
    theme,
    resolvedTheme,
    setTheme: (newTheme: Theme) => {
      localStorage.setItem(storageKey, newTheme);
      setTheme(newTheme);
    },
  };

  return (
    <ThemeProviderContext.Provider value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);
  if (context === undefined) throw new Error("useTheme must be used within a ThemeProvider");
  return context;
};
