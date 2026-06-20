import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Database,
  KeyRound,
  Loader2,
  MoveRight,
  RotateCcw,
  Server,
  ShieldCheck,
  Sparkles,
  Trash2,
  UserCog,
  Users,
} from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";

type DatabaseType = "mysql" | "postgresql" | "sqlite";
type SetupMode = "new" | "migrate" | null;

const steps = [
  { id: 1, title: "连接数据库", icon: Database },
  { id: 2, title: "导入旧数据", icon: Sparkles },
  { id: 3, title: "创建管理员", icon: ShieldCheck },
] as const;

function databaseTypeLabel(type: string | null | undefined) {
  if (type === "postgresql") return "PostgreSQL";
  if (type === "mysql") return "MySQL";
  if (type === "sqlite") return "SQLite";
  return "未配置";
}

function databaseConfigSummary(config: any) {
  if (!config?.type) return "";
  if (config.type === "sqlite") return config.sqlite?.path || "";
  const external = config.type === "postgresql" ? config.postgresql : config.mysql;
  if (!external) return "";
  return `${external.user || "-"}@${external.host || "-"}:${external.port || "-"} / ${external.database || "-"}`;
}

function visibleSavedPassword(value: unknown) {
  const text = String(value || "");
  return text === "********" ? "" : text;
}

