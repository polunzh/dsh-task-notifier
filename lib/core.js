/**
 * 任务通知台 · 宿主侧纯逻辑。
 *
 * 这里只放无 IO、无 ctx 的纯函数，方便单测直接覆盖安全相关的判定：
 * config 归一化、文本/标题净化、AppleScript 转义、请求守卫、状态文件解析。
 * 任何需要文件系统或 ctx 的行为都留在 index.js 里。
 */
import { URL } from "node:url";

export const NS = "dsh-task-notifier";
export const PREFIX = "/task-notifier/api";
export const STATE_VERSION = 1;

export const LIMITS = Object.freeze({
  /** 单次请求体上限。 */
  bodyBytes: 64 * 1024,
  /** 状态文件读取上限，防止损坏/被替换成巨型文件时把进程拖死。 */
  stateFileBytes: 1024 * 1024,
  /** 任务表最多保留的条数。 */
  maxTasks: 300,
  /** 会话标题最大长度（同时用于通知正文，避免 osascript 参数过长）。 */
  maxTitle: 120,
  /** 单次请求最多处理的 id 数。 */
  maxIds: 200,
  /** 会话 id 最大长度（uuid 一般 36，留足余量）。 */
  maxIdLength: 128,
  /** 页面心跳有效期。 */
  heartbeatTtlMs: 8_000,
  /** 长轮询上限/下限。 */
  maxWaitMs: 25_000,
  minWaitMs: 500,
  /** 并发长轮询上限，防止被打开大量连接拖住事件循环。 */
  maxConcurrentWaits: 32,
  /** 系统通知自检的冷却时间，防止被反复触发刷屏。 */
  testCooldownMs: 1_500,
  /** /notify 兜底的冷却时间。 */
  notifyCooldownMs: 800,
});

export const DEFAULTS = Object.freeze({
  osNotify: "auto", // auto | always | off
  sound: true, // 浏览器端合成提示音（client 读取）
  osSound: "Glass", // macOS 系统提示音名
  osTitle: "DeepSeek Harness", // 系统通知标题
});

const OS_NOTIFY_MODES = new Set(["auto", "always", "off"]);
/** 系统提示音名只允许 macOS 自带音名那种形态，杜绝把任意文本塞进 AppleScript。 */
const SAFE_SOUND = /^[A-Za-z][A-Za-z0-9 _-]{0,39}$/;
/** C0/C1 控制字符（保留可打印文本，统一折叠为空格）。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
/** 同上的非全局版本：带 /g 的正则在 .test() 之间会保留 lastIndex，不能用于判定。 */
const HAS_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** 是否为普通对象。 */
export function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 净化一段用户可见文本：折叠控制字符与空白、去首尾、按码点截断。
 * @param {unknown} value 原始值
 * @param {number} max 最大长度
 * @returns {string} 安全文本（空串表示无内容）
 */
export function sanitizeText(value, max = LIMITS.maxTitle) {
  if (typeof value !== "string") return "";
  const flat = value.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  // 用 Array.from 按码点切，避免把 emoji / 代理对劈成半个字符
  return Array.from(flat).slice(0, max).join("").trim();
}

/**
 * 归一化插件 config：非法值一律回落到默认值，绝不把原始输入透传给 osascript。
 * @param {unknown} config cordis.patch.yml 里的 config
 * @returns {{osNotify: string, sound: boolean, osSound: string, osTitle: string}}
 */
export function normalizeConfig(config) {
  const source = isRecord(config) ? config : {};
  const osNotify = OS_NOTIFY_MODES.has(source.osNotify) ? source.osNotify : DEFAULTS.osNotify;
  const sound = source.sound === undefined ? DEFAULTS.sound : source.sound === true;
  const rawSound = typeof source.osSound === "string" ? source.osSound.trim() : "";
  const osSound = SAFE_SOUND.test(rawSound) ? rawSound : DEFAULTS.osSound;
  const osTitle = sanitizeText(source.osTitle, 64) || DEFAULTS.osTitle;
  return { osNotify, sound, osSound, osTitle };
}

/**
 * 会话 id 归一化：只接受非空字符串，并限制长度。
 * @param {unknown} value 原始 id
 * @returns {string|null}
 */
export function normalizeId(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > LIMITS.maxIdLength) return null;
  if (HAS_CONTROL_CHARS.test(trimmed)) return null;
  return trimmed;
}

/**
 * 归一化 id 列表：去重、限长、限量。
 * @param {unknown} value 请求体里的 ids
 * @param {number} max 最多保留条数
 * @returns {string[]}
 */
