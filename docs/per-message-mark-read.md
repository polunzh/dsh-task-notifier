# 单条消息标为已读 · 设计 + 计划

高保真稿：[design/per-message-mark-read/index.html](./design/per-message-mark-read/index.html)　·　截图：[mockup-zh.png](./design/per-message-mark-read/mockup-zh.png)
基线：`1.4.17`（行 = 3px 色条 + 标题 + 副行，打开即标已读）

## 1. 问题

通知面板里的每条消息目前只有一个动作：点整行 → 标已读 + 跳转会话 + 收起面板。头部只有「全部已读」。
用户要在不离开面板、不跳转的前提下确认单条消息，没有入口；一条未读要么点开跳走，要么等「全部已读」一起清掉。

## 2. 方案

未读行在 hover / 键盘聚焦时，把右侧时间替换成一枚 22px 圆形对勾按钮；点击只标已读，不跳转、不收起面板。已读行不出现任何按钮。

```
┌─────────────────────────────────────────────┐
│ ▎ ● 审查通知中心合并策略        7 分钟前     │   未读 · 默认
│   任务 · 完成 5 次                           │
├─────────────────────────────────────────────┤
│ ▎ ● 休息结束                          (✓)   │   未读 · hover / focus
│   插件：dsh-todo · 回来继续专注吧。           │
├─────────────────────────────────────────────┤
│ ▎   番茄提醒接入通知中心        14 分钟前     │   已读 · 无按钮
│   任务                                      │
└─────────────────────────────────────────────┘
```

选这个入口的理由：

- 行宽度只有 396px，常驻文字按钮会永久压缩标题；
- 对勾压在时间槽位里，不改变行布局，hover 时没有位移抖动；
- 已读行没有可执行动作，不出现按钮，保持「一个信号只说一件事」。

被否掉的方案：

- **常驻「已读」文字按钮**：英文 `Mark read` 约 72px，标题永久少一截，且每行多一个视觉元素。
- **左侧选择框 + 批量操作**：为单条需求引入多选，交互成本远超收益。
- **右键菜单**：桌面可用、触屏不可用，且完全不可发现。

## 3. 行为

| 触发 | 结果 |
| --- | --- |
| hover / `focus-within` 未读行 | 时间淡出（120ms），对勾按钮淡入 |
| 点对勾（鼠标 / Enter / Space） | 只发已读：不调到 `openSession`，面板保持展开 |
| 点行其他区域 | 维持现状：标已读 + 跳转会话 + 收起面板 |
| 已读行 | 无按钮，hover 时间照常显示 |

已读传播：

- 任务来源条目走宿主 `POST /task-notifier/api/read { notificationIds }`。宿主现有逻辑会连带清掉该条目对应会话的 `task.unread`，与「打开行」一致。
- 账号公告只在本机 `accountRead` 记录 id（沿用点开时的路径），不向服务端上报。
- 铃铛角标、头部未读 chip、「未读」分段计数同步减一；当前在「未读」筛选下时该行立即消失。
- 标记后该行的未读点、浅底、600 字重同时撤掉，过渡 150ms。

## 4. 视觉规格

| 部位 | 规格 |
| --- | --- |
| 右侧槽位 | `.dtn-ni__end`：由时间宽度决定，按钮绝对定位 `right: 0`，不改行布局、不产生 hover 位移 |
| 按钮 | `22×22`，圆角 `50%`，图标 `check` `13px`；默认 `opacity: 0`、`label-tertiary` |
| 显隐 | `.dtn-ni:hover` / `.dtn-ni:focus-within` 时按钮 `opacity: 1`、时间 `opacity: 0`；`120ms ease` |
| 按钮 hover | 背景 `--dsw-alias-interactive-bg-hover-solid`，图标 `label-primary` |
| 已读行 | 不渲染按钮 |
| 触屏 / 窄屏 | `@media (hover: none), (max-width: 640px)`：未读行 `padding-right` +26px 让出按钮位，按钮常驻在时间右侧、不重叠 |

不动色条、未读点、字重、未读浅底与分组分隔线。

## 5. 文案与无障碍

- 复用现有 key `action.markRead`（`标为已读` / `Mark read`），同时用作 `aria-label` 与 `title`，不新增文案。
- 按钮是真实 `<button type="button">`，与行的 `role="button"` **平级**：每行外面包一层 `.dtn-ni__shell`（`position: relative`），按钮绝对定位在 shell 里，不在行按钮的 DOM 内。ARIA 规定 `role="button"` 的后代是展示性的，嵌套会把「标为已读」从读屏里抹掉；平级还顺带免掉了 `stopPropagation` 与键盘事件守卫。
- 行的 `aria-label` 不变（标题 + 发送方 + 正文）；Tab 顺序：行 → 行内动作按钮。

## 6. 计划

1. `lib/client.js`
   - `NotificationRow`：接受 `onMarkRead`，行外层包 `.dtn-ni__shell`，对勾按钮作为行的兄弟节点，右侧时间槽不变。
   - `NotificationCenterRoot`：新增 `markEntryRead(entry)` 统一账号公告与宿主两条路径；`openEntry` 复用它，行为不变。
   - CSS：`.dtn-ni__shell`、`.dtn-ni__read` 的显隐（shell 的 `:hover` / `:focus-within`），触屏窄屏未读行加 `padding-right` 让出按钮位。
2. 测试 `test/client-panel.test.js`：按钮只在未读行渲染、在行的 DOM 之外（shell 平级）、hover/focus 显隐与窄屏常驻的样式断言、复用 `action.markRead` 不新增 key。
3. 预览与截图：`preview/index.html` 的 `/read` 桩补 `notificationIds`（与宿主一致，否则单条已读会被快照刷回未读）；`scripts/screenshot.mjs` 先在未读行上悬停再拍 `center-light` / `center-light-en`。
4. README（中/英）功能描述补一句单条标为已读。
5. 版本 `1.4.18`，commit → push（publish.yml staged，npmjs.com 上点 Approve）。

## 7. 验收

- 未读行 hover：时间让位给对勾；点击后行变已读、面板不收起、会话没被切换；角标与 chip 各减一。
- 键盘：Tab 到行内按钮，Enter 只标已读；行本身 Enter 仍然打开会话。
- 「未读」筛选下点对勾，该行立刻从列表消失；清空后显示空态。
- 账号公告与插件来源同样可单条标已读。
- 窄屏 390px（触屏）按钮常驻且不与时间重叠；深浅色、中英截图各一张。

## 8. 非目标

- 不做「标为未读」、多选批量、滑动操作。
- 不改行点击（打开即标已读）与「全部已读」。
- 不改三列任务看板卡片（已有「标为已读」）。
- 不动通知发布契约与宿主 `/read` 接口。
