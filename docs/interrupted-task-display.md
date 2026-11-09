# 中断任务状态展示设计方案

## 1. 背景与目标

当前 `dsh-task-notifier` 的任务面板有三列看板：**待回复 (input)**、**进行中 (running)**、**未读结果 (unread)**，以及底部的**更早的任务 (archive)**。

当会话在执行过程中遭遇意外终止时（如：退出 DeepSeek Harness 进程、欠费超额、模型报错等）：
1. 退出/崩溃：进程退出后未收尾的会话在重新打开或下次启动时，DSH 宿主会结算或恢复为 `interrupted`；当前任务通知台在上次运行时若记录了 `running: true`，重启恢复时会被强制按 idle 读入或残留为未完成状态；且未进入未读列，用户无法感知这些异常退出的任务。
2. 欠费或 API 错误：模型调用触发 `QUOTA` / `ACCOUNT_QUOTA` 或报错时，DSH agent loop 追加 `turn/end { reason: { kind: "error", error: { code, message } } }`，随后触发 `api-session/status (false)`。由于该轮次是异常中断而非正常完成，但目前被一律视为 completed 计入未读，用户在看板上看不到“中断/出错/欠费”的原因，只显示“完成 · 刚刚”。

目标：
- 识别并记录任务的**中断/异常原因（interrupted / quota / error）**；
- 在面板中明确呈现中断状态与中断原因标签（例如「已中断 · 退出」/「已中断 · 欠费」/「执行出错」）；
- 在三列看板以及卡片视觉上清晰呈现中断任务（可归入未读列供用户查阅与重新处理，带有明显的警告/中断视觉标记，如琥珀色/红色警告徽章）；
- 宿主与前端均完成对应中英文国际化文案支持。

## 2. 状态模型设计

### 2.1 任务中断分类 (`interruptedKind` & `interruptedMessage`)

在 `task` 对象中扩展字段：
- `interrupted`: `boolean`，标记该任务是否以中断/异常收尾；
- `interruptedKind`: `null | "process_exit" | "quota" | "error"`；
  - `"process_exit"`: DSH 进程退出 / 崩溃重启 / 父子会话级联关闭产生的中断（对应 `turn/end` 的 `reason.kind === "interrupted"`，或 `aborted` 且原因为 `disposed` / `parent`）；
  - `"quota"`: 账户额度耗尽 / 欠费（对应 `code === "QUOTA" || code === "ACCOUNT_QUOTA"` 或识别到 quota 错误）；
  - `"error"`: 其它运行期报错终止（对应 `turn/end` 的 `reason.kind === "error"`，以及 `aborted` 且原因为 `hook` 的插件取消）；
  - 用户主动点停止（`aborted` 且原因为 `user`）属于有意操作，不算中断，按正常收尾处理；
- `interruptedMessage`: 简短错误提示（净化限长后的文本，如错误原因或错误代码）；

### 2.2 宿主事件与状态转移

1. **会话事件监听 (`session/event`)**：
   - 当收到 `turn/end` 事件：
     - 若 `event.data.reason.kind === "interrupted"`：
       标记 `task.interrupted = true`, `task.interruptedKind = "process_exit"`;
     - 若 `event.data.reason.kind === "error"`：
       判断错误码或信息：
       - 若 `code === "QUOTA" || code === "ACCOUNT_QUOTA"` 或包含 quota/balance 欠费关键词：
         标记 `task.interrupted = true`, `task.interruptedKind = "quota"`, `task.interruptedMessage = reason.error.message`;
       - 否则：
         标记 `task.interrupted = true`, `task.interruptedKind = "error"`, `task.interruptedMessage = reason.error.message`;
     - 若 `event.data.reason.kind === "completed"`：
       清空 `interrupted` 相关标记。
2. **状态文件与重启检测 (`seedFromPersistence`)**：
   - 进程退出时，若任务处于 `running: true`，在重启后该任务被置为 `running: false`。
   - 若上次保存的状态是 `running: true`，说明进程在执行中被强退或退出，恢复时自动标记为 `interrupted = true`, `interruptedKind = "process_exit"`, `unread = true`，使退出的任务重新在面板中浮现，等待用户查阅。
3. **状态转移 (`transitionTask`)**：
   - 当任务再次变为 `running: true`（用户重新输入并发送）：自动重置 `interrupted = false`, `interruptedKind = null`, `interruptedMessage = null`。

### 2.3 状态持久化兼容 (`core.js`)

- `parseState` 增加解析 `interrupted`, `interruptedKind`, `interruptedMessage`。
- 向后兼容：旧版本数据缺失上述字段时默认无中断。

## 3. UI 交互与视觉设计

### 3.1 看板列定位与卡片渲染

- 中断任务也是“等待用户查阅并决定后续”的任务，在未读时归入第三列「未读结果 (unread)」，带进入该列后仍以警告色徽章与左侧色条区分。
- 卡片徽章与状态条：
  - 正常完成卡片：绿色/蓝色中性提示（完成 · 时间）；
  - 中断卡片：
    - `process_exit`: 琥珀色徽章 `[已中断 · 退出]` / `[Interrupted · Exited]`；
    - `quota`: 红色/琥珀色徽章 `[已中断 · 欠费]` / `[Interrupted · Quota]`；
    - `error`: 红色徽章 `[执行出错]` / `[Error]`，并显示简短原因；
  - 侧边高亮条采用警告色（warning/error 强调色），与普通正常完成卡片明显区分。
  - 操作按钮显示「查看会话」或「去处理」，点击跳转至对应会话。

### 3.2 国际化 (zh / en)

- 中文：
  - `badge.interrupted.exit`: "已中断 · 退出"
  - `badge.interrupted.quota`: "已中断 · 欠费"
  - `badge.interrupted.error`: "已中断 · 报错"
  - `task.interrupted.exit`: "Harness 退出导致任务中断"
  - `task.interrupted.quota`: "额度不足或欠费导致任务中断"
  - `task.interrupted.error`: "执行出错导致任务中断"
- 英文：
  - `badge.interrupted.exit`: "Interrupted · Exited"
  - `badge.interrupted.quota`: "Interrupted · Quota"
  - `badge.interrupted.error`: "Interrupted · Error"
  - `task.interrupted.exit`: "Interrupted due to Harness exit"
  - `task.interrupted.quota`: "Interrupted due to insufficient quota"
  - `task.interrupted.error`: "Interrupted due to execution error"

## 4. 实施计划

1. **核心逻辑 (`lib/core.js`)**：
   - 增加中断错误分类识别辅助函数；
   - 更新 `transitionTask`、`parseState` 支持中断字段。
2. **宿主逻辑 (`lib/index.js`)**：
   - 在 `onSessionEvent` 处理 `turn/end` 的 `interrupted` 与 `error`（区分 quota）；
   - 在 `seedFromPersistence` 对之前处于 `running` 但进程重启的任务打上退出中断标记；
   - 在再次变为 `running` 时重置中断标记。
3. **前端展示 (`lib/client.js`)**：
   - 更新中英文字典；
   - 扩展 `TaskCard`、`badge`、状态展示与卡片色彩样式。
4. **单测覆盖 (`test/`)**：
   - 为 core 与 host 增加中断识别、持久化与重启恢复测试用例，确保全部通过。
5. **文档与截图**：
   - 更新 README.md 与 README.zh-CN.md；如有界面调整保持截图规范。
