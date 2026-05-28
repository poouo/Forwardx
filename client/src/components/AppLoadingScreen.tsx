export default function AppLoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-foreground">
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-xl border border-border/50 bg-card shadow-sm">
          <img src="/logo-light.png" alt="ForwardX" className="h-11 w-11 object-contain" />
        </div>
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
        <p className="text-sm font-medium">加载中</p>
      </div>
    </div>
  );
}
