import { applicationCatalog } from "../plugins/applicationCatalog";

/** Only navigation destinations are registered. Detail/editor views never opt in. */
export const detachablePageTitles = {
  home: "首页", monitorAlerts: "监控预警", accounts: "账号管理", resources: "资产管理",
  favorites: "我的收藏", panels: "面板管理", servers: "终端管理", certificates: "HTTPS 证书",
  authenticator: "身份验证器", flow: "云效流水线", claude: "Claude 管理", codex: "Codex 管理",
  frp: "内网穿透", notes: "备忘录", logs: "操作日志", api_logs: "API 日志", settings: "系统设置",
} as const;

// Each software destination has a stable owner while other pages are selected.
export const softwarePageDestinations = [
  { id: undefined, title: "软件商店" },
  ...applicationCatalog.filter(app => !app.section).map(app => ({ id: app.id, title: app.name })),
];
