export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "forwardx-default-secret-change-me",
  // SQLite 单文件数据库路径，默认 /data/forwardx.db（docker volume 挂载点）
  sqlitePath: process.env.SQLITE_PATH ?? "/data/forwardx.db",
  isProduction: process.env.NODE_ENV === "production",
};
