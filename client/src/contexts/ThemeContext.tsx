import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { flushSync } from "react-dom";

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

type ViewTransitionDocument = Document & {
  startViewTransition?: (updateCallback: () => void) => {
    finished: Promise<void>;
    ready: Promise<void>;
    updateCallbackDone: Promise<void>;
    skipTransition: () => void;
  };
};

function getResolvedTheme(theme: Theme): "dark" | "light" {
  if (theme === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return theme;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function ThemeProvider({
  children,
  defaultTheme = "light",
  storageKey = "forwardx-theme",
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(storageKey) as Theme) || defaultTheme
  );

  const resolvedTheme = getResolvedTheme(theme);

  useLayoutEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(resolvedTheme);
  }, [resolvedTheme]);

  const setTheme = useCallback((newTheme: Theme) => {
    if (newTheme === theme) return;
    localStorage.setItem(storageKey, newTheme);

    const transitionDocument = document as ViewTransitionDocument;
    if (!transitionDocument.startViewTransition || prefersReducedMotion()) {
      setThemeState(newTheme);
      return;
    }

    transitionDocument.startViewTransition(() => {
      flushSync(() => {
        setThemeState(newTheme);
      });
    });
  }, [storageKey, theme]);

  const value = useMemo(() => ({
    theme,
    resolvedTheme,
    setTheme,
  }), [resolvedTheme, setTheme, theme]);

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
