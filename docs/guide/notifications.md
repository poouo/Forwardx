# Telegram 和通知

Telegram 机器人可以用于：

- 用户绑定 Telegram。
- 查询用量。
- 查询规则。
- 一键登录。
- 管理员接收主机上下线通知。
- 到期提醒。
- 服务器续费提醒。

## 配置步骤

1. 在 Telegram 找到 `@BotFather`。
2. 创建机器人并复制 Bot Token。
3. 进入 ForwardX：

```text
系统设置 -> Telegram
```

4. 填写 Token 并保存。
5. 开启需要的通知开关。

## 注意事项

- 必须先配置好机器人，才能开启相关提醒。
- 服务器需要能访问 Telegram API。
- 主机短暂升级重启通常不会立刻误报离线。
- 如果通知发不出去，先检查 Bot Token 和服务器网络。

