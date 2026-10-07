import { defineConfig } from "vitepress";

const base = process.env.VITEPRESS_BASE || "/";

export default defineConfig({
  base,
  lang: "zh-CN",
  title: "ForwardX",
  description: "ForwardX 转发管理面板用户教程",
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ["meta", { name: "theme-color", content: "#0f766e" }],
    ["meta", { name: "referrer", content: "strict-origin-when-cross-origin" }],
  ],
  themeConfig: {
    siteTitle: "ForwardX 教程",
    nav: [
      { text: "快速开始", link: "/guide/quick-start" },
      { text: "部署面板", link: "/guide/deploy-panel" },
      { text: "文档目录", link: "/guide/" },
      { text: "常见问题", link: "/guide/troubleshooting" },
      { text: "GitHub", link: "https://github.com/poouo/Forwardx" },
    ],
    sidebar: [
      {
        text: "开始使用",
        items: [
          { text: "文档目录", link: "/guide/" },
          { text: "快速开始", link: "/guide/quick-start" },
          { text: "部署前准备", link: "/guide/preparation" },
          { text: "首次初始化", link: "/guide/first-setup" },
          { text: "移动客户端（APK / IPA）", link: "/guide/mobile-app" },
        ],
      },
      {
        text: "面板部署与配置",
        items: [
          { text: "部署总览", link: "/guide/deploy-panel" },
          { text: "Docker 部署", link: "/guide/deploy-docker" },
          { text: "本地部署", link: "/guide/deploy-local" },
          { text: "数据库配置", link: "/guide/database" },
          { text: "HTTPS 与反向代理", link: "/guide/reverse-proxy" },
          { text: "环境变量", link: "/guide/env-vars" },
        ],
      },
      {
        text: "Agent、链路与转发",
        items: [
          { text: "安装 Agent", link: "/guide/agent" },
          { text: "主机管理", link: "/guide/hosts" },
          { text: "转发规则与单规则限额", link: "/guide/rules" },
          { text: "流量和延迟", link: "/guide/traffic-latency" },
          { text: "隧道链路", link: "/guide/tunnels" },
          { text: "端口转发链", link: "/guide/port-chains" },
          { text: "转发组、入口组与出口组", link: "/guide/groups" },
          { text: "DDNS 和故障转移", link: "/guide/ddns" },
          { text: "PROXY Protocol", link: "/guide/proxy-protocol" },
        ],
      },
      {
        text: "账户与系统功能",
        items: [
          { text: "用户、套餐和权限", link: "/guide/users-billing" },
          { text: "Telegram / Discord 和通知", link: "/guide/notifications" },
          { text: "AI 助手", link: "/guide/ai-assistant" },
          { text: "Google 账户登录", link: "/guide/google-login" },
        ],
      },
      {
        text: "运维与排障",
        items: [
          { text: "目录、数据与日志", link: "/guide/paths-logs" },
          { text: "管理员账号恢复", link: "/guide/account-recovery" },
          { text: "升级与备份", link: "/guide/upgrade-backup" },
          { text: "迁移到新面板", link: "/guide/migration" },
          { text: "常见问题排查", link: "/guide/troubleshooting" },
          { text: "卸载与数据保留", link: "/guide/uninstall" },
        ],
      },
      {
        text: "开发与扩展",
        items: [
          { text: "本地开发", link: "/guide/development" },
          { text: "插件与扩展开发", link: "/guide/plugins" },
          { text: "架构参考", link: "/ARCHITECTURE_CN" },
          { text: "支付接入参考", link: "/PAYMENT_CN" },
        ],
      },
    ],
    outline: {
      level: [2, 3],
      label: "本页目录",
    },
    docFooter: {
      prev: "上一页",
      next: "下一页",
    },
    lastUpdated: {
      text: "最后更新",
      formatOptions: {
        dateStyle: "medium",
        timeStyle: "short",
      },
    },
    search: {
      provider: "local",
      options: {
        translations: {
          button: {
            buttonText: "搜索文档",
            buttonAriaLabel: "搜索文档",
          },
          modal: {
            displayDetails: "显示详细列表",
            resetButtonTitle: "清除搜索",
            backButtonTitle: "关闭搜索",
            noResultsText: "没有找到结果",
            footer: {
              selectText: "选择",
              selectKeyAriaLabel: "回车",
              navigateText: "切换",
              navigateUpKeyAriaLabel: "上箭头",
              navigateDownKeyAriaLabel: "下箭头",
              closeText: "关闭",
              closeKeyAriaLabel: "ESC",
            },
          },
        },
      },
    },
    socialLinks: [{ icon: "github", link: "https://github.com/poouo/Forwardx" }],
  },
});
