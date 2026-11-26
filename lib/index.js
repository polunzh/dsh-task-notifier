/**
 * 任务通知台：宿主侧。
 *
 * 四件事：
 *  1. 监听 `api-session/*` 事件，维护一张「任务表」（每个活跃会话一行），
 *     running 状态翻转时推进 startedAt / completedAt，并把完成的任务标为未读；
 *  2. 未读状态持久化到 `$DSH_HOME/storages/dsh-task-notifier/state.json`
 *     （目录 0700、文件 0600，文件里存的是会话标题，属于用户私有内容）；
 *  3. 注册 /task-notifier/api/* 同源路由：浏览器轮询 /state、长轮询 /wait、
 *     心跳 /heartbeat、标已读 /read、系统通知自检 /test；
 *  4. 系统通知兜底：页面心跳在线就让浏览器通知处理；页面离线（或 osNotify=always）
 *     时用 `osascript display notification` 弹 macOS 通知，顺带播放系统提示音。
 *
 * 安全边界（详见仓库 SECURITY.md）：
 *  - 路由先过宿主 `connection.requestRejection()`（Host/Origin fence + 鉴权）；
 *    该服务缺失时 **fail-closed**，不做"拿不到守卫就放行"；
 *  - 写操作要求 `application/json`，跨站简单请求（text/plain）打不进来；
 *  - 所有进入持久化 / 通知 / AppleScript 的文本都先经 core.js 净化与截断；
 *  - /test、/notify 有冷却，/wait 有并发上限，防止被刷屏或拖住事件循环。
 *
 * 会话点击跳转（openSession）由浏览器侧完成；宿主不关心 UI 布局。
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  LIMITS,
  NOTIF_VERSION,
  NS,
  PREFIX,
  STATE_VERSION,
  classifyTurnEnd,
  hostMessages,
  isQuotaError,
  normalizeConfig,
  normalizeLocale,
  findTaskTwin,
  normalizeNotificationEntry,
  notificationScript,
  normalizeId,
  normalizeIds,
  parseNotifications,
  parseState,
  requestAdmission,
  routeOf,
  sanitizeText,
  statePayload,
  taskEntryKey,
  transitionTask,
  trimNotifications,
} from "./core.js";

export const inject = ["webServer", "connection", "sessionQuery"];

/* ------------------------------------------------------------------ */
/* 数据目录                                                            */
/* ------------------------------------------------------------------ */

function dataDir(homeRoot) {
  const home = homeRoot || process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "storages", NS);
}

function stateFile(homeRoot) {
  return join(dataDir(homeRoot), "state.json");
}

