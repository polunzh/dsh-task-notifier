# 安全说明 · Security

本插件跑在用户自己的 DSH 里，拥有宿主进程的文件系统与子进程权限。这份文档写清楚它**做什么、不做什么**，方便用户和插件市场审核判断风险。

> 一句话：**它不联网、不上传任何数据、不读凭据、没有安装期脚本**；唯一的对外动作是在 macOS 上调用系统自带的 `osascript` 弹一条本地通知。

---

## 1. 数据流

```
会话事件 (api-session/*)
        │  标题 / 运行状态
        ▼
   宿主侧内存任务表
        │
        ├─► $DSH_HOME/storages/dsh-task-notifier/state.json   （仅未读状态与标题，目录 0700 / 文件 0600）
        └─► osascript display notification                    （仅 macOS，参数经严格转义）

浏览器 ←── 同源 HTTP ──► 宿主
        /task-notifier/api/{state,wait,heartbeat,read,notify,test}
```

**没有任何出站网络请求。** 没有遥测、统计上报、CDN 资源、远程配置。仓库内 `grep` 即可验证：`lib/` 下没有对非 localhost 地址的 `fetch`。

## 2. 本地存储

| 项目 | 位置 | 权限 | 内容 |
|---|---|---|---|
| 未读状态 | `$DSH_HOME/storages/dsh-task-notifier/state.json` | **0600**（目录 **0700**） | 每个会话的 `id`、**标题**、运行/完成时间、未读数 |
| 浏览器侧 | 无 | — | 提示音与筛选状态只在内存；不使用 localStorage / IndexedDB / Cookie |

- 会话标题通常是用户第一句话的摘要，属于私有内容，所以文件和目录都收紧到仅属主可访问。
- 状态文件有 1 MiB 读取上限，超过即忽略，避免被替换成巨型文件拖垮进程。
- 任务表上限 300 条（面板展示），内存表超过 600 条时淘汰最久未变化的空闲任务。
- 删除插件目录不会自动删这个文件；不需要时手动删 `$DSH_HOME/storages/dsh-task-notifier/`。

## 3. HTTP 路由

所有路由挂在 `/task-notifier/api/*`，**不是公开 API**，只服务于本机浏览器页面：

1. 先过宿主 `connection.requestRejection()` —— 它做 Host/Origin fence（拒绝 `Sec-Fetch-Site: cross-site`、拒绝 Origin 与 Host 不一致）并强制鉴权（浏览器会话或 API token），不通过直接 403/401。
2. 本插件额外 **fail-closed**：如果拿不到这个守卫（例如宿主版本不匹配），一律返回 503，而不是"没守卫就放行"。
3. 所有写操作（`POST`）要求 `Content-Type: application/json`。跨站表单只能发 `text/plain` 简单请求，因此即使守卫将来回退，也打不到写接口。
4. 响应统一带 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`。

### 输入校验与限流

| 输入 | 处理 |
|---|---|
| 会话 id | 非空字符串、≤128 字符、无控制字符，否则丢弃 |
| 标题 | 折叠控制字符与换行、按码点截断到 120 字符后才入库/通知 |
| `ids` 数组 | 去重、最多 200 条 |
| 请求体 | 上限 64 KiB，超出返回 413 |
| `config.osNotify` | 仅接受 `auto` / `always` / `off`，其余回落 `auto` |
| `config.osSound` | 仅接受 `^[A-Za-z][A-Za-z0-9 _-]{0,39}$`，否则回落 `Glass` |
| `config.osTitle` | 净化并截断到 64 字符 |
| `/test` | 1.5 秒冷却，防止被反复触发刷屏 |
| `/notify` | 0.8 秒冷却，且只对任务表里已存在的 id 生效 |
| `/wait` 长轮询 | 并发上限 32，超时上限 25 秒 |

## 4. AppleScript 执行边界

系统通知通过 `execFile("osascript", ["-e", script])` 发送：**不带 shell**，参数以数组传递，不存在 shell 拼接。

进入脚本的文本先经 `sanitizeText()`（去掉控制字符、折叠换行），再按 AppleScript 字符串规则转义反斜杠与双引号，最后包成字面量。因此会话标题里即使出现 `" & do shell script "id" & "`，也只会变成一条普通通知正文，不会产生第二条 AppleScript 语句（`test/core.test.js` 覆盖了该用例）。

## 5. 明确不做的事

- ❌ 不读取任何凭据：`~/.dsh/.credentials.yaml`、`.env`、SSH key、keychain、浏览器数据都不碰。
- ❌ 不调用 `eval` / `new Function` / 动态 `import` 远程代码。
- ❌ 不开子进程做通知以外的事（`osascript` 是唯一一处）。
- ❌ 不修改 DSH 自身文件；插件只在 `$DSH_HOME/storages/` 下写自己的状态。
- ❌ 不声明 `preinstall` / `postinstall` / `prepare` 等安装期脚本（`package.json` 里没有这些字段）。
- ❌ 不请求麦克风/摄像头/剪贴板读取。

## 6. 已知限制

- **系统通知仅 macOS**：非 macOS 平台只用浏览器通知；`/test` 会返回 `unsupported-platform`。
- **浏览器通知需要授权**：只有用户点击「浏览器通知」按钮才会请求权限，插件不会在后台自动弹权限框。未授权时自动退回系统通知（macOS）。
- **页面在线判定的含义**：浏览器每 3 秒心跳一次；心跳 8 秒内有效且浏览器通知已授权时，由页面发通知，宿主不重复发，避免双弹。
- **语言**：界面与系统通知文案支持中文 / English，跟随宿主界面语言。

## 7. 报告问题

发现问题请开 issue：<https://github.com/polunzh/dsh-task-notifier/issues>。
如果是敏感问题（可被利用的漏洞），请用 GitHub 的 private vulnerability reporting，或在 issue 里只描述影响、不发利用细节。
