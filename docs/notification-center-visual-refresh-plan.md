# 通知中心视觉改版（v2）实施计划

配套设计：[notification-center-visual-refresh-design.md](./notification-center-visual-refresh-design.md)；高保真稿：[design/notification-center-v2/index.html](./design/notification-center-v2/index.html)。
基线 `1.4.10`，目标版本 `1.4.11`。

## 0. 前置

- 工作区已有一处未提交改动（`任务面板`入口从头部移到底部整宽按钮）。它属于本次改版的一部分，先并入同一批提交，不单独发版。
- 现状测试 98 个全绿（`npm test`）。

## 1. 数据层（lib/core.js）

- `NotificationEntry` 增加 `count`（正整数，缺省 1，上限 999）。
- `normalizeNotificationEntry` 透传并夹取 `count`；旧状态文件里没有该字段时按 1 处理。
- 新增 `mergeTaskEntryKey(sessionId, kind)`：返回 `task:<sessionId>:<completed|interrupted>`，宿主与测试共用。
- `parseNotifications` 兼容旧 id：读取时把 `task:<sid>:<ts>` 折叠到新 key（`count` 累加、`ts` 取最大、`read` 取与），避免升级后新旧条目并存。
- 测试：count 夹取、迁移折叠、正常条目不受影响。

## 2. 宿主（lib/index.js）

- `notifyTaskResult`：id 改为 `mergeTaskEntryKey(sessionId, kind)`；再次写入时 `count += 1`、`ts = at`、`read = false`。
  - 系统通知 / 提示音仍按事件触发（每次完成/中断都响），只有收件箱条目合并——`dispatchEntry` 行为不变。
- 新增只读路由 `GET /task-notifier/api/sources`（前缀、鉴权、`connection.requestRejection` 与现有路由一致）：
  - 数据来自 `ctx.get("pluginManager")?.listBundles()` / `listPlugins()`，取 `meta.icon`（data URL）与 `meta.title`、`name`；
  - 索引三种键：包名全名、去 scope 名、显示名；
  - 结果按 10 分钟缓存；单个 icon 超过 64KiB 跳过；最多 40 条；
  - pluginManager 缺失或抛错 → 返回 `{ sources: [] }`，客户端降级，不报错给用户。
- 测试：连续完成 5 次只有 1 条 / count=5 / 未读 1；完成后再中断是 2 条；已读后再次完成重新未读；sources 路由正常与降级路径。

## 3. 客户端（lib/client.js）

- 行组件重写：`dtn-ni__tile`（28px）+ 可选状态徽标 + 未读点 + 标题/时间 + 可选副行；删除 `dtn-ni__tone` 色条、来源 chip、`dtn-ni__open`。
- 副行规则：`count > 1` → 「完成 N 次 / 中断 N 次」；否则正文；中断结果文案用 warn/err 色。
- 图标：`sourceIcons` 从 `/api/sources` 拉取（打开面板时、10 分钟 TTL、只拉一次），`task` / `account` 用内置 SVG 瓦片，`plugin` 用 `<img>` + `onError` 降级到拼图瓦片。
- 筛选：来源 select 换成漏斗按钮 + 菜单；分段控件计数只在 > 0 时渲染。
- 头部：只留「全部已读 / 关闭」（任务面板已在底部）。
- 文案：`center.countCompleted`、`center.countInterrupted`、`center.sourceMenu`、`center.icon.*`；中英都要。
- 测试：行结构（含 img、无 chip/rail）、计数文案、降级路径、筛选菜单可访问性（aria-expanded / role=menu）。

## 4. 视觉验证

- 用 `npm run preview` + Chrome 截图，按设计稿逐项比对：行高 44/62、分隔线起点 54px、未读点、徽标位置。
- 深浅色各一张、中英各一张、400px（面板）与 390px（窄屏 sheet）各一张。
- 更新 `docs/design/notification-center/*.png` 与 README 里引用的图。

## 5. README

- 中英双语同步：把「通知中心」小节改成新截图 + 一句「来源用插件自己的图标，重复完成合并为一行」。
- 版本号、截图链接不变结构，只换图与描述。

## 6. 发版

1. `npm test` 全绿；`node test/e2e/native-slot.js` 不被本改动影响，可跳过（无 slot 变更）。
2. `package.json` 版本 `1.4.10` → `1.4.11`。
3. commit（英文）、push main，`publish.yml` 走 OIDC 发布。
4. 在 Desktop 里实测一次：dsh-todo 通知出现其图标；连续完成两次同会话只多一行。

## 7. 风险

| 风险 | 处理 |
| --- | --- |
| `pluginManager` 在旧版 DSH 上没有或签名不同 | 可选注入 + try/catch，全部降级到内置瓦片 |
| 图标 payload 过大 | 10 分钟缓存、单条 64KiB 上限、只拉一次 |
| 旧通知 id 与新 id 并存 | 读取时迁移折叠（§1） |
| 合并后用户想回看每次完成 | 三列看板仍按会话展示；本轮不做二级展开 |
