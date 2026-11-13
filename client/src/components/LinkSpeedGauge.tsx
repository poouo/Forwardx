import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { gaugeFraction, gaugeStopLabel } from "@/lib/linkSpeedGauge";

export const LINK_SPEED_UPLOAD_COLOR = "var(--traffic-out)";
export const LINK_SPEED_DOWNLOAD_COLOR = "var(--traffic-in)";

const CENTER_X = 160;
const CENTER_Y = 150;
const START_ANGLE = 135;
const SWEEP = 270;
const DOWNLOAD_RADIUS = 132;
const UPLOAD_RADIUS = 116;
const LABEL_RADIUS = 92;
const STROKE = 10;

function point(radius: number, fraction: number) {
  const angle = ((START_ANGLE + SWEEP * fraction) * Math.PI) / 180;
  return { x: CENTER_X + radius * Math.cos(angle), y: CENTER_Y + radius * Math.sin(angle) };
}

function arcPath(radius: number) {
  const from = point(radius, 0);
  const to = point(radius, 1);
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} A ${radius} ${radius} 0 1 1 ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
}

function Dial({
  radius,
  color,
  value,
  peak,
  live,
  stops,
  animated,
}: {
  radius: number;
  color: string;
  value?: number;
  peak?: number;
  live: boolean;
  stops: readonly number[];
  animated: boolean;
}) {
  const fraction = gaugeFraction(value, stops);
  const peakFraction = gaugeFraction(peak, stops);
  const path = arcPath(radius);
  const start = point(radius, 0);
  const peakInner = point(radius - STROKE / 2 - 1, peakFraction);
  const peakOuter = point(radius + STROKE / 2 + 1, peakFraction);
  const motion = animated ? "transition-all duration-500 ease-linear" : "";
  return (
    <g>
      <path d={path} fill="none" strokeWidth={STROKE} strokeLinecap="round" className="stroke-muted" />
      <path
        d={path}
        fill="none"
        pathLength={1}
        strokeWidth={STROKE}
        strokeLinecap="round"
        strokeDasharray={`${fraction} 1`}
        className={motion}
        style={{ stroke: color, opacity: fraction > 0 ? 1 : 0 }}
      />
      {peakFraction > 0 && peakFraction - fraction > 0.004 && (
        <line
          x1={peakInner.x}
          y1={peakInner.y}
          x2={peakOuter.x}
          y2={peakOuter.y}
          strokeWidth={2}
          strokeLinecap="round"
          style={{ stroke: color }}
        />
      )}
      {live && (
        <circle
          cx={start.x}
          cy={start.y}
          r={STROKE / 2 + 2.5}
          strokeWidth={3}
          className={cn("fill-background", animated && "transition-transform duration-500 ease-linear")}
          style={{
            stroke: color,
            transformOrigin: `${CENTER_X}px ${CENTER_Y}px`,
            transform: `rotate(${(SWEEP * fraction).toFixed(2)}deg)`,
          }}
        />
      )}
    </g>
  );
}

/**
 * 双环速度表：外环下载、内环上传。测速中的方向带游标，
 * 环上的短刻线标出该方向的峰值。
 */
export function LinkSpeedGauge({
  stops,
  upload,
  download,
  uploadPeak,
  downloadPeak,
  liveDirection,
  animated = true,
  label,
  children,
}: {
  stops: readonly number[];
  upload?: number;
  download?: number;
  uploadPeak?: number;
  downloadPeak?: number;
  liveDirection?: "upload" | "download";
  animated?: boolean;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="relative mx-auto w-full max-w-[340px]">
      <svg viewBox="0 0 320 256" className="block w-full" role="img" aria-label={label}>
        <Dial
          radius={DOWNLOAD_RADIUS}
          color={LINK_SPEED_DOWNLOAD_COLOR}
          value={download}
          peak={downloadPeak}
          live={liveDirection === "download"}
          stops={stops}
          animated={animated}
        />
        <Dial
          radius={UPLOAD_RADIUS}
          color={LINK_SPEED_UPLOAD_COLOR}
          value={upload}
          peak={uploadPeak}
          live={liveDirection === "upload"}
          stops={stops}
          animated={animated}
        />
        {stops.map((stop, index) => {
          const position = point(LABEL_RADIUS, index / (stops.length - 1));
          return (
            <text
              key={stop}
              x={position.x}
              y={position.y}
              textAnchor="middle"
              dominantBaseline="central"
              className="fill-muted-foreground text-[11px] tabular-nums"
            >
              {gaugeStopLabel(stop)}
            </text>
          );
        })}
      </svg>
      <div className="pointer-events-none absolute inset-x-0 top-[58.6%] flex -translate-y-1/2 flex-col items-center px-16 text-center">
        {children}
      </div>
    </div>
  );
}
