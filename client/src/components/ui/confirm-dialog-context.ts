import { createContext, useContext, type ReactNode } from "react";

type ConfirmTone = "default" | "destructive";

export type ConfirmOptions = {
  title?: string;
  description: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
};

// Keep context identity independent of translated UI modules. During Fast
// Refresh an existing provider and a refreshed consumer must use the same
// context, even when the dialog or its translation catalog is re-evaluated.
export const ConfirmDialogContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) {
    throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  }
  return confirm;
}
