# 插件通知点击跳转 · 设计 + 计划

## 1. 问题

通知中心里插件来源的行（如 dsh-todo 的番茄提醒）点击后只标已读、收起面板，无任何跳转。行本身带 `role="button"` 与手型光标，用户预期点击会发生什么，但 `openEntry` 只有 `entry._notice`（账号）与 `entry.sessionId`（任务）两条分支，插件来源两头都落空。浏览器通知的 `openNotification` 同样在 `!entry?.sessionId` 时直接返回。

设计稿（notification-center-design.md）预留过 `actionLabel`，从未接线；宿主 `layout.selectPanel(panelId)` 服务现成可用（dsh-todo 的 `openPanel()` 即用它），缺的只是发布契约里的目标字段。

## 2. 设计

### 2.1 发布契约新增可选字段 `panelId`

```js
window.dshNotifications.post({
  id, source: "plugin", sourceLabel, title, body, tone,
  panelId: "dsh-todo",   // 可选：发布方注册在 main 槽位的面板 key
});
```

- 归一化规则与 `sessionId` 相同（`normalizeId`：非空、≤128、无控制字符），落在 `lib/core.js normalizeNotificationEntry`。
- 宿主服务 `ctx.notifications.post()` 与客户端 `window.dshNotifications.post()` / `/publish` 路由共用同一归一化，两条发布路径行为一致。
- 没有主面板的插件不传，行为维持现状（仅标已读）。
- 安全性：`selectPanel` 由宿主校验目标必须已注册，未注册即抛错；`panelId` 只能引导到已注册面板，无注入面（React 文本节点，无 DOM 拼接）。

### 2.2 点击行为（行点击 / 键盘 Enter·Space / 浏览器通知点击共用语义）

1. 有 `sessionId` → `uiWorkspace.openSession`（现有，优先级最高：直达内容本身）。
2. 无 `sessionId`、有 `panelId` → 收起面板 → `layout.selectPanel(panelId)`，try/catch 静默失败（面板未注册 / layout 服务缺失时等同现状）。
3. 账号公告 → 维持只读标已读。
4. 插件来源跳转时同步 `markNotificationRead`：没有会话切换来兜底已读（任务的已读靠 selection 订阅同步），必须显式标。

### 2.3 视觉与交互入口

零改动。行样式、文案、光标、无障碍标签全部保持；「一个功能一个入口」——行点击本身就是动作，不加「打开」链接或按钮。

### 2.4 已知边界

- macOS 系统通知（osascript `display notification`）点击无法携带回调，只聚焦应用；跳转只在通知中心行与浏览器通知上生效，README 注明。
- 面板已注册但插件后被禁用：`selectPanel` 抛错被捕获，行点击退化为标已读，不报错不卡死。

## 3. 计划

### dsh-task-notifier（1.4.17 → 1.5.0，minor：契约新增字段）

1. `lib/core.js`：`normalizeNotificationEntry` 增加 `panelId`（`normalizeId` 归一化，默认 null）。
2. `lib/client.js`：
   - `openEntry`：新增 panelId 分支（收起面板 + `ctx.layout?.selectPanel?.()` + try/catch）。
   - `openNotification`（浏览器通知点击）：panelId 分支同上，并补 `markNotificationRead`。
3. 测试：
   - `test/core.test.js`：panelId 合法值保留、超长/含控制字符/非字符串回落 null。
   - `test/client-panel.test.js`：结构断言——openEntry 与 openNotification 均含 panelId → selectPanel 接线，sessionId 优先。
   - `test/host.test.js`：`/publish` 往返保住 panelId。
4. `README.md` / `README.zh-CN.md`：发布契约补 `panelId` 与点击语义、系统通知边界。
5. commit → 版本 1.5.0 → push（publish.yml staged，npmjs.com 上点 Approve）。

### dsh-todo（0.2.18 → 0.2.19）

1. `lib/client.js` `publishPomodoroNotice` 条目加 `panelId: PANEL_ID`（"dsh-todo"）。
2. `test/pomodoro-notify.test.js` 断言条目含 panelId。
3. commit → 版本 0.2.19 → push → npm Approve。

### 验证

- 两仓库 `npm test` 全绿。
- 真机手测：跑一轮短番茄（或 /test 触发插件条目）→ 通知中心行点击 → 主面板切到 dsh-todo；dsh-todo 禁用状态下点击不报错。
- 浏览器通知点击路径在页面在线时手测一次。

## 4. 非目标

- 不做通用 action 回调机制（`{type, payload}` 一类），两个真实字段够用。
- 不给账号公告加跳转。
- 不改系统通知的点击能力（平台限制）。
- 不动行视觉与合并/去重逻辑。
