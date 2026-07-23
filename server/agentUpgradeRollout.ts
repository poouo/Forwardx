export const AGENT_UPGRADE_WAVE_SIZE = 5;
export const AGENT_UPGRADE_WAVE_INTERVAL_MS = 15_000;

export function planAgentUpgradeWaves<T>(
  hosts: T[],
  now = Date.now(),
  waveSize = AGENT_UPGRADE_WAVE_SIZE,
  waveIntervalMs = AGENT_UPGRADE_WAVE_INTERVAL_MS,
) {
  const normalizedWaveSize = Math.max(1, Math.floor(waveSize));
  const normalizedInterval = Math.max(1_000, Math.floor(waveIntervalMs));
  return hosts.map((host, index) => {
    const wave = Math.floor(index / normalizedWaveSize);
    const delayMs = wave * normalizedInterval;
    return {
      host,
      wave,
      delayMs,
      requestedAt: new Date(now + delayMs),
    };
  });
}
