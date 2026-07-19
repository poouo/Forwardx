import { normalizeForwardRuleProtocol, type ForwardRuleProtocol } from "../shared/forwardTypes";

type ReservationEntry = {
  token: symbol;
  protocol: ForwardRuleProtocol;
};

export type HostPortReservation = {
  hostId: number;
  port: number;
  protocol: ForwardRuleProtocol;
  release: () => void;
};

type PortUsageCheck = (port: number) => Promise<boolean>;

const reservations = new Map<number, Map<number, ReservationEntry[]>>();

function protocolsConflict(_left: ForwardRuleProtocol, _right: ForwardRuleProtocol) {
  return true;
}

function normalizedHostId(value: unknown) {
  const hostId = Number(value);
  return Number.isInteger(hostId) && hostId > 0 ? hostId : 0;
}

function normalizedPort(value: unknown) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

export function reservedHostPorts(hostIdValue: unknown, protocolValue: unknown) {
  const hostId = normalizedHostId(hostIdValue);
  const protocol = normalizeForwardRuleProtocol(protocolValue, "both");
  const hostReservations = reservations.get(hostId);
  if (!hostReservations) return [];
  const ports: number[] = [];
  for (const [port, entries] of hostReservations) {
    if (entries.some((entry) => protocolsConflict(entry.protocol, protocol))) ports.push(port);
  }
  return ports;
}

export function tryReserveHostPort(hostIdValue: unknown, portValue: unknown, protocolValue: unknown): HostPortReservation | null {
  const hostId = normalizedHostId(hostIdValue);
  const port = normalizedPort(portValue);
  const protocol = normalizeForwardRuleProtocol(protocolValue, "both");
  if (!hostId || !port) return null;

  let hostReservations = reservations.get(hostId);
  if (!hostReservations) {
    hostReservations = new Map();
    reservations.set(hostId, hostReservations);
  }
  const entries = hostReservations.get(port) || [];
  if (entries.some((entry) => protocolsConflict(entry.protocol, protocol))) return null;

  const token = Symbol(`host:${hostId}:port:${port}`);
  entries.push({ token, protocol });
  hostReservations.set(port, entries);
  let released = false;
  return {
    hostId,
    port,
    protocol,
    release: () => {
      if (released) return;
      released = true;
      const currentHost = reservations.get(hostId);
      const currentEntries = currentHost?.get(port);
      if (!currentHost || !currentEntries) return;
      const remaining = currentEntries.filter((entry) => entry.token !== token);
      if (remaining.length > 0) currentHost.set(port, remaining);
      else currentHost.delete(port);
      if (currentHost.size === 0) reservations.delete(hostId);
    },
  };
}

export async function reserveSpecificHostPort(options: {
  hostId: number;
  port: number;
  protocol: unknown;
  isUsed?: PortUsageCheck;
}): Promise<HostPortReservation | null> {
  const reservation = tryReserveHostPort(options.hostId, options.port, options.protocol);
  if (!reservation) return null;
  try {
    if (options.isUsed && await options.isUsed(reservation.port)) {
      reservation.release();
      return null;
    }
    return reservation;
  } catch (error) {
    reservation.release();
    throw error;
  }
}

export async function reserveAvailableHostPort(options: {
  hostId: number;
  protocol: unknown;
  findPort: (reservedPorts: number[]) => Promise<number | null>;
  isUsed?: PortUsageCheck;
  maxAttempts?: number;
}): Promise<HostPortReservation | null> {
  const maxAttempts = Math.max(1, Math.min(256, Number(options.maxAttempts) || 64));
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const port = await options.findPort(reservedHostPorts(options.hostId, options.protocol));
    if (!port) return null;
    const reservation = tryReserveHostPort(options.hostId, port, options.protocol);
    if (!reservation) continue;
    try {
      if (options.isUsed && await options.isUsed(port)) {
        reservation.release();
        continue;
      }
    } catch (error) {
      reservation.release();
      throw error;
    }
    return reservation;
  }
  return null;
}

export function releaseHostPortReservations(items: Iterable<HostPortReservation>) {
  for (const reservation of items) reservation.release();
}

export function clearHostPortReservationsForTest() {
  reservations.clear();
}
