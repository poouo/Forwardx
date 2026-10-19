export type NetworkTestSummary = {
  sent?: number; received?: number; lossPercent?: number;
  minMs?: number; avgMs?: number; maxMs?: number; jitterMs?: number;
  hops: { hop: number; address: string; lossPercent?: number; avgMs?: number; timedOut: boolean }[];
};

/** Parse known formats only. A silent intermediate hop is not proof of packet loss at the destination. */
export function networkTestSummary(method: string, output: string): NetworkTestSummary {
  const text = output.slice(0, 256000), result: NetworkTestSummary = { hops: [] };
  if (/^ping6?$/.test(method)) {
    const packets = text.match(/(\d+) packets transmitted,\s*(\d+) (?:packets )?received.*?([\d.]+)% packet loss/);
    if (packets) { result.sent = Number(packets[1]); result.received = Number(packets[2]); result.lossPercent = Number(packets[3]); }
    const times = text.match(/(?:rtt|round-trip).*?=\s*([\d.]+)\/([\d.]+)\/([\d.]+)(?:\/([\d.]+))?\s*ms/);
    if (times) { result.minMs = Number(times[1]); result.avgMs = Number(times[2]); result.maxMs = Number(times[3]); if (times[4]) result.jitterMs = Number(times[4]); }
  } else if (/^mtr6?$/.test(method)) {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\.\|--\s+(\S+)\s+([\d.]+)%\s+(\d+)\s+([\d.]+)\s+([\d.]+)/);
      if (match) result.hops.push({ hop: Number(match[1]), address: match[2], lossPercent: Number(match[3]), avgMs: Number(match[6]), timedOut: match[2] === "???" });
    }
  } else if (/^traceroute6?$/.test(method)) {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(.+)/);
      if (!match || Number(match[1]) > 64) continue;
      const address = match[2].match(/^(\S+)/)?.[1] || "*", times = [...match[2].matchAll(/([\d.]+)\s*ms/g)].map(item => Number(item[1]));
      result.hops.push({ hop: Number(match[1]), address, timedOut: !times.length, ...(times.length ? { avgMs: times.reduce((a, b) => a + b, 0) / times.length } : {}) });
    }
  }
  result.hops = result.hops.slice(0, 64);
  return result;
}
