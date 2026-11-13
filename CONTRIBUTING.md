# 贡献指南

ForwardX 由作者一人维护，欢迎提交 Bug 报告、功能建议和 Pull Request。

## 提交 Issue

- **Bug**：写明复现步骤、期望结果和实际结果，以及面板和 Agent 的版本、部署方式（Docker / 本地）和数据库类型。转发不通的问题请附上规则类型和相关日志，日志位置见 [目录与日志](docs/guide/paths-logs.md)。
- **功能建议**：说明使用场景和希望达到的效果。

贴日志前请去掉 Token、密码和不想公开的 IP。

## 本地开发

需要 Node.js 22+ 和 pnpm 10.28.1。

```bash
git clone https://github.com/poouo/Forwardx.git
cd Forwardx
pnpm install
pnpm dev:panel
```

`dev:panel` 在 `http://127.0.0.1:5173` 启动面板，使用 `.dev` 目录里的独立数据并自动登录开发管理员，不要暴露到公网。详见 [开发指南](docs/guide/development.md)。

目录结构：

- `client/src/`：前端（React）
- `server/`：后端（Express + tRPC）
- `agent/`、`forwardx-fxp/`：Go 编写的 Agent 和 FXP 运行时
- `drizzle/`：数据库 Schema
- `shared/`：前后端共用代码
- `docs/`：文档站

## 提交 Pull Request

1. 从 `main` 新建分支并完成修改。
2. 运行检查：

   ```bash
   pnpm exec tsc --noEmit
   pnpm test:server
   pnpm build
   ```

   改动了 Agent 的，还要在 `agent/` 目录下运行 `go test ./... && go vet ./...`。
3. 界面上新增的中文文案，要在 `client/src/i18n/en.json` 里补上英文。
4. 提交信息写成 `类型: 说明`，例如 `fix: correct realm traffic counting`。常用类型有 `feat`、`fix`、`docs`、`refactor`、`perf`、`chore`。

## 许可证

提交的代码按 [GNU Affero General Public License v3.0 only](LICENSE) 发布。
