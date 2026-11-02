// Keep drivers out of startup/router imports. Connection tests, health probes
// and migrations use these same entry points and load only the requested kind.
// import() is cached by Node; it never opens a connection by itself.
export async function loadMysqlDriver() {
  return (await import("mysql2/promise")).default;
}

export async function loadPostgresqlDriver() {
  return (await import("pg")).default;
}

export async function loadSqliteDriver() {
  return (await import("better-sqlite3")).default;
}
