# 通知列表里的任务进度 · 实施计划

配套设计：[inbox-task-progress.md](./inbox-task-progress.md)；高保真稿：[design/inbox-task-progress/index.html](./design/inbox-task-progress/index.html)。
基线 `1.4.18`（`npm test` 118 项全绿）→ 目标 `1.4.19`。

## 1. 已确认决策（2026-11-27）

- 运行中行**混进「今天」**，不单独成区；排在今天通知行前，按 `changeAt` 倒序。
- 子代理默认展开前 3 行；第 4 行起折成「还有 N 个 ›」，点击进任务面板看完整树。
- 铃铛角标、头部 chip、`未读` 分段都不统计运行中。
- 不改宿主接口、发布契约与三列看板。

## 2. 数据与渲染口径

全部在客户端 `lib/client.js` 内完成，数据源是 `store.state.tasks`（`/state` 快照，已带 `running / startedAt / needsInput / parentId / parentTitle / interrupted / unread`）。

### 2.1 分组

```
runningGroups(tasks):
  live = tasks.filter(t => t.running && !t.needsInput)
  liveIds = Set(live.id)
  kids = tasks.filter(t => t.parentId && !t.needsInput)   // 等待中的子代理不重复进组
  roots = live.filter(t => !t.parentId || !liveIds.has(t.parentId))
  groups = roots.sort(changeAt desc).map(root => ({
    root,
    from: root.parentId ? parentTitle : null,             // 父没在跑 → 提升为根，标「来自」
    children: kids.filter(k => k.parentId === root.id)
                  .sort(running first, changeAt desc),
    childTotal,
    runningCount,
  }))
  cap: groups 3, children 3
```

- 父标题优先用快照里的 `parentTitle`，缺失时回退 `tree.parentFallback`。
- 子代理由 `parentId` 直接挂父；`depth ≥ 2` 不展示。
- 统计口径与展示一致：`N 个子代理` / `N 运行` 只数面板里这组（不含等待回复的子代理）。

### 2.2 结果行分组规模

`childCount(sessionId) = tasks.filter(t => t.parentId === sessionId).length`。

- 只对 `entry.source === "task"` 的行生效；`childCount > 0` 时副行追加 `tree.children`。
- 读时计算，不写进通知；任务表裁剪后自然消失。

### 2.3 位置、计数与空态

- `todayRows = [...runningRows, ...todayFeedRows]`；`earlierRows` 只放历史通知。
- 运行中行只在 `filter === "all"` 且 `sourceFilter === "all" || "task"` 时渲染。
- `totalUnread` 公式不变。
- 空态条件：`!pinnedRows.length && !todayRows.length && !earlierRows.length`。

### 2.4 计时

- 面板打开且存在运行中任务时，`setInterval(1000)` 更新本地 `clock`，用于 `card.runningFor` 的 `relativeTime`；关闭或没有运行中任务时清除。
- 不新增轮询；任务状态变化仍由现有 `/wait?rev` 拉取。

## 3. 改动清单

| 文件 | 改动 |
| --- | --- |
| `lib/client.js` | 新增 `runningGroups()`、`childCounts()`、`RunningGroup`；`NotificationCenterRoot` 混入今天；`rowMeta` 接受子代理数；`clock` 计时；CSS 与 zh / en 文案 |
| `test/client-panel.test.js` | 新增 4–5 条源码结构断言（见 §5） |
| `preview/index.html` | `seedTasks()` 补 1 条独立运行任务 |
| `scripts/screenshot.mjs` | 复用现有 `center-light / center-dark / center-light-en` |
| `preview/screenshots/*.png` | 重新生成 |
| `README.md` / `README.zh-CN.md` | 功能段补「运行中任务与子代理分组」；截图表更新 |
| `package.json` | `1.4.19` |

## 4. 步骤

1. **文案**：`center.childDone / center.childInterrupted / center.moreChildren / center.moreRunning`，zh / en 同步。
2. **分组函数**：`runningGroups()` 先跑通「1 个运行中」与「父 + 3 子」；处理父没在跑时的提升。
3. **渲染**：`RunningGroup`（根行 + `.dtn-nr__tree` + `.dtn-live` 流动条 + 溢出链接），插在「今天」区块最前。
4. **筛选与空态**：未读 / 待处理 / 来源筛选按 §2.3 调整。
5. **结果行**：`rowMeta(entry, childCount)` 追加分组规模；`NotificationRow` 传入。
6. **计时与无障碍**：1s `clock`；`aria-label` 用 `row.openState` 的「标题（状态）」格式；`prefers-reduced-motion` 停流动条。
7. **预览与截图**：`seedTasks()` 补独立运行任务，`npm run screenshot` 出 `center-*`。
8. **测试与质量门**：`npm test`、截图人工核对中英 / 深浅 / 390 窄屏。
9. **文档与发版**：README 中英、版本 `1.4.19` → commit → push → 在 npmjs.com 批准 staged 发布。

## 5. 测试

`test/client-panel.test.js` 增补（源码结构断言，与现有风格一致）：

- 运行中行只在 `filter === "all"` 且来源为 all/task 时渲染；未读 / 待处理不出现。
- 根行副行带 `tree.children` + `tree.childStatsRunning`，且根行渲染 `.dtn-live`。
- 子行有缩进容器（`.dtn-nr__kids`）与三态图标；没有未读点、没有标已读按钮。
- 今天区块包含运行中行；空态条件包含运行中。
- `rowMeta` 对任务行追加 `tree.children`；账号 / 插件行不带。
- zh / en 都补了 4 个新 key。

`runningGroups()` 留在 `lib/client.js`（浏览器 bundle，不能直接 import）；断言落在函数结构与调用关系上，不拼 HTML 字符串。

## 6. 验证

- `npm test`（118 + 新增）全绿。
- `npm run screenshot` 三张 `center-*` 能看到运行中行；截图无裁切、无重叠。
- 预览页手工：`?state=filled&view=panel`（浅色 / 深色 / 英文 / 390 宽）。
- 真机回归：开一个会长跑的任务（或 AgentTeams 成员），确认运行中行出现在「今天」最前、时长每秒走、结束后消失并在今天出现结果行；铃铛角标不因运行中增加。
- 断网 / 宿主重启：面板显示上次快照，错误条仍在。

## 7. 发版

- README（中 / 英）功能段与截图。
- `package.json` `1.4.19`；提交信息 `feat: show running tasks and task groups in the notification list`。
- push 后 `publish.yml` 进 staged 队列，需要到 npmjs.com 点 Approve 才进 registry。

## 8. 回滚

改动集中在 `lib/client.js` 的渲染与样式；回滚即撤回该文件与新文案，宿主与持久化格式不变，不需要迁移。
