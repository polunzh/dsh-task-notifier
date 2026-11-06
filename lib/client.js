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

        "tab.input": "待回复",
        "tab.unread": "已完成未读",
        "tab.running": "运行中",
        "tab.idle": "已完成",
        "tab.all": "全部",

        "action.testSound": "试听提示音",
        "action.testOs": "试发系统通知",
        "action.markAllRead": "全部标为已读（{n}）",

        "permission.granted": "浏览器通知：已开启",
        "permission.denied": "浏览器通知：被拒绝",
        "permission.unsupported": "浏览器通知：不可用",
        "permission.default": "浏览器通知：未开启",

        "search.placeholder": "按标题搜索…",
        "search.aria": "搜索任务",

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

        "tab.input": "Needs input",
        "tab.unread": "Unread",
        "tab.running": "Running",
        "tab.idle": "Completed",
        "tab.all": "All",

        "action.testSound": "Preview chime",
        "action.testOs": "Send test notification",
        "action.markAllRead": "Mark all read ({n})",

        "permission.granted": "Browser notifications: on",
        "permission.denied": "Browser notifications: blocked",
        "permission.unsupported": "Browser notifications: unavailable",
        "permission.default": "Browser notifications: off",

        "search.placeholder": "Search by title…",
        "search.aria": "Search tasks",

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

    /** 行首状态标记：等人（琥珀圆环）> 运行中（转圈）> 空闲（灰点）。 */
    function StatusDot({ kind }) {
      if (kind === "input") {
        return h(
          "span",
          { className: "dtn-dot dtn-dot--input", "aria-hidden": "true" },
          h("span", { className: "dtn-dot__core" }),
        );
      }
      if (kind === "running") {
        return h("span", { className: "dtn-dot dtn-dot--running", "aria-hidden": "true" });
      }
      return h("span", { className: "dtn-dot dtn-dot--done", "aria-hidden": "true" });
    }

    function Tab({ id, active, onClick, children, count, tone }) {
      const warn = tone === "warn" && count > 0;
      return h(
        "button",
        {
          type: "button",
          className: "dtn-tab",
          role: "tab",
          "aria-selected": active === true ? "true" : "false",
          onClick,
          style: {
            appearance: "none",
            border: "none",
            background: active
              ? warn
                ? "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, var(--dsw-alias-bg-layer-1))"
                : "var(--dsw-alias-bg-layer-2)"
              : "transparent",
            color: active ? "var(--dsw-alias-label-primary)" : "var(--dsw-alias-label-secondary)",
            borderRadius: "var(--dsw-radius-sm)",
            padding: "5px 12px",
            fontSize: 12.5,
            fontWeight: active ? 600 : 500,
            cursor: "pointer",
            font: "inherit",
          },
        },
        children,
        h(
          "span",
          {
            style: {
              marginLeft: 5,
              padding: "0 6px",
              borderRadius: 8,
              background: count
                ? warn
                  ? "color-mix(in srgb, var(--dsw-alias-state-warn-primary) 24%, var(--dsw-alias-bg-layer-1))"
                  : "var(--dsw-alias-interactive-bg-hover-accent, var(--dsw-alias-bg-layer-2))"
                : "transparent",
              color: count
                ? warn
                  ? "var(--dsw-alias-label-primary)"
                  : "var(--dsw-alias-state-business-primary)"
                : "var(--dsw-alias-label-dimmed)",
              fontFamily: "var(--ds-font-family-code)",
              fontSize: 10.5,
              fontWeight: 600,
            },
          },
          String(count ?? 0),
        ),
      );
    }

    /** 等人的具体原因：提问、计划审阅、审批，各自的文案不同。 */
    function inputLabel(kind) {
      if (kind === "approval") return t("task.needsApproval");
      if (kind === "plan") return t("task.needsPlan");
      return t("task.needsInput");
    }

    function TaskRow({ task, now, onOpen }) {
      const waiting = task.needsInput === true;
      const stateText = waiting
        ? inputLabel(task.inputKind)
        : task.running
          ? t("task.running")
          : t("tab.idle");
      // 等待行的底色本身就是琥珀色，再用琥珀色写字会掉到 2.5:1；用主文本色保住对比度。
      const meta = waiting
        ? { text: stateText, color: "var(--dsw-alias-label-primary)", weight: 600 }
        : task.running
          ? { text: t("task.running"), color: "var(--dsw-alias-state-business-primary)", weight: 500 }
          : task.unread
            ? {
                text: t("task.completed", { time: relativeTime(task.completedAt, now) }),
                color: "var(--dsw-alias-state-business-primary)",
                weight: 500,
              }
            : {
                text: relativeTime(task.changeAt, now) || t("task.noTime"),
                color: "var(--dsw-alias-label-dimmed)",
                weight: 400,
              };
      return h(
        "li",
        {
          className: waiting ? "dtn-row dtn-row--input" : task.unread ? "dtn-row dtn-row--unread" : "dtn-row",
          style: {
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "10px 12px",
            borderRadius: "var(--dsw-radius-sm)",
            listStyle: "none",
            cursor: "pointer",
          },
          tabIndex: 0,
          role: "button",
          "aria-label": t("row.openState", { title: taskTitle(task), state: stateText }),
          onClick: () => onOpen(task),
          onKeyDown: (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen(task);
            }
          },
        },
        h(StatusDot, { kind: waiting ? "input" : task.running ? "running" : "done" }),
        h(
          "span",
          {
            style: {
              flex: "1 1 auto",
              minWidth: 0,
              color: "var(--dsw-alias-label-primary)",
              fontSize: 12.5,
              fontWeight: waiting || task.unread ? 600 : 500,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            },
          },
          taskTitle(task),
        ),
        h(
          "span",
          {
            style: {
              flex: "none",
              whiteSpace: "nowrap",
              color: meta.color,
              fontSize: 11,
              fontWeight: meta.weight,
              fontFamily: "var(--ds-font-family-code)",
            },
          },
          meta.text,
        ),
      );
    }

    function TasksPage(props) {
      const { store } = props;
      const ctx = props.ctx ?? {};
      const state = useNotifier(store);
      useLocaleTick();
      const [tab, setTab] = useState("unread");
      const [query, setQuery] = useState("");
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

      const needsInputCount = state.needsInputCount?.() ?? 0;
      const runningCount = state.runningCount?.() ?? 0;
      const unreadCount = state.unreadCount?.() ?? 0;

      const visible = tasks.filter((task) => {
        if (tab === "input" && !task.needsInput) return false;
        if (tab === "running" && (!task.running || task.needsInput)) return false;
        if (tab === "unread" && !task.unread) return false;
        if (tab === "idle" && task.running) return false;
        if (query && !taskTitle(task).toLowerCase().includes(query.toLowerCase())) return false;
        return true;
      });

      const openTask = props.onOpen ?? (async () => {});

      const headerRight = [];

      const permissionKey =
        permission === "granted" || permission === "denied" || permission === "unsupported"
          ? permission
          : "default";
      const permissionLabel = t(`permission.${permissionKey}`);
      headerRight.push(
        h(
          "button",
          {
            type: "button",
            key: "permission",
            onClick: async () => {
              setPermission(await requestBrowserPermission());
            },
            style: {
              appearance: "none",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: "var(--dsw-radius-sm)",
              background: "var(--dsw-alias-bg-layer-1)",
              color: "var(--dsw-alias-label-secondary)",
              padding: "5px 10px",
              fontSize: 11.5,
              cursor: "pointer",
              font: "inherit",
            },
          },
          permissionLabel,
        ),
      );

      headerRight.push(
        h(
          "button",
          {
            type: "button",
            key: "test-sound",
            onClick: () => {
              playChime();
            },
            style: {
              appearance: "none",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: "var(--dsw-radius-sm)",
              background: "var(--dsw-alias-bg-layer-1)",
              color: "var(--dsw-alias-label-secondary)",
              padding: "5px 10px",
              fontSize: 11.5,
              cursor: "pointer",
              font: "inherit",
            },
          },
          t("action.testSound"),
        ),
      );

      headerRight.push(
        h(
          "button",
          {
            type: "button",
            key: "test-os",
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
            style: {
              appearance: "none",
              border: "1px solid var(--dsw-alias-border-l2)",
              borderRadius: "var(--dsw-radius-sm)",
              background: "var(--dsw-alias-bg-layer-1)",
              color: "var(--dsw-alias-label-secondary)",
              padding: "5px 10px",
              fontSize: 11.5,
              cursor: "pointer",
              font: "inherit",
            },
          },
          t("action.testOs"),
        ),
      );

      if (unreadCount > 0) {
        headerRight.push(
          h(
            "button",
            {
              type: "button",
              key: "read-all",
              onClick: async () => {
                store.markRead([], true);
                setTab((current) => (current === "unread" ? "running" : current));
              },
              style: {
                appearance: "none",
                border: "1px solid var(--dsw-alias-state-success-primary)",
                borderRadius: "var(--dsw-radius-sm)",
                background: "transparent",
                color: "var(--dsw-alias-state-success-primary)",
                padding: "5px 10px",
                fontSize: 11.5,
                fontWeight: 600,
                cursor: "pointer",
                font: "inherit",
              },
            },
            t("action.markAllRead", { n: unreadCount }),
          ),
        );
      }

      return h(
        "div",
        { className: "dtn-root", style: pageStyle() },
        h(
          "div",
          { className: "dtn-page" },
          h(
            "div",
            { className: "dtn-head" },
            h(
              "div",
              { style: { minWidth: 0 } },
              h(
                "div",
                { style: { fontFamily: "var(--ds-font-family-code)", fontSize: 11, letterSpacing: "0.16em", color: "var(--dsw-alias-label-secondary)", marginBottom: 6 } },
                t("panel.brand"),
              ),
              h(
                "h1",
                { style: { margin: 0, fontSize: 24, letterSpacing: "-0.02em", color: "var(--dsw-alias-label-primary)" } },
                t("panel.title"),
              ),
              h(
                "p",
                {
                  style: {
                    margin: "6px 0 0",
                    color: "var(--dsw-alias-label-secondary)",
                    fontSize: 12.5,
                    lineHeight: 1.6,
                  },
                },
                t("panel.subtitle"),
                state.connection !== "ok" && state.error
                  ? h("span", { style: { color: "var(--dsw-alias-state-warn-primary)", marginLeft: 8 } }, t("panel.connectionError", { error: state.error }))
                  : null,
              ),
            ),
            h("div", { style: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-end" } }, headerRight),
          ),
          notice
            ? h(
                "div",
                {
                  role: "status",
                  style: {
                    marginTop: 12,
                    padding: "8px 12px",
                    borderRadius: "var(--dsw-radius-sm)",
                    background: "var(--dsw-alias-bg-layer-2)",
                    color: "var(--dsw-alias-label-secondary)",
                    fontSize: 12,
                  },
                },
                notice,
              )
            : null,
          h(
            "div",
            {
              className: "dtn-tabs",
              role: "tablist",
              "aria-label": t("panel.title"),
              style: { display: "flex", gap: 6, margin: "18px 0 12px", flexWrap: "wrap" },
            },
            h(Tab, { id: "input", active: tab === "input", onClick: () => setTab("input"), count: needsInputCount, tone: "warn" }, t("tab.input")),
            h(Tab, { id: "unread", active: tab === "unread", onClick: () => setTab("unread"), count: unreadCount }, t("tab.unread")),
            h(Tab, { id: "running", active: tab === "running", onClick: () => setTab("running"), count: runningCount }, t("tab.running")),
            h(Tab, { id: "idle", active: tab === "idle", onClick: () => setTab("idle"), count: tasks.filter((task) => !task.running).length }, t("tab.idle")),
            h(Tab, { id: "all", active: tab === "all", onClick: () => setTab("all"), count: tasks.length }, t("tab.all")),
          ),
          h("input", {
            value: query,
            onInput: (event) => setQuery(event.target.value),
            placeholder: t("search.placeholder"),
            "aria-label": t("search.aria"),
            style: {
              width: "100%",
              boxSizing: "border-box",
              appearance: "none",
              border: "1px solid var(--dsw-alias-border-l1)",
              borderRadius: "var(--dsw-radius-sm)",
              background: "var(--dsw-alias-bg-layer-1)",
              color: "var(--dsw-alias-label-primary)",
              padding: "8px 10px",
              fontSize: 12.5,
              font: "inherit",
              outline: "none",
            },
          }),
          visible.length
            ? h(
                "ul",
                { className: "dtn-list", style: { margin: "10px 0 0", padding: 0, display: "flex", flexDirection: "column", gap: 4 } },
                visible.map((task) => h(TaskRow, { key: task.id, task, now, onOpen: openTask })),
              )
            : h(
                "div",
                {
                  style: {
                    marginTop: 10,
                    padding: "28px 12px",
                    textAlign: "center",
                    color: "var(--dsw-alias-label-secondary)",
                    fontSize: 12.5,
                    border: "1px dashed var(--dsw-alias-border-l1)",
                    borderRadius: "var(--dsw-radius-sm)",
                  },
                },
                t(`empty.${tab === "input" || tab === "running" || tab === "unread" || tab === "idle" ? tab : "nomatch"}`),
              ),
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
        padding: "calc(20px + var(--dsh-frame-top-clearance, 0px)) max(20px, var(--dsh-frame-leading-clearance, 0px)) 40px",
      };
    }

    /* ============================ 装配 ============================ */

    const CSS = `
html[data-dsh-style] .dtn-dot--running { animation-name: dtn-spin; }
html[data-dsh-style] .dtn-dot--running,
html[data-dsh-style] .dtn-row,
html[data-dsh-style] .dtn-tab,
html[data-dsh-style] .dtn-icon {
  -webkit-user-select: none;
}
html[data-dsh-style] .dtn-dot--running { transition: none; }

.dtn-row {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--dsw-alias-border-l1);
}
.dtn-row--unread { background: var(--dsw-alias-bg-layer-2); }
.dtn-row--input {
  background: var(
    --dsw-alias-state-warn-tertiary,
    color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, var(--dsw-alias-bg-layer-1))
  );
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, transparent);
}

.dtn-dot {
  flex: none;
  display: inline-grid;
  place-items: center;
  box-sizing: border-box;
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.dtn-dot--done {
  background: var(--dsw-alias-state-idle-primary, var(--dsw-alias-label-dimmed));
  opacity: 0.55;
}
.dtn-dot--running {
  border: 1.8px solid var(--dsw-alias-state-business-primary);
  border-top-color: transparent;
  animation: dtn-spin 0.9s linear infinite;
}
.dtn-dot--input { border: 1.5px solid var(--dsw-alias-state-warn-primary); }
.dtn-dot__core {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary);
}

/* 侧栏角标：等人的琥珀点带一圈呼吸环，运行中的蓝点保持静态。 */
.dtn-attn-ring {
  transform-box: fill-box;
  transform-origin: center;
  animation: dtn-attn 2.2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
}
@keyframes dtn-attn {
  0% { opacity: 0.6; transform: scale(0.85); }
  70%, 100% { opacity: 0; transform: scale(2.1); }
}

@media (prefers-reduced-motion: reduce) {
  .dtn-dot--running { animation: none !important; }
  .dtn-attn-ring { animation: none !important; opacity: 0 !important; }
}
@keyframes dtn-spin { to { transform: rotate(360deg); } }

.dtn-row:focus-visible,
.dtn-tab:focus-visible,
.dtn-icon:focus-visible {
  outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 2px;
}
.dtn-row:hover {
  background: var(--dsw-alias-interactive-bg-hover-solid, var(--dsw-alias-interactive-bg-hover));
  border-color: var(--dsw-alias-border-l2);
}
.dtn-row--input:hover {
  background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 14%, var(--dsw-alias-bg-layer-1));
  border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 48%, transparent);
}
.dtn-tab:hover:not([aria-selected="true"]),
.dtn-icon:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
@media (hover: hover) {
  .dtn-row { transition: background 140ms ease, border-color 140ms ease; }
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
