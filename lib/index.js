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
  NS,
  PREFIX,
  STATE_VERSION,
  hostMessages,
  normalizeConfig,
  normalizeLocale,
  notificationScript,
  normalizeId,
  normalizeIds,
  parseState,
  requestAdmission,
  routeOf,
  sanitizeText,
  statePayload,
  transitionTask,
} from "./core.js";

export const inject = ["webServer", "connection", "sessionQuery"];

/* ------------------------------------------------------------------ */
/* 数据目录                                                            */
/* ------------------------------------------------------------------ */

function dataDir() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  return join(home, "storages", NS);
}

function stateFile() {
  return join(dataDir(), "state.json");
}

export function apply(ctx, config) {
  const settings = normalizeConfig(config);
  const logger = ctx.logger ?? console;
  const tasks = new Map();
  let rev = 1;
  let lastHeartbeat = 0;
  let lastCanNotify = false; // 心跳带来的「页面的浏览器通知权限已授权」
  let lastLocale = "zh"; // 心跳带来的界面语言，用于系统通知兜底文案
  let persistTimer = null;
  let lastOsErrorAt = 0;
  let lastTestAt = 0;
  let lastNotifyAt = 0;
  let activeWaits = 0;
  let dirHardened = false;
  let guardWarned = false;

  /* ---------- 持久化 ---------- */

  function ensureDataDir() {
    const dir = dataDir();
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
      const file = stateFile();
      if (!existsSync(file)) return null;
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > LIMITS.stateFileBytes) {
        logger?.warn?.(`${NS}: 未读状态文件过大或不是普通文件，已忽略`);
        return null;
      }
      return parseState(JSON.parse(readFileSync(file, "utf8")));
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
        const target = stateFile();
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

  /* ---------- 任务表 ---------- */

  function nowMs() {
    return Date.now();
  }

  function snapshotTasks() {
    const list = [...tasks.values()];
    list.sort((a, b) => (b.changeAt ?? 0) - (a.changeAt ?? 0));
    return list.slice(0, LIMITS.maxTasks).map((task) => ({ ...task }));
  }

  function bump() {
    rev += 1;
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
    }
  }

  function ensureTask(id) {
    let task = tasks.get(id);
    if (!task) {
      task = {
        id,
        title: null,
        running: false,
        startedAt: 0,
        completedAt: 0,
        unread: false,
        changeAt: 0,
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
    const candidates = [summary.title, summary.name, summary.header?.title, summary.summary?.title];
    for (const candidate of candidates) {
      const title = safeTitle(candidate);
      if (title) return title;
    }
    return null;
  }

  function seedFromPersistence() {
    const saved = loadPersisted();
    if (!saved) return;
    for (const task of saved) {
      tasks.set(task.id, {
        id: task.id,
        title: task.title,
        running: false, // 重启后一律先按空闲看，随事件收敛
        startedAt: 0,
        completedAt: task.completedAt,
        unread: task.unread,
        changeAt: task.changeAt,
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
        for (const record of records) {
          // 只预热还活着的会话；历史会话不进面板（它们靠未读快照或事件出现）。
          if (record?.live !== true) continue;
          const id = normalizeId(record?.id ?? record?.header?.id);
          if (!id) continue;
          ids.push(id);
          const title = extractTitle(record) ?? safeTitle(record?.header?.title) ?? null;
          upsert(id, { title: title ?? undefined });
        }
        // 标题兜底：日志折叠标题（异步快照，缺省时弱化显示，不生成、不烧模型）。
        // 观测形状：{ sessionId, status, value: { session, title: { title, ... } } }
        if (typeof sessionQuery.readTitleSnapshots === "function" && ids.length) {
          try {
            const observations = await sessionQuery.readTitleSnapshots(ids.slice(0, 200));
            if (Array.isArray(observations)) {
              observations.forEach((observation, index) => {
                if (observation?.status !== "fulfilled") return;
                upsert(ids[index], { title: safeTitle(observation?.value?.title?.title) ?? undefined });
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
        const title = safeTitle(observations?.[0]?.value?.title?.title);
        if (title) upsert(sessionId, { title });
        return title;
      })
      .catch(() => null);
  }

  /* ---------- 系统通知兜底 ---------- */

  function pageLive() {
    return lastHeartbeat > 0 && nowMs() - lastHeartbeat < LIMITS.heartbeatTtlMs;
  }

  function osNotifyOne(task, force = false) {
    if (process.platform !== "darwin") {
      return { ok: false, reason: "unsupported-platform", locale: lastLocale };
    }
    if (settings.osNotify === "off") return { ok: false, reason: "disabled", locale: lastLocale };
    if (!force) {
      if (settings.osNotify === "always") {
        // 恒发
      } else {
        // auto：页面在线且浏览器通知已授权时交给页面，避免双弹
        if (pageLive() && lastCanNotify) return { ok: false, reason: "page-handles" };
      }
    }
    const messages = hostMessages(lastLocale);
    const name = task?.title ?? messages.unnamed;
    const body = messages.completed(name);
    const script = notificationScript({ body, title: settings.osTitle, sound: settings.osSound });
    execFile("osascript", ["-e", script], { timeout: 5_000 }, (error) => {
      if (error && nowMs() - lastOsErrorAt > 60_000) {
        lastOsErrorAt = nowMs();
        logger?.warn?.(`${NS}: 系统通知发送失败：`, error.message);
      }
    });
    return { ok: true };
  }

  /* ---------- 事件订阅 ---------- */

  function onStatusChanged(sessionId, running) {
    const id = normalizeId(sessionId);
    if (!id) return;
    const task = ensureTask(id);
    const { changed, completed } = transitionTask(task, running === true, nowMs());
    if (!changed) return;
    if (completed) {
      // 标题句子多半刚生成好，先补一次再发通知，避免「未命名会话」满屏飞
      Promise.resolve(refreshTitle(id))
        .catch(() => {})
        .finally(() => {
          osNotifyOne(task);
        });
    }
    bump();
    persistSoon();
    pruneTasks();
  }

  ctx.effect(() => {
    const disposers = [
      ctx.on("api-session/status", (sessionId, running) => {
        try {
          onStatusChanged(sessionId, running);
        } catch (error) {
          logger?.warn?.(`${NS}: 状态事件处理失败：`, error?.message ?? error);
        }
      }),
      ctx.on("api-session/added", (summary) => {
        try {
          const id = normalizeId(summary?.id ?? summary?.sessionId);
          if (!id) return;
          upsert(id, { title: extractTitle(summary) ?? undefined });
        } catch (error) {
          logger?.warn?.(`${NS}: added 事件处理失败：`, error?.message ?? error);
        }
      }),
      ctx.on("api-session/removed", (sessionId) => {
        try {
          const id = normalizeId(sessionId);
          if (!id) return;
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
    const deadline = nowMs() + Math.min(Math.max(timeoutMs ?? 15_000, LIMITS.minWaitMs), LIMITS.maxWaitMs);
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        if (rev !== requested || nowMs() >= deadline) {
          clearInterval(timer);
          resolve(rev);
        }
      }, 200);
      if (typeof timer.unref === "function") timer.unref();
    });
  }

  function runTestNotification() {
    // 测试路径强制发送，绕过 auto 判重，让用户真的能验证到弹窗。
    if (process.platform !== "darwin") {
      return { ok: false, reason: "unsupported-platform", locale: lastLocale };
    }
    if (settings.osNotify === "off") return { ok: false, reason: "disabled", locale: lastLocale };
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

  function osNotifyByIds(ids) {
    let sent = 0;
    for (const id of ids) {
      const task = tasks.get(id);
      if (task && osNotifyOne(task, true).ok) sent += 1;
    }
    return sent;
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

            if (route === "read" && method === "POST") {
              const body = await readJson(req);
              if (body === null) {
                json(res, 413, { error: "payload-too-large" });
                return;
              }
              if (body.all === true) {
                for (const task of tasks.values()) {
                  if (task.unread) task.unread = false;
                }
              } else {
                for (const id of normalizeIds(body.ids)) {
                  const task = tasks.get(id);
                  if (task?.unread) task.unread = false;
                }
              }
              bump();
              persistSoon();
              json(res, 200, { rev, tasks: snapshotTasks() });
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
