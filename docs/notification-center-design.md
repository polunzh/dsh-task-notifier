# 通知中心设计方案

> 2026-11-25 视觉改版 v2：行结构（应用瓦片 + 副行）、插件图标与重复结果合并见
> [notification-center-visual-refresh-design.md](./notification-center-visual-refresh-design.md)。

## 1. 背景与目标

现在 `dsh-task-notifier` 的提醒是「任务面板 + 系统通知 + 提示音」：任务面板是侧边栏里的一个入口，只有进入这个面板才看得到；系统通知是瞬时的，错过就没了。用户希望在**任何界面**都能很方便地看到通知，并且把它放在右上角。

同时希望这个通知位不只承接本插件的任务事件：其它插件、内置账号通知也能发到这里，成为一个统一的通知中心；系统通知/提示音的弹出也收敛成唯一出口，避免多个来源各自弹。

明确的方向（已与用户确认）：

- **并入 `dsh-task-notifier`**，不新建插件；
- 目前没有任何现成的右上角通知 UI，这次从零新建一个**右上角入口**；
- 来源**尽量都接入**（任务、账号通知、其它插件）；
- 系统通知/提示音的弹出发起**统一**到一处。

### 非目标

- 不替换 DSH 的应用根、不注入第二套应用；
- 不重做会话内的聊天流；
- 不把「瞬时 toast」改造成持久收件箱（见 §7.3 的取舍）。

## 2. 信息架构与入口

### 2.1 唯一入口：右上角铃铛

- 用 `shell.overlay`（root 作用域、跨所有主面板的浮层）承载一个 `fixed` 的**铃铛按钮**，固定在窗口右上角。它是唯一入口，在所有界面（会话页、插件页、设置页、无会话空白页）都可见。
- 铃铛上带**未读角标**：所有来源的未读总数（上限显示 `99+`）。
- 点击铃铛 → 在铃铛下方右侧对齐弹出**通知面板**（popover）。
- 原有侧边栏的「任务面板」入口移除，避免同一功能出现两个入口（符合「一个功能只留一处入口」）。完整的三列任务看板保留为面板里的「展开」目标页，供重度整理时使用。

> 为什么不用会话头右侧的 `conversation.session.header.utilities`：它是 session 作用域，只在打开会话时存在，设置页/插件页就没有；`shell.overlay` 是唯一真正覆盖「任何界面」的座位。代价是浮层需要自己处理与右上角现有窗口按钮/右栏展开按钮的避让。

### 2.2 面板结构

面板宽 `min(400px, 100vw - 24px)`，高 `min(640px, calc(100vh - 96px))`，圆角 16、面板投影、1px hairline。

从上到下：

1. **头部**：铃铛图标 + 标题「通知」+ 未读 chip；右侧「全部已读」文字按钮、关闭按钮。
2. **筛选条**：分段控件 `全部 / 未读 n / 待处理 n`；右侧来源筛选 `全部来源 ▾`（任务 / 账号 / 插件）。
3. **列表**：
   - 若存在待处理项，顶部固定「需要你处理」分组（琥珀色提示点），置顶展示「等你回复 / 等你审批」的任务；
   - 其余按时间倒序，按「今天 / 更早」分组；
   - 每项：来源图标 + 标题 + 一行正文 + 相对时间 + 未读点；可跳转项 hover 显示「打开」。
4. **底部**：「展开完整任务面板 ›」+「通知设置」。

### 2.3 窄屏

宽度 < 640px 时，面板变成**全屏下拉 sheet**：从顶部下滑，带拖拽把手，占满屏宽，列表可滚动，底部操作吸底。铃铛仍在右上角。

## 3. 通知模型

统一的一条通知：

```ts
type Source = 'task' | 'account' | 'plugin';
type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';

interface NotificationEntry {
  id: string;            // 稳定唯一，用于去重与已读
  source: Source;
  sourceLabel?: string;  // plugin 源的显示名，如「Hindsight」
  kind: string;          // completed | interrupted | needsInput | needsApproval | announcement | info | warning …
  title: string;
  body?: string;
  tone: Tone;
  ts: number;
  read: boolean;
  sessionId?: string;    // 可跳转会话
  actionLabel?: string;  // 自定义动作文案（默认「打开」）
  sticky?: boolean;      // 待处理置顶
}
```

- **未读**：每条自带 `read`；铃铛角标 = 未读总数。打开某项或进入对应会话即标已读；未读行 hover 时右侧出现对勾，可只标这一条；「全部已读」一次清空。
- **去重**：按 `id`（任务类用 `task:<sessionId>:<completedAt>`；账号类用公告 id；插件类由发布方给稳定 id）。
- **持久化**：宿主写 `$DSH_HOME/storages/dsh-task-notifier/notifications.json`，最多保留 200 条；账号公告的已读状态单独按 id 记录，正文仍以远端为准。

## 4. 来源接入

### 4.1 任务（本插件自身）

复用现有宿主任务表与事件：完成、中断（退出/欠费/报错）、等待回复、等待审批，都转成 `source: 'task'` 的通知。`completedAt`/中断原因等字段沿用现有 `core.js`。

### 4.2 账号通知（内置）

内置 `@deepseek-ai/dsh-client-ui-account-notifications` 通过 `ctx.remote.account.getNotifications / getNotificationContent / reportNotificationEvent` 拉取服务端公告，目前只显示在账号菜单里。通知中心把它作为 `source: 'account'` 的一类来源：`inject: ['remote','remote.account','accountUi']`（可选注入，缺失时该来源自动停用），面板打开时按需拉取，已读回报复用 `reportNotificationEvent`。

### 4.3 任意插件：公开发布契约

