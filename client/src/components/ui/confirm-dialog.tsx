import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type ConfirmTone = "default" | "destructive";

type ConfirmOptions = {
  title?: string;
  description: ReactNode;
  confirmText?: string;
  cancelText?: string;
  tone?: ConfirmTone;
};

type PendingConfirm = Required<Pick<ConfirmOptions, "title" | "confirmText" | "cancelText" | "tone">> & {
  description: ReactNode;
  resolve: (confirmed: boolean) => void;
};

const ConfirmDialogContext = createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(null);

const DEFAULT_CONFIRM_TITLE = "确认操作";

export function ConfirmDialogProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const pendingRef = useRef<PendingConfirm | null>(null);

  const close = useCallback((confirmed: boolean) => {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    current?.resolve(confirmed);
  }, []);

  const confirm = useCallback((options: ConfirmOptions) => {
    pendingRef.current?.resolve(false);
    return new Promise<boolean>((resolve) => {
      const next: PendingConfirm = {
        title: options.title || DEFAULT_CONFIRM_TITLE,
        description: options.description,
        confirmText: options.confirmText || "确认",
        cancelText: options.cancelText || "取消",
        tone: options.tone || "default",
        resolve,
      };
      pendingRef.current = next;
      setPending(next);
    });
  }, []);

  const contextValue = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmDialogContext.Provider value={contextValue}>
      {children}
      <Dialog open={!!pending} onOpenChange={(open) => { if (!open) close(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader className="gap-3 pr-8">
            <div className={`flex h-10 w-10 items-center justify-center rounded-md ${
              pending?.tone === "destructive"
                ? "bg-destructive/10 text-destructive"
                : "bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }`}>
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div className="space-y-1.5 text-left">
              <DialogTitle>{pending?.title || DEFAULT_CONFIRM_TITLE}</DialogTitle>
              <DialogDescription asChild>
                <div className="text-sm leading-6 text-muted-foreground">{pending?.description}</div>
              </DialogDescription>
            </div>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => close(false)}>{pending?.cancelText || "取消"}</Button>
            <Button
              variant={pending?.tone === "destructive" ? "destructive" : "default"}
              onClick={() => close(true)}
            >
              {pending?.confirmText || "确认"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmDialogContext.Provider>
  );
}

export function useConfirmDialog() {
  const confirm = useContext(ConfirmDialogContext);
  if (!confirm) {
    throw new Error("useConfirmDialog must be used within ConfirmDialogProvider");
  }
  return confirm;
}
