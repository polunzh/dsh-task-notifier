# 通知中心实施计划

配套设计：[notification-center-design.md](./notification-center-design.md)；高保真稿：[design/notification-center/](./design/notification-center/index.html)。

## 1. 已确认决策

- 并入 `dsh-task-notifier`，不新建插件。
- 唯一入口：右上角 `shell.overlay` 铃铛；**移除侧边栏「任务面板」入口**，三列看板保留为面板「展开」目标页。
- 聚合三类来源：任务事件、内置账号通知、任意插件（契约发布）。
- 系统通知 / 提示音收敛为宿主单一 `dispatch` 出口。
- 瞬时 `workspace.toast` 不进收件箱。
- 账号通知来源默认开启，面板打开时按需拉取。

## 2. 现状与基线

- 宿主 `lib/index.js`（939 行）：维护任务表、`/task-notifier/api/*` 路由、系统通知兜底；`inject: ["webServer","connection","sessionQuery"]`。
- 客户端 `lib/client.js`（2719 行）：`createStore()` 轮询、任务三列看板、`sidebar.panellist` 图标、`main` 页、提示音与浏览器通知。
- `lib/core.js`（409 行）：状态归一化、净化、限长、事件分类。
- 测试 90 个，基线全绿（`node --test`）。
- 现有持久化：`$DSH_HOME/storages/dsh-task-notifier/state.json`（任务表）。

## 3. 数据与契约

### 3.1 通知条目（core.js 归一化）

```ts
type Source = 'task' | 'account' | 'plugin';
interface NotificationEntry {
  id: string; source: Source; sourceLabel?: string; kind: string;
  title: string; body?: string; tone: 'default'|'success'|'warning'|'error'|'info';
  ts: number; read: boolean; sessionId?: string; actionLabel?: string; sticky?: boolean;
}
```

- 所有进入存储/通知的文本复用 `sanitizeText` + 限长；`title`/`body` 长度上限沿用或新增常量。
- 去重键：任务 `task:<sessionId>:<completedAt>`；账号 `account:<noticeId>`（已读回报）；插件由发布方给稳定 `id`。
- 上限：持久化最多 200 条，超出按时间淘汰已读优先。

### 3.2 宿主服务 `notifications`

Cordis 服务（`index.js` 内 `ctx.provide('notifications', service)`，并导出类型/README 说明）：

```
post(entry) -> NotificationEntry      // 校验、净化、去重、入库、触发 dispatch
list(opts?) -> NotificationEntry[]
markRead(ids) / markAllRead()
dismiss(id)
subscribe(fn) -> dispose
```

其它宿主插件 `inject: ['notifications']` 后调用；未安装时发布方用可选注入降级。

### 3.3 客户端契约

- 本插件客户端 `ctx.provide('notifications', hub)`，`hub.post(entry)` 走宿主；其它客户端插件 `inject: ['notifications']`。
- 轻量兜底：`window.dshNotifications = { post }`，零依赖发布（README 记录 shape）。
- 面板数据仍走 `/task-notifier/api/state` 轮询（与既有 long-poll `/wait` 复用）。

### 3.4 HTTP 路由（沿用 `/task-notifier/api` 前缀与鉴权）

- `GET /state`：返回 `{ tasks, notifications, settings, rev, now }`。
- `GET /wait`：扩展现有长轮询，`rev` 变化即返回。
- `POST /read`（ids）、`POST /readAll`。
- 安全边界不变：`connection.requestRejection` fail-closed、写操作要求 `application/json`、冷却与并发上限沿用。

### 3.5 统一出口

`dispatch(entry)` 决定浏览器通知 / 系统通知 / 提示音：

- 心跳在线 → 浏览器 `Notification`；离线或 `osNotify: always` → macOS `osascript`；
- 按 `id` + 短窗口去重；浏览器构造失败兜底宿主；
- 任务、账号、插件统一走这里，账号/插件不再各自弹。

## 4. 分阶段任务

### Phase 0 · 基线
- 建分支 `feat/notification-center`；`npm test` 绿。**验证**：90 pass。

