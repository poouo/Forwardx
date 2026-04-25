# 登录问题分析

## 代码中的默认账户
- 用户名: `admin`
- 密码: `admin123`
- 位置: `server/db.ts` 第 191-204 行，`initDatabase()` 函数

## 问题根因

代码逻辑本身是正确的：
1. `initDatabase()` 在每次启动时检查是否存在 `admin` 用户
2. 如果不存在，则创建默认管理员 (admin / admin123)
3. 密码使用 scrypt + 随机 salt 哈希存储
4. `authenticateUser()` 正确验证密码

**但是 README.md 中的描述与实际代码不一致：**

README 第 148-149 行写的是：
> - 首次登录的用户自动注册为普通用户
> - 项目所有者自动获得管理员权限

这完全不是代码的实际行为。代码中没有"自动注册"功能，登录页面也没有注册入口。

**此外 .env.example 和 README 中还残留了 MySQL 相关配置：**
- README 技术栈写的是 "MySQL 8.0"，实际已迁移到 SQLite
- .env.example 中有 `DATABASE_URL=mysql://...`，实际代码使用 `SQLITE_PATH`
- README 中 docker-compose 示例包含 MySQL 容器，实际只有单容器

## 结论
登录问题最可能的原因是：用户看了 README 中的错误描述，以为"首次登录自动注册"，
实际上需要使用默认管理员账户 admin / admin123 登录。
README 文档严重过时，需要全面更新。
