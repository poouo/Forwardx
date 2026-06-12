import { defineConfig } from "drizzle-kit";

const rawDialect = (process.env.DATABASE_TYPE || process.env.DB_TYPE || "mysql").toLowerCase();
const dialect = rawDialect === "postgres" || rawDialect === "pg" ? "postgresql" : rawDialect;

const config = dialect === "postgresql"
  ? {
      schema: "./drizzle/schema.ts",
      out: "./drizzle",
      dialect: "postgresql" as const,
      dbCredentials: {
        url: process.env.POSTGRES_URL ?? process.env.POSTGRESQL_URL ?? process.env.PG_URL ?? "postgres://forwardx:forwardx@127.0.0.1:5432/forwardx",
      },
    }
  : dialect === "sqlite"
    ? {
        schema: "./drizzle/schema.ts",
        out: "./drizzle",
        dialect: "sqlite" as const,
        dbCredentials: {
          url: process.env.SQLITE_PATH ?? "./data/forwardx.db",
        },
      }
    : {
        schema: "./drizzle/schema.ts",
        out: "./drizzle",
        dialect: "mysql" as const,
        dbCredentials: {
          url: process.env.MYSQL_URL ?? "mysql://forwardx:forwardx@127.0.0.1:3306/forwardx",
        },
      };

export default defineConfig(config);
