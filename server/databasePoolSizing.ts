export type DatabasePoolSettings = {
  maxOpen: number;
  maxIdle: number;
  queueLimit: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds: number;
  connectTimeoutMillis: number;
};

export function databasePoolSettingsForHostCount(value: unknown): DatabasePoolSettings {
  const hostCount = Math.max(0, Math.floor(Number(value) || 0));
  // mysql2 rapidly closes free connections above maxIdle; PostgreSQL maps this value to its retained minimum.
  // Keeping it equal to maxOpen makes both pools open on demand and reuse the connections reached under load.
  if (hostCount > 100) {
    return {
      maxOpen: 32,
      maxIdle: 32,
      queueLimit: 512,
      idleTimeoutMillis: 5 * 60_000,
      maxLifetimeSeconds: 0,
      connectTimeoutMillis: 6000,
    };
  }
  if (hostCount > 30) {
    return {
      maxOpen: 24,
      maxIdle: 24,
      queueLimit: 384,
      idleTimeoutMillis: 5 * 60_000,
      maxLifetimeSeconds: 0,
      connectTimeoutMillis: 6000,
    };
  }
  return {
    maxOpen: 16,
    maxIdle: 16,
    queueLimit: 256,
    idleTimeoutMillis: 5 * 60_000,
    maxLifetimeSeconds: 0,
    connectTimeoutMillis: 6000,
  };
}