export default function Setup() {
  const utils = trpc.useUtils();
  const status = trpc.setup.status.useQuery(undefined, { refetchOnWindowFocus: false, retry: false, refetchInterval: 3000 });
  const defaultSqlitePath = status.data?.defaultSqlitePath || "/data/forwardx.db";
  const [step, setStep] = useState(1);
  const [databaseStepReviewed, setDatabaseStepReviewed] = useState(false);
  const [loadedDatabaseConfigKey, setLoadedDatabaseConfigKey] = useState("");
  const [databaseType, setDatabaseType] = useState<DatabaseType>("sqlite");
  const [mode, setMode] = useState<SetupMode>(null);
  const [mysql, setMysql] = useState({
    host: "127.0.0.1",
    port: 3306,
    user: "forwardx",
    password: "",
    database: "forwardx",
    ssl: false,
  });
  const [postgresql, setPostgresql] = useState({
    host: "127.0.0.1",
    port: 5432,
    user: "forwardx",
    password: "",
    database: "forwardx",
    ssl: false,
  });
  const [sqlitePath, setSqlitePath] = useState(defaultSqlitePath);
  const [admin, setAdmin] = useState({ email: "", password: "", name: "" });
  const [migration, setMigration] = useState({ oldPanelUrl: "", migrationCode: "", targetPanelUrl: window.location.origin });
  const [jobId, setJobId] = useState<string | null>(null);

  useEffect(() => {
    if (!sqlitePath || sqlitePath === "/data/forwardx.db") setSqlitePath(defaultSqlitePath);
  }, [defaultSqlitePath, sqlitePath]);

  const databaseConfig = useMemo(
    () =>
      databaseType === "mysql"
        ? { type: "mysql" as const, mysql }
        : databaseType === "postgresql"
          ? { type: "postgresql" as const, postgresql }
        : { type: "sqlite" as const, sqlite: { path: sqlitePath || defaultSqlitePath } },
    [databaseType, defaultSqlitePath, mysql, postgresql, sqlitePath],
  );
  const externalDatabase = databaseType === "postgresql" ? postgresql : mysql;
  const setExternalDatabase = databaseType === "postgresql" ? setPostgresql : setMysql;
  const externalDefaultPort = databaseType === "postgresql" ? 5432 : 3306;

  const data = status.data;
  const configuredDatabase = data?.config as any;
  const configuredDatabaseKey = useMemo(() => JSON.stringify(configuredDatabase || null), [configuredDatabase]);
  const configuredDatabaseType = String(configuredDatabase?.type || data?.databaseType || data?.activeDatabaseType || "");
  const configuredDatabaseLabel = databaseTypeLabel(configuredDatabaseType);
  const configuredDatabaseText = databaseConfigSummary(configuredDatabase);
  const dbReady = !!data?.databaseConnected && !!data?.schemaReady;
  const hasAdmin = !!data?.hasAdmin;
  const hasExistingData = !!data?.hasExistingData;
  const existingData = data?.existingData;

  useEffect(() => {
    if (!configuredDatabase?.type || configuredDatabaseKey === loadedDatabaseConfigKey) return;
    if (configuredDatabase.type === "postgresql" && configuredDatabase.postgresql) {
      setDatabaseType("postgresql");
      setPostgresql({
        host: configuredDatabase.postgresql.host || "127.0.0.1",
        port: Number(configuredDatabase.postgresql.port || 5432),
        user: configuredDatabase.postgresql.user || "forwardx",
        password: visibleSavedPassword(configuredDatabase.postgresql.password),
        database: configuredDatabase.postgresql.database || "forwardx",
        ssl: !!configuredDatabase.postgresql.ssl,
      });
    } else if (configuredDatabase.type === "mysql" && configuredDatabase.mysql) {
      setDatabaseType("mysql");
      setMysql({
        host: configuredDatabase.mysql.host || "127.0.0.1",
        port: Number(configuredDatabase.mysql.port || 3306),
        user: configuredDatabase.mysql.user || "forwardx",
        password: visibleSavedPassword(configuredDatabase.mysql.password),
        database: configuredDatabase.mysql.database || "forwardx",
        ssl: !!configuredDatabase.mysql.ssl,
      });
    } else if (configuredDatabase.type === "sqlite") {
      setDatabaseType("sqlite");
      setSqlitePath(configuredDatabase.sqlite?.path || defaultSqlitePath);
    }
    setLoadedDatabaseConfigKey(configuredDatabaseKey);
  }, [configuredDatabase, configuredDatabaseKey, defaultSqlitePath, loadedDatabaseConfigKey]);

  const databaseConfigMatchesSaved = useMemo(() => {
    if (!configuredDatabase?.type || configuredDatabase.type !== databaseType) return false;
    if (databaseType === "sqlite") {
      return String(configuredDatabase.sqlite?.path || defaultSqlitePath) === String(sqlitePath || defaultSqlitePath);
    }
    const saved = configuredDatabase.type === "postgresql" ? configuredDatabase.postgresql : configuredDatabase.mysql;
    const current = databaseType === "postgresql" ? postgresql : mysql;
    if (!saved) return false;
    return String(saved.host || "") === current.host.trim()
      && Number(saved.port || (databaseType === "postgresql" ? 5432 : 3306)) === Number(current.port || (databaseType === "postgresql" ? 5432 : 3306))
      && String(saved.user || "") === current.user.trim()
      && String(saved.database || "") === current.database.trim()
      && !!saved.ssl === !!current.ssl;
  }, [configuredDatabase, databaseType, defaultSqlitePath, mysql, postgresql, sqlitePath]);

  const canContinueWithSavedDatabase = dbReady
    && !!data?.databaseConfigured
    && databaseConfigMatchesSaved
    && (databaseType === "sqlite" || !externalDatabase.password.trim());

  useEffect(() => {
    if (!databaseStepReviewed && dbReady && step === 1 && status.data?.databaseConfigured) setStep(2);
  }, [databaseStepReviewed, dbReady, status.data?.databaseConfigured, step]);

  const saveDatabase = trpc.setup.saveDatabase.useMutation({
    onSuccess: async (next) => {
      await utils.setup.status.invalidate();
      if (next?.needsRestart) {
        toast.info("数据库类型已保存，服务正在重启，请稍后刷新页面");
        return;
      }
      toast.success("数据库已初始化");
      setStep(2);
    },
    onError: (error) => toast.error(error.message || "数据库连接失败"),
  });

  const createAdmin = trpc.setup.createAdmin.useMutation({
    onSuccess: async () => {
      toast.success("管理员账户已创建，请登录");
      await utils.setup.status.invalidate();
      window.location.href = "/login";
    },
    onError: (error) => toast.error(error.message || "创建管理员失败"),
  });

  const updateAdmin = trpc.setup.updateAdmin.useMutation({
    onSuccess: async () => {
      toast.success("管理员账户已更新，请登录");
      await utils.setup.status.invalidate();
      window.location.href = "/login";
    },
    onError: (error) => toast.error(error.message || "更新管理员失败"),
  });

  const startMigration = trpc.setup.startMigration.useMutation({
    onSuccess: (job) => {
      setJobId(job.id);
      toast.success("迁移任务已开始");
    },
    onError: (error) => toast.error(error.message || "启动迁移失败"),
  });

  const useExistingData = trpc.setup.useExistingData.useMutation({
    onSuccess: async () => {
      toast.success("已选择使用以前的数据");
      await utils.setup.status.invalidate();
      window.location.href = "/login";
    },
    onError: (error) => toast.error(error.message || "使用旧数据失败"),
  });

  const resetExistingData = trpc.setup.resetExistingData.useMutation({
    onSuccess: async () => {
      toast.success("旧数据已清空，请创建新管理员");
      await utils.setup.status.invalidate();
      setMode("new");
      setStep(3);
    },
    onError: (error) => toast.error(error.message || "清空旧数据失败"),
  });

  const migrationStatus = trpc.setup.migrationStatus.useQuery(
    { jobId: jobId || "" },
    { enabled: !!jobId, refetchInterval: (query) => (query.state.data?.status === "success" || query.state.data?.status === "failed" ? false : 1200) },
  );

  useEffect(() => {
    if (migrationStatus.data?.status === "success") {
      toast.success("迁移完成，请使用旧面板账户登录");
      setTimeout(() => {
        window.location.href = "/login";
      }, 1000);
    }
    if (migrationStatus.data?.status === "failed") {
      toast.error(migrationStatus.data.error || "迁移失败");
    }
  }, [migrationStatus.data?.status, migrationStatus.data?.error]);

  const handleDatabaseNext = () => {
    if (canContinueWithSavedDatabase) {
      setDatabaseStepReviewed(false);
      setStep(2);
      return;
    }
    saveDatabase.mutate(databaseConfig);
  };

  const handleReviewDatabaseStep = () => {
    setDatabaseStepReviewed(true);
    setStep(1);
  };

  const handleModeNext = () => {
    if (!mode) {
      toast.error("请选择新面板或迁移旧数据");
      return;
    }
    if (mode === "migrate") {
      if (!migration.oldPanelUrl.trim() || !migration.migrationCode.trim()) {
        toast.error("请输入旧面板地址和迁移码");
        return;
      }
      startMigration.mutate(migration);
      return;
    }
    if (hasExistingData && hasAdmin && data?.setupDataChoice !== "new-panel") {
      toast.info("检测到当前数据库已有业务数据，请先选择使用旧数据或清空后新建");
      return;
    }
    setStep(3);
  };

  const handleAdminSubmit = () => {
    if (!admin.email.trim()) {
      toast.error("请输入管理员邮箱");
      return;
    }
    if (!hasAdmin && !admin.password.trim()) {
      toast.error("请输入管理员密码");
      return;
    }
    if (hasAdmin) {
      updateAdmin.mutate({
        email: admin.email.trim(),
        password: admin.password.trim() || undefined,
        name: admin.name.trim() || undefined,
      });
    } else {
      createAdmin.mutate({
        email: admin.email.trim(),
        password: admin.password,
        name: admin.name.trim() || undefined,
      });
    }
  };

  return (
    <div className="min-h-screen bg-[linear-gradient(135deg,#f8fbff_0%,#eef7f3_45%,#fff8ed_100%)] px-4 py-8 text-foreground">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <div className="text-center">
          <img src="/logo-light.png" alt="ForwardX" className="mx-auto h-14 w-14 object-contain dark:hidden" />
          <img src="/logo-dark.png" alt="ForwardX" className="mx-auto hidden h-14 w-14 object-contain dark:block" />
          <h1 className="mt-4 text-2xl font-semibold tracking-tight">ForwardX 首次部署</h1>
          <p className="mt-2 text-sm text-muted-foreground">按步骤完成数据库初始化、旧面板迁移和管理员配置。</p>
        </div>

        <div className="rounded-lg border border-white/70 bg-white/75 p-4 shadow-lg shadow-slate-200/60 backdrop-blur-xl">
          <div className="grid gap-3 sm:grid-cols-3">
            {steps.map((item) => {
              const Icon = item.icon;
              const active = step === item.id;
              const done = step > item.id || (item.id === 1 && dbReady) || (item.id === 3 && hasAdmin && step > 2);
              return (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 rounded-md border px-3 py-2 transition-all duration-300 ${
                    active ? "border-primary/40 bg-primary/10 text-primary" : done ? "border-emerald-500/25 bg-emerald-50 text-emerald-700" : "border-border/50 bg-white/60 text-muted-foreground"
                  }`}
                >
                  <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${done ? "bg-emerald-600 text-white" : active ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                    {done ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs">步骤 {item.id}</p>
                    <p className="truncate text-sm font-medium">{item.title}</p>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {data?.error && (
          <Alert variant={data.needsRestart ? "default" : "destructive"}>
            <AlertTitle>{data.needsRestart ? "等待服务重启" : "数据库连接异常"}</AlertTitle>
            <AlertDescription>{data.error}</AlertDescription>
          </Alert>
        )}

        <div className="overflow-hidden">
          <div className="transition-all duration-300 ease-out" key={step}>
            {step === 1 && (
              <Card className="border-white/70 bg-white/85 shadow-xl shadow-slate-200/60 backdrop-blur-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Database className="h-4 w-4" />
                    连接数据库
                  </CardTitle>
                  <CardDescription>选择数据库并初始化。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5">
                  <div className="grid gap-3 sm:grid-cols-3">
                    {(["sqlite", "mysql", "postgresql"] as DatabaseType[]).map((type) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setDatabaseType(type)}
                        className={`rounded-lg border p-4 text-left transition ${databaseType === type ? "border-primary/50 bg-primary/10 shadow-sm" : "border-border bg-white/70 hover:border-primary/30"}`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="font-semibold">
                            {type === "sqlite" ? "SQLite 本地数据库" : type === "mysql" ? "MySQL 外部数据库" : "PostgreSQL 外部数据库"}
                          </div>
                          {databaseType === type && <CheckCircle2 className="h-4 w-4 text-primary" />}
                        </div>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {type === "sqlite" ? "适合单机部署。" : type === "mysql" ? "适合现有 MySQL 环境。" : "适合 PostgreSQL 环境。"}
                        </p>
                      </button>
                    ))}
                  </div>

                  <Alert className="border-sky-500/25 bg-sky-50/80 text-sky-950">
                    <Database className="h-4 w-4 text-sky-700" />
                    <AlertTitle>数据库版本要求</AlertTitle>
                    <AlertDescription>
                      MySQL 需要 8.0.13 或以上版本；PostgreSQL 建议 12 或以上版本；SQLite 使用本地数据文件，无需额外准备数据库服务。
                    </AlertDescription>
                  </Alert>

                  {dbReady && data?.databaseConfigured && (
                    <Alert className="border-emerald-500/25 bg-emerald-50/80 text-emerald-950">
                      <Database className="h-4 w-4 text-emerald-700" />
                      <AlertTitle>当前已连接 {configuredDatabaseLabel} 数据库</AlertTitle>
                      <AlertDescription>
                        {configuredDatabaseText || "数据库连接正常。"} 如需修改数据库配置，请选择新的数据库类型并重新保存。
                      </AlertDescription>
                    </Alert>
                  )}

                  {databaseType === "sqlite" ? (
                    <div className="space-y-2">
                      <Label>SQLite 数据文件</Label>
                      <Input value={sqlitePath} onChange={(e) => setSqlitePath(e.target.value)} placeholder={defaultSqlitePath} />
                    </div>
                  ) : (
                    <div className="grid gap-4">
                      <div className="grid gap-4 sm:grid-cols-[1fr_120px]">
                        <div className="space-y-2">
                          <Label>地址</Label>
                          <Input value={externalDatabase.host} onChange={(e) => setExternalDatabase({ ...externalDatabase, host: e.target.value })} placeholder="127.0.0.1" />
                        </div>
                        <div className="space-y-2">
                          <Label>端口</Label>
                          <Input type="number" min={1} max={65535} value={externalDatabase.port} onChange={(e) => setExternalDatabase({ ...externalDatabase, port: Number(e.target.value || externalDefaultPort) })} />
                        </div>
                      </div>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>数据库名</Label>
                          <Input value={externalDatabase.database} onChange={(e) => setExternalDatabase({ ...externalDatabase, database: e.target.value })} />
                        </div>
                        <div className="space-y-2">
                          <Label>用户名</Label>
                          <Input value={externalDatabase.user} onChange={(e) => setExternalDatabase({ ...externalDatabase, user: e.target.value })} />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>密码</Label>
                        <Input type="password" value={externalDatabase.password} onChange={(e) => setExternalDatabase({ ...externalDatabase, password: e.target.value })} />
                      </div>
                      <div className="flex items-center justify-between rounded-md border border-border/50 bg-white/70 p-3">
                        <div>
                          <p className="text-sm font-medium">启用 SSL</p>
                          <p className="text-xs text-muted-foreground">远程数据库或云数据库可按需开启。</p>
                        </div>
                        <Switch checked={externalDatabase.ssl} onCheckedChange={(ssl) => setExternalDatabase({ ...externalDatabase, ssl })} />
                      </div>
                    </div>
                  )}

                  <div className="flex justify-end">
                    <Button disabled={saveDatabase.isPending} onClick={handleDatabaseNext}>
                      {saveDatabase.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      {canContinueWithSavedDatabase ? "继续下一步" : "保存并连接"}
                      {!saveDatabase.isPending && <ArrowRight className="ml-2 h-4 w-4" />}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {step === 2 && (
              <Card className="border-white/70 bg-white/85 shadow-xl shadow-slate-200/60 backdrop-blur-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Sparkles className="h-4 w-4" />
                    新面板或旧数据迁移
                  </CardTitle>
                  <CardDescription>新建面板或导入旧数据。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-5">
                  {dbReady && data?.databaseConfigured && (
                    <div className="flex flex-col gap-3 rounded-lg border border-emerald-500/25 bg-emerald-50/80 p-4 text-sm sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 font-medium text-emerald-800">
                          <CheckCircle2 className="h-4 w-4 shrink-0" />
                          已连接 {configuredDatabaseLabel} 数据库
                        </div>
                        {configuredDatabaseText && (
                          <p className="mt-1 truncate text-xs text-emerald-700/80" title={configuredDatabaseText}>
                            {configuredDatabaseText}
                          </p>
                        )}
                      </div>
                      <Button variant="outline" size="sm" className="shrink-0 bg-white/70" onClick={handleReviewDatabaseStep}>
                        查看或修改数据库
                      </Button>
                    </div>
                  )}

                  {hasExistingData && hasAdmin && data?.setupDataChoice !== "new-panel" && (
                    <div className="grid gap-4 rounded-lg border border-amber-500/30 bg-amber-50/80 p-4">
                      <Alert className="border-amber-500/30 bg-white/70">
                        <ShieldCheck className="h-4 w-4" />
                        <AlertTitle>检测到当前数据库已有面板业务数据</AlertTitle>
                        <AlertDescription>
                          当前数据库已有主机、规则、隧道、订单或其他业务数据。
                        </AlertDescription>
                      </Alert>
                      <div className="grid gap-3 sm:grid-cols-4">
                        <div className="rounded-md border bg-white/70 p-3">
                          <Users className="h-4 w-4 text-primary" />
                          <p className="mt-2 text-xs text-muted-foreground">用户</p>
                          <p className="text-lg font-semibold">{existingData?.userCount ?? 0}</p>
                        </div>
                        <div className="rounded-md border bg-white/70 p-3">
                          <Server className="h-4 w-4 text-primary" />
                          <p className="mt-2 text-xs text-muted-foreground">主机</p>
                          <p className="text-lg font-semibold">{existingData?.hostCount ?? 0}</p>
                        </div>
                        <div className="rounded-md border bg-white/70 p-3">
                          <Sparkles className="h-4 w-4 text-primary" />
                          <p className="mt-2 text-xs text-muted-foreground">规则</p>
                          <p className="text-lg font-semibold">{existingData?.ruleCount ?? 0}</p>
                        </div>
                        <div className="rounded-md border bg-white/70 p-3">
                          <KeyRound className="h-4 w-4 text-primary" />
                          <p className="mt-2 text-xs text-muted-foreground">隧道</p>
                          <p className="text-lg font-semibold">{existingData?.tunnelCount ?? 0}</p>
                        </div>
                      </div>
                      <div className="flex flex-col gap-3 sm:flex-row">
                        <Button disabled={useExistingData.isPending} onClick={() => useExistingData.mutate()}>
                          {useExistingData.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          使用以前的数据
                        </Button>
                        <Button
                          variant="destructive"
                          disabled={resetExistingData.isPending}
                          onClick={() => {
                            if (confirm("确定要清空当前数据库中的 ForwardX 面板数据，并作为新面板重新初始化吗？")) {
                              resetExistingData.mutate();
                            }
                          }}
                        >
                          {resetExistingData.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}
                          清空并作为新面板
                        </Button>
                      </div>
                    </div>
                  )}

                  <div className="grid gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      disabled={hasExistingData && hasAdmin && data?.setupDataChoice !== "new-panel"}
                      onClick={() => setMode("new")}
                      className={`rounded-lg border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === "new" ? "border-emerald-500/50 bg-emerald-50" : "border-border bg-white/70 hover:border-emerald-400/40"}`}
                    >
                      <div className="font-semibold">作为新面板使用</div>
                      <p className="mt-2 text-sm text-muted-foreground">不导入旧数据。</p>
                    </button>
                    <button type="button" onClick={() => setMode("migrate")} className={`rounded-lg border p-4 text-left transition ${mode === "migrate" ? "border-primary/50 bg-primary/10" : "border-border bg-white/70 hover:border-primary/30"}`}>
                      <div className="font-semibold">从旧面板导入数据</div>
                      <p className="mt-2 text-sm text-muted-foreground">使用旧面板迁移码导入。</p>
                    </button>
                  </div>

                  {mode === "migrate" && (
                    <div className="grid gap-4 rounded-lg border bg-white/70 p-4">
                      <Alert>
                        <KeyRound className="h-4 w-4" />
                        <AlertTitle>迁移码规则</AlertTitle>
                        <AlertDescription>迁移码 5 分钟有效，使用后失效。</AlertDescription>
                      </Alert>
                      <Alert className="border-sky-500/25 bg-sky-50/80 text-sky-950">
                        <Database className="h-4 w-4 text-sky-700" />
                        <AlertTitle>迁移前请确认数据库版本</AlertTitle>
                        <AlertDescription>
                          新面板连接 MySQL 时需要 8.0.13 或以上版本；连接 PostgreSQL 时建议 12 或以上版本。
                        </AlertDescription>
                      </Alert>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div className="space-y-2">
                          <Label>旧面板地址</Label>
                          <Input value={migration.oldPanelUrl} onChange={(e) => setMigration({ ...migration, oldPanelUrl: e.target.value })} placeholder="http://旧IP:3000 或 https://panel.example.com" />
                        </div>
                        <div className="space-y-2">
                          <Label>旧面板迁移码</Label>
                          <Input value={migration.migrationCode} onChange={(e) => setMigration({ ...migration, migrationCode: e.target.value.toUpperCase() })} placeholder="24 位迁移码" />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Label>新面板访问地址</Label>
                        <Input value={migration.targetPanelUrl} onChange={(e) => setMigration({ ...migration, targetPanelUrl: e.target.value })} />
                      </div>
                      {migrationStatus.data && (
                        <div className="rounded-lg border border-primary/15 bg-primary/5 p-4">
                          <div className="flex items-center justify-between text-sm">
                            <span className="font-medium">{migrationStatus.data.step}</span>
                            <span>{migrationStatus.data.progress}%</span>
                          </div>
                          <Progress value={migrationStatus.data.progress} className="mt-3" />
                          <div className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                            {migrationStatus.data.status === "running" && <RotateCcw className="h-3.5 w-3.5 animate-spin" />}
                            {migrationStatus.data.status === "success" && <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />}
                            {migrationStatus.data.error || "迁移中，请保持新旧面板可访问。"}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex justify-between">
                    <Button variant="outline" onClick={handleReviewDatabaseStep}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      上一步
                    </Button>
                    <Button disabled={startMigration.isPending || !!jobId} onClick={handleModeNext}>
                      {startMigration.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : mode === "migrate" ? <MoveRight className="mr-2 h-4 w-4" /> : null}
                      {mode === "migrate" ? "开始迁移" : "下一步"}
                      {mode !== "migrate" && <ArrowRight className="ml-2 h-4 w-4" />}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {step === 3 && (
              <Card className="border-white/70 bg-white/85 shadow-xl shadow-slate-200/60 backdrop-blur-xl">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <UserCog className="h-4 w-4" />
                    {hasAdmin ? "确认管理员账户" : "创建管理员账户"}
                  </CardTitle>
                  <CardDescription>
                    {hasAdmin ? "确认管理员账户。" : "创建初始管理员。"}
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4">
                  {hasAdmin && (
                    <Alert>
                      <ShieldCheck className="h-4 w-4" />
                      <AlertTitle>已存在管理员账户</AlertTitle>
                      <AlertDescription>如果不需要更改管理员信息，可以直接前往登录页。</AlertDescription>
                    </Alert>
                  )}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label>管理员邮箱</Label>
                      <Input type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} placeholder="admin@example.com" />
                    </div>
                    <div className="space-y-2">
                      <Label>显示名称</Label>
                      <Input value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} placeholder="管理员" />
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>{hasAdmin ? "新密码（留空不修改）" : "密码"}</Label>
                    <Input type="password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} placeholder="至少 8 位" />
                  </div>
                  <div className="flex flex-col gap-3 sm:flex-row sm:justify-between">
                    <Button variant="outline" onClick={() => setStep(2)}>
                      <ArrowLeft className="mr-2 h-4 w-4" />
                      上一步
                    </Button>
                    <div className="flex flex-col gap-3 sm:flex-row">
                      {hasAdmin && (
                        <Button variant="outline" onClick={() => { window.location.href = "/login"; }}>
                          直接登录
                        </Button>
                      )}
                      <Button disabled={createAdmin.isPending || updateAdmin.isPending} onClick={handleAdminSubmit}>
                        {(createAdmin.isPending || updateAdmin.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        {hasAdmin ? "保存并登录" : "创建并登录"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