- **宿主侧**：`ctx.notifications.post(entry)`（Cordis 服务）。其它宿主插件 `inject: ['notifications']` 即可发布。参照 `dsh-better-sidebar` 的 `ctx.provide("betterSidebar", service)` 先例。
- **客户端侧**：本插件在客户端 `ctx.provide('notifications', hub)`，其它客户端插件 `inject: ['notifications']` 后 `ctx.notifications.post(...)`；也可用轻量的 `window.dshNotifications.post(...)` 约定（零依赖）。
- 若本插件未安装或服务不可用，发布方以**可选注入**优雅降级（不发即无）。

### 4.4 系统通知 / 提示音统一出口

所有来源都走宿主同一个 `dispatch(entry)`：

- 页面心跳在线 → 浏览器 `Notification`；离线或 `osNotify: "always"` → macOS 系统通知（`osascript`）；
- 提示音同一条路径；
- 按 `id` + 短窗口去重，避免「轮次收尾 + 状态翻转 + 会话级失败」重复弹；
- 浏览器构造失败时兜底交给宿主，沿用现有 `notification-reliability.md` 的修复。

这样任务、账号、插件三类通知不会各自弹一遍。

## 5. 视觉规范

- 全部使用 DSH token（`--dsw-alias-*`）；正文用次级色，时间用三级色，未读点用来源语义色。
- 铃铛 32×32 命中区（外扩到 40），圆角 8；hover `--dsw-alias-interactive-bg-hover`；focus 用 `--dsw-focus-ring-color`。
- 角标：红底白字胶囊，`min-width 16`、高 16、`font-size 10.5 / 600`，超过 99 显示 `99+`。
- 面板：`--dsw-elevation-prominent`，`--dsw-radius-lg`，hairline 边框；头部/筛选条 sticky，列表滚动。
- 列表项：高约 64，左来源图标 20，标题 13.5/600，正文 12.5 次级、单行省略，时间 11 三级右对齐；未读左侧 6px 圆点。
- tone 复用现有语义色：任务未读=绿、待处理=琥珀、中断=红/琥珀（与任务卡一致）；账号=蓝；插件=中性。
- 深色主题跟随宿主 token，不写死颜色。

## 6. 交互与无障碍

- 铃铛：`<button>` + `aria-label="通知"` + `aria-expanded`；角标带 `aria-label="未读 N 条"`。
- 面板：`role="dialog"`，打开时焦点进入面板，Esc 关闭，点击面板外关闭，关闭后焦点回到铃铛。
- 键盘：筛选分段可用 Tab/方向键；列表项回车打开。
- 窄屏 sheet：可下滑关闭；打开时锁滚动。
- 动效克制：仅淡入 + 轻微上移（120ms），`prefers-reduced-motion` 下关闭。

## 7. 关键取舍

1. **一个入口**：移除侧边栏任务面板图标，只保留右上角铃铛；三列看板通过「展开」进入。避免两处入口。
2. **客态双通道**：浏览器通知 + 系统通知的判定只在本插件做一次，别的来源不再自己弹。
3. **瞬时 toast 不进收件箱**：`workspace.toast` 是宿主内部 store（无对外服务/事件）驱动的 3 秒确认（复制成功、置顶失败等）。把它镜像进常驻收件箱既需要替换宿主渲染、又与「界面精简」冲突。**决定**：这类瞬时确认保持原样，不进通知中心；如果某个操作失败值得留痕，由对应插件通过 `post()` 主动上报。若后续确实要，再单独评估。

> 1.4.1 修正：真实的客户端 Cordis 上下文里直接访问未注入的 `ctx.remote` / `ctx.accountUi` 会抛错，导致整个 `apply` 失效（铃铛与侧边栏入口都不出现）；已改为 `ctx.get("remote")`。侧边栏任务面板入口保留。
4. **跨插件聚合只对「主动接入」生效**：中心无法凭空拦截任意插件的弹窗，接入靠 §4.3 的契约。这点会在 README 写清楚，避免过高预期。

## 8. 实施计划

1. **宿主（`lib/index.js` / `lib/core.js`）**
   - 新增通知存储与 `notifications` 服务（`post/list/markRead/markAllRead/subscribe`）；
   - 统一 `dispatch(entry)`：系统通知 + 提示音的单一出口，合并现有 osNotify/chime/去重逻辑；
   - 现有 `/task-notifier/api/*` 扩展：`/state` 带上通知列表，新增 `/readAll`、`/publish`（如需要）；
   - 任务来源继续用现有任务表生成 `task` 通知。
2. **客户端（`lib/client.js`）**
   - 把现有 store 泛化成「通知 + 任务」双模型，任务/账号/插件来源统一渲染；
   - 新增 `shell.overlay` 铃铛（`ctx.provide('notifications', hub)` 供其它客户端插件发布）；
   - 新增通知面板 popover / 窄屏 sheet；保留三列看板为「展开」目标页；
   - 移除 `sidebar.panellist` 入口。
3. **来源接入**
   - 账号通知桥（可选注入 `remote.account` / `accountUi`）；
   - 可选 `window.dshNotifications` 轻量约定。
4. **i18n**：面板、来源、tone、空态、无障碍文案补 zh / en。
5. **测试**：`core`/`host` 补通知模型、去重、统一出口、可选注入降级；`client` 补铃铛角标、面板筛选、已读联动。
6. **交付**：更新 README（中英）、高保真截图（中/英、宽/窄、深色）、`npm test`、按项目约定递增版本并发布。

## 9. 需要确认

- 侧边栏「任务面板」入口是否按 §7.1 移除，只留右上角铃铛（推荐移除）。
- §7.3：瞬时 toast 不进收件箱，是否接受。
- 账号通知作为来源默认开启，还是设置里默认关闭、用户手动开。
