export const DATABASE_UNAVAILABLE_MESSAGE = "数据库暂时不可用，请查看数据库异常提示";

export type DatabaseHealth = {
  state: "checking" | "healthy" | "unavailable" | "not_configured";
  databaseType: "mysql" | "postgresql" | "sqlite" | null;
  checkedAt: string | null;
  unavailableSince: string | null;
  reason: { code: string; message: string; suggestion: string } | null;
  restartRequired: boolean;
};
