export function DashboardLayoutSkeleton() {
  return (
    <div className="flex min-h-screen bg-background">
      <div className="w-64 border-r bg-card animate-pulse" />
      <div className="flex-1 p-6">
        <div className="space-y-4">
          <div className="h-8 w-48 bg-muted rounded animate-pulse" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 bg-muted rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
