import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Download,
  Gauge,
  Loader2,
  TriangleAlert,
} from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { toast } from "@/lib/localizedToast";
import { trpc } from "@/lib/trpc";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { useAuth } from "@/_core/hooks/useAuth";
import { useMotionEnabled } from "@/components/MotionPolicy";
import {
  LINK_SPEED_DOWNLOAD_COLOR,
  LINK_SPEED_UPLOAD_COLOR,
  LinkSpeedGauge,
} from "@/components/LinkSpeedGauge";
import { gaugeStops, peakOfSamples } from "@/lib/linkSpeedGauge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  segmentedControlClassName,
  segmentedOptionClassName,
} from "@/components/ui/segmented";
import {
  linkSpeedActive,
  type LinkSpeedDirection,
  type LinkSpeedMeasurement,
  type LinkSpeedStatus,
} from "@shared/linkSpeed";

const DIRECTION_COLOR: Record<LinkSpeedDirection, string> = {
  upload: LINK_SPEED_UPLOAD_COLOR,
  download: LINK_SPEED_DOWNLOAD_COLOR,
};

function bytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}
function rate(value?: number) {
  return `${(value || 0).toFixed(2)} Mbps`;
}
/** 表盘中央空间有限，数值越大保留的小数位越少。 */
function compactMbps(value?: number) {
  const mbps = value || 0;
  return mbps.toFixed(mbps >= 1000 ? 0 : mbps >= 100 ? 1 : 2);
}
function DirectionIcon({
  direction,
  className,
}: {
  direction: LinkSpeedDirection;
  className?: string;
}) {
  const Icon = direction === "upload" ? ArrowUp : ArrowDown;
  return (
    <Icon
      className={cn("h-4 w-4 shrink-0", className)}
      style={{ color: DIRECTION_COLOR[direction] }}
      aria-hidden
    />
  );
}
function Measurement({
  direction,
  title,
  result,
  udp,
}: {
  direction: LinkSpeedDirection;
  title: string;
  result?: LinkSpeedMeasurement;
  udp: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 p-4">
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <DirectionIcon direction={direction} />
        {title}
      </p>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums">
        {result ? result.mbps.toFixed(2) : "—"}
        <span className="ml-1.5 text-sm font-normal text-muted-foreground">
          Mbps
        </span>
      </p>
      {result && (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border/40 pt-3 text-xs">
          <dt className="text-muted-foreground">{t("峰值速度")}</dt>
          <dd className="text-right tabular-nums">{rate(result.peakMbps)}</dd>
          <dt className="text-muted-foreground">{t("接收数据量")}</dt>
          <dd className="text-right tabular-nums">{bytes(result.bytes)}</dd>
          <dt className="text-muted-foreground">{t("实际时长")}</dt>
          <dd className="text-right tabular-nums">
            {(result.durationMs / 1000).toFixed(2)} s
          </dd>
          {udp && (
            <>
              <dt className="text-muted-foreground">{t("接收 / 发送包数")}</dt>
              <dd className="text-right tabular-nums">
                {result.packets || 0} / {result.sentPackets || 0}
              </dd>
              <dt className="text-muted-foreground">{t("丢包")}</dt>
              <dd className="text-right tabular-nums">
                {result.lostPackets || 0} (
                {(result.lossPercent || 0).toFixed(2)}%)
              </dd>
              <dt className="text-muted-foreground">{t("抖动")}</dt>
              <dd className="text-right tabular-nums">
                {(result.jitterMs || 0).toFixed(2)} ms
              </dd>
            </>
          )}
        </dl>
      )}
    </div>
  );
}
function PhaseBar({
  direction,
  label,
  seconds,
  percent,
  animated,
}: {
  direction: LinkSpeedDirection;
  label: string;
  seconds: number;
  percent: number;
  animated: boolean;
}) {
  return (
    <div className="min-w-0">
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
      >
        <div
          className={cn(
            "h-full rounded-full",
            animated && "transition-[width] duration-500 ease-linear",
          )}
          style={{
            width: `${percent}%`,
            backgroundColor: DIRECTION_COLOR[direction],
          }}
        />
      </div>
      <p className="mt-1.5 flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <DirectionIcon direction={direction} className="h-3 w-3" />
          {label}
        </span>
        <span className="tabular-nums">{seconds}s</span>
      </p>
    </div>
  );
}
export function LinkSpeedTestButton({
  resourceType,
  resourceId,
  name,
}: {
  resourceType: "tunnel" | "chain";
  resourceId: number;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const [protocol, setProtocol] = useState<"tcp" | "udp">("tcp");
  const [duration, setDuration] = useState("10");
  const [offeredRate, setOfferedRate] = useState("100");
  const [initial, setInitial] = useState<LinkSpeedStatus | null>(null);
  const motionEnabled = useMotionEnabled();
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const utils = trpc.useUtils();
  const last = trpc.linkSpeed.latest.useQuery(
    { resourceType, resourceId },
    { enabled: open, staleTime: 0 },
  );
  useEffect(() => {
    if (!initial && last.data) setInitial(last.data);
  }, [initial, last.data]);
  const query = trpc.linkSpeed.status.useQuery(
    { id: initial?.id || "00000000-0000-0000-0000-000000000000" },
    {
      enabled: open && !!initial,
      refetchInterval: (q) =>
        q.state.error?.data?.code !== "NOT_FOUND" &&
        linkSpeedActive(q.state.data?.state || initial?.state)
          ? 500
          : false,
    },
  );
  const status = query.data?.id === initial?.id ? query.data : initial;
  // 面板重启或结果过期后任务不再存在，此时不能继续当作测速中。
  const jobLost = query.error?.data?.code === "NOT_FOUND";
  const active = !jobLost && linkSpeedActive(status?.state);
  const start = trpc.linkSpeed.start.useMutation({
    onSuccess: (result) => {
      setInitial(result);
    },
    onError: (error) => toast.error(error.message),
  });
  const cancel = trpc.linkSpeed.cancel.useMutation({
    onSuccess: (result) => {
      setInitial(result);
      utils.linkSpeed.status.setData({ id: result.id }, result);
    },
    onError: (error) => toast.error(error.message),
  });
  const samples = status?.samples || [];
  const latest = samples.at(-1);
  const liveDirection =
    active && (status?.state === "upload" || status?.state === "download")
      ? status.state
      : undefined;
  const liveMbps =
    liveDirection && latest?.direction === liveDirection ? latest.mbps : 0;
  const phaseSeconds = status?.duration || Number(duration) || 10;
  const phasePercent = (direction: LinkSpeedDirection) => {
    if (!status) return 0;
    if (status[direction] || status.state === "completed") return 100;
    if (status.state !== direction) return 0;
    const elapsed = latest?.direction === direction ? latest.elapsedMs : 0;
    return Math.min(100, (elapsed / (status.duration * 1000)) * 100);
  };
  const uploadPeak =
    status?.upload?.peakMbps ?? peakOfSamples(samples, "upload");
  const downloadPeak =
    status?.download?.peakMbps ?? peakOfSamples(samples, "download");
  const stops = gaugeStops(
    Math.max(
      uploadPeak,
      downloadPeak,
      status?.upload?.mbps || 0,
      status?.download?.mbps || 0,
    ),
  );
  const chart = samples.map((sample) => ({
    second: Number(
      (
        (sample.elapsedMs +
          (sample.direction === "download"
            ? (status?.duration || 10) * 1000
            : 0)) /
        1000
      ).toFixed(2),
    ),
    [sample.direction]: sample.mbps,
  }));
  const stateLabel = status
    ? {
        preparing: t("准备链路"),
        upload: t("上传测速中"),
        download: t("下载测速中"),
        completed: t("测速完成"),
        cancelled: t("已取消"),
        error: t("测速失败"),
      }[status.state]
    : t("等待测速数据");
  const gaugeLabel = [
    stateLabel,
    status?.upload ? `${t("上传")} ${rate(status.upload.mbps)}` : "",
    status?.download ? `${t("下载")} ${rate(status.download.mbps)}` : "",
    liveDirection ? rate(liveMbps) : "",
  ]
    .filter(Boolean)
    .join("，");
  const exportResult = () => {
    if (!status) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(status, null, 2)], { type: "application/json" }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `link-speed-${status.id}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const locked = active || start.isPending;
  const readout = () => {
    if (liveDirection) {
      return (
        <>
          <span className="text-[2.5rem] font-semibold leading-none tracking-tight tabular-nums">
            {compactMbps(liveMbps)}
          </span>
          <span className="mt-1 text-xs text-muted-foreground">Mbps</span>
          <span className="mt-2 flex items-center gap-1 text-sm">
            <DirectionIcon direction={liveDirection} />
            {stateLabel}
          </span>
        </>
      );
    }
    if (status?.state === "completed") {
      return (
        <>
          {(["download", "upload"] as const).map((direction) => (
            <span
              key={direction}
              className="flex items-center gap-1.5 text-[1.75rem] font-semibold leading-tight tabular-nums"
            >
              <DirectionIcon direction={direction} className="h-5 w-5" />
              {compactMbps(status[direction]?.mbps)}
            </span>
          ))}
          <span className="mt-1 text-xs text-muted-foreground">Mbps</span>
          <span className="mt-1.5 flex items-center gap-1 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4" aria-hidden />
            {stateLabel}
          </span>
        </>
      );
    }
    const StateIcon =
      active && status?.state === "preparing"
        ? Loader2
        : status?.state === "error"
          ? TriangleAlert
          : status?.state === "cancelled"
            ? CircleSlash
            : Gauge;
    return (
      <>
        <StateIcon
          className={cn(
            "h-7 w-7 text-muted-foreground",
            active && status?.state === "preparing" && "animate-spin",
            status?.state === "error" && "text-destructive",
          )}
          aria-hidden
        />
        <span
          className={cn(
            "mt-2 text-sm text-muted-foreground",
            status?.state === "error" && "text-destructive",
          )}
        >
          {stateLabel}
        </span>
      </>
    );
  };
  if (!isAdmin) return null;
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        title={t("链路测速")}
        aria-label={t("链路测速")}
        onClick={() => setOpen(true)}
      >
        <Gauge className="h-3.5 w-3.5" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Gauge className="h-5 w-5" />
              {t("链路测速")}
            </DialogTitle>
            <DialogDescription>{name}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <LinkSpeedGauge
              stops={stops}
              upload={
                status?.upload?.mbps ??
                (liveDirection === "upload" ? liveMbps : undefined)
              }
              download={
                status?.download?.mbps ??
                (liveDirection === "download" ? liveMbps : undefined)
              }
              uploadPeak={
                status?.upload || liveDirection === "upload" ? uploadPeak : 0
              }
              downloadPeak={
                status?.download || liveDirection === "download"
                  ? downloadPeak
                  : 0
              }
              liveDirection={liveDirection}
              animated={motionEnabled}
              label={gaugeLabel}
            >
              <div className="flex flex-col items-center" aria-live="polite">
                {readout()}
              </div>
            </LinkSpeedGauge>
            <div className="mx-auto grid max-w-md grid-cols-2 gap-2">
              <PhaseBar
                direction="upload"
                label={t("上传")}
                seconds={phaseSeconds}
                percent={phasePercent("upload")}
                animated={motionEnabled}
              />
              <PhaseBar
                direction="download"
                label={t("下载")}
                seconds={phaseSeconds}
                percent={phasePercent("download")}
                animated={motionEnabled}
              />
            </div>
          </div>
          {status?.error && (
            <p role="alert" className="text-sm text-destructive">
              {t(status.error)}
            </p>
          )}
          {query.error && (
            <p role="alert" className="text-sm text-destructive">
              {t(query.error.message)}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-3 rounded-xl bg-muted/30 p-3">
            <div className="space-y-2">
              <Label>{t("协议")}</Label>
              <div
                role="radiogroup"
                aria-label={t("协议")}
                className={cn(segmentedControlClassName, "grid grid-cols-2 gap-1")}
              >
                {(["tcp", "udp"] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={protocol === value}
                    disabled={locked}
                    onClick={() => setProtocol(value)}
                    className={segmentedOptionClassName(
                      protocol === value,
                      locked,
                      "h-[30px] px-4",
                    )}
                  >
                    {value.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
            <div className="min-w-32 flex-1 space-y-2">
              <Label htmlFor={`speed-duration-${resourceType}-${resourceId}`}>
                {t("每方向时长（秒）")}
              </Label>
              <Input
                id={`speed-duration-${resourceType}-${resourceId}`}
                type="number"
                min={3}
                max={30}
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                disabled={locked}
              />
            </div>
            {protocol === "udp" && (
              <div className="min-w-32 flex-1 space-y-2">
                <Label htmlFor={`speed-rate-${resourceType}-${resourceId}`}>
                  {t("UDP 发送速率（Mbps）")}
                </Label>
                <Input
                  id={`speed-rate-${resourceType}-${resourceId}`}
                  type="number"
                  min={1}
                  max={1000}
                  value={offeredRate}
                  onChange={(e) => setOfferedRate(e.target.value)}
                  disabled={locked}
                />
              </div>
            )}
            {active ? (
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                disabled={cancel.isPending}
                onClick={() => status && cancel.mutate({ id: status.id })}
              >
                {t("停止测速")}
              </Button>
            ) : (
              <Button
                className="w-full sm:w-auto"
                disabled={
                  start.isPending ||
                  !Number.isInteger(Number(duration)) ||
                  Number(duration) < 3 ||
                  Number(duration) > 30 ||
                  (protocol === "udp" &&
                    (!Number.isFinite(Number(offeredRate)) ||
                      Number(offeredRate) < 1 ||
                      Number(offeredRate) > 1000))
                }
                onClick={() =>
                  start.mutate({
                    resourceType,
                    resourceId,
                    protocol,
                    duration: Number(duration),
                    rateMbps: protocol === "udp" ? Number(offeredRate) : 100,
                  })
                }
              >
                {start.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Gauge className="mr-2 h-4 w-4" />
                )}
                {t("开始测速")}
              </Button>
            )}
          </div>
          {status && (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <Measurement
                  direction="upload"
                  title={t("上传（入口 → 出口）")}
                  result={status.upload}
                  udp={status.protocol === "udp"}
                />
                <Measurement
                  direction="download"
                  title={t("下载（出口 → 入口）")}
                  result={status.download}
                  udp={status.protocol === "udp"}
                />
              </div>
              {chart.length > 0 && (
                <div className="h-36 min-w-0" aria-label={t("实时速度曲线")}>
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart
                      data={chart}
                      margin={{ top: 8, right: 12, left: 0, bottom: 0 }}
                    >
                      <CartesianGrid
                        strokeDasharray="3 3"
                        vertical={false}
                        opacity={0.2}
                      />
                      <XAxis
                        dataKey="second"
                        type="number"
                        domain={[0, status.duration * 2]}
                        tickFormatter={(v) => `${v}s`}
                        tick={{ fontSize: 11 }}
                      />
                      <YAxis width={52} tick={{ fontSize: 11 }} />
                      <Tooltip
                        labelFormatter={(v) => `${v}s`}
                        formatter={(v: number, key: string) => [
                          rate(v),
                          key === "upload" ? t("上传") : t("下载"),
                        ]}
                      />
                      <Area
                        dataKey="upload"
                        name="upload"
                        stroke={LINK_SPEED_UPLOAD_COLOR}
                        fill={LINK_SPEED_UPLOAD_COLOR}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                      />
                      <Area
                        dataKey="download"
                        name="download"
                        stroke={LINK_SPEED_DOWNLOAD_COLOR}
                        fill={LINK_SPEED_DOWNLOAD_COLOR}
                        fillOpacity={0.12}
                        isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
              <div className="space-y-2.5 text-xs text-muted-foreground">
                <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-2">
                  {status.route.map((node, index) => (
                    <li
                      key={`${node.hostId}-${index}`}
                      className="flex min-w-0 items-center gap-1.5"
                    >
                      {index > 0 && (
                        <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      )}
                      <span className="min-w-0 break-words rounded-lg border border-border/60 bg-muted/30 px-2 py-1">
                        <span className="font-medium text-foreground">
                          {node.name}
                        </span>{" "}
                        {node.transport}
                      </span>
                    </li>
                  ))}
                </ol>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  <span>{status.protocol.toUpperCase()}</span>
                  <span>
                    {status.duration}s ↑ / {status.duration}s ↓
                  </span>
                  {status.rateMbps > 0 && (
                    <span>
                      {t("发送上限")} {rate(status.rateMbps)}
                    </span>
                  )}
                  <span>{new Date(status.createdAt).toLocaleString()}</span>
                  {status.finishedAt && (
                    <span>
                      {t("结束时间")}{" "}
                      {new Date(status.finishedAt).toLocaleTimeString()}
                    </span>
                  )}
                </div>
              </div>
            </>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 flex-1 basis-64 text-xs text-muted-foreground">
              {t(
                "测速使用临时端口并产生实际流量；测量所列节点路径，不包含用户到入口及出口到业务目标。",
              )}
            </p>
            {status && !active && (
              <Button variant="ghost" size="sm" onClick={exportResult}>
                <Download className="mr-2 h-4 w-4" />
                {t("导出结果")}
              </Button>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