export function normalizeIds(value, max = LIMITS.maxIds) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const item of value) {
    if (out.length >= max) break;
    const id = normalizeId(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 把文本转成 AppleScript 字符串字面量（含引号）。
 *
 * 先净化（去掉控制字符与换行），再按 AppleScript 规则转义反斜杠与双引号。
 * 顺序不能反，否则净化会吃掉转义出来的反斜杠。
 * @param {unknown} text 原始文本
 * @param {number} max 最大长度
 * @returns {string} 形如 `"已完成"` 的字面量
 */
export function appleScriptQuote(text, max = LIMITS.maxTitle) {
  const safe = sanitizeText(text, max);
  const escaped = safe.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * 构造 `display notification` 脚本。
 * @param {{body: unknown, title: unknown, sound: unknown}} parts 通知正文/标题/提示音
 * @returns {string} 可直接交给 `osascript -e` 的脚本
 */
export function notificationScript(parts) {
  const body = appleScriptQuote(parts?.body ?? "", LIMITS.maxTitle);
  const title = appleScriptQuote(parts?.title ?? DEFAULTS.osTitle, 64);
  const sound = appleScriptQuote(parts?.sound ?? DEFAULTS.osSound, 40);
  return `display notification ${body} with title ${title} sound name ${sound}`;
}

/**
 * 从 URL 中解析出插件路由名。
 * @param {string} rawUrl 请求的原始 URL（可含 query）
 * @returns {string|null} `""` 表示路由根，`null` 表示不归本插件管
 */
export function routeOf(rawUrl) {
  let pathname;
  try {
    pathname = new URL(rawUrl ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
  const normalized = pathname.replace(/\/+$/, "");
  if (normalized === PREFIX) return "";
  if (normalized.startsWith(`${PREFIX}/`)) return normalized.slice(PREFIX.length + 1);
  return null;
}

/**
 * 判定一个请求是否可以被本插件处理。
 *
 * 宿主 `connection.requestRejection()` 已经做了 Host/Origin fence + 鉴权（缺失时返回
 * 403/401）。这里的职责是**在守卫缺失时 fail-closed**：拿不到守卫就拒绝，而不是放行。
 * 另外对写操作要求 JSON Content-Type —— 跨站表单只能发简单请求（text/plain），
 * 这样即使将来守卫回退，也不会被简单请求打到写接口。
 * @param {unknown} connection ctx.connection 服务
 * @param {{method?: string, headers?: Record<string, unknown>}} request 原生请求
 * @returns {{ok: true} | {ok: false, status: number, reason: string}}
 */
export function requestAdmission(connection, request) {
  const guard = connection && typeof connection.requestRejection === "function" ? connection : null;
  if (!guard) return { ok: false, status: 503, reason: "no-connection-guard" };
  let rejection;
  try {
    rejection = guard.requestRejection(request);
  } catch {
    return { ok: false, status: 403, reason: "guard-error" };
  }
  if (rejection !== undefined) {
    return { ok: false, status: typeof rejection === "number" ? rejection : 403, reason: "rejected" };
  }
  const method = String(request?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const contentType = String(request?.headers?.["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      return { ok: false, status: 415, reason: "unsupported-media-type" };
    }
  }
  return { ok: true };
}

/**
 * 解析持久化状态文件内容。
 * @param {unknown} raw 已 JSON.parse 的值
 * @returns {Array<{id: string, title: string|null, completedAt: number, unread: boolean, changeAt: number}>|null}
 */
export function parseState(raw) {
  if (!isRecord(raw) || raw.version !== STATE_VERSION || !Array.isArray(raw.tasks)) return null;
  const out = [];
  for (const task of raw.tasks) {
    if (!isRecord(task)) continue;
    const id = normalizeId(task.id);
    if (!id) continue;
    out.push({
      id,
      title: sanitizeText(task.title, LIMITS.maxTitle) || null,
      completedAt: Number.isFinite(task.completedAt) ? task.completedAt : 0,
      unread: task.unread === true,
      changeAt: Number.isFinite(task.changeAt) ? task.changeAt : 0,
    });
  }
  return out;
}

/**
 * 任务状态转移：运行状态翻转时推进时间戳并标记未读。
 *
 * 一次运行状态的翻转意味着上一轮已经收口：任何挂在旧轮次上的「等待用户输入」
 * 都不再可信，必须一起清掉，否则会留下永远不亮的死状态。
 * @param {{running: boolean, needsInput?: boolean, inputKind?: string|null, startedAt: number, completedAt: number, unread: boolean, changeAt: number}} task 任务
 * @param {boolean} running 事件里的运行状态
 * @param {number} now 当前时间
 * @returns {{changed: boolean, completed: boolean}}
 */
export function transitionTask(task, running, now) {
  const isRunning = running === true;
  if (task.running === isRunning) return { changed: false, completed: false };
  task.running = isRunning;
  task.needsInput = false;
  task.inputKind = null;
  if (isRunning) {
    task.startedAt = now;
    task.completedAt = 0;
    task.changeAt = now;
    return { changed: true, completed: false };
  }
  task.completedAt = now;
  task.unread = true;
  task.changeAt = now;
  return { changed: true, completed: true };
}

/**
 * 面板/长轮询返回的 JSON 体。
 * @param {{rev: number, now: number, settings: object, tasks: object[]}} input 输入
 * @returns {object}
 */
export function statePayload(input) {
  return {
    rev: input.rev,
    now: input.now,
    settings: input.settings,
    tasks: input.tasks,
  };
}

/* ------------------------------------------------------------------ */
/* 宿主侧文案（系统通知兜底用，跟随页面语言）                          */
/* ------------------------------------------------------------------ */

const HOST_MESSAGES = Object.freeze({
  zh: {
    unnamed: "未命名会话",
    completed: (title) => `${title} 已完成`,
    test: (title) => `测试通知 · 看到「${title}」说明系统通知已连通`,
    testTitle: "任务通知台自检",
  },
  en: {
    unnamed: "Untitled session",
    completed: (title) => `${title} — done`,
    test: (title) => `Test notification · seeing "${title}" means system notifications work`,
    testTitle: "Task Notifier self-test",
  },
});

/**
 * 归一化语言标签：只支持本插件提供文案的 zh / en。
 * @param {unknown} value 语言标签
 * @returns {"zh"|"en"}
 */
export function normalizeLocale(value) {
  const tag = typeof value === "string" ? value.trim().toLowerCase() : "";
  return tag.startsWith("en") ? "en" : "zh";
}

/**
 * 取宿主侧文案表。
 * @param {unknown} locale 语言标签
 * @returns {{unnamed: string, completed: (title: string) => string, test: (title: string) => string, testTitle: string}}
 */
export function hostMessages(locale) {
  return HOST_MESSAGES[normalizeLocale(locale)];
}