### Phase 1 · 宿主通知模型与出口
- `lib/core.js`：新增 `normalizeNotification`、条目标识/去重/淘汰、`parseNotifications`、限长常量；保留现有任务函数不动。
- `lib/index.js`：通知内存表 + `notifications.json` 持久化；`ctx.provide('notifications', …)`；`dispatch()` 合并现有系统通知/提示音；`/state`、`/read`、`/readAll` 扩展。
- **验证**：`test/core.test.js` 加归一化/去重/淘汰；`test/host.test.js` 加服务 post/read、state 携带、dispatch 去重、可选注入降级。

### Phase 2 · 任务来源桥接
- 现有完成/中断/等待回复/审批路径生成 `task` 通知，复用 `completedAt`、中断字段；不改任务表语义。
- **验证**：host 用例断言完成/中断/等待各产生对应通知，重复上报不重复。

### Phase 3 · 客户端模型
- 泛化 store：`tasks` 与 `notifications` 双模型；`unreadCount` 来自通知；保留 `syncActiveSessionRead`。
- **验证**：`test/client-notify.test.js` 扩展；store 单测（可在 node 环境抽取纯函数）。

### Phase 4 · 铃铛与面板 UI
- `lib/client.js`：`shell.overlay` 注册铃铛（`ctx.slots.inject('shell.overlay', …)`），角标、popover、窄屏 sheet、空态/连接异常；`role=dialog`、Esc、点外关闭、焦点回归。
- 移除 `sidebar.panellist` 注册；`main` 页保留为「展开」目标（面板底部按钮 `ctx.layout.selectPanel(PANEL_ID)`）。
- 主题：只用 `--dsw-alias-*`；深色跟随。
- **验证**：扩展 `preview/` mock 与 `scripts/screenshot.mjs` 生成新截图；无头 Chrome 校验铃铛/面板渲染。

### Phase 5 · 其它来源接入
- 客户端 `ctx.provide('notifications', hub)` + `window.dshNotifications` 约定；README 写明 shape。
- 账号通知桥：可选注入 `remote`、`remote.account`、`accountUi`（缺失即停用）；面板打开时拉取、已读回报 `reportNotificationEvent`。
- **验证**：host/client 用例覆盖可选服务缺失时不报错；手动用真实账号通知冒烟。

### Phase 6 · i18n / 文档 / 发布
- `lib/client.js` 中英字典补齐面板、来源、tone、空态、无障碍。
- README.md / README.zh-CN.md 更新；新增截图（中/英、宽/窄、深色）。
- `npm test` 全绿；按 semver 递增 `package.json` version；commit + push；发布走既有 OIDC 流程。

## 5. 兼容与迁移

- `state.json` 结构不变；新增 `notifications.json` 独立文件。旧版本任务数据照常读取。
- 移除侧边栏入口对既有用户是可见变化：旧书签/main 面板 key 保留，仍可通过面板「展开」进入。
- 缺失 `remote.account` / `accountUi` 的部署：账号来源自动隐藏，其余正常。
- 其它插件未接入：无影响。

## 6. 风险

1. **右上角遮挡**：`shell.overlay` 浮层需避开右栏展开/窗口按钮；多屏宽实测。
2. **双弹**：务必把任务现有系统通知迁到 `dispatch`，不留旧路径。
3. **账号通知请求放大**：面板打开才拉取，复用已读回报；避免重复轮询。
4. **client.js 体量大**：先抽纯逻辑到可测函数，再改 UI，避免回归。
5. **移除侧栏入口的接受度**：设计已标注；如需保留可加 config 开关。

## 7. 验证与发布

- `npm test`（全部用例）。
- `node scripts/screenshot.mjs`（扩展后）生成中/英、宽/窄、深色截图并断言关键 DOM。
- 手动：窄屏 sheet、Esc/点外关闭、角标联动、账号来源缺省。
- 发布：递增版本 → commit/push → `publish.yml` OIDC 自动发 npm（版本已存在会跳过，必须先递增）。
