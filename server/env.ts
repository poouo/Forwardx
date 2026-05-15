export const ENV = {
  cookieSecret: process.env.JWT_SECRET ?? "forwardx-default-secret-change-me",
  // SQLite 单文件数据库路径，默认 /data/forwardx.db（docker volume 挂载点）
  sqlitePath: process.env.SQLITE_PATH ?? "/data/forwardx.db",
  // 管理后台一键升级命令。为空时只允许检查更新，不执行升级。
  // 执行时会注入 FORWARDX_TARGET_VERSION / FORWARDX_CURRENT_VERSION / FORWARDX_REPO_URL。
  upgradeCommand: process.env.FORWARDX_UPGRADE_COMMAND ?? "",
  isProduction: process.env.NODE_ENV === "production",
};
