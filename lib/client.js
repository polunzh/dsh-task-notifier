/**
 * 任务通知台：浏览器侧。
 *
 * 职责：
 *  - 心跳 /task-notifier/api/heartbeat，让宿主知道页面还开着（有页面则宿主
 *    不再发系统通知，避免双弹）；
 *  - 长轮询 /wait + /state，感知「任务完成」事件，然后响合成提示音、弹
 *    浏览器 Notification（点击跳回对应会话）；
 *  - 侧边栏「任务」面板：待回复 / 运行中 / 未读结果（含中断） + 搜索 +
 *    全部标为已读 + 通知自检按钮。
 */
window.__ModuleLoader__.load({
  id: "@polunzh/dsh-task-notifier",
  factory(require) {
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect, useMemo, useRef, useCallback } = React;

    const NS = "dsh-task-notifier";
    const PANEL_ID = "task-notifier";
    const API = "/task-notifier/api";

    /* ============================ 文案（中/英） ============================ */

    /** 所有界面文案都走这张表；宿主 locale 服务可用时注册进去，不可用时本地兜底。 */
    const DICT = {
      zh: {
        "center.title": "通知",
        "center.unread": "{n} 未读",
        "center.unreadShort": "未读",
        "center.all": "全部",
        "center.todo": "待处理",
        "center.allSources": "全部来源",
        "center.needYou": "需要你处理",
        "center.today": "今天",
        "center.earlier": "更早",
        "center.markAllRead": "全部已读",
        "center.empty": "暂时没有通知",
        "center.emptyHint": "任务完成、中断或插件消息会出现在这里。",
        "center.expand": "展开完整任务面板",
        "center.settings": "通知设置",
        "center.open": "打开",
        "center.handle": "去处理",
        "center.close": "关闭",
        "center.source.task": "任务",
        "center.source.account": "账号",
        "center.source.plugin": "插件",
        "center.pluginPrefix": "插件：{name}",
        "center.completedBody": "已完成",
        "center.interruptedBody": "已中断",
        "center.accountBadge": "账号公告",
        "center.loading": "正在加载…",
        "center.connectionError": "连接异常：{error}",
        "panel.title": "任务面板",
        "panel.brand": "TASK NOTIFIER",
        "panel.subtitle": "筛选待回复、进行中与未读结果（含中断、欠费与报错）；任务完成时播放提示音并弹通知。",
        "panel.connectionError": "连接异常：{error}",
        "panel.total": "全部 {n}",

        "tab.input": "待回复",
        "tab.unread": "未读结果",
        "tab.running": "运行中",
        "tab.idle": "已完成",
        "tab.all": "全部",

        "action.testSound": "试听提示音",
        "action.testOs": "试发系统通知",
        "action.markAllRead": "全部标为已读",
        "action.markAllReadN": "全部标为已读（{n}）",
        "action.markRead": "标为已读",
        "action.open": "打开",
        "action.goReply": "去处理",
        "action.clearFilter": "查看全部",

        "badge.new": "未读更新",
        "badge.running": "正在执行",
        "badge.waiting": "等你决定",
        "badge.read": "已读",
        "badge.interrupted.exit": "已中断 · 退出",
        "badge.interrupted.quota": "已中断 · 欠费",
        "badge.interrupted.error": "已中断 · 报错",

        "permission.granted": "浏览器通知：已开启",
        "permission.denied": "浏览器通知：被拒绝",
        "permission.unsupported": "浏览器通知：不可用",
        "permission.default": "浏览器通知：未开启",

        "search.placeholder": "按标题搜索…",
        "search.aria": "搜索任务",

        "lane.inputHint": "需要你做决定",
        "lane.runningHint": "后台并发处理",
        "lane.unreadHint": "等待你查阅",
        "lane.pad.input": "没有其他阻塞审批",
        "lane.pad.running": "没有更多进行中的任务",
        "lane.pad.unread": "没有更多未读结果",
        "lane.foot.input": "最长等待：{time}",
        "lane.foot.running": "最久已运行：{time}",
        "lane.foot.unread": "最早一条：{time}",
        "lane.foot.count": "{n} 项",

        "card.wait": "已等待 {time}",
        "card.runningFor": "已运行 {time}",
        "card.done": "完成 · {time}",
        "card.readAt": "已读 · {time}",

        "task.untitled": "未命名会话",
        "task.running": "运行中",
        "task.needsInput": "等待回复",
        "task.needsApproval": "等待审批",
        "task.needsPlan": "等待审阅计划",
        "task.completed": "完成 · {time}",
        "task.interrupted.exit": "Harness 退出，轮次未收尾",
        "task.interrupted.quota": "额度不足或欠费，轮次中止",
        "task.interrupted.error": "执行出错，轮次中止",
        "task.noTime": "—",
        "row.open": "打开会话：{title}",
        "row.openState": "打开会话：{title}（{state}）",

        "tree.subagent": "子代理",
        "tree.fromParent": "来自 {name}",
        "tree.children": "{n} 个子代理",
        "tree.childStatsRunning": "{n} 运行",
        "tree.childStatsDone": "{n} 完成",
        "tree.parentFallback": "父会话",
        "tree.toggleExpand": "展开子代理",
        "tree.toggleCollapse": "收起子代理",

        "time.justNow": "刚刚",
        "time.seconds": "{n} 秒前",
        "time.minutes": "{n} 分钟前",
        "time.hours": "{n} 小时前",
        "time.days": "{n} 天前",

        "empty.input": "没有等你回复的任务。",
        "empty.running": "没有正在运行的任务。",
        "empty.unread": "没有未读结果。",
        "empty.idle": "没有已完成任务。",
        "empty.nomatch": "没有匹配的任务。",

        "blank.all": "现在没有任务",
        "blank.allHint": "有任务完成时会响一声，并在这里等你查看。",
        "blank.search": "没有匹配的任务",

        "archive.title": "更早的任务",
        "archive.count": "{n} 个已读",
        "archive.expand": "展开历史",
        "archive.collapse": "收起历史",

        "notify.body": "已完成，点开查看会话",
        "notify.interrupted": "任务已中断，点开查看原因",
        "test.sent": "已发出系统通知",
        "test.disabled": "osNotify=off，系统通知已关闭",
        "test.unsupported": "当前平台不支持系统通知（仅 macOS）",
        "test.failed": "系统通知发送失败",
        "test.error": "系统通知发送失败：{error}",
        "test.cooldown": "操作太频繁，稍等一下",
      },
      en: {
        "center.title": "Notifications",
        "center.unread": "{n} unread",
        "center.unreadShort": "Unread",
        "center.all": "All",
        "center.todo": "Action",
        "center.allSources": "All sources",
        "center.needYou": "Needs you",
        "center.today": "Today",
        "center.earlier": "Earlier",
        "center.markAllRead": "Mark all read",
        "center.empty": "No notifications yet",
        "center.emptyHint": "Task results, interruptions and plugin messages show up here.",
        "center.expand": "Open full task board",
        "center.settings": "Preferences",
        "center.open": "Open",
        "center.handle": "Handle",
        "center.close": "Close",
        "center.source.task": "Task",
        "center.source.account": "Account",
        "center.source.plugin": "Plugin",
        "center.pluginPrefix": "Plugin: {name}",
        "center.completedBody": "Done",
        "center.interruptedBody": "Interrupted",
        "center.accountBadge": "Account notice",
        "center.loading": "Loading…",
        "center.connectionError": "Connection problem: {error}",
        "panel.title": "Tasks",
        "panel.brand": "TASK NOTIFIER",
        "panel.subtitle": "Filter tasks waiting on your reply, running, and unread results (interruptions, quota stops and errors included); a chime and a notification fire when a task finishes.",
        "panel.connectionError": "Connection problem: {error}",
        "panel.total": "All {n}",

        "tab.input": "Needs input",
        "tab.unread": "Unread",
        "tab.running": "Running",
        "tab.idle": "Completed",
        "tab.all": "All",

        "action.testSound": "Preview chime",
        "action.testOs": "Send test notification",
        "action.markAllRead": "Mark all read",
        "action.markAllReadN": "Mark all read ({n})",
        "action.markRead": "Mark read",
        "action.open": "Open",
        "action.goReply": "Reply",
        "action.clearFilter": "Show all",

        "badge.new": "New",
        "badge.running": "Running",
        "badge.waiting": "Waiting on you",
        "badge.read": "Read",
        "badge.interrupted.exit": "Interrupted · Exited",
        "badge.interrupted.quota": "Interrupted · Quota",
        "badge.interrupted.error": "Interrupted · Error",

        "permission.granted": "Browser notifications: on",
        "permission.denied": "Browser notifications: blocked",
        "permission.unsupported": "Browser notifications: unavailable",
        "permission.default": "Browser notifications: off",

        "search.placeholder": "Search by title…",
        "search.aria": "Search tasks",

        "lane.inputHint": "Waiting on you",
        "lane.runningHint": "Running in the background",
        "lane.unreadHint": "Ready to review",
        "lane.pad.input": "No other approvals waiting",
        "lane.pad.running": "No other tasks running",
        "lane.pad.unread": "No more unread results",
        "lane.foot.input": "Longest wait: {time}",
        "lane.foot.running": "Longest run: {time}",
        "lane.foot.unread": "Oldest: {time}",
        "lane.foot.count": "{n} items",

        "card.wait": "Waiting {time}",
        "card.runningFor": "Running {time}",
        "card.done": "Done · {time}",
        "card.readAt": "Read · {time}",

        "task.untitled": "Untitled session",
        "task.running": "Running",
        "task.needsInput": "Needs your reply",
        "task.needsApproval": "Needs your approval",
        "task.needsPlan": "Plan needs review",
        "task.completed": "Done · {time}",
        "task.interrupted.exit": "Harness exited before the turn finished",
        "task.interrupted.quota": "Turn stopped: quota or balance exhausted",
        "task.interrupted.error": "Turn stopped by an execution error",
        "task.noTime": "—",
        "row.open": "Open session: {title}",
        "row.openState": "Open session: {title} ({state})",

        "tree.subagent": "Subagent",
        "tree.fromParent": "from {name}",
        "tree.children": "{n} subagents",
        "tree.childStatsRunning": "{n} running",
        "tree.childStatsDone": "{n} done",
        "tree.parentFallback": "parent session",
        "tree.toggleExpand": "Expand subagents",
        "tree.toggleCollapse": "Collapse subagents",

        "time.justNow": "just now",
        "time.seconds": "{n}s ago",
        "time.minutes": "{n}m ago",
        "time.hours": "{n}h ago",
        "time.days": "{n}d ago",

        "empty.input": "Nothing is waiting on you.",
        "empty.running": "No task is running.",
        "empty.unread": "No unread results.",
        "empty.idle": "No completed tasks yet.",
        "empty.nomatch": "No matching tasks.",

        "blank.all": "Nothing here yet",
        "blank.allHint": "When a task finishes, a chime plays and it waits for you here.",
        "blank.search": "No matching tasks",

        "archive.title": "Earlier tasks",
        "archive.count": "{n} read",
        "archive.expand": "Show history",
        "archive.collapse": "Hide history",

        "notify.body": "Done — click to open the session",
        "notify.interrupted": "Task interrupted — click to see why",
        "test.sent": "Test notification sent",
        "test.disabled": "osNotify=off, system notifications are disabled",
        "test.unsupported": "System notifications are macOS-only",
        "test.failed": "Failed to send the test notification",
        "test.error": "Failed to send the test notification: {error}",
        "test.cooldown": "Too frequent, try again in a moment",
      },
    };

    /** 宿主 locale 服务；apply 时注入。 */
    let localeApi = null;
    /** 宿主 bind 出来的翻译函数；缺失时用本地表兜底。 */
    let boundTranslate = null;

    function interpolate(template, vars) {
      if (!vars) return template;
      return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole,
      );
    }

    /** 当前界面语言：优先问宿主，其次跟随浏览器。 */
    function activeLocale() {
      try {
        const snapshot = localeApi && localeApi.getSnapshot ? localeApi.getSnapshot() : null;
        const tag = snapshot && typeof snapshot.active === "string" ? snapshot.active : "";
        if (tag) return tag.toLowerCase().startsWith("zh") ? "zh" : "en";
      } catch {
        /* 宿主 locale 服务形态变化时忽略 */
      }
      const nav = typeof navigator !== "undefined" && navigator.language ? navigator.language : "zh";
      return nav.toLowerCase().startsWith("en") ? "en" : "zh";
    }

    /** 取一条文案；宿主 bind 返回空或原键名时回落到本地表。 */
    function t(key, vars) {
      let text;
      if (boundTranslate) {
        try {
          text = boundTranslate(key, vars);
        } catch {
          text = undefined;
        }
      }
      if (typeof text !== "string" || text === "" || text === key) {
        const dict = DICT[activeLocale()] ?? DICT.zh;
        text = dict[key] ?? DICT.zh[key] ?? key;
        text = interpolate(text, vars);
      }
      return text;
    }

    /* ============================ 小工具 ============================ */

    function sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function fetchJson(path, options) {
      const response = await fetch(path, { cache: "no-store", ...options });
      if (!response.ok) throw new Error(`${path} → ${response.status}`);
      return response.json();
    }

    /**
     * 所有写接口统一走这里。
     *
     * 宿主对非 GET 请求要求 `application/json`（挡跨站简单请求），漏了会直接 415；
     * 之前「试发系统通知」就是裸 fetch POST，永远报「系统通知发送失败」。
     * @param {string} path 接口路径
     * @param {object} [body] 请求体
     * @param {object} [options] 额外 fetch 选项（signal 等）
     */
    function postJson(path, body, options = {}) {
      const { headers, ...rest } = options;
      return fetchJson(path, {
        ...rest,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body ?? {}),
      });
    }

    function relativeTime(timestamp, now) {
      if (!timestamp) return "";
      const delta = Math.max(0, (now ?? Date.now()) - timestamp);
      if (delta < 15_000) return t("time.justNow");
      if (delta < 60_000) return t("time.seconds", { n: Math.floor(delta / 1000) });
      if (delta < 3_600_000) return t("time.minutes", { n: Math.floor(delta / 60_000) });
      if (delta < 86_400_000) return t("time.hours", { n: Math.floor(delta / 3_600_000) });
      return t("time.days", { n: Math.floor(delta / 86_400_000) });
    }

    function taskTitle(task) {
      return task?.title || t("task.untitled");
    }

    /* ============================ 状态仓 ============================ */

    /**
     * 单例仓：轮询驱动，图标与页面共同观察。
     *
     * 去重记的是「每个会话已经通知到的完成时刻」，而不是会话 id 本身：
     * 同一个会话会跑很多轮，只按 id 记住会让第二轮之后的完成全部静默。
     * 页面重新载入会重置这张表，watermark 负责压掉载入前就有的历史未读。
     */
    function createStore() {
      const state = {
        loaded: false,
        rev: 0,
        bootAt: Date.now(),
        watermark: 0,
        unreadNames: 0,
        notifications: [],
        notifWatermark: 0,
        notifiedIds: new Set(),
        connection: "connecting", // connecting | ok | reconnected...
        error: null,
      };
      const listeners = new Set();
      // 插件被卸载/禁用时必须停掉轮询，否则会留下永远跑的 for(;;) 和后端长轮询。
      const lifetime = new AbortController();
      let disposed = false;

      function emit() {
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* 渲染回调失败不影响轮询 */
          }
        }
      }

      /** 等待回复与「正在干活」互斥：等人的会话不再计入运行中。 */
      function needsInputCount() {
        let count = 0;
        for (const task of state.tasks ?? []) if (task.needsInput) count += 1;
        return count;
      }

      function runningCount() {
        let count = 0;
        for (const task of state.tasks ?? []) if (task.running && !task.needsInput) count += 1;
        return count;
      }

      function unreadCount() {
        let count = 0;
        // 与「未读结果」列的口径保持一致：仍在运行或卡在等人上的任务不算未读结果。
        // 否则用户接着问下一句、任务刚开跑，侧栏角标会亮起来而未读列却是空的。
        for (const task of state.tasks ?? []) {
          if (task.unread && !task.running && !task.needsInput) count += 1;
        }
        return count;
      }

      state.needsInputCount = needsInputCount;
      state.runningCount = runningCount;
      state.unreadCount = unreadCount;

      /** 铃铛角标：所有来源的未读通知（账号来源由组件另外叠加）。 */
      function notificationUnreadCount() {
        let count = 0;
        for (const entry of state.notifications ?? []) if (!entry.read) count += 1;
        return count;
      }
      state.notificationUnreadCount = notificationUnreadCount;

      /** 当前主视图会话切过来时，把它对应的任务与通知标为已读。 */
      async function syncActiveSessionRead(id) {
        if (id) await markSessionRead(id);
      }

      /** 把 /state 的结果灌进本地仓；booting 时同时推进水位线，避免把历史未读当成新通知。 */
      function applyState(data, booting) {
        state.tasks = data.tasks ?? [];
        state.notifications = data.notifications ?? [];
        state.settings = data.settings ?? {};
        state.rev = data.rev ?? state.rev;
        state.nowAt = data.now ?? Date.now();
        if (booting) {
          state.watermark = Math.max(0, ...state.tasks.map((task) => task.completedAt ?? 0), state.bootAt);
          state.notifWatermark = Math.max(0, ...state.notifications.map((entry) => entry.ts ?? 0), state.bootAt);
          for (const entry of state.notifications) state.notifiedIds.add(entry.id);
        }
        state.loaded = true;
        state.connection = state.error ? "reconnected" : "ok";
        state.error = null;
      }

      async function firstLoad() {
        try {
          const data = await fetchJson(`${API}/state`, { signal: lifetime.signal });
          if (disposed) return;
          applyState(data, true);
          emit();
        } catch (error) {
          if (disposed) return;
          state.error = error?.message ?? String(error);
          state.connection = "error";
          emit();
        }
      }

      async function pollLoop() {
        while (!disposed) {
          try {
            await fetchJson(`${API}/wait?rev=${state.rev}`, { signal: lifetime.signal });
            if (disposed) return;
            const data = await fetchJson(`${API}/state`, { signal: lifetime.signal });
            if (disposed) return;
            applyState(data, false);
            await notifyNewNotifications();
            emit();
          } catch (error) {
            if (disposed) return;
            state.error = error?.message ?? String(error);
            state.connection = "reconnecting";
            emit();
            await sleep(3000);
          }
        }
      }

      /**
       * 新结果提醒：任务、插件等来源的未读通知统一从通知列表判断。
       * 水位线 + 已通知 id 集合保证同一结果只提醒一次，也不会把载入前的历史未读当成新通知。
       */
      async function notifyNewNotifications() {
        const list = state.notifications ?? [];
        const fresh = list.filter(
          (entry) =>
            !entry.read &&
            entry.source !== "account" &&
            (entry.ts ?? 0) > state.notifWatermark &&
            !state.notifiedIds.has(entry.id),
        );
        if (!fresh.length) return;
        // 一次轮询里补齐多个结果只响一声，避免提示音叠成噪音。
        if (state.settings.sound !== false) playChime();
        const fallbackIds = [];
        for (const entry of fresh) {
          state.notifiedIds.add(entry.id);
          state.notifWatermark = Math.max(state.notifWatermark, entry.ts ?? 0);
          const body =
            entry.source === "task"
              ? entry.kind === "interrupted"
                ? t("notify.interrupted")
                : t("notify.body")
              : entry.body || t("notify.body");
          const shown =
            notificationPermissionState() === "granted" &&
            notifyBrowser(
              entry.title || t("task.untitled"),
              () => state.openNotification?.(entry),
              body,
              `${NS}:${entry.sessionId || entry.id}`,
            );
          if (!shown) fallbackIds.push(entry.id);
        }
        // 一次请求带上所有兜底 id：宿主对 /notify 有冷却，逐个发会被 429 掉。
        if (fallbackIds.length) fallbackOsNotify(fallbackIds);
        pruneNotifiedIds();
      }

      function pruneNotifiedIds() {
        if (state.notifiedIds.size <= 300) return;
        const alive = new Set((state.notifications ?? []).map((entry) => entry.id));
        for (const id of state.notifiedIds) if (!alive.has(id)) state.notifiedIds.delete(id);
      }

      function markTasksReadLocally(ids) {
        for (const id of ids) {
          const task = (state.tasks ?? []).find((t) => t.id === id);
          if (task) task.unread = false;
        }
      }

      function markNotificationsReadLocally(ids) {
        const set = new Set(ids);
        for (const entry of state.notifications ?? []) {
          if (set.has(entry.id)) entry.read = true;
        }
      }

      function markAllReadLocally() {
        for (const task of state.tasks ?? []) task.unread = false;
        for (const entry of state.notifications ?? []) entry.read = true;
      }

      function applyReadResponse(data) {
        if (data?.tasks) state.tasks = data.tasks;
        if (data?.notifications) state.notifications = data.notifications;
        if (data?.rev !== undefined) state.rev = data.rev;
      }

      async function markRead(ids, all) {
        if (all) markAllReadLocally();
        else markTasksReadLocally(ids);
        emit();
        try {
          const data = await postJson(`${API}/read`, all ? { all: true } : { ids });
          applyReadResponse(data);
        } catch (error) {
          state.error = error?.message ?? String(error);
        }
        emit();
      }

      /** 单条通知已读（点开列表项）。 */
      async function markNotificationRead(ids) {
        markNotificationsReadLocally(ids);
        emit();
        try {
          const data = await postJson(`${API}/read`, { notificationIds: ids });
          applyReadResponse(data);
        } catch (error) {
          state.error = error?.message ?? String(error);
        }
        emit();
      }

      /** 全部已读（任务 + 通知；账号来源由组件另外清）。 */
      async function markAllRead() {
        markAllReadLocally();
        emit();
        try {
          const data = await postJson(`${API}/read`, { all: true });
          applyReadResponse(data);
        } catch (error) {
          state.error = error?.message ?? String(error);
        }
        emit();
      }

      /** 会话切到主视图：任务与该会话的通知一起已读。 */
      async function markSessionRead(sessionId) {
        markTasksReadLocally([sessionId]);
        for (const entry of state.notifications ?? []) {
          if (entry.sessionId === sessionId) entry.read = true;
        }
        emit();
        try {
          const data = await postJson(`${API}/read`, { sessionId });
          applyReadResponse(data);
        } catch (error) {
          state.error = error?.message ?? String(error);
        }
        emit();
      }

      async function sendHeartbeat() {
        if (disposed) return;
        try {
          await postJson(
            `${API}/heartbeat`,
            { canNotify: canBrowserNotify(), locale: activeLocale() },
            { signal: lifetime.signal },
          );
        } catch {
          /* 心跳失败不影响主流程 */
        }
      }

      /** 停止一切网络活动；插件卸载时调用。 */
      function dispose() {
        if (disposed) return;
        disposed = true;
        try {
          lifetime.abort();
        } catch {
          /* 已中止 */
        }
        listeners.clear();
      }

      return {
        state,
        firstLoad,
        pollLoop,
        sendHeartbeat,
        markRead,
        markNotificationRead,
        markAllRead,
        markSessionRead,
        syncActiveSessionRead,
        emit,
        dispose,
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
      };
    }

    /* ============================ 声音 ============================ */

    let audioContext = null;

    function ensureAudioContext() {
      try {
        if (!audioContext) {
          const AudioCtor = window.AudioContext || window.webkitAudioContext;
          if (!AudioCtor) return null;
          audioContext = new AudioCtor();
        }
        if (audioContext.state === "suspended") {
          audioContext.resume().catch(() => {});
        }
        return audioContext;
      } catch {
        return null;
      }
    }

    /**
     * 排一段 chime：两个音，G5 → C6，指数衰减。
     * @param {AudioContext} ctx 已处于 running 的音频上下文
     */
    function scheduleChime(ctx) {
      const round = (frequency, start, duration) => {
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        const t0 = ctx.currentTime + start;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.35, t0 + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
        oscillator.connect(gain).connect(ctx.destination);
        oscillator.start(t0);
        oscillator.stop(t0 + duration + 0.02);
      };
      try {
        round(784, 0, 0.16);
        round(1046.5, 0.09, 0.3);
      } catch {
        /* 声音失败不影响通知 */
      }
    }

    /**
     * 播放提示音。
     *
     * 页面刚打开时 AudioContext 基本都是 suspended，旧实现直接 return，于是启动后
     * 第一条通知永远没声音。这里改成先恢复、等 running 之后再排音。
     */
    function playChime() {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === "running") {
        scheduleChime(ctx);
        return;
      }
      Promise.resolve(ctx.resume?.())
        .then(() => {
          if (ctx.state === "running") scheduleChime(ctx);
        })
        .catch(() => {});
    }

    /* ============================ 浏览器通知 ============================ */

    function canBrowserNotify() {
      return typeof Notification !== "undefined" && Notification.permission === "granted";
    }

    function notificationPermissionState() {
      if (typeof Notification === "undefined") return "unsupported";
      return Notification.permission;
    }

    async function requestBrowserPermission() {
      try {
        if (typeof Notification === "undefined") return "unsupported";
        if (Notification.permission === "granted") return "granted";
        if (Notification.permission === "denied") return "denied";
        const result = await Notification.requestPermission();
        return result;
      } catch {
        return "unsupported";
      }
    }

    /**
     * 弹浏览器通知。
     *
     * tag 按会话区分：所有通知共用一个 tag 时，后一条会被系统当成「同一条通知的更新」
     * 折叠掉，连续完成几个任务就只剩最后一条横幅。同一个会话的多次完成则互相替换。
     * @param {string} title 标题
     * @param {Function} onClick 点击后的跳转动作
     * @param {string} [body] 正文文案（已翻译）
     * @param {string} [tag] 通知归并标识
     * @returns {boolean} 是否真的构造出通知（失败时调用方走系统通知兜底）
     */
    function notifyBrowser(title, onClick, body, tag = NS) {
      try {
        if (!canBrowserNotify()) return false;
        const notification = new Notification(title, { body: body || t("notify.body"), tag });
        notification.onclick = () => {
          try {
            window.focus();
          } catch {
            /* 无焦点 API 时忽略 */
          }
          onClick();
          try {
            notification.close();
          } catch {
            /* 已关闭 */
          }
        };
        return true;
      } catch {
        return false;
      }
    }

    /** 浏览器通知发不出时的兜底：让宿主强制弹系统通知。 */
    function fallbackOsNotify(ids) {
      postJson(`${API}/notify`, { ids }).catch(() => {
        /* 兜底失败最少还有声音 */
      });
    }

    /* ============================ 钩子 ============================ */

    function useNotifier(store) {
      const [, setTick] = useState(0);
      useEffect(() => {
        const listener = () => setTick((tick) => tick + 1);
        store.addListener(listener);
        return () => store.removeListener(listener);
      }, [store]);
      return store.state;
    }

    /** 语言切换时强制重渲染；宿主没有 subscribe 时退化为不跟随（重启后生效）。 */
    function useLocaleTick() {
      const [, setTick] = useState(0);
      useEffect(() => {
        if (!localeApi || typeof localeApi.subscribe !== "function") return undefined;
        try {
          return localeApi.subscribe(() => setTick((tick) => tick + 1));
        } catch {
          return undefined;
        }
      }, []);
    }

    /* ============================ 面板页 ============================ */

    /**
     * 三列看板：待回复 / 进行中 / 未读结果（含中断、欠费与报错） 永远同屏。
     * 状态不靠 Tab 选中态表达，而是「列位置 + 列顶色条 + 极浅状态底色」三重编码。
     */
    const LANES = [
      {
        id: "input",
        icon: "alert",
        titleKey: "tab.input",
        hintKey: "lane.inputHint",
        padKey: "lane.pad.input",
        emptyKey: "empty.input",
        footKey: "lane.foot.input",
      },
      {
        id: "running",
        icon: "activity",
        titleKey: "tab.running",
        hintKey: "lane.runningHint",
        padKey: "lane.pad.running",
        emptyKey: "empty.running",
        footKey: "lane.foot.running",
      },
      {
        id: "unread",
        icon: "inbox",
        titleKey: "tab.unread",
        hintKey: "lane.unreadHint",
        padKey: "lane.pad.unread",
        emptyKey: "empty.unread",
        footKey: "lane.foot.unread",
      },
    ];

    /** 面板里所有图标都从这张表出，统一 24 网格 / 1.6 描边。 */
    const ICONS = {
      alert: [
        ["path", { d: "M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" }],
        ["path", { d: "M12 9v4" }],
        ["path", { d: "M12 17h.01" }],
      ],
      activity: [["path", { d: "M22 12h-4l-3 9L9 3l-3 9H2" }]],
      inbox: [
        ["path", { d: "M22 11.08V12a10 10 0 1 1-5.93-9.14" }],
        ["path", { d: "m22 4-10 10.01-3-3" }],
      ],
      check: [["path", { d: "m20 6-11 11-4-4" }]],
      search: [["circle", { cx: 11, cy: 11, r: 6.6 }], ["path", { d: "m20 20-4.9-4.9" }]],
      chevron: [["path", { d: "m9 6 6 6-6 6" }]],
      chevronDown: [["path", { d: "m6 9 6 6 6-6" }]],
      bell: [
        ["path", { d: "M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" }],
        ["path", { d: "M13.73 21a2 2 0 0 1-3.46 0" }],
      ],
      sound: [
        ["path", { d: "M11 5 6 9H2v6h4l5 4V5Z" }],
        ["path", { d: "M15.54 8.46a5 5 0 0 1 0 7.07" }],
        ["path", { d: "M19.07 4.93a10 10 0 0 1 0 14.14" }],
      ],
      clock: [["circle", { cx: 12, cy: 12, r: 8.4 }], ["path", { d: "M12 7.6V12l3 1.8" }]],
      branch: [
        ["line", { x1: 6, y1: 3, x2: 6, y2: 15 }],
        ["circle", { cx: 18, cy: 6, r: 3 }],
        ["circle", { cx: 6, cy: 18, r: 3 }],
        ["path", { d: "M18 9a9 9 0 0 1-9 9" }],
      ],
      megaphone: [
        ["path", { d: "M3 11v2a1 1 0 0 0 1 1h2l4 4V6L6 10H4a1 1 0 0 0-1 1Z" }],
        ["path", { d: "M15 8a4 4 0 0 1 0 8" }],
      ],
      plugin: [
        ["path", { d: "M9 3h6v3a2 2 0 1 0 4 0V9h3v6h-3a2 2 0 1 0 0 4H9v-4a2 2 0 1 0 0-4H9Z" }],
      ],
      close: [["path", { d: "M6 6l12 12M18 6 6 18" }]],
    };

    function Icon(props) {
      const parts = ICONS[props.name] ?? [];
      const size = props.size ?? 16;
      return h(
        "svg",
        {
          className: props.className,
          width: size,
          height: size,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.6,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: props.style,
        },
        parts.map((part, index) => h(part[0], { ...part[1], key: index })),
      );
    }

    /** 等人的具体原因：提问、计划审阅、审批，各自的文案不同。 */
    function inputLabel(kind) {
      if (kind === "approval") return t("task.needsApproval");
      if (kind === "plan") return t("task.needsPlan");
      return t("task.needsInput");
    }

    function cardBadge(task) {
      if (task.needsInput) return { text: inputLabel(task.inputKind), tone: "warn", dot: true };
      if (task.running) return { text: t("badge.running"), tone: "blue", dot: true };
      if (task.interrupted) {
        // 中断是「人需要来看一眼」的结果，徽章优先于普通的未读更新。
        return {
          text: interruptedLabel(task),
          tone: interruptedKeyOf(task) === "exit" ? "warn" : "error",
          dot: true,
        };
      }
      if (task.unread) return { text: t("badge.new"), tone: "green", dot: true };
      return { text: t("badge.read"), tone: "idle", dot: false };
    }

    /** 中断类型 → 文案键：只有 quota/error 有独立文案，其余（含脏值）都按退出展示。 */
    function interruptedKeyOf(task) {
      const kind = task?.interruptedKind;
      return kind === "quota" ? "quota" : kind === "error" ? "error" : "exit";
    }

    function interruptedLabel(task) {
      return t(`badge.interrupted.${interruptedKeyOf(task)}`);
    }

    function interruptedDetail(task) {
      return t(`task.interrupted.${interruptedKeyOf(task)}`);
    }

    function cardTime(task, now) {
      const at = task.needsInput
        ? task.changeAt
        : task.running
          ? task.startedAt || task.changeAt
          : task.completedAt || task.changeAt;
      return relativeTime(at, now) || t("task.noTime");
    }

    function cardDetail(task, now) {
      if (task.needsInput) return t("card.wait", { time: relativeTime(task.changeAt, now) });
      if (task.running) {
        return t("card.runningFor", { time: relativeTime(task.startedAt || task.changeAt, now) });
      }
      if (task.interrupted) return interruptedDetail(task);
      return "";
    }

    function TaskCard(props) {
      const {
        task,
        lane,
        now,
        onOpen,
        onMarkRead,
        isSub = false,
        showParent = false,
        parentLabel = "",
        childStats = null,
        hasChildren = false,
        collapsed = false,
        onToggle,
      } = props;
      const badge = cardBadge(task);
      const detail = cardDetail(task, now);
      const interrupted = task.interrupted === true && !task.running && !task.needsInput;
      const cardClass = [
        "dtn-card",
        `dtn-card--${badge.tone}`,
        `dtn-card--lane-${lane}`,
        interrupted ? "dtn-card--interrupted" : "",
        isSub ? "dtn-card--sub" : "",
        hasChildren ? "dtn-card--parent" : "",
        hasChildren && collapsed ? "dtn-card--folded" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const stateText = task.needsInput
        ? inputLabel(task.inputKind)
        : task.running
          ? t("task.running")
          : task.interrupted
            ? interruptedLabel(task)
            : t("task.completed", { time: relativeTime(task.completedAt, now) });
      const stats = childStats && childStats.total > 0 ? childStats : null;
      return h(
        "article",
        {
          className: cardClass,
          role: "button",
          tabIndex: 0,
          "aria-label": t("row.openState", { title: taskTitle(task), state: stateText }),
          onClick: () => onOpen(task),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen(task);
            }
          },
        },
        showParent
          ? h(
              "div",
              { className: "dtn-card__lineage" },
              h(Icon, { name: "branch", size: 12, className: "dtn-card__lineage-ico" }),
              h(
                "span",
                { className: "dtn-card__lineage-name" },
                t("tree.fromParent", { name: parentLabel || t("tree.parentFallback") }),
              ),
            )
          : null,
        h(
          "div",
          { className: "dtn-card__top" },
          isSub
            ? h(
                "span",
                { className: "dtn-card__kind" },
                h(Icon, { name: "branch", size: 11 }),
                t("tree.subagent"),
              )
            : null,
          h(
            "span",
            { className: `dtn-badge dtn-badge--${badge.tone}` },
            badge.dot ? h("span", { className: "dtn-badge__dot", "aria-hidden": "true" }) : null,
            badge.text,
          ),
          h("span", { className: "dtn-card__time" }, cardTime(task, now)),
        ),
        h("span", { className: "dtn-card__title" }, taskTitle(task)),
        task.running ? h("span", { className: "dtn-live", "aria-hidden": "true" }) : null,
        h(
          "div",
          { className: "dtn-card__foot" },
          detail
            ? h(
                "span",
                {
                  className: "dtn-card__detail",
                  title: task.interrupted && task.interruptedMessage ? task.interruptedMessage : undefined,
                },
                detail,
              )
            : null,
          h(
            "span",
            { className: "dtn-card__actions" },
            task.unread && !task.running && !task.needsInput
              ? h(
                  "button",
                  {
                    type: "button",
                    className: "dtn-mini",
                    onClick: (event) => {
                      event.stopPropagation();
                      onMarkRead(task);
                    },
                  },
                  h(Icon, { name: "check", size: 12 }),
                  t("action.markRead"),
                )
              : null,
            h(
              "button",
              {
                type: "button",
                className: "dtn-mini dtn-mini--go",
                onClick: (event) => {
                  event.stopPropagation();
                  onOpen(task);
                },
              },
              task.needsInput ? t("action.goReply") : t("action.open"),
              h(Icon, { name: "chevron", size: 12 }),
            ),
          ),
        ),
        stats && hasChildren
          ? h(
              "button",
              {
                type: "button",
                className: "dtn-card__children",
                "aria-expanded": collapsed ? "false" : "true",
                title: collapsed ? t("tree.toggleExpand") : t("tree.toggleCollapse"),
                onClick: (event) => {
                  event.stopPropagation();
                  if (onToggle) onToggle();
                },
              },
              h(Icon, {
                name: collapsed ? "chevron" : "chevronDown",
                size: 12,
                className: "dtn-card__children-tw",
              }),
              h("span", null, t("tree.children", { n: stats.total })),
              stats.running
                ? h("span", { className: "dtn-card__children-meta" }, t("tree.childStatsRunning", { n: stats.running }))
                : null,
              stats.done
                ? h("span", { className: "dtn-card__children-meta" }, t("tree.childStatsDone", { n: stats.done }))
                : null,
            )
          : stats
            ? h(
                "span",
                { className: "dtn-card__children dtn-card__children--static" },
                h(Icon, { name: "branch", size: 12, className: "dtn-card__children-tw" }),
                h("span", null, t("tree.children", { n: stats.total })),
                stats.running
                  ? h("span", { className: "dtn-card__children-meta" }, t("tree.childStatsRunning", { n: stats.running }))
                  : null,
                stats.done
                  ? h("span", { className: "dtn-card__children-meta" }, t("tree.childStatsDone", { n: stats.done }))
                  : null,
              )
            : null,
      );
    }

    /** 列脚：给一列里最「久」的那条一个真实数字，便于判断该先处理谁。 */
    function laneFoot(lane, tasks, now) {
      if (!tasks.length) return "";
      if (lane === "input") {
        const oldest = Math.min(...tasks.map((task) => task.changeAt || now));
        return t("lane.foot.input", { time: relativeTime(oldest, now) });
      }
      if (lane === "running") {
        const oldest = Math.min(...tasks.map((task) => task.startedAt || task.changeAt || now));
        return t("lane.foot.running", { time: relativeTime(oldest, now) });
      }
      const oldest = Math.min(...tasks.map((task) => task.completedAt || task.changeAt || now));
      return t("lane.foot.unread", { time: relativeTime(oldest, now) });
    }

    /** 把一列内的任务按 parentId 归成树；父不在本列的子代理当作根，改用「来自」标注。 */
    function buildLaneTree(tasks) {
      const inLane = new Map(tasks.map((task) => [task.id, task]));
      const kids = new Map();
      const roots = [];
      for (const task of tasks) {
        const parent = task.parentId;
        if (parent && parent !== task.id && inLane.has(parent)) {
          const bucket = kids.get(parent);
          if (bucket) bucket.push(task);
          else kids.set(parent, [task]);
        } else {
          roots.push(task);
        }
      }
      const seen = new Set();
      const build = (task, depth) => {
        if (seen.has(task.id) || depth > 8) return { task, children: [] };
        seen.add(task.id);
        const children = (kids.get(task.id) ?? []).map((child) => build(child, depth + 1));
        return { task, children };
      };
      return roots.map((task) => build(task, 0));
    }

    /** 递归渲染一个树节点：卡片 + 可折叠的同栏子树。 */
    function TaskTreeNode(props) {
      const { node, lane, now, onOpen, onMarkRead, childStats, allById, collapsed, onToggle, isRoot } = props;
      const { task, children } = node;
      const hasChildren = children.length > 0;
      const isSub = Boolean(task.parentId);
      const showParent = isRoot && isSub;
      const parentTask = showParent ? allById.get(task.parentId) : null;
      const parentLabel = parentTask ? taskTitle(parentTask) : task.parentTitle || t("tree.parentFallback");
      const stats = childStats.get(task.id) ?? null;
      const isCollapsed = hasChildren && collapsed.has(task.id);
      return h(
        "div",
        { className: "dtn-tree" },
        h(TaskCard, {
          task,
          lane,
          now,
          onOpen,
          onMarkRead,
          isSub,
          showParent,
          parentLabel,
          childStats: stats,
          hasChildren,
          collapsed: isCollapsed,
          onToggle: hasChildren ? () => onToggle(task.id) : null,
        }),
        hasChildren && !isCollapsed
          ? h(
              "div",
              { className: "dtn-subtree" },
              children.map((child) =>
                h(TaskTreeNode, {
                  key: child.task.id,
                  node: child,
                  lane,
                  now,
                  onOpen,
                  onMarkRead,
                  childStats,
                  allById,
                  collapsed,
                  onToggle,
                  isRoot: false,
                }),
              ),
            )
          : null,
      );
    }

    function Lane(props) {
      const { lane, tasks, now, query, onOpen, onMarkRead, childStats, allById, collapsed, onToggle } = props;
      const emptyText = query ? t("blank.search") : t(`empty.${lane.id}`);
      const foot = laneFoot(lane.id, tasks, now);
      const nodes = buildLaneTree(tasks);
      return h(
        "section",
        { className: `dtn-lane dtn-lane--${lane.id}`, "aria-label": t(lane.titleKey) },
        h(
          "header",
          { className: "dtn-lane__head" },
          h("span", { className: "dtn-lane__icon" }, h(Icon, { name: lane.icon, size: 15 })),
          h("span", { className: "dtn-lane__name" }, t(lane.titleKey)),
          h("span", { className: "dtn-lane__count" }, String(tasks.length)),
          h("span", { className: "dtn-lane__hint" }, t(lane.hintKey)),
        ),
        h(
          "div",
          { className: "dtn-lane__body" },
          nodes.map((node) =>
            h(TaskTreeNode, {
              key: node.task.id,
              node,
              lane: lane.id,
              now,
              onOpen,
              onMarkRead,
              childStats,
              allById,
              collapsed,
              onToggle,
              isRoot: true,
            }),
          ),
          h(
            "div",
            { className: tasks.length ? "dtn-lane__pad" : "dtn-lane__pad dtn-lane__pad--empty" },
            h(Icon, { name: tasks.length ? lane.icon : "clock", size: 16 }),
            h("span", null, tasks.length ? t(lane.padKey) : emptyText),
          ),
        ),
        foot
          ? h(
              "footer",
              { className: "dtn-lane__foot" },
              h("span", null, foot),
              h("span", { className: "dtn-lane__foot-n" }, t("lane.foot.count", { n: tasks.length })),
            )
          : null,
      );
    }

    function TasksPage(props) {
      const { store } = props;
      const ctx = props.ctx ?? {};
      const state = useNotifier(store);
      useLocaleTick();
      const [filter, setFilter] = useState(null);
      const [query, setQuery] = useState("");
      const [archiveOpen, setArchiveOpen] = useState(false);
      const [permission, setPermission] = useState(notificationPermissionState);
      const [notice, setNotice] = useState(null);
      // 折叠的父会话 id 集合：默认空 = 展开，点父卡可收起它的同栏子树。
      const [collapsed, setCollapsed] = useState(() => new Set());

      // 自检结果用一行 status 提示，不打断操作
      useEffect(() => {
        if (!notice) return undefined;
        const timer = setTimeout(() => setNotice(null), 4000);
        return () => clearTimeout(timer);
      }, [notice]);

      const now = state.nowAt ?? Date.now();
      const tasks = useMemo(() => {
        const list = [...(state.tasks ?? [])];
        const rank = (task) => (task.needsInput ? 0 : task.running ? 1 : 2);
        list.sort((a, b) => rank(a) - rank(b) || (b.changeAt ?? 0) - (a.changeAt ?? 0));
        return list;
      }, [state.rev, state.tasks]);

      const inputTasks = useMemo(() => tasks.filter((task) => task.needsInput), [tasks]);
      const runningTasks = useMemo(() => tasks.filter((task) => task.running && !task.needsInput), [tasks]);
      const unreadTasks = useMemo(() => tasks.filter((task) => !task.running && !task.needsInput && task.unread), [tasks]);
      const earlierTasks = useMemo(() => tasks.filter((task) => !task.running && !task.needsInput && !task.unread), [tasks]);

      const byLane = { input: inputTasks, running: runningTasks, unread: unreadTasks };

      // 全局父子索引：栏内建树时用；跨栏或被搜索过滤掉的子任务也计入父卡计数。
      const treeIndex = useMemo(() => {
        const allById = new Map(tasks.map((task) => [task.id, task]));
        const byParent = new Map();
        for (const task of tasks) {
          if (!task.parentId || task.parentId === task.id || !allById.has(task.parentId)) continue;
          const bucket = byParent.get(task.parentId);
          if (bucket) bucket.push(task);
          else byParent.set(task.parentId, [task]);
        }
        const stats = new Map();
        for (const [parentId, kids] of byParent) {
          let running = 0;
          let done = 0;
          for (const kid of kids) {
            if (kid.running && !kid.needsInput) running += 1;
            else if (!kid.running && !kid.needsInput) done += 1;
          }
          stats.set(parentId, { total: kids.length, running, done });
        }
        return { allById, stats };
      }, [tasks]);

      const toggleCollapse = useCallback((id) => {
        setCollapsed((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }, []);

      const needsInputCount = state.needsInputCount?.() ?? 0;
      const runningCount = state.runningCount?.() ?? 0;
      const unreadCount = state.unreadCount?.() ?? 0;

      const needle = query.trim().toLowerCase();
      const matches = (task) => !needle || taskTitle(task).toLowerCase().includes(needle);
      const visibleLanes = filter ? LANES.filter((lane) => lane.id === filter) : LANES;
      const archiveVisible = earlierTasks.filter(matches);

      const openTask = props.onOpen ?? (async () => {});
      const markRead = (task) => store.markRead([task.id], false);

      const permissionKey =
        permission === "granted" || permission === "denied" || permission === "unsupported"
          ? permission
          : "default";
      const permissionLabel = t(`permission.${permissionKey}`);

      const headerRight = [
        h(
          "button",
          {
            type: "button",
            key: "permission",
            className: `dtn-perm dtn-perm--${permissionKey}`,
            title: permissionLabel,
            onClick: async () => {
              setPermission(await requestBrowserPermission());
            },
          },
          h("span", { className: "dtn-perm__dot", "aria-hidden": "true" }),
          permissionLabel,
        ),
        h(
          "button",
          {
            type: "button",
            key: "test-sound",
            className: "dtn-btn",
            onClick: () => {
              playChime();
            },
          },
          h(Icon, { name: "sound", size: 14 }),
          h("span", null, t("action.testSound")),
        ),
        h(
          "button",
          {
            type: "button",
            key: "test-os",
            className: "dtn-btn",
            onClick: async () => {
              try {
                // 必须走 postJson：宿主对非 GET 要求 application/json，裸 POST 会被 415 拒掉。
                const result = await postJson(`${API}/test`);
                if (result?.ok) setNotice(t("test.sent"));
                else if (result?.reason === "disabled") setNotice(t("test.disabled"));
                else if (result?.reason === "unsupported-platform") setNotice(t("test.unsupported"));
                else setNotice(result?.reason ? t("test.error", { error: result.reason }) : t("test.failed"));
              } catch (error) {
                const message = String(error?.message ?? error);
                setNotice(message.includes("429") ? t("test.cooldown") : t("test.error", { error: message }));
                console?.error?.("[dsh-task-notifier] 测试系统通知失败：", error);
              }
            },
          },
          h(Icon, { name: "bell", size: 14 }),
          h("span", null, t("action.testOs")),
        ),
      ];

      if (unreadCount > 0) {
        headerRight.push(
          h(
            "button",
            {
              type: "button",
              key: "read-all",
              className: "dtn-btn dtn-btn--primary",
              "aria-label": t("action.markAllReadN", { n: unreadCount }),
              onClick: async () => {
                store.markRead([], true);
              },
            },
            h(Icon, { name: "check", size: 14 }),
            h("span", null, t("action.markAllRead")),
            h("span", { className: "dtn-btn__count" }, String(unreadCount)),
          ),
        );
      }

      const chips = LANES.map((lane) =>
        h(
          "button",
          {
            key: lane.id,
            type: "button",
            className: "dtn-chip",
            "data-lane": lane.id,
            "aria-pressed": filter === lane.id ? "true" : "false",
            title: filter === lane.id ? t("action.clearFilter") : t(lane.hintKey),
            onClick: () => setFilter((current) => (current === lane.id ? null : lane.id)),
          },
          h("span", { className: "dtn-chip__dot", "aria-hidden": "true" }),
          t(lane.titleKey),
          h("span", { className: "dtn-chip__n" }, String(byLane[lane.id].length)),
        ),
      );

      const hasTasks = tasks.length > 0;

      return h(
        "div",
        { className: "dtn-root", style: pageStyle() },
        h(
          "div",
          { className: "dtn-page" },
          h(
            "header",
            { className: "dtn-head" },
            h(
              "div",
              { className: "dtn-head__info" },
              h("div", { className: "dtn-eyebrow" }, t("panel.brand")),
              h(
                "div",
                { className: "dtn-title-row" },
                h("h1", { className: "dtn-title" }, t("panel.title")),
                hasTasks ? h("span", { className: "dtn-total" }, t("panel.total", { n: tasks.length })) : null,
              ),
              h(
                "p",
                { className: "dtn-sub" },
                t("panel.subtitle"),
                state.connection !== "ok" && state.error
                  ? h("span", { className: "dtn-sub__error" }, t("panel.connectionError", { error: state.error }))
                  : null,
              ),
            ),
            h("div", { className: "dtn-actions" }, headerRight),
          ),
          notice
            ? h("div", { className: "dtn-notice", role: "status" }, notice)
            : null,
          hasTasks
            ? h(
                "div",
                { className: "dtn-toolbar" },
                h(
                  "label",
                  { className: "dtn-search" },
                  h(Icon, { name: "search", size: 15, className: "dtn-search__icon" }),
                  h("input", {
                    className: "dtn-search__input",
                    value: query,
                    onInput: (event) => setQuery(event.target.value),
                    placeholder: t("search.placeholder"),
                    "aria-label": t("search.aria"),
                  }),
                ),
                h("div", { className: "dtn-chips", role: "group" }, chips),
                filter
                  ? h(
                      "button",
                      {
                        type: "button",
                        className: "dtn-link",
                        onClick: () => setFilter(null),
                      },
                      t("action.clearFilter"),
                    )
                  : null,
              )
            : null,
          hasTasks
            ? h(
                "div",
                { className: filter ? "dtn-lanes dtn-lanes--single" : "dtn-lanes" },
                visibleLanes.map((lane) =>
                  h(Lane, {
                    key: lane.id,
                    lane,
                    tasks: byLane[lane.id].filter(matches),
                    now,
                    query: needle,
                    onOpen: openTask,
                    onMarkRead: markRead,
                    childStats: treeIndex.stats,
                    allById: treeIndex.allById,
                    collapsed,
                    onToggle: toggleCollapse,
                  }),
                ),
              )
            : h(
                "div",
                { className: "dtn-blank" },
                h(Icon, { name: "inbox", size: 22, className: "dtn-blank__icon" }),
                h("div", { className: "dtn-blank__title" }, t("blank.all")),
                h("div", { className: "dtn-blank__hint" }, t("blank.allHint")),
              ),
          !filter && hasTasks && archiveVisible.length
            ? h(
                "div",
                { className: "dtn-archive" },
                h(
                  "button",
                  {
                    type: "button",
                    className: "dtn-archive__bar",
                    "aria-expanded": archiveOpen ? "true" : "false",
                    onClick: () => setArchiveOpen((open) => !open),
                  },
                  h(Icon, { name: "check", size: 14, className: "dtn-archive__check" }),
                  h("span", null, t("archive.title")),
                  h("span", { className: "dtn-archive__n" }, t("archive.count", { n: archiveVisible.length })),
                  h(
                    "span",
                    { className: "dtn-archive__toggle" },
                    archiveOpen ? t("archive.collapse") : t("archive.expand"),
                    h(Icon, { name: archiveOpen ? "chevronDown" : "chevron", size: 13 }),
                  ),
                ),
                archiveOpen
                  ? h(
                      "div",
                      { className: "dtn-archive__list" },
                      archiveVisible.map((task) =>
                        h(
                          "button",
                          {
                            key: task.id,
                            type: "button",
                            className: "dtn-hist",
                            onClick: () => openTask(task),
                          },
                          h(Icon, {
                            name: task.interrupted ? "alert" : "check",
                            size: 13,
                            className: task.interrupted ? "dtn-hist__check dtn-hist__check--warn" : "dtn-hist__check",
                          }),
                          h("span", { className: "dtn-hist__title" }, taskTitle(task)),
                          h("span", { className: "dtn-hist__time" }, relativeTime(task.completedAt, now) || t("task.noTime")),
                        ),
                      ),
                    )
                  : null,
              )
            : null,
        ),
      );
    }

    function pageStyle() {
      return {
        height: "100%",
        minHeight: 0,
        boxSizing: "border-box",
        overflow: "auto",
        color: "var(--dsw-alias-label-primary)",
        fontFamily: "var(--dsw-font-family)",
        background: "transparent",
        padding: "calc(26px + var(--dsh-frame-top-clearance, 0px)) max(24px, var(--dsh-frame-leading-clearance, 0px)) 36px",
      };
    }

    /* ============================ 通知中心 ============================ */

    const ACCOUNT_READ_KEY = `${NS}:account-read`;

    function loadAccountRead() {
      try {
        const raw = localStorage.getItem(ACCOUNT_READ_KEY);
        const arr = raw ? JSON.parse(raw) : [];
        return new Set(Array.isArray(arr) ? arr.filter((item) => typeof item === "string") : []);
      } catch {
        return new Set();
      }
    }

    function saveAccountRead(set) {
      try {
        localStorage.setItem(ACCOUNT_READ_KEY, JSON.stringify([...set]));
      } catch {
        /* 存储不可用就当作没记住 */
      }
    }

    function plainText(value) {
      return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    }

    /** 账号通知转成统一条目（只读展示，账号来源不触发系统通知）。 */
    function accountEntriesOf(notices, readSet) {
      const out = [];
      for (const notice of notices ?? []) {
        if (!notice?.id) continue;
        out.push({
          id: `account:${notice.id}`,
          source: "account",
          sourceLabel: null,
          kind: "announcement",
          title: plainText(notice.title) || t("center.accountBadge"),
          body: plainText(notice.body) || null,
          tone: "info",
          ts: Date.parse(notice.createdAt) || Date.now(),
          read: readSet.has(notice.id),
          sessionId: null,
          _notice: notice,
        });
      }
      return out;
    }

    function sourceIconName(source) {
      if (source === "account") return "megaphone";
      if (source === "plugin") return "plugin";
      return "check";
    }

    function entryTag(entry) {
      if (entry.kind === "needsInput") return { text: entry.body || t("task.needsInput"), tone: "warn" };
      if (entry.source === "task") {
        if (entry.kind === "interrupted") {
          const kind = entry.interruptedKind;
          const key =
            kind === "quota"
              ? "badge.interrupted.quota"
              : kind === "error"
                ? "badge.interrupted.error"
                : "badge.interrupted.exit";
          return { text: t(key), tone: kind === "quota" ? "err" : "warn" };
        }
        return { text: t("center.completedBody"), tone: "ok" };
      }
      if (entry.source === "account") return { text: t("center.accountBadge"), tone: "src" };
      return {
        text: entry.sourceLabel ? t("center.pluginPrefix", { name: entry.sourceLabel }) : t("center.source.plugin"),
        tone: "src",
      };
    }

    function NotificationRow(props) {
      const { entry, onOpen } = props;
      const tag = entryTag(entry);
      return h(
        "div",
        {
          className: `dtn-ni dtn-ni--${entry.source}`,
          role: "button",
          tabIndex: 0,
          "aria-label": entry.title,
          onClick: () => onOpen(entry),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen(entry);
            }
          },
        },
        h("span", { className: `dtn-ni__icon dtn-ni__icon--${entry.source}` }, h(Icon, { name: sourceIconName(entry.source), size: 16 })),
        h(
          "div",
          { className: "dtn-ni__main" },
          h(
            "div",
            { className: "dtn-ni__top" },
            h("span", { className: "dtn-ni__title" }, entry.title || t("task.untitled")),
            h("span", { className: "dtn-ni__time" }, relativeTime(entry.ts, Date.now())),
          ),
          entry.body ? h("div", { className: "dtn-ni__body" }, entry.body) : null,
          h("div", { className: "dtn-ni__tags" }, h("span", { className: `dtn-ni__tag dtn-ni__tag--${tag.tone}` }, tag.text)),
        ),
        entry.read ? null : h("span", { className: "dtn-ni__dot", "aria-hidden": "true" }),
        h("span", { className: "dtn-ni__open" }, entry.kind === "needsInput" ? t("center.handle") : t("center.open"), " ›"),
      );
    }

    /** 侧边栏任务面板入口图标（带未读角标）。 */
    function TaskSidebarIcon(props) {
      const state = useNotifier(props.store);
      const size = props && Number.isFinite(props.size) ? props.size : 18;
      const unread = state.unreadCount?.() ?? 0;
      return h(
        "span",
        { className: "dtn-panel-mark", style: { width: `${size}px`, height: `${size}px` } },
        h(Icon, { name: "bell", size }),
        unread > 0
          ? h("span", { className: "dtn-panel-mark__badge", "aria-hidden": "true" }, unread > 9 ? "9+" : String(unread))
          : null,
      );
    }

    /**
     * 右上角通知中心：铃铛（唯一入口）+ 通知面板；`展开` 进入原三列任务看板。
     * 注册在 shell.overlay，跨所有主面板常驻。
     */
    function NotificationCenterRoot(props) {
      const store = props.store;
      const ctx = props.ctx ?? {};
      const remote = props.remote;
      const accountUi = props.accountUi;
      const state = useNotifier(store);
      useLocaleTick();
      const [open, setOpen] = useState(false);
      const [expanded, setExpanded] = useState(false);
      const [filter, setFilter] = useState("all"); // all | unread | todo
      const [sourceFilter, setSourceFilter] = useState("all");
      const [accountNotices, setAccountNotices] = useState([]);
      const [accountRead, setAccountRead] = useState(loadAccountRead);
      const rootRef = useRef(null);
      const btnRef = useRef(null);
      const [anchor, setAnchor] = useState(null);

      // 打开面板时才拉账号通知，避免后台空轮询。
      useEffect(() => {
        if (!open || !remote) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const api = remote.account;
            const get = api && api.getNotifications;
            if (typeof get !== "function") return;
            const meta =
              accountUi && typeof accountUi.clientMetadata === "function"
                ? accountUi.clientMetadata(activeLocale())
                : undefined;
            const result = await (meta === undefined ? get() : get(meta));
            const value = result && result.ok === false ? null : result && result.ok === true ? result.value : result;
            const list = value && Array.isArray(value.notifications) ? value.notifications : [];
            if (!cancelled) setAccountNotices(list);
          } catch {
            /* 账号来源不可用就当作没有 */
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [open, remote, accountUi]);

      useEffect(() => {
        if (!open) return undefined;
        const onKey = (event) => {
          if (event.key === "Escape") setOpen(false);
        };
        const onDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener("keydown", onKey);
        document.addEventListener("pointerdown", onDown, true);
        return () => {
          document.removeEventListener("keydown", onKey);
          document.removeEventListener("pointerdown", onDown, true);
        };
      }, [open]);

      const accountEntries = useMemo(() => accountEntriesOf(accountNotices, accountRead), [accountNotices, accountRead]);
      const feed = useMemo(
        () => [...(state.notifications ?? []), ...accountEntries].sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)),
        [state.rev, state.notifications, accountEntries],
      );
      const todoTasks = useMemo(() => (state.tasks ?? []).filter((task) => task.needsInput), [state.rev, state.tasks]);
      const unreadFeed = feed.filter((entry) => !entry.read);
      const accountUnread = accountEntries.filter((entry) => !entry.read).length;
      const hostUnread = state.notificationUnreadCount?.() ?? 0;
      const totalUnread = hostUnread + accountUnread + todoTasks.length;

      const visibleFeed = feed.filter(
        (entry) => (filter === "unread" ? !entry.read : true) && (sourceFilter === "all" || entry.source === sourceFilter),
      );
      const showPinned = filter !== "unread";
      const showFeed = filter !== "todo";

      const markAll = () => {
        store.markAllRead?.();
        if (accountNotices.length) {
          const next = new Set(accountRead);
          for (const notice of accountNotices) next.add(notice.id);
          setAccountRead(next);
          saveAccountRead(next);
        }
      };

      const openEntry = async (entry) => {
        if (entry._notice) {
          const next = new Set(accountRead);
          next.add(entry._notice.id);
          setAccountRead(next);
          saveAccountRead(next);
          return;
        }
        if (!entry.read) store.markNotificationRead?.([entry.id]);
        if (entry.sessionId) {
          try {
            await ctx.uiWorkspace?.openSession(entry.sessionId);
          } catch {
            /* 跳转失败保留面板 */
          }
        }
        setOpen(false);
      };

      const openTodo = async (task) => {
        try {
          await ctx.uiWorkspace?.openSession(task.id);
        } catch {
          /* 跳转失败保留面板 */
        }
        setOpen(false);
        setExpanded(false);
      };

      const bell = h(
        "button",
        {
          type: "button",
          className: `dtn-bell${open ? " is-open" : ""}`,
          "aria-label": t("center.title"),
          "aria-expanded": open ? "true" : "false",
          ref: btnRef,
          onClick: () => {
            if (!open) {
              const rect = btnRef.current?.getBoundingClientRect?.();
              if (rect) {
                setAnchor({
                  top: Math.round(rect.bottom + 6),
                  right: Math.max(8, Math.round(window.innerWidth - rect.right)),
                });
              }
            }
            setOpen((value) => !value);
          },
        },
        h(Icon, { name: "bell", size: 18 }),
        totalUnread > 0
          ? h("span", { className: "dtn-bell__badge", "aria-label": t("center.unread", { n: totalUnread }) }, totalUnread > 99 ? "99+" : String(totalUnread))
          : null,
      );

      const pinnedRows = showPinned
        ? todoTasks.map((task) =>
            h(
              "div",
              {
                key: `todo:${task.id}`,
                className: "dtn-ni dtn-ni--todo",
                role: "button",
                tabIndex: 0,
                onClick: () => openTodo(task),
                onKeyDown: (event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    openTodo(task);
                  }
                },
              },
              h("span", { className: "dtn-ni__icon dtn-ni__icon--task" }, h(Icon, { name: "alert", size: 16 })),
              h(
                "div",
                { className: "dtn-ni__main" },
                h(
                  "div",
                  { className: "dtn-ni__top" },
                  h("span", { className: "dtn-ni__title" }, taskTitle(task)),
                  h("span", { className: "dtn-ni__time" }, relativeTime(task.changeAt || task.startedAt, Date.now())),
                ),
                h("div", { className: "dtn-ni__tags" }, h("span", { className: "dtn-ni__tag dtn-ni__tag--warn" }, inputLabel(task.inputKind))),
              ),
              h("span", { className: "dtn-ni__open" }, t("center.handle"), " ›"),
            ),
          )
        : [];

      const feedRows = showFeed ? visibleFeed.map((entry) => h(NotificationRow, { key: entry.id, entry, onOpen: openEntry })) : [];

      const grouped = [];
      let lastDay = null;
      for (const row of feedRows) {
        const entry = row.props.entry;
        const day = new Date(entry.ts ?? Date.now()).toDateString() === new Date().toDateString() ? "today" : "earlier";
        if (day !== lastDay) {
          grouped.push(
            h("div", { className: "dtn-nc__group", key: `g:${day}` }, day === "today" ? t("center.today") : t("center.earlier")),
          );
          lastDay = day;
        }
        grouped.push(row);
      }

      const panel = open
        ? h(
            "div",
            {
              className: "dtn-nc__panel",
              role: "dialog",
              "aria-label": t("center.title"),
              style: anchor
                ? { "--dtn-top": `${anchor.top}px`, "--dtn-right": `${anchor.right}px` }
                : undefined,
            },
            h(
              "div",
              { className: "dtn-nc__head" },
              h(Icon, { name: "bell", size: 16 }),
              h("span", { className: "dtn-nc__title" }, t("center.title")),
              totalUnread > 0 ? h("span", { className: "dtn-nc__chip" }, t("center.unread", { n: totalUnread })) : null,
              h("span", { className: "dtn-nc__sp" }),
              totalUnread > 0
                ? h("button", { type: "button", className: "dtn-nc__act", onClick: markAll }, t("center.markAllRead"))
                : null,
              h(
                "button",
                { type: "button", className: "dtn-nc__x", "aria-label": t("center.close"), onClick: () => setOpen(false) },
                h(Icon, { name: "close", size: 15 }),
              ),
            ),
            h(
              "div",
              { className: "dtn-nc__filter" },
              h(
                "div",
                { className: "dtn-nc__seg" },
                h("button", { type: "button", className: filter === "all" ? "on" : "", onClick: () => setFilter("all") }, t("center.all"), h("i", null, String(feed.length + todoTasks.length))),
                h("button", { type: "button", className: filter === "unread" ? "on" : "", onClick: () => setFilter("unread") }, t("center.unreadShort"), h("i", null, String(totalUnread))),
                h("button", { type: "button", className: filter === "todo" ? "on" : "", onClick: () => setFilter("todo") }, t("center.todo"), h("i", null, String(todoTasks.length))),
              ),
              h(
                "select",
                { className: "dtn-nc__src", value: sourceFilter, onChange: (event) => setSourceFilter(event.target.value), "aria-label": t("center.allSources") },
                h("option", { value: "all" }, t("center.allSources")),
                h("option", { value: "task" }, t("center.source.task")),
                h("option", { value: "account" }, t("center.source.account")),
                h("option", { value: "plugin" }, t("center.source.plugin")),
              ),
            ),
            h(
              "div",
              { className: "dtn-nc__body" },
              state.connection === "error" && state.error
                ? h("div", { className: "dtn-nc__error" }, t("center.connectionError", { error: state.error }))
                : null,
              pinnedRows.length
                ? [h("div", { className: "dtn-nc__group is-todo", key: "g:todo" }, h("i", null), t("center.needYou")), ...pinnedRows]
                : null,
              grouped.length ? grouped : null,
              !pinnedRows.length && !feedRows.length
                ? h(
                    "div",
                    { className: "dtn-nc__empty" },
                    h(Icon, { name: "bell", size: 26 }),
                    h("div", { className: "dtn-nc__empty-title" }, t("center.empty")),
                    h("div", { className: "dtn-nc__empty-hint" }, t("center.emptyHint")),
                  )
                : null,
            ),
            h(
              "div",
              { className: "dtn-nc__foot" },
              h(
                "button",
                { type: "button", className: "dtn-nc__expand", onClick: () => { setExpanded(true); setOpen(false); } },
                t("center.expand"),
                h(Icon, { name: "chevron", size: 14 }),
              ),
              h("span", { className: "dtn-nc__foot-settings" }, t("center.settings")),
            ),
          )
        : null;

      const full = expanded
        ? h(
            "div",
            { className: "dtn-nc__full", role: "dialog", "aria-label": t("panel.title") },
            h(
              "div",
              { className: "dtn-nc__full-bar" },
              h("span", null, t("panel.title")),
              h(
                "button",
                { type: "button", className: "dtn-nc__x", "aria-label": t("center.close"), onClick: () => setExpanded(false) },
                h(Icon, { name: "close", size: 16 }),
              ),
            ),
            h("div", { className: "dtn-nc__full-body" }, h(TasksPage, { ctx, store, onOpen: openTodo })),
          )
        : null;

      return h("div", { className: "dtn-nc", ref: rootRef }, bell, panel, full);
    }

    /* ============================ 装配 ============================ */

    const CSS = `
/* ============================ 侧栏入口 ============================ */

/* 宿主 .panelGlyph 没有固定尺寸：这个方框就是图标占位，必须是 size×size，
   标题才会和别的入口从同一条竖线上开始。 */
.dtn-panel-mark {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.dtn-panel-mark > svg {
  display: block;
}
/* 未读数叠在图标右上角（画进 SVG 会把画布撑大）；描边取侧栏底色，和图标线条分开。 */
.dtn-panel-mark__badge {
  position: absolute;
  top: -4px;
  right: -5px;
  min-width: 11px;
  height: 11px;
  padding: 0 2px;
  box-sizing: border-box;
  border-radius: 6px;
  background: var(--dsw-alias-state-error-primary, #ec1313);
  box-shadow: 0 0 0 1.5px var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-label-primary-inverted, #fff);
  font-family: var(--ds-font-family-code);
  font-size: 8px;
  font-weight: 700;
  line-height: 11px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  pointer-events: none;
}

/* ============================ 页面骨架 ============================ */

/* 宽屏（宿主整窗 3000px+）里把内容收敛到 1240，别让一排任务拉成一条直线。 */
.dtn-page {
  max-width: 1240px;
  margin: 0 auto;
  min-width: 0;
}

/* 不需要跟着主题变化的派生色：状态文字压深一点，保证 4.5:1 以上对比度。 */
.dtn-root {
  --dtn-warn-ink: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 58%, var(--dsw-alias-label-primary));
  --dtn-blue-ink: color-mix(in srgb, var(--dsw-alias-state-business-primary) 88%, var(--dsw-alias-label-primary));
  --dtn-green-ink: color-mix(in srgb, var(--dsw-alias-state-success-primary) 52%, var(--dsw-alias-label-primary));
  --dtn-error-ink: color-mix(in srgb, var(--dsw-alias-state-error-primary) 62%, var(--dsw-alias-label-primary));
}

/* ============================== 页头 ============================== */
.dtn-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}
.dtn-head__info {
  min-width: 0;
}
.dtn-eyebrow {
  font-family: var(--ds-font-family-code);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.18em;
  color: var(--dsw-alias-label-tertiary);
  margin-bottom: 8px;
}
.dtn-title-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.dtn-title {
  margin: 0;
  font-size: 22px;
  line-height: 30px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--dsw-alias-label-primary);
}
.dtn-total {
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-interactive-bg-hover);
  border-radius: 999px;
  padding: 2px 8px;
}
.dtn-sub {
  margin: 7px 0 0;
  max-width: 640px;
  font-size: 12.5px;
  line-height: 19px;
  color: var(--dsw-alias-label-secondary);
}
.dtn-sub__error {
  margin-left: 8px;
  color: var(--dsw-alias-state-warn-label, var(--dsw-alias-state-warn-primary));
}

/* ============================ 动作区 ============================ */
.dtn-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px;
  flex: none;
  padding-top: 4px;
}
.dtn-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 12px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 120ms ease;
}
.dtn-btn svg {
  color: var(--dsw-alias-label-tertiary);
}
.dtn-btn:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover));
  border-color: var(--dsw-alias-border-l3);
  color: var(--dsw-alias-label-primary);
}
.dtn-btn:hover svg {
  color: inherit;
}
.dtn-btn:active {
  transform: scale(0.985);
}
.dtn-btn--primary {
  border-color: transparent;
  background: var(--dsw-alias-label-primary);
  color: var(--dsw-alias-label-primary-inverted);
  font-weight: 600;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 22%, transparent);
}
.dtn-btn--primary svg {
  color: currentColor;
  opacity: 0.85;
}
.dtn-btn--primary:hover {
  background: color-mix(in srgb, var(--dsw-alias-label-primary) 88%, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary-inverted);
}
.dtn-btn__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  margin-left: 1px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-label-primary-inverted) 20%, transparent);
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  font-weight: 700;
}

/* 通知权限：读作「状态」，形状与矩形按钮区分开。 */
.dtn-perm {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease;
}
.dtn-perm:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dtn-perm__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-label-caption);
}
.dtn-perm--granted .dtn-perm__dot {
  background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 16%, transparent);
}
.dtn-perm--denied .dtn-perm__dot {
  background: var(--dsw-alias-state-error-primary);
}
.dtn-perm--default .dtn-perm__dot,
.dtn-perm--unsupported .dtn-perm__dot {
  background: var(--dsw-alias-state-warn-primary);
}

.dtn-notice {
  margin-top: 14px;
  padding: 8px 12px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
}

/* ============================ 工具条 ============================ */
.dtn-toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  margin: 18px 0 14px;
}
.dtn-search {
  display: flex;
  align-items: center;
  gap: 8px;
  width: min(320px, 100%);
  height: 34px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-tertiary);
  transition: border-color 140ms ease, box-shadow 140ms ease;
}
.dtn-search:focus-within {
  border-color: color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 58%, transparent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)) 14%, transparent);
}
.dtn-search__icon {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-search__input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: 0;
  background: transparent;
  font: inherit;
  font-size: 12.5px;
  color: var(--dsw-alias-label-primary);
}
.dtn-search__input::placeholder {
  color: var(--dsw-alias-label-tertiary);
}
.dtn-chips {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin-left: auto;
}
.dtn-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease;
}
.dtn-chip__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  flex: none;
  background: var(--dsw-alias-label-caption);
}
.dtn-chip__n {
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10px;
  font-weight: 600;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-chip:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dtn-chip[data-lane="input"] .dtn-chip__dot {
  background: var(--dsw-alias-state-warn-primary);
}
.dtn-chip[data-lane="running"] .dtn-chip__dot {
  background: var(--dsw-alias-state-business-primary);
}
.dtn-chip[data-lane="unread"] .dtn-chip__dot {
  background: var(--dsw-alias-state-success-primary);
}
.dtn-chip[aria-pressed="true"] {
  color: var(--dsw-alias-label-primary);
  border-color: var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover));
}
.dtn-chip[aria-pressed="true"][data-lane="input"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 38%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, var(--dsw-alias-bg-base));
}
.dtn-chip[aria-pressed="true"][data-lane="running"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-business-primary) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, var(--dsw-alias-bg-base));
}
.dtn-chip[aria-pressed="true"][data-lane="unread"] {
  border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 34%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 8%, var(--dsw-alias-bg-base));
}
.dtn-link {
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-tertiary);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 130ms ease, color 130ms ease;
}
.dtn-link:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}

/* ============================== 三列 ============================== */
.dtn-lanes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: stretch;
  gap: 16px;
}
.dtn-lanes--single {
  grid-template-columns: minmax(0, 1fr);
}
.dtn-lane {
  --dtn-tone: var(--dsw-alias-label-caption);
  --dtn-tone-ink: var(--dsw-alias-label-secondary);
  --dtn-tone-tint: transparent;
  --dtn-tone-line: var(--dsw-alias-border-l2);
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  border-radius: var(--dsw-radius-md);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--dsw-alias-label-primary) 4%, transparent);
}
.dtn-lane::before {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 2px;
  background: var(--dtn-tone);
  opacity: 0.9;
}
.dtn-lane--input {
  --dtn-tone: var(--dsw-alias-state-warn-primary);
  --dtn-tone-ink: var(--dtn-warn-ink);
  --dtn-tone-tint: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 4.5%, var(--dsw-alias-bg-base));
  --dtn-tone-line: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 26%, transparent);
}
.dtn-lane--running {
  --dtn-tone: var(--dsw-alias-state-business-primary);
  --dtn-tone-ink: var(--dtn-blue-ink);
  --dtn-tone-tint: color-mix(in srgb, var(--dsw-alias-state-business-primary) 4%, var(--dsw-alias-bg-base));
  --dtn-tone-line: color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, transparent);
}
.dtn-lane--unread {
  --dtn-tone: var(--dsw-alias-state-success-primary);
  --dtn-tone-ink: var(--dtn-green-ink);
  --dtn-tone-tint: color-mix(in srgb, var(--dsw-alias-state-success-primary) 4%, var(--dsw-alias-bg-base));
  --dtn-tone-line: color-mix(in srgb, var(--dsw-alias-state-success-primary) 24%, transparent);
}
.dtn-lane__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 11px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
}
.dtn-lane__icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 6px;
  color: var(--dtn-tone-ink);
  background: color-mix(in srgb, var(--dtn-tone) 12%, transparent);
}
.dtn-lane__name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dtn-lane__count {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--dtn-tone) 12%, transparent);
  color: var(--dtn-tone-ink);
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  font-weight: 600;
}
.dtn-lane__hint {
  margin-left: auto;
  min-width: 0;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dtn-lane__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  background: var(--dtn-tone-tint);
}
/* 列内任务比别的列少时，用一块虚线「空槽」吃掉高度差，别留大白洞。 */
.dtn-lane__pad {
  flex: 1;
  min-height: 52px;
  display: grid;
  place-items: center;
  gap: 4px;
  padding: 14px 10px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-sm);
  color: var(--dsw-alias-label-tertiary);
  font-size: 10.5px;
  line-height: 15px;
  text-align: center;
}
.dtn-lane__pad svg {
  opacity: 0.55;
}
.dtn-lane__pad--empty {
  min-height: 150px;
}
.dtn-lane__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  border-top: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-lane__foot-n {
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
}

/* ============================== 卡片 ============================== */
.dtn-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1);
  cursor: pointer;
  text-align: left;
  transition: transform 150ms cubic-bezier(0.16, 1, 0.3, 1), box-shadow 150ms ease,
    border-color 150ms ease;
}
.dtn-card:hover {
  transform: translateY(-1px);
  border-color: var(--dtn-tone-line);
  box-shadow: var(--dsw-elevation-panel);
}
.dtn-card:active {
  transform: translateY(0);
}
.dtn-card--input {
  border-color: var(--dtn-tone-line);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary) 7%, var(--dsw-alias-bg-layer-1)),
    var(--dsw-alias-bg-layer-1) 72%
  );
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-warn-primary);
}
.dtn-card--input:hover {
  box-shadow: inset 3px 0 0 var(--dsw-alias-state-warn-primary), var(--dsw-elevation-panel);
}
/* 中断卡片：左侧色条 + 极浅底色，和正常完成的绿色卡片拉开距离。 */
.dtn-card--warn {
  --dtn-card-tone: var(--dsw-alias-state-warn-primary);
}
.dtn-card--error {
  --dtn-card-tone: var(--dsw-alias-state-error-primary);
}
.dtn-card--interrupted {
  border-color: color-mix(in srgb, var(--dtn-card-tone) 30%, transparent);
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--dtn-card-tone) 6%, var(--dsw-alias-bg-layer-1)),
    var(--dsw-alias-bg-layer-1) 78%
  );
  box-shadow: inset 3px 0 0 var(--dtn-card-tone);
}
.dtn-card--interrupted:hover {
  box-shadow: inset 3px 0 0 var(--dtn-card-tone), var(--dsw-elevation-panel);
}
.dtn-card--interrupted .dtn-card__detail {
  color: var(--dtn-card-tone);
}
.dtn-card__top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dtn-card__time {
  margin-left: auto;
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
  white-space: nowrap;
}
.dtn-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 20px;
  padding: 0 7px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
}
.dtn-badge__dot {
  width: 5px;
  height: 5px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.dtn-badge--warn {
  color: var(--dtn-warn-ink);
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, transparent);
}
.dtn-badge--blue {
  color: var(--dtn-blue-ink);
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);
}
.dtn-badge--green {
  color: var(--dtn-green-ink);
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 13%, transparent);
}
.dtn-badge--error {
  color: var(--dtn-error-ink);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);
}
.dtn-badge--idle {
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-interactive-bg-hover);
}
.dtn-card__title {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
  font-size: 12.5px;
  line-height: 18px;
  font-weight: 560;
  color: var(--dsw-alias-label-primary);
}
.dtn-card--input .dtn-card__title {
  font-weight: 650;
}
/* 运行中：不确定进度用不确定的流动条，不编造百分比。 */
.dtn-live {
  position: relative;
  height: 3px;
  border-radius: 2px;
  overflow: hidden;
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);
}
.dtn-live::after {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 38%;
  border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
  animation: dtn-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
.dtn-card__foot {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 22px;
}
.dtn-card__detail {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-card__actions {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 5px;
}
.dtn-mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 7px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition: background 130ms ease, color 130ms ease, border-color 130ms ease;
}
.dtn-mini:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
.dtn-mini--go {
  color: var(--dtn-tone-ink);
  border-color: var(--dtn-tone-line);
  background: color-mix(in srgb, var(--dtn-tone) 8%, transparent);
  font-weight: 600;
}
.dtn-mini--go:hover {
  color: var(--dtn-tone-ink);
  background: color-mix(in srgb, var(--dtn-tone) 15%, transparent);
}

/* ============================ 更早完成 ============================ */
.dtn-archive {
  margin-top: 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1);
  overflow: hidden;
}
.dtn-archive__bar {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px 12px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 140ms ease;
}
.dtn-archive__bar:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dtn-archive__check {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-archive__n {
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
}
.dtn-archive__toggle {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-archive__list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px;
  border-top: 1px solid var(--dsw-alias-border-l1);
}
.dtn-hist {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 130ms ease;
}
.dtn-hist:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dtn-hist__check {
  flex: none;
  color: var(--dsw-alias-label-caption);
}
.dtn-hist__check--warn {
  color: var(--dtn-warn-ink);
}
.dtn-hist__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dtn-hist__time {
  flex: none;
  font-family: var(--ds-font-family-code);
  font-variant-numeric: tabular-nums;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}

/* ============================ 全空状态 ============================ */
.dtn-blank {
  margin-top: 24px;
  padding: 48px 20px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  border: 1px dashed var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-md);
  text-align: center;
}
.dtn-blank__icon {
  color: var(--dsw-alias-label-caption);
}
.dtn-blank__title {
  margin-top: 5px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.dtn-blank__hint {
  font-size: 11.5px;
  color: var(--dsw-alias-label-tertiary);
}

/* ============================ 交互与动效 ============================ */
.dtn-card,
.dtn-chip,
.dtn-btn,
.dtn-perm,
.dtn-mini,
.dtn-archive__bar,
.dtn-hist,
.dtn-link,
.dtn-icon {
  -webkit-user-select: none;
}
.dtn-card:focus-visible,
.dtn-chip:focus-visible,
.dtn-btn:focus-visible,
.dtn-perm:focus-visible,
.dtn-mini:focus-visible,
.dtn-archive__bar:focus-visible,
.dtn-hist:focus-visible,
.dtn-link:focus-visible,
.dtn-icon:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
@keyframes dtn-slide {
  0% {
    transform: translateX(-110%);
  }
  60%,
  100% {
    transform: translateX(260%);
  }
}
/* 侧栏角标：等人的琥珀点带一圈呼吸环，运行中的蓝点保持静态。 */
.dtn-attn-ring {
  transform-box: fill-box;
  transform-origin: center;
  animation: dtn-attn 2.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
}
@keyframes dtn-attn {
  0% {
    opacity: 0.6;
    transform: scale(0.85);
  }
  70%,
  100% {
    opacity: 0;
    transform: scale(2.1);
  }
}
@media (prefers-reduced-motion: reduce) {
  .dtn-live::after,
  .dtn-attn-ring {
    animation: none !important;
  }
  .dtn-live::after {
    width: 100%;
    opacity: 0.45;
  }
}

/* ============================== 窄屏 ============================== */
@media (max-width: 1080px) {
  .dtn-head {
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
  }
  .dtn-actions {
    justify-content: flex-start;
    padding-top: 0;
  }
  .dtn-lanes {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
  }
  .dtn-lane__pad--empty {
    min-height: 84px;
  }
}
@media (max-width: 720px) {
  .dtn-title {
    font-size: 20px;
  }
  .dtn-search {
    width: 100%;
  }
  .dtn-chips {
    margin-left: 0;
  }
}

/* ============================== 任务树 ============================== */
.dtn-tree {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dtn-subtree {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-left: 8px;
  padding-left: 16px;
}
.dtn-subtree::before {
  content: "";
  position: absolute;
  left: 0;
  top: -8px;
  bottom: 14px;
  width: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l2);
}
.dtn-subtree > .dtn-tree {
  position: relative;
}
.dtn-subtree > .dtn-tree::before {
  content: "";
  position: absolute;
  left: -16px;
  top: 24px;
  width: 14px;
  height: 2px;
  border-radius: 2px;
  background: var(--dsw-alias-border-l2);
}
/* 子代理卡：虚线边 + 弱化，和父会话卡区分层级 */
.dtn-card--sub {
  border-style: dashed;
  padding: 8px 11px;
  gap: 5px;
}
.dtn-card--sub .dtn-card__title {
  font-size: 12px;
  line-height: 17px;
  font-weight: 500;
}
.dtn-card__kind {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: var(--dsw-alias-label-tertiary);
  text-transform: uppercase;
}
.dtn-card__lineage {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 1px;
  min-width: 0;
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-card__lineage-ico {
  flex: none;
  color: var(--dsw-alias-label-caption);
}
.dtn-card__lineage-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-secondary);
  font-weight: 600;
}
/* 父卡上的子代理计数 / 折叠开关 */
.dtn-card__children {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  margin-top: 1px;
  padding: 3px 7px;
  border-radius: 5px;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
  font-size: 10.5px;
  font-weight: 600;
}
.dtn-card__children:hover {
  background: var(--dsw-alias-interactive-bg-active);
  color: var(--dsw-alias-label-primary);
}
.dtn-card__children--static {
  cursor: default;
}
.dtn-card__children--static:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
.dtn-card__children-tw {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-card__children-meta {
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
}

/* ============================ 通知中心 ============================ */
.dtn-nc {
  position: relative;
  display: inline-flex;
  align-items: center;
  pointer-events: auto;
  font-family: var(--dsw-font-family);
}
.dtn-nc,
.dtn-nc * { box-sizing: border-box; }

/* DSH 没有全局重置原生表单控件；不归一就会出现系统按钮边框。 */
.dtn-nc button,
.dtn-nc select {
  margin: 0;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  line-height: inherit;
  cursor: pointer;
  appearance: none;
  -webkit-appearance: none;
}
.dtn-nc :focus-visible { outline: 2px solid var(--dsw-focus-ring-color, #4176e6); outline-offset: 2px; }

.dtn-bell {
  position: relative;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-secondary);
  background: transparent;
}
.dtn-bell:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover-solid); }
.dtn-bell.is-open { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-active); }
.dtn-bell__badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 9px;
  background: var(--dsw-alias-state-error-primary, #ec1313);
  color: var(--dsw-alias-label-primary-inverted, #fff);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 16px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1, #fff);
}

.dtn-nc__panel {
  position: fixed;
  z-index: 90;
  top: var(--dtn-top, 60px);
  right: var(--dtn-right, 12px);
  width: 396px;
  max-width: calc(100vw - 24px);
  max-height: min(620px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg, 16px);
  box-shadow: var(--dsw-elevation-prominent);
  overflow: hidden;
}
.dtn-nc__head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 52px;
  flex: none;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-primary);
}
.dtn-nc__title { font-size: 14px; font-weight: 650; letter-spacing: .1px; }
.dtn-nc__chip {
  font-size: 11px;
  font-weight: 600;
  color: var(--dsw-alias-state-business-primary);
  background: var(--dsw-alias-state-business-tertiary, #e4edfd);
  padding: 1px 7px;
  border-radius: 9px;
}
.dtn-nc__sp { flex: 1; }
.dtn-nc__act {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  padding: 5px 9px;
  border-radius: 7px;
}
.dtn-nc__act:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dtn-nc__x {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-label-tertiary);
}
.dtn-nc__x:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.dtn-nc__filter {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  flex: none;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.dtn-nc__seg { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dtn-nc__seg button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  padding: 4px 10px;
  border-radius: 7px;
}
.dtn-nc__seg button:hover { color: var(--dsw-alias-label-primary); }
.dtn-nc__seg button i { font-style: normal; font-size: 10.5px; color: var(--dsw-alias-label-tertiary); }
.dtn-nc__seg button.on { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font-weight: 600; box-shadow: 0 1px 2px #00000014; }
.dtn-nc__seg button.on i { color: var(--dsw-alias-label-secondary); }
.dtn-nc__src {
  margin-left: auto;
  font-size: 12px;
  color: var(--dsw-alias-label-secondary);
  padding: 5px 22px 5px 8px;
  border-radius: 7px;
  background-color: transparent;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2381858c' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");
  background-repeat: no-repeat;
  background-position: right 6px center;
}
.dtn-nc__src:hover { background-color: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }

.dtn-nc__body { flex: 1; overflow: auto; padding: 2px 0 6px; }
.dtn-nc__error { margin: 8px 12px; padding: 6px 10px; border-radius: 8px; font-size: 11.5px; color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-tertiary, #fdeaea); }
.dtn-nc__group {
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 16px 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .3px;
  color: var(--dsw-alias-label-tertiary);
  background: var(--dsw-alias-bg-layer-1);
}
.dtn-nc__group.is-todo i { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-warn-primary); }

.dtn-ni {
  display: flex;
  align-items: flex-start;
  gap: 11px;
  margin: 1px 6px;
  padding: 9px 10px;
  border-radius: 10px;
  position: relative;
  cursor: default;
  outline: none;
}
.dtn-ni:hover, .dtn-ni:focus-visible { background: var(--dsw-alias-interactive-bg-hover); }
.dtn-ni__icon {
  width: 30px;
  height: 30px;
  flex: none;
  margin-top: 1px;
  border-radius: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.dtn-ni__icon--task { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary, #e4edfd); }
.dtn-ni__icon--account { color: var(--dsw-alias-state-warn-label, #dd8629); background: var(--dsw-alias-state-warn-tertiary, #fef5e7); }
.dtn-ni__icon--plugin { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform, #f5f6f7); }
.dtn-ni__main { flex: 1; min-width: 0; }
.dtn-ni__top { display: flex; align-items: center; gap: 8px; }
.dtn-ni__title { font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dtn-ni__time { margin-left: auto; flex: none; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.dtn-ni__body { margin-top: 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dtn-ni__tags { display: flex; gap: 6px; margin-top: 5px; }
.dtn-ni__tag { font-size: 10.5px; font-weight: 600; line-height: 16px; padding: 1px 7px; border-radius: 6px; }
.dtn-ni__tag--warn { color: var(--dsw-alias-state-warn-label, #b56a06); background: var(--dsw-alias-state-warn-tertiary, #fef5e7); }
.dtn-ni__tag--err { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-state-error-tertiary, #fdeaea); }
.dtn-ni__tag--ok { color: var(--dsw-alias-state-success-primary); background: var(--dsw-alias-state-success-tertiary, #e6faed); }
.dtn-ni__tag--src { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform, #f5f6f7); font-weight: 500; }
.dtn-ni__dot { position: absolute; left: -4px; top: 24px; width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-state-business-primary); }
.dtn-ni--todo { background: linear-gradient(90deg, var(--dsw-alias-state-warn-tertiary, #fef5e7), transparent 62%); }
.dtn-ni--todo .dtn-ni__dot { background: var(--dsw-alias-state-warn-primary); }
.dtn-ni__open { margin-left: auto; flex: none; align-self: center; font-size: 11.5px; color: var(--dsw-alias-state-business-primary); padding: 3px 6px; border-radius: 6px; opacity: 0; }
.dtn-ni:hover .dtn-ni__open, .dtn-ni:focus-visible .dtn-ni__open { opacity: 1; }
.dtn-ni--todo .dtn-ni__open { opacity: 1; color: var(--dsw-alias-state-warn-label, #b56a06); }

.dtn-nc__empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 44px 20px; color: var(--dsw-alias-label-tertiary); }
.dtn-nc__empty-title { font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dtn-nc__empty-hint { font-size: 12px; text-align: center; max-width: 260px; }

.dtn-nc__foot { flex: none; height: 46px; display: flex; align-items: center; padding: 0 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dtn-nc__expand { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-state-business-primary); padding: 6px 8px; border-radius: 7px; }
.dtn-nc__expand:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dtn-nc__foot-settings { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-tertiary); padding: 6px 8px; }

.dtn-nc__full { position: fixed; inset: 0; z-index: 100; background: var(--dsw-alias-bg-base); display: flex; flex-direction: column; }
.dtn-nc__full-bar { flex: none; height: 52px; display: flex; align-items: center; padding: 0 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 13px; font-weight: 600; }
.dtn-nc__full-bar .dtn-nc__x { margin-left: auto; }
.dtn-nc__full-body { flex: 1; min-height: 0; overflow: auto; }

@media (max-width: 640px) {
  .dtn-nc__panel {
    position: fixed;
    top: 52px;
    left: 8px;
    right: 8px;
    width: auto;
    max-width: none;
    max-height: calc(100vh - 64px);
  }
  .dtn-ni__open { opacity: 1; }
}
`;

    let store = null;

    return {
      inject: ["slots", "layout", "uiWorkspace", "locale"],
      apply(ctx) {
        store = createStore();

        /** 行点击 / 通知点击共用的「打开并已读」路径。 */
        const openTask = async (task) => {
          if (task?.unread) await store.markRead([task.id], false);
          try {
            await ctx.uiWorkspace.openSession(task.id);
            return;
          } catch {
            /* 形参可能不匹配；换对象形式再试一次 */
          }
          try {
            await ctx.uiWorkspace.openSession({ sessionId: task.id });
            return;
          } catch {
            /* 跳转失败时保持当前面板 */
          }
        };
        store.state.openRequest = openTask;

        /** 通知点击：有会话就跳过去。 */
        const openNotification = async (entry) => {
          if (!entry?.sessionId) return;
          await openTask({ id: entry.sessionId, unread: false });
        };
        store.state.openNotification = openNotification;

        // 账号通知来源是可选能力：只走 ctx.get，直接访问未注入的服务属性会在真实宿主里抛错。
        const remoteApi = typeof ctx.get === "function" ? ctx.get("remote") : undefined;
        const accountUi = typeof ctx.get === "function" ? ctx.get("accountUi") : undefined;

        ctx.effect(() => stylesInsert(CSS), "dsh-task-notifier: stylesheet");

        // 注册文案并绑定宿主 locale；服务缺失时 t() 自动回落到本地表。
        localeApi = ctx.locale ?? null;
        if (localeApi) {
          ctx.effect(() => localeApi.register(NS, DICT), "dsh-task-notifier: dictionaries");
          if (typeof localeApi.bind === "function") {
            try {
              boundTranslate = localeApi.bind(NS);
            } catch {
              boundTranslate = null;
            }
          }
        }

        ctx.effect(
          () => {
            /**
             * 会话切换即已读：侧边栏、搜索、快捷键打开会话时同步未读状态，
             * 和面板点开、通知点开这两个入口保持一致。
             * uiWorkspace.selection 是宿主发布当前主视图会话的 snapshot store；
             * 老版本宿主没有它，缺失时静默跳过（面板内的手动已读仍然可用）。
             */
            const selection = ctx.uiWorkspace?.selection;
            const syncActive = () => {
              const activeId = selection?.getSnapshot?.()?.sessionId;
              if (activeId) store.syncActiveSessionRead(activeId);
            };
            const canWatch =
              typeof selection?.subscribe === "function" && typeof selection?.getSnapshot === "function";
            const disposeSelection = canWatch ? selection.subscribe(syncActive) : () => {};
            // 首次载入完成后再对齐一次：进入页面时当前会话可能已经是未读。
            store.firstLoad().then(syncActive, () => {});
            store.pollLoop();
            const heartbeat = setInterval(() => store.sendHeartbeat(), 3000);
            // 浏览器只在用户手势之后允许出声。载入后借第一次点击/按键把 AudioContext
            // 唤醒，否则页面刚打开时完成的那一轮会「有通知没声音」。
            const warmAudio = () => ensureAudioContext();
            document.addEventListener("pointerdown", warmAudio, { once: true, capture: true });
            document.addEventListener("keydown", warmAudio, { once: true, capture: true });
            return () => {
              clearInterval(heartbeat);
              disposeSelection();
              document.removeEventListener("pointerdown", warmAudio, { capture: true });
              document.removeEventListener("keydown", warmAudio, { capture: true });
              // 卸载/禁用后必须停掉长轮询与所有在途请求
              store.dispose();
            };
          },
          "dsh-task-notifier: data loops",
        );
        ctx.slots.inject("conversation.session.header.utilities", () =>
          ctx.slots.register(
            { name: "conversation.session.header.utilities", id: "task-notifier-bell", order: 100 },
            (slotProps) =>
              h(NotificationCenterRoot, {
                ...slotProps,
                ctx,
                store,
                remote: remoteApi,
                accountUi,
              }),
          ),
        );

        // 侧边栏任务面板入口（保留）：点开进入三列看板。
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_ID, order: 20, label: () => t("panel.title") },
            (slotProps) => TaskSidebarIcon({ ...slotProps, store }),
          ),
        );
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            { name: "main", key: PANEL_ID },
            () => TasksPage({ ctx, store, onOpen: openTask }),
          ),
        );

        // 客户端发布契约：其它客户端插件 inject:['notifications'] 后调 post，
        // 也提供 window.dshNotifications 这个零依赖入口。
        const clientHub = {
          post: async (entry) => {
            try {
              const result = await postJson(`${API}/publish`, entry ?? {});
              return result?.notification ?? null;
            } catch {
              return null;
            }
          },
        };
        if (typeof ctx.provide === "function") {
          try {
            ctx.provide("notifications", clientHub);
          } catch {
            /* 服务名被占用时忽略 */
          }
        }
        try {
          if (typeof window !== "undefined") window.dshNotifications = clientHub;
        } catch {
          /* 只读 window 时忽略 */
        }
      },
    };

    function stylesInsert(css) {
      const tag = document.createElement("style");
      tag.id = "dsh-task-notifier-style";
      tag.textContent = css;
      document.head.append(tag);
      return () => tag.remove();
    }
  },
});
