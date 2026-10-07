# 管理员账号恢复

忘记管理员密码时，使用随面板发布的交互式重置工具。不要删除数据库、重建数据卷或期待 ADMIN_PASSWORD 环境变量重设密码。

## Docker 部署

容器需运行，容器名按实际替换：

~~~bash
docker exec -it forwardx-panel node dist/reset-admin-password.js
~~~

也可先进入容器，再执行同一个工具：

~~~bash
docker exec -it forwardx-panel sh
node dist/reset-admin-password.js
~~~

## 本地安装

默认安装目录：

~~~bash
sudo bash /opt/forwardx-panel/scripts/install-panel-local.sh reset-admin
~~~

安装脚本也支持 reset-password 别名；Docker 安装脚本的 reset-admin 动作会调用容器内工具。

## 行为和注意事项

- 执行前先 [备份数据库](./upgrade-backup.md)，确保工具连接的是当前面板使用的数据库。
- 需要交互式终端；密码隐藏输入，不作为命令行参数传递。
- 有多个管理员时按提示选择用户名或邮箱。
- 重置后撤销该管理员已有登录会话，不清除两步验证设置。
- 被禁用的管理员默认仍保持禁用；仅在确认需要重新启用时，为重置命令追加 --enable-account。
- 数据库不可连接时，应先修复连接，工具不能绕过数据库故障。
- 本地自定义部署须加载与面板相同的环境和数据库配置，不能从任意工作目录运行后误改另一套数据库。

Google 绑定与密码是不同的登录能力；Google 登录及解绑规则见 [Google 账户登录](./google-login.md)。
