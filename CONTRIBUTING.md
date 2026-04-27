# 贡献指南

感谢你对 ForwardX 的关注！我们欢迎任何形式的贡献，包括但不限于：

- 提交 Bug 报告
- 提出功能建议
- 提交代码修复或新功能
- 改进文档

## 开发环境搭建

### 前置要求

- Node.js 22+
- pnpm 10+

### 本地开发

```bash
# 克隆项目
git clone https://github.com/your-username/forwardx.git
cd forwardx

# 安装依赖
pnpm install

# 启动开发服务器（前端 + 后端热重载）
pnpm dev
```

开发服务器启动后，访问 `http://localhost:5173`（Vite 开发服务器会自动代理 API 请求到后端 3000 端口）。

### 项目结构

- `client/src/` — 前端 React 代码
- `server/` — 后端 Express + tRPC 代码
- `drizzle/` — 数据库 Schema 定义
- `shared/` — 前后端共享代码

### 构建测试

```bash
# 构建生产版本
pnpm build

# 启动生产服务
pnpm start
```

## 提交 Issue

提交 Issue 时，请尽量包含以下信息：

- **Bug 报告**：复现步骤、期望行为、实际行为、环境信息（OS、浏览器、Node.js 版本）
- **功能建议**：使用场景描述、期望的功能表现

## 提交 Pull Request

1. Fork 本仓库
2. 创建功能分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -m "feat: add your feature"`
4. 推送分支：`git push origin feature/your-feature`
5. 创建 Pull Request

### Commit 规范

请遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

| 类型 | 说明 |
|------|------|
| `feat` | 新功能 |
| `fix` | Bug 修复 |
| `docs` | 文档更新 |
| `style` | 代码格式调整（不影响逻辑） |
| `refactor` | 代码重构 |
| `perf` | 性能优化 |
| `chore` | 构建/工具链变更 |

示例：

```
feat: add IPv6 forwarding support
fix: correct realm traffic counting chain placement
docs: update agent deployment instructions
```

### 代码风格

- TypeScript 严格模式
- 使用 Tailwind CSS 编写样式，避免自定义 CSS
- React 组件使用函数式组件 + Hooks
- 后端 API 使用 tRPC 定义，保持类型安全

## 许可证

提交贡献即表示你同意你的代码将在 [MIT License](LICENSE) 下发布。
