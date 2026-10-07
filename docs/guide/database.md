# 数据库配置

ForwardX 支持 SQLite、MySQL 和 PostgreSQL。安装脚本可能已询问并保存数据库选择，网页初始化时请检查预填内容，不必重复创建一套数据库。

## 如何选择

| 类型 | 适用场景 | 需要准备 |
| --- | --- | --- |
| SQLite | 单实例、小规模、希望减少运维组件 | 持久化数据目录及写权限 |
| MySQL | 已有 MySQL 运维环境 | MySQL 8.0.13+、数据库和独立账号 |
| PostgreSQL | 已有 PostgreSQL 运维环境 | PostgreSQL 12+、数据库和独立账号 |

数据库类型并不是高可用开关。先选择适合自己的运维方式，并定期验证备份。切换数据库不等于自动复制旧数据；跨类型导入或面板迁移应按对应功能的限制操作。

## 配置入口和优先级

首次初始化向导中确认类型，外部数据库填写地址、端口、数据库名、账号、密码及 SSL 后测试连接。

数据库连接配置写入 database.json；位置由 DATABASE_CONFIG_PATH 决定。SQLite 文件位置由 SQLITE_PATH 决定。Docker 与本地安装默认路径不同，见 [目录与日志](./paths-logs.md)。

环境变量可以覆盖数据库选择或连接信息，详见 [环境变量](./env-vars.md)。设置 DATABASE_TYPE / DB_TYPE 后，网页切换可能被启动环境重新覆盖，排障时应同时核对服务环境和配置文件，避免误连旧库。

复用已有数据库时，原管理员和业务数据继续存在；重装面板不会重置密码。

## Docker 中的数据库地址

| 数据库位置 | 填写方式 |
| --- | --- |
| 同一个 Docker 网络中的数据库容器 | 该网络可解析的服务名，例如 postgres |
| Docker 宿主机 | 宿主机可访问的内网地址，或已配置的 host.docker.internal |
| 其他服务器 | 从面板容器可达的域名或 IP |

容器中的 127.0.0.1 指向面板容器自身，而不是宿主机。安装脚本生成的 Compose 包含 host.docker.internal 的 host-gateway 映射；仓库原始 Compose 不包含，手动部署需按需在 forwardx 服务下添加：

~~~yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
~~~

需要支持 host-gateway 的 Docker 版本。数据库也必须监听容器能访问的地址，并允许相应来源账号连接；仅改主机名不能解决监听或授权问题。不要为方便连接而将数据库无认证暴露到公网。

## 连接异常怎么判断

| 提示 | 优先检查 |
| --- | --- |
| ENOTFOUND / getaddrinfo | 主机名、容器网络和 DNS |
| ECONNREFUSED / connection refused | 数据库是否启动、监听地址与端口 |
| timeout / ETIMEDOUT | 路由、安全组、防火墙、数据库负载 |
| access denied / authentication failed | 用户、密码、来源授权 |
| database does not exist / unknown database | 数据库名及是否已创建 |
| readonly / permission denied | SQLite 文件及父目录权限、磁盘挂载状态 |
| disk full / I/O error | 空间、inode、宿主机磁盘与内核日志 |

数据库异常时，面板提供独立异常提示与诊断信息；它不依赖业务数据库来展示故障状态。但若宿主机、Node 进程或反代本身失去响应，仍可能无法打开网页。

宝塔或 SysV 管理的 PostgreSQL 显示 active (exited)，只代表启动脚本执行完成，不代表数据库仍在运行。可在数据库所在宿主机只读检查：

~~~bash
ss -lntp | grep -E ':5432|:3306'
ps -ef | grep -E '[p]ostgres|[m]ysqld|[m]ariadbd'
~~~

端口按实际配置调整，并查看数据库自身的最新日志。不要依赖只适用于发行版 PostgreSQL 包的 pg_lsclusters 去判断宝塔安装的数据库。

## 备份与迁移

- [升级与备份](./upgrade-backup.md)：SQLite 在线一致备份、外部数据库备份及升级注意事项。
- [迁移到新面板](./migration.md)：普通迁移与旧地址转交的无缝模式。
- [管理员账号恢复](./account-recovery.md)：不删除数据库恢复密码。

数据库连接配置、备份文件和导出的日志可能包含敏感信息，不要直接公开。
