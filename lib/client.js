/**
 * 任务通知台：浏览器侧。
 *
 * 职责：
 *  - 心跳 /task-notifier/api/heartbeat，让宿主知道页面还开着（有页面则宿主
 *    不再发系统通知，避免双弹）；
 *  - 长轮询 /wait + /state，感知「任务完成」事件，然后响合成提示音、弹
 *    浏览器 Notification（点击跳回对应会话）；
 *  - 侧边栏「任务」面板：运行中 / 已完成未读 / 全部 三个筛选 + 搜索 +
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
        "panel.title": "任务面板",
        "panel.brand": "TASK NOTIFIER",
        "panel.subtitle": "筛选待回复、进行中与已完成未读的任务；任务完成时播放提示音并弹通知。",
        "panel.connectionError": "连接异常：{error}",
        "panel.total": "全部 {n}",

        "tab.input": "待回复",
        "tab.unread": "已完成未读",
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
        "task.noTime": "—",
        "row.open": "打开会话：{title}",
        "row.openState": "打开会话：{title}（{state}）",

        "time.justNow": "刚刚",
        "time.seconds": "{n} 秒前",
        "time.minutes": "{n} 分钟前",
        "time.hours": "{n} 小时前",
        "time.days": "{n} 天前",

        "empty.input": "没有等你回复的任务。",
        "empty.running": "没有正在运行的任务。",
        "empty.unread": "没有未读的已完成任务。",
        "empty.idle": "没有已完成任务。",
        "empty.nomatch": "没有匹配的任务。",

        "blank.all": "现在没有任务",
        "blank.allHint": "有任务完成时会响一声，并在这里等你查看。",
        "blank.search": "没有匹配的任务",

        "archive.title": "更早完成的任务",
        "archive.count": "{n} 个已读",
        "archive.expand": "展开历史",
        "archive.collapse": "收起历史",

        "notify.body": "已完成，点开查看会话",
        "test.sent": "已发出系统通知",
        "test.disabled": "osNotify=off，系统通知已关闭",
        "test.unsupported": "当前平台不支持系统通知（仅 macOS）",
        "test.failed": "系统通知发送失败",
        "test.cooldown": "操作太频繁，稍等一下",
      },
      en: {
        "panel.title": "Tasks",
        "panel.brand": "TASK NOTIFIER",
        "panel.subtitle": "Filter tasks waiting on your reply, running, and completed-but-unread; a chime and a notification fire when a task finishes.",
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
        "task.noTime": "—",
        "row.open": "Open session: {title}",
        "row.openState": "Open session: {title} ({state})",

        "time.justNow": "just now",
        "time.seconds": "{n}s ago",
        "time.minutes": "{n}m ago",
        "time.hours": "{n}h ago",
        "time.days": "{n}d ago",

        "empty.input": "Nothing is waiting on you.",
        "empty.running": "No task is running.",
        "empty.unread": "No unread completed tasks.",
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
        "test.sent": "Test notification sent",
        "test.disabled": "osNotify=off, system notifications are disabled",
        "test.unsupported": "System notifications are macOS-only",
        "test.failed": "Failed to send the test notification",
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
     * notified 存的是「页面已通知过的会话 id」——页面重新载入会重置，
     * 避免历史未读重复弹通知。
     */
    function createStore() {
      const state = {
        loaded: false,
        rev: 0,
        bootAt: Date.now(),
        watermark: 0,
        unreadNames: 0,
        notified: new Set(),
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
        for (const task of state.tasks ?? []) if (task.unread) count += 1;
        return count;
      }

      state.needsInputCount = needsInputCount;
      state.runningCount = runningCount;
      state.unreadCount = unreadCount;

      async function firstLoad() {
        try {
          const data = await fetchJson(`${API}/state`, { signal: lifetime.signal });
          if (disposed) return;
          state.tasks = data.tasks ?? [];
          state.settings = data.settings ?? {};
          state.rev = data.rev ?? 0;
          state.nowAt = data.now ?? Date.now();
          // 水位线：首次载入时已有的「完成」不再弹通知，只作为面板数据呈现
          state.watermark = Math.max(0, ...state.tasks.map((task) => task.completedAt ?? 0), state.bootAt);
          state.loaded = true;
          state.connection = "ok";
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
            state.tasks = data.tasks ?? [];
            state.settings = data.settings ?? {};
            state.rev = data.rev ?? state.rev;
            state.nowAt = data.now ?? Date.now();
            state.loaded = true;
            state.connection = state.error ? "reconnected" : "ok";
            state.error = null;
            await notifyNewCompletions();
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

      async function notifyNewCompletions() {
        const tasks = state.tasks ?? [];
        const fresh = tasks.filter(
          (task) => task.unread && !state.notified.has(task.id) && (task.completedAt ?? 0) > state.watermark,
        );
        if (!fresh.length) return;
        let maxCompleted = state.watermark;
        for (const task of fresh.slice(0, 3)) {
          state.notified.add(task.id);
          maxCompleted = Math.max(maxCompleted, task.completedAt ?? 0);
          if (state.settings.sound !== false) playChime();
          // 通知链：已授权 → 浏览器通知；否则交给宿主弹系统通知兜底。
          // 权限请求只在用户点击按钮时发起，不在后台自动弹（浏览器也多半会忽略非手势请求）。
          if (notificationPermissionState() === "granted") {
            notifyBrowser(taskTitle(task), () => state.openRequest?.(task));
          } else {
            fallbackOsNotify([task.id]);
          }
        }
        state.watermark = maxCompleted;
      }

      function markReadLocally(ids) {
        for (const id of ids) {
          const task = (state.tasks ?? []).find((t) => t.id === id);
          if (task) task.unread = false;
        }
        emit();
      }

      async function markRead(ids, all) {
        const body = {};
        if (all) body.all = true;
        else body.ids = ids;
        markReadLocally(all ? (state.tasks ?? []).map((task) => task.id) : ids);
        try {
          const data = await fetchJson(`${API}/read`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          state.tasks = data.tasks ?? state.tasks;
          state.rev = data.rev ?? state.rev;
        } catch (error) {
          state.error = error?.message ?? String(error);
        }
        emit();
      }

      async function sendHeartbeat() {
        if (disposed) return;
        try {
          await fetchJson(`${API}/heartbeat`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ canNotify: canBrowserNotify(), locale: activeLocale() }),
            signal: lifetime.signal,
          });
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

    /** 两个音的轻快上行 chime：G5 → C6，指数衰减，音量可调。 */
    function playChime() {
      const ctx = ensureAudioContext();
      if (!ctx || ctx.state !== "running") return;
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

    function notifyBrowser(title, onClick) {
      try {
        if (!canBrowserNotify()) return false;
        const notification = new Notification(title, { body: t("notify.body"), tag: NS });
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
      fetchJson(`${API}/notify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids }),
      }).catch(() => {
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

    /* ============================ 图标（侧栏入口） ============================ */

    function PanelIcon(props) {
      // 宿主把它放进自己的按钮里渲染；这里只画 SVG + 内嵌未读角标。
      const state = useNotifier(props.store);
      const size = props && Number.isFinite(props.size) ? props.size : 18;
      const unread = state.unreadCount?.() ?? 0;
      const running = state.runningCount?.() ?? 0;
      // 等人的优先级高于「在跑」：任务卡在用户身上时，蓝点会误导人以为不用管。
      const needsInput = state.needsInputCount?.() ?? 0;
      const badgeFontSize = unread > 9 ? 7 : 9;
      const badgeText = unread > 9 ? "9+" : String(unread);
      const badgeWidth = unread > 9 ? 14 : unread > 0 ? 11 : 0;
      const badgeHeight = unread > 0 ? 11 : 0;
      const badgeX = size - badgeWidth + 1;
      const badgeY = -1;
      const canvasSize = size + 5;
      const viewBox = `-2 -2 ${canvasSize} ${canvasSize}`;
      return h(
        "svg",
        {
          width: canvasSize,
          height: canvasSize,
          viewBox,
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.7,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          "aria-hidden": "true",
          focusable: "false",
          style: { flex: "none", overflow: "visible" },
        },
        h("g", { transform: "translate(0 2.5)" },
          h("rect", { x: 2.6, y: 4.2, width: 18.8, height: 15.6, rx: 2.6 }),
          h("path", { d: "M2.6 8.2h18.8" }),
          h("circle", { cx: 7.5, cy: 12.4, r: 1.15, fill: "currentColor", stroke: "none" }),
          h("circle", { cx: 12, cy: 12.4, r: 1.15, fill: "currentColor", stroke: "none", opacity: 0.55 }),
          h("circle", { cx: 16.5, cy: 12.4, r: 1.15, fill: "currentColor", stroke: "none", opacity: 0.28 }),
          needsInput > 0
            ? h("circle", {
                className: "dtn-attn-ring",
                cx: 19.4,
                cy: 19.4,
                r: 3.2,
                fill: "none",
                stroke: "var(--dsw-alias-state-warn-primary)",
                strokeWidth: 1.3,
              })
            : null,
          needsInput > 0
            ? h("circle", {
                cx: 19.4,
                cy: 19.4,
                r: 3.2,
                fill: "var(--dsw-alias-state-warn-primary)",
                stroke: "none",
              })
            : running > 0
              ? h("circle", {
                  cx: 19.4,
                  cy: 19.4,
                  r: 3.4,
                  fill: "var(--dsw-alias-state-business-primary)",
                  stroke: "none",
                })
              : null,
        ),
        unread > 0
          ? h("g", { className: "dtn-icon-badge" },
              h("rect", {
                x: badgeX,
                y: badgeY,
                width: badgeWidth,
                height: badgeHeight,
                rx: 5.5,
                fill: "var(--dsw-alias-state-error-primary, #ec1313)",
                stroke: "var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-layer-1))",
                strokeWidth: 1.8,
              }),
              h("text", {
                x: badgeX + badgeWidth / 2,
                y: badgeY + 8,
                textAnchor: "middle",
                fill: "var(--dsw-alias-label-primary-inverted, #fff)",
                stroke: "none",
                fontFamily: "var(--ds-font-family-code)",
                fontSize: badgeFontSize,
                fontWeight: 700,
              }, badgeText),
            )
          : null,
      );

    }

    /* ============================ 面板页 ============================ */

    /**
     * 三列看板：待回复 / 进行中 / 已完成未读 永远同屏。
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
      if (task.unread) return { text: t("badge.new"), tone: "green", dot: true };
      return { text: t("badge.read"), tone: "idle", dot: false };
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
      return "";
    }

    function TaskCard(props) {
      const { task, lane, now, onOpen, onMarkRead } = props;
      const badge = cardBadge(task);
      const detail = cardDetail(task, now);
      const stateText = task.needsInput ? inputLabel(task.inputKind) : task.running ? t("task.running") : t("task.completed", { time: relativeTime(task.completedAt, now) });
      return h(
        "article",
        {
          className: `dtn-card dtn-card--${badge.tone} dtn-card--lane-${lane}`,
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
        h(
          "div",
          { className: "dtn-card__top" },
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
          detail ? h("span", { className: "dtn-card__detail" }, detail) : null,
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

    function Lane(props) {
      const { lane, tasks, now, query, onOpen, onMarkRead } = props;
      const emptyText = query ? t("blank.search") : t(`empty.${lane.id}`);
      const foot = laneFoot(lane.id, tasks, now);
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
          tasks.map((task) => h(TaskCard, { key: task.id, task, lane: lane.id, now, onOpen, onMarkRead })),
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
                const result = await fetchJson(`${API}/test`, { method: "POST" });
                if (result?.ok) setNotice(t("test.sent"));
                else if (result?.reason === "disabled") setNotice(t("test.disabled"));
                else if (result?.reason === "unsupported-platform") setNotice(t("test.unsupported"));
                else setNotice(t("test.failed"));
              } catch (error) {
                const message = String(error?.message ?? error);
                setNotice(message.includes("429") ? t("test.cooldown") : t("test.failed"));
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
                          h(Icon, { name: "check", size: 13, className: "dtn-hist__check" }),
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

    /* ============================ 装配 ============================ */

    const CSS = `
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
            store.firstLoad();
            store.pollLoop();
            const heartbeat = setInterval(() => store.sendHeartbeat(), 3000);
            return () => {
              clearInterval(heartbeat);
              // 卸载/禁用后必须停掉长轮询与所有在途请求
              store.dispose();
            };
          },
          "dsh-task-notifier: data loops",
        );
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            {
              name: "sidebar.panellist",
              id: PANEL_ID,
              order: 20,
              label: t("panel.title"),
            },
            () => PanelIcon({ store }),
          ),
        );
        ctx.slots.inject("main", () =>
          ctx.slots.register(
            {
              name: "main",
              key: PANEL_ID,
            },
            () => TasksPage({ ctx, store, onOpen: openTask }),
          ),
        );
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