function notificationsFile(homeRoot) {
  return join(dataDir(homeRoot), "notifications.json");
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const logger = ctx.logger ?? console;
  /**
   * 数据目录在 apply 时定下来：插件生命周期里 DSH_HOME 不该再变，
   * 也让测试可以用独立临时目录并行启动多个实例而不互相污染。
   */
  const homeRoot = process.env.DSH_HOME || join(homedir(), ".dsh");
  const tasks = new Map();
  /** 通知中心：id → 归一化条目。任务是其中一类来源。 */
  const notifications = new Map();
  /**
   * 阻塞在「人」身上的会话：会话 id → 待回答的工具调用（callId → question | plan）。
   * 这类调用在用户作答前不会产出 tool/result，因此存在即表示界面必须停下来等人。
   * 只存在于内存：进程重启后旧轮次已经收口，不存在仍然可信的等待。
   */
  const pendingQuestions = new Map();
  /** 会话 id → 待裁决的审批 id。由会话日志的 approval/asked + approval/decided 配对维护。 */
  const pendingApprovals = new Map();
  let rev = 1;
  let lastHeartbeat = 0;
  let lastCanNotify = false; // 心跳带来的「页面的浏览器通知权限已授权」
  let lastLocale = "zh"; // 心跳带来的界面语言，用于系统通知兜底文案
  let persistTimer = null;
  let notifPersistTimer = null;
  let lastOsErrorAt = 0;
  let lastTestAt = 0;
  let lastNotifyAt = 0;
  /** 会话 id → 最近一次自动系统通知的时刻，用于合并同一结果的重复上报。 */
  const lastOsNotifyAt = new Map();
  let activeWaits = 0;
  let dirHardened = false;
  let guardWarned = false;

  /* ---------- 持久化 ---------- */

  function ensureDataDir() {
    const dir = dataDir(homeRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!dirHardened) {
      try {
        chmodSync(dir, 0o700);
      } catch {
        /* 目录属主不是当前用户时改不了，写盘会走下面的失败分支 */
      }
      dirHardened = true;
    }
    return dir;
  }

  function loadPersisted() {
    try {
      const file = stateFile(homeRoot);
      if (!existsSync(file)) return null;
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > LIMITS.stateFileBytes) {
        logger?.warn?.(`${NS}: 未读状态文件过大或不是普通文件，已忽略`);
        return null;
      }
      const raw = JSON.parse(readFileSync(file, "utf8"));
      const parsed = parseState(raw);
      if (!parsed) return null;
      // 记录存储快照里原始的 running 任务 id：重启后这些任务说明是进程中途退出导致的非正常收尾
      const wasRunningIds = new Set();
      if (Array.isArray(raw?.tasks)) {
        for (const item of raw.tasks) {
          if (item?.running === true) {
            const id = normalizeId(item.id);
            if (id) wasRunningIds.add(id);
          }
        }
      }
      return { tasks: parsed, wasRunningIds };
    } catch (error) {
      logger?.warn?.(`${NS}: 未读状态读取失败（忽略）：`, error?.message ?? error);
      return null;
    }
  }

  function persistSoon() {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        ensureDataDir();
        const payload = {
          version: STATE_VERSION,
          savedAt: nowMs(),
          tasks: snapshotTasks(),
        };
        const target = stateFile(homeRoot);
        const tmp = `${target}.tmp`;
        // 0600：文件里是会话标题，只给当前用户读。
        writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, target);
      } catch (error) {
        logger?.warn?.(`${NS}: 未读状态写盘失败：`, error?.message ?? error);
      }
    }, 600);
    if (typeof persistTimer.unref === "function") persistTimer.unref();
  }

  /* ---------- 通知中心 ---------- */

  function loadNotifications() {
    try {
      const file = notificationsFile(homeRoot);
      if (!existsSync(file)) return;
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > LIMITS.stateFileBytes) {
        logger?.warn?.(`${NS}: 通知快照文件过大或不是普通文件，已忽略`);
        return;
      }
      const parsed = parseNotifications(JSON.parse(readFileSync(file, "utf8")));
      if (!parsed) return;
      for (const entry of trimNotifications(parsed, LIMITS.maxNotifications)) {
        notifications.set(entry.id, entry);
      }
      if (parsed.length) logger?.debug?.(`${NS}: 已恢复 ${parsed.length} 条通知`);
    } catch (error) {
      logger?.warn?.(`${NS}: 通知快照读取失败（忽略）：`, error?.message ?? error);
    }
  }

  function persistNotificationsSoon() {
    if (notifPersistTimer) return;
    notifPersistTimer = setTimeout(() => {
      notifPersistTimer = null;
      try {
        ensureDataDir();
        const payload = {
          version: NOTIF_VERSION,
          savedAt: nowMs(),
          notifications: snapshotNotifications(),
        };
        const target = notificationsFile(homeRoot);
        const tmp = `${target}.tmp`;
        writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf8", mode: 0o600 });
        renameSync(tmp, target);
      } catch (error) {
        logger?.warn?.(`${NS}: 通知快照写盘失败：`, error?.message ?? error);
      }
    }, 600);
    if (typeof notifPersistTimer.unref === "function") notifPersistTimer.unref();
  }

  function snapshotNotifications() {
    return trimNotifications([...notifications.values()], LIMITS.maxNotifications).map((n) => ({ ...n }));
  }

  function trimNotificationsInPlace() {
    const trimmed = trimNotifications([...notifications.values()], LIMITS.maxNotifications);
    if (trimmed.length === notifications.size) return;
    notifications.clear();
    for (const entry of trimmed) notifications.set(entry.id, entry);
  }

  /**
   * 写入或更新一条通知。id 是去重键；已读状态以已有记录为准，
   * 避免同一结果被重复上报时又变回未读。
   * @param {unknown} input 原始条目
   * @param {{dispatch?: boolean}} [options] dispatch=false 时只入库（例如已读回写）
   * @returns {object|null} 归一化后的条目
   */
  function postNotification(input, options = {}) {
    const entry = normalizeNotificationEntry(input, nowMs());
    if (!entry) return null;
    const existing = notifications.get(entry.id);
    if (existing) {
      if (entry.source === "task") {
        // 任务条目代表「这个会话的结果」，同一条再次发生只累加次数并重新标未读；
        // 同一时刻的重复上报（多条事件路径）按幂等处理，不重复计数、不改已读。
        if (entry.ts > (existing.ts ?? 0)) {
          entry.count = Math.min(LIMITS.maxCount, (existing.count ?? 1) + 1);
          entry.read = false;
        } else {
          entry.count = existing.count ?? 1;
          entry.read = existing.read === true;
        }
      } else if (existing.read) {
        entry.read = true;
      }
    }
    notifications.set(entry.id, entry);
    trimNotificationsInPlace();
    bump();
    persistNotificationsSoon();
    if (options.dispatch !== false) dispatchEntry(entry);
    return entry;
  }

  /**
   * 标记通知已读。all=true 时连同任务未读一起清空。
   * @param {string[]} notificationIds
   * @param {boolean} all
   */
  function markNotificationsRead(notificationIds, all) {
    let changed = false;
    if (all === true) {
      for (const entry of notifications.values()) {
        if (!entry.read) {
          entry.read = true;
          changed = true;
        }
      }
      for (const task of tasks.values()) {
        if (task.unread) {
          task.unread = false;
          changed = true;
        }
      }
    } else {
      for (const id of normalizeIds(notificationIds, LIMITS.maxIds)) {
        const entry = notifications.get(id);
        if (entry && !entry.read) {
          entry.read = true;
          changed = true;
        }
        if (entry?.sessionId) {
          const task = tasks.get(entry.sessionId);
          if (task?.unread) {
            task.unread = false;
            changed = true;
          }
        }
      }
    }
    if (changed) {
      bump();
      persistNotificationsSoon();
      persistSoon();
    }
    return changed;
  }

  /** 会话切到主视图时，把这个会话的任务与通知一起标为已读。 */
  function markSessionRead(sessionId) {
    const id = normalizeId(sessionId);
    if (!id) return false;
    let changed = false;
    const task = tasks.get(id);
    if (task?.unread) {
      task.unread = false;
      changed = true;
    }
    for (const entry of notifications.values()) {
      if (entry.sessionId === id && !entry.read) {
        entry.read = true;
        changed = true;
      }
    }
    if (changed) {
      bump();
      persistNotificationsSoon();
      persistSoon();
    }
    return changed;
  }

  /**
   * 统一通知出口：所有来源的系统通知都从这里走。
   * 页面在线时交给浏览器端（含它自己的 /notify 兜底），只有页面离线或 osNotify=always 才弹系统通知。
   * @param {object} entry 通知条目
   * @param {boolean} [force] 强制发送（页面兜底路径），绕过在线判定与去重
   */
  function dispatchEntry(entry, force = false) {
    if (!entry) return { ok: false, reason: "empty" };
    if (settings.osNotify === "off") return { ok: false, reason: "disabled" };
    if (process.platform !== "darwin") return { ok: false, reason: "unsupported-platform" };
    if (!force) {
      const always = settings.osNotify === "always";
      if (!always && pageLive()) return { ok: false, reason: "page-handles" };
      const key = entry.sessionId || entry.id;
      const now = nowMs();
      if (now - (lastOsNotifyAt.get(key) ?? 0) < LIMITS.osNotifyDedupeMs) {
        return { ok: false, reason: "duplicate" };
      }
      lastOsNotifyAt.set(key, now);
    }
    const messages = hostMessages(lastLocale);
    let body;
    if (entry.source === "task") {
      const name = entry.title || messages.unnamed;
      body = entry.kind === "interrupted" ? messages.interrupted(name, entry.interruptedKind) : messages.completed(name);
    } else {
      body = entry.body ? `${entry.title} · ${entry.body}` : entry.title;
    }
    const script = notificationScript({ body, title: settings.osTitle, sound: settings.osSound });
    execFile("osascript", ["-e", script], { timeout: 5_000 }, (error) => {
      if (error && nowMs() - lastOsErrorAt > 60_000) {
        lastOsErrorAt = nowMs();
        logger?.warn?.(`${NS}: 系统通知发送失败：`, error.message);
      }
    });
    return { ok: true };
  }

  function dispatchByIds(notificationIds) {
    let sent = 0;
    for (const id of normalizeIds(notificationIds, LIMITS.maxIds)) {
      const entry = notifications.get(id);
      if (entry && dispatchEntry(entry, true).ok) sent += 1;
    }
    return sent;
  }

  /* ---------- 任务表 ---------- */

  function nowMs() {
    return Date.now();
  }

  function snapshotTasks() {
    const list = [...tasks.values()];
    list.sort((a, b) => (b.changeAt ?? 0) - (a.changeAt ?? 0));
    // 带上父会话标题：跨栏渲染子代理卡时用它显示「来自〈父〉」，父会话不在
    // 本次快照切片里也能拼出来。
    return list.slice(0, LIMITS.maxTasks).map((task) => ({
      ...task,
      parentTitle: task.parentId ? tasks.get(task.parentId)?.title ?? null : null,
    }));
  }

  function bump() {
    rev += 1;
  }

  /**
   * 宿主里会「停下来等人」的工具：在用户作答前它们不会产出 tool/result。
   * 其余工具（bash、read…）只是跑得久，不能误判成等待输入。
   */
  const INPUT_TOOL_KINDS = new Map([
    ["ask_user_question", "question"],
    ["exit_plan_mode", "plan"],
  ]);

  /** 事件里的 id 只用来做集合键：限长、拒绝空串，避免脏键把内存撑坏。 */
  function pendingKey(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > LIMITS.maxIdLength) return null;
    return trimmed;
  }

  function clearPending(id) {
    pendingQuestions.delete(id);
    pendingApprovals.delete(id);
  }

  /** 当前会话卡在哪种人身上：审批优先于提问，计划审阅单独标出来。 */
  function inputKindOf(id) {
    if ((pendingApprovals.get(id)?.size ?? 0) > 0) return "approval";
    const questions = pendingQuestions.get(id);
    if (!questions) return null;
    for (const kind of questions.values()) {
      if (kind === "plan") return "plan";
    }
    return questions.size > 0 ? "question" : null;
  }

  /**
   * 把「是否在等人」同步进任务表，并推进 rev 让面板立刻重绘。
   * 这是纯派生状态：不写盘（重启后旧等待已经不可信），但 changeAt 会随翻转移。
   * @param {string} id 会话 id
   */
  function syncNeedsInput(id) {
    const kind = inputKindOf(id);
    let task = tasks.get(id);
    if (!task) {
      if (kind === null) return;
      task = ensureTask(id);
    }
    const needsInput = kind !== null;
    if (task.needsInput === needsInput && (task.inputKind ?? null) === kind) return;
    task.needsInput = needsInput;
    task.inputKind = kind;
    task.changeAt = nowMs();
    bump();
    persistSoon();
  }

  /**
   * 把中断/报错结果写进任务表：这类任务一定被标成未读，等用户回来看。
   * 中继原因（interruptedMessage）允许为空，因此不复用 upsert 的「跳过 null」规则。
   * @param {string} id 会话 id
   * @param {{interrupted: boolean, kind: string, message: string|null}|null} info classifyTurnEnd 的结果
   * @returns {boolean} 这次调用是否真的改动了任务（用来避免重复提醒）
   */
  function markInterrupted(id, info) {
    if (!info?.interrupted) return false;
    const task = ensureTask(id);
    const kind = info.kind ?? "process_exit";
    const message = info.message ?? null;
    const changed =
      task.interrupted !== true ||
      task.interruptedKind !== kind ||
      task.interruptedMessage !== message ||
      task.unread !== true;
    task.interrupted = true;
    task.interruptedKind = kind;
    task.interruptedMessage = message;
    task.unread = true;
    if (!changed) return false;
    const now = nowMs();
    // 中断也是一次收尾：面板排序和客户端「这是不是一条新结果」都读 completedAt，
    // 只写 changeAt 会让客户端按「完成时刻」过滤时把这条新结果永远漏掉。
    task.completedAt = now;
    task.changeAt = now;
    bump();
    persistSoon();
    return true;
  }

  /**
   * 从会话日志事件里维护「等人」集合。
   *
   * 为什么不用 projection 的 userQuestions：它只跟踪 ask_user_question；审批在
   * approval/asked + approval/decided 里成对出现，而计划审阅是 exit_plan_mode
   * 的阻塞调用。三者合起来才是完整的「需要你」中间态。
   * @param {{id?: string}|string} session 会话（或会话 id）
   * @param {{type?: string, data?: object}} event 追加到日志的事件
   */
  function onSessionEvent(session, event) {
    const id = normalizeId(session?.id ?? session);
    if (!id || !event) return;
    // 事件里的 session 带完整 header：顺手补齐谱系，让新出现的子代理尽快归位。
    const lineage = lineageFrom(session, id);
    if (lineage && tasks.has(id)) upsert(id, lineage);
    switch (event.type) {
      case "session/title": {
        // 标题由宿主在首轮提示后追加到日志；这里即时入表，面板和完成通知
        // 就不用等到轮次结束才去补标题。
        const title = safeTitle(event.data?.title);
        if (title) upsert(id, { title, ...(lineage ?? {}) });
        return;
      }
      case "tool/call": {
        const kind = INPUT_TOOL_KINDS.get(event.data?.name);
        const callId = pendingKey(event.data?.callId);
        if (!kind || !callId) return;
        let questions = pendingQuestions.get(id);
        if (!questions) {
          questions = new Map();
          pendingQuestions.set(id, questions);
        }
        questions.set(callId, kind);
        syncNeedsInput(id);
        return;
      }
      case "tool/result": {
        // 阻塞的提问在作答后才有结果；定时提问超时返回 pending，也算落地。
        const callId = pendingKey(event.data?.message?.toolCallId);
        const questions = pendingQuestions.get(id);
        if (!callId || !questions?.delete(callId)) return;
        if (questions.size === 0) pendingQuestions.delete(id);
        syncNeedsInput(id);
        return;
      }
      case "approval/asked": {
        const approvalId = pendingKey(event.data?.id);
        if (!approvalId) return;
        let approvals = pendingApprovals.get(id);
        if (!approvals) {
          approvals = new Set();
          pendingApprovals.set(id, approvals);
        }
        approvals.add(approvalId);
        syncNeedsInput(id);
        return;
      }
      case "approval/decided": {
        const approvalId = pendingKey(event.data?.id);
        const approvals = pendingApprovals.get(id);
        if (!approvalId || !approvals?.delete(approvalId)) return;
        if (approvals.size === 0) pendingApprovals.delete(id);
        syncNeedsInput(id);
        return;
      }
      case "turn/start": {
        // 轮次开启：清空之前的等待状态，若有旧中断标记也在新轮次开启时重置
        if (pendingQuestions.has(id) || pendingApprovals.has(id)) {
          clearPending(id);
          syncNeedsInput(id);
        }
        const task = tasks.get(id);
        if (task && (task.interrupted || task.interruptedKind)) {
          task.interrupted = false;
          task.interruptedKind = null;
          task.interruptedMessage = null;
          task.changeAt = nowMs();
          bump();
          persistSoon();
        }
        return;
      }
      case "turn/end": {
        // 轮次边界是最终兜底：任何残留等待都属于已经结束的轮次。
        if (pendingQuestions.has(id) || pendingApprovals.has(id)) {
          clearPending(id);
          syncNeedsInput(id);
        }
        // 分析本轮次结束原因：识别中断、欠费与错误
        markInterrupted(id, classifyTurnEnd(event.data?.reason));
        return;
      }
      default:
    }
  }

  /** 任务表只增不减会泄漏，超量时淘汰最久没变化的空闲任务。 */
  function pruneTasks() {
    if (tasks.size <= LIMITS.maxTasks * 2) return;
    const idle = [...tasks.values()]
      .filter((task) => !task.running)
      .sort((a, b) => (a.changeAt ?? 0) - (b.changeAt ?? 0));
    for (const task of idle) {
      if (tasks.size <= LIMITS.maxTasks) break;
      tasks.delete(task.id);
      clearPending(task.id);
      lastOsNotifyAt.delete(task.id);
    }
  }

  function ensureTask(id) {
    let task = tasks.get(id);
    if (!task) {
      task = {
        id,
        title: null,
        running: false,
        needsInput: false,
        inputKind: null,
        startedAt: 0,
        completedAt: 0,
        unread: false,
        changeAt: 0,
        interrupted: false,
        interruptedKind: null,
        interruptedMessage: null,
        // 谱系：由会话头的 parentSession / delegationDepth / origin 带进来。
        parentId: null,
        depth: 0,
        origin: null,
      };
      tasks.set(id, task);
    }
    return task;
  }

  function upsert(id, patch) {
    const taskId = normalizeId(id);
    if (!taskId) return;
    const task = ensureTask(taskId);
    let changed = false;
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || value === null) continue;
      if (task[key] !== value) {
        task[key] = value;
        changed = true;
      }
    }
    if (changed) {
      task.changeAt = nowMs();
      bump();
      persistSoon();
      pruneTasks();
    }
  }

  /** 会话标题只保留净化后的短文本：它会进通知正文、进入状态文件和 AppleScript。 */
  function safeTitle(value) {
    return sanitizeText(value, LIMITS.maxTitle) || null;
  }

  function extractTitle(summary) {
    if (!summary) return null;
    const candidates = [
      summary.title,
      summary.name,
      summary.header?.title,
      summary.summary?.title,
      // api-session/added 的 summary 把标题放在 projections.values.title 里，
      // 而不是顶层的 title；漏掉这个位置会让面板在标题生成后仍显示「未命名会话」。
      summary.projections?.values?.title,
    ];
    for (const candidate of candidates) {
      const title = safeTitle(candidate);
      if (title) return title;
    }
    return null;
  }

  /**
   * 从会话头/记录里抽出谱系三元组。`session/event` 的 session、`api-session/added`
   * 的 summary、`listSessions` 的 record 都带 `header`（或本身就是 header）。
   * 只保留安全、可展示的部分；非法值整条丢弃。
   * @param {unknown} source 会话 / 记录 / 摘要
   * @param {string} selfId 自身会话 id（防止把自己当父）
   * @returns {{parentId?: string, depth?: number, origin?: string}|null}
   */
  function lineageFrom(source, selfId) {
    if (!source || typeof source !== "object") return null;
    const header = source.header && typeof source.header === "object" ? source.header : source;
    const parentId = normalizeId(header.parentSession);
    const rawDepth = Number.isFinite(header.delegationDepth) ? Math.trunc(header.delegationDepth) : 0;
    const depth = rawDepth > 0 ? Math.min(rawDepth, 8) : 0;
    const rawOrigin = typeof header.origin === "string" ? header.origin.trim() : "";
    const origin = rawOrigin ? sanitizeText(rawOrigin, 24) || null : null;
    const patch = {};
    if (parentId && parentId !== selfId) patch.parentId = parentId;
    if (depth) patch.depth = depth;
    if (origin) patch.origin = origin;
    return Object.keys(patch).length ? patch : null;
  }

  function seedFromPersistence() {
    const loaded = loadPersisted();
    if (!loaded) return;
    const { tasks: saved, wasRunningIds } = loaded;
    const now = nowMs();
    for (const task of saved) {
      const wasRunning = wasRunningIds?.has(task.id) === true;
      const isInterrupted = task.interrupted || wasRunning;
      const interruptedKind = isInterrupted ? task.interruptedKind || "process_exit" : null;
      const interruptedMessage = isInterrupted ? task.interruptedMessage : null;
      tasks.set(task.id, {
        id: task.id,
        title: task.title,
        running: false, // 重启后一律先按空闲看，随事件收敛
        // 等待状态不跨进程：旧进程里的提问/审批已经随轮次一起消失了。
        needsInput: false,
        inputKind: null,
        startedAt: 0,
        completedAt: task.completedAt || (wasRunning ? now : 0),
        unread: task.unread || wasRunning,
        changeAt: task.changeAt || now,
        interrupted: isInterrupted,
        interruptedKind,
        interruptedMessage,
        parentId: task.parentId ?? null,
        depth: Number.isFinite(task.depth) ? task.depth : 0,
        origin: task.origin ?? null,
      });
    }
    if (saved.length) logger?.debug?.(`${NS}: 已恢复 ${saved.length} 条任务未读状态`);
  }

  function seedFromSessionQuery() {
    const sessionQuery = ctx.sessionQuery;
    if (!sessionQuery || typeof sessionQuery.listSessions !== "function") return;
    sessionQuery
      .listSessions()
      .then(async (records) => {
        if (!Array.isArray(records)) return;
        const ids = [];
        const seen = new Set();
        for (const record of records) {
          // 只预热还活着的会话；历史会话不进面板（它们靠未读快照或事件出现）。
          if (record?.live !== true) continue;
          const id = normalizeId(record?.id ?? record?.header?.id);
          if (!id || seen.has(id)) continue;
          seen.add(id);
          ids.push(id);
          const title = extractTitle(record) ?? safeTitle(record?.header?.title) ?? null;
          upsert(id, { title: title ?? undefined, ...(lineageFrom(record, id) ?? {}) });
        }
        // 已经恢复但缺标题的任务也补一次：旧版本没有调用 seed，状态文件里
        // 留下了 title=null 的行，不能让它们一直显示「未命名会话」。
        for (const task of tasks.values()) {
          if (task.title || seen.has(task.id)) continue;
          seen.add(task.id);
          ids.push(task.id);
        }
        // 标题兜底：日志折叠标题（异步快照，缺省时弱化显示，不生成、不烧模型）。
        // 观测形状：{ sessionId, status, value: { session, title: { title, ... } } }
        if (typeof sessionQuery.readTitleSnapshots === "function" && ids.length) {
          try {
            const observations = await sessionQuery.readTitleSnapshots(ids.slice(0, 200));
            if (Array.isArray(observations)) {
              observations.forEach((observation, index) => {
                if (observation?.status !== "fulfilled") return;
                const id = ids[index];
                // 会话可能在异步读取期间被 removed：不要用一次标题读取把它复活。
                if (!tasks.has(id)) return;
                upsert(id, { title: safeTitle(observation?.value?.title?.title) ?? undefined });
              });
            }
          } catch (error) {
            logger?.debug?.(`${NS}: 标题补齐失败（忽略）：`, error?.message ?? error);
          }
        }
        persistSoon();
      })
      .catch((error) => {
        logger?.debug?.(`${NS}: 预热会话列表失败（忽略）：`, error?.message ?? error);
      });
  }

  /** 完成时刻补一次标题（读快照，不触发生成；失败静默）。 */
  function refreshTitle(sessionId) {
    const sessionQuery = ctx.sessionQuery;
    if (typeof sessionQuery?.readTitleSnapshots !== "function") return Promise.resolve(null);
    return sessionQuery
      .readTitleSnapshots([sessionId])
      .then((observations) => {
        const observation = observations?.[0];
        const title = safeTitle(observation?.value?.title?.title);
        // 快照里带着会话头，顺手补谱系：程序化起的子代理会话可能没走 added/session 事件。
        const lineage = lineageFrom(observation?.value?.session, sessionId);
        if (title || lineage) upsert(sessionId, { ...(title ? { title } : {}), ...(lineage ?? {}) });
        return title;
      })
      .catch(() => null);
  }

  /* ---------- 系统通知兜底 ---------- */

  function pageLive() {
    return lastHeartbeat > 0 && nowMs() - lastHeartbeat < LIMITS.heartbeatTtlMs;
  }

  /**
   * 把一个刚收尾的会话写成一条 `task` 通知，并走统一出口。
   * 正常完成和中断/报错都走这里；dispatchEntry 决定弹不弹、要不要去重。
   * @param {string} sessionId 会话 id
   */
  function notifyTaskResult(sessionId) {
    const task = tasks.get(sessionId);
    if (!task) return;
    Promise.resolve(refreshTitle(sessionId))
      .catch(() => {})
      .finally(() => {
        const current = tasks.get(sessionId);
        if (!current) return;
        // 子代理的收尾不单独发通知：它属于父会话的一次执行，看板里仍按树展示；
        // 谱系可能刚在 refreshTitle 里补齐，所以判断放在这里。等你回复/审批仍会置顶。
        if (current.parentId) return;
        const at = current.completedAt || current.changeAt || nowMs();
        const interrupted = current.interrupted === true;
        const title = current.title || hostMessages(lastLocale).unnamed;
        const kind = interrupted ? "interrupted" : "completed";
        // 后台任务每轮起一个新会话、标题相同：窗口内并进同一条，行上显示「完成 N 次」。
        const twin = findTaskTwin(notifications.values(), { title, kind, at });
        postNotification({
          id: twin?.id ?? taskEntryKey(sessionId, kind) ?? `task:${sessionId}:${at}`,
          source: "task",
          kind: interrupted ? "interrupted" : "completed",
          title,
          tone: interrupted ? (current.interruptedKind === "quota" ? "warning" : "error") : "success",
          ts: at,
          sessionId,
          read: false,
          interruptedKind: interrupted ? current.interruptedKind || "process_exit" : null,
          interruptedMessage: interrupted ? current.interruptedMessage : null,
        });
      });
  }

  /* ---------- 事件订阅 ---------- */

  function onStatusChanged(sessionId, running) {
    const id = normalizeId(sessionId);
    if (!id) return;
    const task = ensureTask(id);
    const { changed, completed } = transitionTask(task, running === true, nowMs());
    if (!changed) return;
    // 轮次翻转后，旧轮次上挂着的等待一律作废（状态机已经替我们清字段，这里清集合）。
    clearPending(id);
    if (completed) {
      // 标题句子多半刚生成好，先补一次再发通知，避免「未命名会话」满屏飞
      notifyTaskResult(id);
    }
    bump();
    persistSoon();
    pruneTasks();
  }

  // 启动预热：先恢复上一次的未读快照，再从会话服务读出 live 会话标题。
  // 这两步必须真的执行；只定义不调用会让面板一直停在「未命名会话」。
  loadNotifications();
  seedFromPersistence();
  seedFromSessionQuery();

  ctx.effect(() => {
    const disposers = [
      // 会话日志的追加流：只读观察，用来识别「停下来等人」的中间态。
      // global 让根上下文能收到子作用域（各 Agent）的会话事件。
      ctx.on(
        "session/event",
        (session, event) => {
          try {
            onSessionEvent(session, event);
          } catch (error) {
            logger?.warn?.(`${NS}: 会话事件处理失败：`, error?.message ?? error);
          }
        },
        { global: true },
      ),
      ctx.on("api-session/status", (sessionId, running) => {
        try {
          onStatusChanged(sessionId, running);
        } catch (error) {
          logger?.warn?.(`${NS}: 状态事件处理失败：`, error?.message ?? error);
        }
      }),
      // 没有落到持久轮次位置的 Agent 失败（会话级故障）：同样要标成中断，
      // 否则任务会停在「运行中」，永远不会出现在未读结果里。
      ctx.on("api-session/error", (sessionId, message) => {
        try {
          const id = normalizeId(sessionId);
          if (!id) return;
          const text = sanitizeText(message, LIMITS.maxReason) || null;
          const changed = markInterrupted(id, {
            interrupted: true,
            kind: isQuotaError(text ?? "") ? "quota" : "error",
            message: text,
          });
          // 只有真的产生了新结果才提醒：同一个错误反复上报时不该重复弹。
          // 会话级失败没有轮次收尾事件：页面关着时只有这一条路径能提醒到人。
          if (changed) notifyTaskResult(id);
        } catch (error) {
          logger?.warn?.(`${NS}: 错误事件处理失败：`, error?.message ?? error);
        }
      }),
      ctx.on("api-session/added", (summary) => {
        try {
          const id = normalizeId(summary?.id ?? summary?.sessionId);
          if (!id) return;
          upsert(id, { title: extractTitle(summary) ?? undefined, ...(lineageFrom(summary, id) ?? {}) });
        } catch (error) {
          logger?.warn?.(`${NS}: added 事件处理失败：`, error?.message ?? error);
        }
      }),
      ctx.on("api-session/removed", (sessionId) => {
        try {
          const id = normalizeId(sessionId);
          if (!id) return;
          clearPending(id);
          lastOsNotifyAt.delete(id);
          if (tasks.delete(id)) {
            bump();
            persistSoon();
          }
        } catch (error) {
          logger?.warn?.(`${NS}: removed 事件处理失败：`, error?.message ?? error);
        }
      }),
    ];
    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          /* 卸载时服务可能已失效 */
        }
      }
    };
  }, `${NS}: api-session events`);

  /* ---------- 宿主服务：供其它插件发布通知 ---------- */

  const notificationsService = {
    /** @param {unknown} entry 通知条目 @returns {object|null} 归一化后的条目 */
    post: (entry) => postNotification(entry),
    /** @returns {object[]} 当前通知快照（时间倒序） */
    list: () => snapshotNotifications(),
    /** @param {string[]} ids 通知 id @returns {boolean} 是否有变化 */
    markRead: (ids) => markNotificationsRead(ids, false),
    /** @returns {boolean} 是否有变化 */
    markAllRead: () => markNotificationsRead([], true),
    /** 预留的订阅入口；宿主内部变更通过 rev + /state 传播。 */
    subscribe: () => () => {},
  };
  if (typeof ctx.provide === "function") {
    try {
      ctx.provide("notifications", notificationsService);
    } catch (error) {
      logger?.warn?.(`${NS}: 提供 notifications 服务失败：`, error?.message ?? error);
    }
  }

  /* ------------------------------------------------------------------ */
  /* HTTP 路由                                                           */
  /* ------------------------------------------------------------------ */

  function json(res, status, body) {
    const payload = Buffer.from(JSON.stringify(body), "utf8");
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": payload.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    res.end(payload);
  }

  async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > LIMITS.bodyBytes) {
        chunks.length = 0;
        return null; // 超限：交由调用方回 413
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  function waitForRevision(requested, timeoutMs) {
    // 已经变了就别等下一个 tick：长轮询最常见的一步就是「一进来就该返回」。
    if (rev !== requested) return Promise.resolve(rev);
    const deadline = nowMs() + Math.min(Math.max(timeoutMs ?? 15_000, LIMITS.minWaitMs), LIMITS.maxWaitMs);
    return new Promise((resolve) => {
      // 不 unref：请求还没答复时进程本来就不该退出。unref 会让事件循环先空掉，
      // 在 CI 上表现为「Promise 未结算而事件循环已经结束」。
      const timer = setInterval(() => {
        if (rev !== requested || nowMs() >= deadline) {
          clearInterval(timer);
          resolve(rev);
        }
      }, 200);
    });
  }

  function runTestNotification() {
    // 测试路径强制发送，绕过 auto 判重，让用户真的能验证到弹窗。
    if (settings.osNotify === "off") return { ok: false, reason: "disabled", locale: lastLocale };
    if (process.platform !== "darwin") {
      return { ok: false, reason: "unsupported-platform", locale: lastLocale };
    }
    const messages = hostMessages(lastLocale);
    const script = notificationScript({
      body: messages.test(messages.testTitle),
      title: settings.osTitle,
      sound: settings.osSound,
    });
    execFile("osascript", ["-e", script], { timeout: 5_000 }, () => {});
    return {
      ok: true,
      mode: settings.osNotify,
      pageLive: pageLive(),
      canNotify: lastCanNotify,
      locale: lastLocale,
    };
  }

  function osNotifyByIds(notificationIds) {
    return dispatchByIds(notificationIds);
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: PREFIX,
        handler: async (req, res) => {
          // 宿主守卫（Host/Origin fence + 鉴权）；守卫缺失时 fail-closed。
          const admission = requestAdmission(ctx.connection, req);
          if (!admission.ok) {
            if (!guardWarned && admission.reason === "no-connection-guard") {
              guardWarned = true;
              logger?.warn?.(`${NS}: 找不到 connection.requestRejection，已按 fail-closed 拒绝所有路由`);
            }
            json(res, admission.status, { error: admission.reason });
            return;
          }

          const method = (req.method || "GET").toUpperCase();
          const route = routeOf(req.url);
          if (route === null) {
            json(res, 404, { error: "not-found" });
            return;
          }

          try {
            if (route === "state" && method === "GET") {
              json(
                res,
                200,
                statePayload({
                  rev,
                  now: nowMs(),
                  settings: { sound: settings.sound, osNotify: settings.osNotify },
                  tasks: snapshotTasks(),
                  notifications: snapshotNotifications(),
                }),
              );
              return;
            }

            if (route === "wait" && method === "GET") {
              if (activeWaits >= LIMITS.maxConcurrentWaits) {
                json(res, 429, { error: "too-many-waits" });
                return;
              }
              const raw = Number(new URL(req.url, "http://localhost").searchParams.get("rev"));
              const requested = Number.isFinite(raw) ? raw : rev;
              activeWaits += 1;
              try {
                const next = await waitForRevision(requested);
                json(res, 200, { rev: next });
              } finally {
                activeWaits -= 1;
              }
              return;
            }

            if (route === "heartbeat" && method === "POST") {
              const body = await readJson(req);
              if (body === null) {
                json(res, 413, { error: "payload-too-large" });
                return;
              }
              lastHeartbeat = nowMs();
              lastCanNotify = body.canNotify === true;
              lastLocale = normalizeLocale(body.locale);
              json(res, 200, { ok: true });
              return;
            }

            if (route === "notify" && method === "POST") {
              // 页面无法弹浏览器通知时来的兜底路径：强制发系统通知。
              if (nowMs() - lastNotifyAt < LIMITS.notifyCooldownMs) {
                json(res, 429, { error: "cooldown" });
                return;
              }
              const body = await readJson(req);
              if (body === null) {
                json(res, 413, { error: "payload-too-large" });
                return;
              }
              lastNotifyAt = nowMs();
              const ids = normalizeIds(body.ids);
              json(res, 200, { ok: true, requested: ids.length, sent: osNotifyByIds(ids) });
              return;
            }

            if (route === "publish" && method === "POST") {
              // 其它插件通过宿主服务或本路由发布通知（同源 + 宿主守卫）。
              const body = await readJson(req);
              if (body === null) {
                json(res, 413, { error: "payload-too-large" });
                return;
              }
              const entry = postNotification(body);
              if (!entry) {
                json(res, 400, { error: "invalid-notification" });
                return;
              }
              json(res, 200, { ok: true, notification: entry, rev });
              return;
            }

            if (route === "read" && method === "POST") {
              const body = await readJson(req);
              if (body === null) {
                json(res, 413, { error: "payload-too-large" });
                return;
              }
              let changed = false;
              if (body.all === true) {
                changed = markNotificationsRead([], true);
              } else {
                if (Array.isArray(body.ids)) {
                  for (const id of normalizeIds(body.ids)) {
                    const task = tasks.get(id);
                    if (task?.unread) {
                      task.unread = false;
                      changed = true;
                    }
                  }
                }
                if (Array.isArray(body.notificationIds)) {
                  if (markNotificationsRead(body.notificationIds, false)) changed = true;
                }
                if (typeof body.sessionId === "string") {
                  if (markSessionRead(body.sessionId)) changed = true;
                }
                if (changed) {
                  bump();
                  persistSoon();
                }
              }
              json(res, 200, { rev, tasks: snapshotTasks(), notifications: snapshotNotifications() });
              return;
            }

            if (route === "test" && method === "POST") {
              if (nowMs() - lastTestAt < LIMITS.testCooldownMs) {
                json(res, 429, { error: "cooldown" });
                return;
              }
              lastTestAt = nowMs();
              json(res, 200, runTestNotification());
              return;
            }

            json(res, 404, { error: "not-found" });
          } catch (error) {
            logger?.warn?.(`${NS}: 路由处理失败：`, error?.message ?? error);
            json(res, 500, { error: "internal" });
          }
        },
      }),
    `${NS}: ${PREFIX} routes`,
  );

  logger?.debug?.(
    `${NS}: 事件订阅 + 路由已注册（osNotify=${settings.osNotify}, sound=${settings.sound}）`,
  );
}
