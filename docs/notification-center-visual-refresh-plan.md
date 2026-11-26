# 通知中心视觉改版实施计划

配套设计：[notification-center-visual-refresh-design.md](./notification-center-visual-refresh-design.md)；高保真稿：[design/notification-center-v2/index.html](./design/notification-center-v2/index.html)。
基线 `1.4.10`，当前目标版本 `1.4.15`（1.4.13/1.4.14 两次迭代的图标方案已按反馈移除）。

## 1. 数据层（lib/core.js）

- `NotificationEntry` 增加 `count`（正整数，缺省 1，上限 999）。
- `normalizeNotificationEntry` 透传并夹取 `count`；旧状态文件缺字段时按 1 处理。
- `taskEntryKey(sessionId, kind)`：`task:<sessionId>:<completed|interrupted>`。
- `parseNotifications` 读取时把旧的 `task:<sid>:<ts>` 折叠到新 key（`count` 累加、`ts` 取最大、未读优先）。
- 测试：count 夹取、迁移折叠、正常条目不受影响。

## 2. 宿主（lib/index.js）

- `notifyTaskResult`：id 用 `taskEntryKey`；再次写入时 `count += 1`、`ts = at`、`read = false`。
  - 系统通知 / 提示音仍按事件触发，只有收件箱条目合并。
- 不新增任何图标路由；1.4.13 加的 `/sources` 已在 1.4.15 移除。
- 测试：连续完成只有 1 条 / count 累加 / 未读 1；完成后再中断是 2 条；已读后再次完成重新未读。

## 3. 客户端（lib/client.js）

- 行组件：`dtn-ni__tone`（3×16 色条，`rowTone()` 决定绿/琥珀/红/蓝/灰）+ 未读点 + 标题/时间 + 可选副行。
- 副行：插件来源以「插件：<name>」开头（`center.pluginPrefix`），后接合并次数 / 中断原因 / 正文。
- 删除：应用瓦片、状态徽标、图标请求与缓存（`readSourceIcons`、`sourceIconCache`、`<img>`）。
- 筛选：漏斗按钮 + 菜单；分段控件计数只在 > 0 时渲染。
- 文案：`center.countCompleted`、`center.countInterrupted`、`center.sourceMenu`；中英同步。
- 测试：色条类名、副行来源文字、无 `dtn-ni__tile` / `/sources` / `img` 残留。

## 4. 视觉验证

- `npm run preview` + `npm run screenshot`：`center-light.png` / `center-dark.png` / `center-light-en.png`。
- 对照设计稿核对：色条颜色、行高 44/62、分隔线缩进 14、未读点、副行来源文字。
- 深浅色、中英各一张；窄屏用设计稿 `mockup-zh.png` 的窄屏示例对照。

## 5. README

- 中英双语同步：截图换成 `preview/screenshots/center-*.png`，功能描述改成「色条标状态、副行写插件名、重复完成合并一行」。

## 6. 发版

1. `npm test` 全绿。
2. `package.json` 递增到 `1.4.15`。
3. commit（英文）、push main，`publish.yml` 走 OIDC 把版本放进 npm staged 队列。
4. 在 npmjs.com 批准后，到 DSH 的 Plugins → Installed 更新。

## 7. 风险

| 风险 | 处理 |
| --- | --- |
| 旧通知 id 与新 id 并存 | 读取时迁移折叠（§1） |
| 合并后用户想回看每次完成 | 三列看板仍按会话展示；本轮不做二级展开 |
| 用户仍想在行内看到插件图标 | 已按反馈移除；需要时再作为可选项加回，不影响数据结构 |
