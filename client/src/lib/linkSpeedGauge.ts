import type { LinkSpeedDirection, LinkSpeedSample } from "@shared/linkSpeed";

/** 表盘刻度按段等分，低速区更宽，几十 Mbps 的链路也能看清指针变化。 */
const STANDARD_STOPS = [0, 5, 10, 50, 100, 250, 500, 1000];
const HIGH_STOPS = [0, 10, 50, 100, 500, 1000, 2500, 5000, 10000];

export function gaugeStops(maxMbps: number) {
  return maxMbps > 1000 ? HIGH_STOPS : STANDARD_STOPS;
}

/** 把速度换算成表盘上的位置，0 为起点，1 为满刻度。 */
export function gaugeFraction(mbps: number | undefined, stops: readonly number[]) {
  const value = Number(mbps);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const segments = stops.length - 1;
  for (let index = 1; index <= segments; index++) {
    if (value <= stops[index]) {
      const from = stops[index - 1];
      return (index - 1 + (value - from) / (stops[index] - from)) / segments;
    }
  }
  return 1;
}

export function gaugeStopLabel(stop: number) {
  return stop >= 1000 ? `${stop / 1000}G` : String(stop);
}

export function peakOfSamples(samples: readonly LinkSpeedSample[], direction: LinkSpeedDirection) {
  let peak = 0;
  for (const sample of samples) {
    if (sample.direction === direction && sample.mbps > peak) peak = sample.mbps;
  }
  return peak;
}
