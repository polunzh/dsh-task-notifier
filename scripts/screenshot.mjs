#!/usr/bin/env node
/**
 * dsh-task-notifier · 预览截图（Chrome headless + CDP）
 *
 *   node scripts/screenshot.mjs        # 生成 5 张，失败非 0 退出
 *   node scripts/screenshot.mjs --keep # 保留服务器 / Chrome / 临时目录（调试用）
 *
 * 输出：preview/screenshots/
 *   panel-light.png    1440×900  ?state=filled&theme=light
 *   panel-dark.png     1440×900  ?state=filled&theme=dark
 *   panel-light-en.png 1440×900  ?state=filled&theme=light&locale=en （英文界面）
 *   unread-tab.png     1440×900  ?state=filled&theme=light&tab=unread&focus=tab
 *   needs-input.png    1440×900  ?state=filled&theme=light&tab=input （待回复分类）
 *   empty.png          1440×900  ?state=empty&theme=light
 *   mobile.png          390×844  ?state=filled&theme=light
 *
 * 截图里不允许出现预览调试信息（顶部状态 chip / 底部署名）：index.html 默认
 * 隐藏它们，只有 ?debug=1 才显示；captureShot 会额外断言两者不可见。
 *
 * 为什么用 CDP 而不是 `--screenshot`：
 *   - 要等页面自己把 document.documentElement.dataset.ready 置成 "1"
 *     且 window.__previewReady === true（mock 数据异步灌入后才会置位）；
 *   - 要读取 DOM 校验「任务面板 / 4 个 Tab / 任务行 / 侧栏图标」真的渲染了，
 *     失败时给出可读报错并非 0 退出；
 *   - 要收集页面未捕获异常。
 *
 * 不依赖网络：预览页的 fetch 桩拦下全部 /task-notifier/api/* 请求；
 * React / ReactDOM 来自 preview/vendor/ 下的本地 UMD。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const root = join(here, "..");
const outDir = join(root, "preview", "screenshots");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const keepAlive = process.argv.includes("--keep");
const settleMs = 1100;
const minPngBytes = 20 * 1024;

const shots = [
  {
    name: "panel-light",
    width: 1440,
    height: 900,
    theme: "light",
    kind: "filled",
    url: "?state=filled&theme=light",
    narrative: "浅色 · 已完成未读（默认 Tab）",
  },
  {
    name: "panel-dark",
    width: 1440,
    height: 900,
    theme: "dark",
    kind: "filled",
    url: "?state=filled&theme=dark",
    narrative: "深色 · 已完成未读（默认 Tab）",
  },
  {
    name: "panel-light-en",
    width: 1440,
    height: 900,
    theme: "light",
    kind: "filled",
    locale: "en",
    url: "?state=filled&theme=light&locale=en",
    narrative: "浅色 · 英文界面（?locale=en）",
  },
  {
    name: "unread-tab",
    width: 1440,
    height: 900,
    theme: "light",
    kind: "filled",
    url: "?state=filled&theme=light&tab=unread&focus=tab",
    narrative: "浅色 · 已完成未读 Tab 聚焦",
  },
  {
    name: "needs-input",
    width: 1440,
    height: 900,
    theme: "light",
    kind: "filled",
    url: "?state=filled&theme=light&tab=input",
    narrative: "浅色 · 待回复 Tab（有人在等你回答）",
    rowText: "确认是否覆盖线上数据",
  },
  {
    name: "empty",
    width: 1440,
    height: 900,
    theme: "light",
    kind: "empty",
    url: "?state=empty&theme=light",
    narrative: "浅色 · 空状态",
  },
  {
    name: "mobile",
    width: 390,
    height: 844,
    theme: "light",
    kind: "filled",
    mobile: true,
    url: "?state=filled&theme=light",
    narrative: "窄屏 390×844 · 侧栏收成图标轨",
  },
];

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(message) {
  console.log(`[screenshot] ${message}`);
}

function fail(message) {
  console.error(`[screenshot] 失败：${message}`);
  process.exitCode = 1;
}

// ---------------------------------------------------------------- 预览服务器

async function startServer() {
  const child = spawn(process.execPath, [join(root, "preview", "server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk) => {
    output += chunk.toString();
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);

  const deadline = Date.now() + 20_000;
  let match = null;
  while (Date.now() < deadline) {
    match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\//);
    if (match) break;
    if (child.exitCode !== null) break;
    await sleep(100);
  }
  if (!match) {
    child.kill("SIGKILL");
    throw new Error(`预览服务器没有在 20s 内启动：\n${output}`);
  }
  return { child, baseUrl: `http://127.0.0.1:${match[1]}/`, getOutput: () => output };
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null) return;
  server.child.kill("SIGINT");
  const deadline = Date.now() + 3000;
  while (server.child.exitCode === null && Date.now() < deadline) await sleep(50);
  if (server.child.exitCode === null) server.child.kill("SIGKILL");
}

// ---------------------------------------------------------------- Chrome / CDP

function launchChrome(userDataDir) {
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      // 在当前沙箱环境里 Chrome 自己的沙箱 / GPU / crashpad 初始化会失败，
      // 导致 GPU 进程退出、浏览器被 FATAL 关掉。截图是本地静态页，关掉即可。
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-gpu",
      "--disable-gpu-sandbox",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
      "--disable-breakpad",
      "--disable-crash-reporter",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-sync",
      "--mute-audio",
      "--remote-allow-origins=*",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  return { child, getStderr: () => stderr };
}

async function waitForDevToolsPort(userDataDir, timeoutMs = 15_000) {
  const portFile = join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(portFile)) {
      try {
        const [port, path] = readFileSync(portFile, "utf8").trim().split("\n");
        if (port && path) return { port: Number(port), path };
      } catch {
        /* 文件还没写完，继续等 */
      }
    }
    await sleep(80);
  }
  throw new Error(`Chrome 没有在 ${timeoutMs}ms 内打开 DevTools 端口`);
}

/** 极简 CDP 客户端（Node 24 自带 WebSocket）。 */
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
  }

  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 Chrome DevTools WebSocket 超时")), 10_000);
      this.ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener("error", (event) => {
        clearTimeout(timer);
        reject(new Error(`Chrome DevTools WebSocket 错误：${event?.message ?? "unknown"}`));
      });
    });
    this.ws.addEventListener("message", (event) => this.#onMessage(event));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("CDP 连接已关闭"));
      this.pending.clear();
    });
    return this;
  }

  #onMessage(event) {
    let message;
    try {
      message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
    } catch {
      return;
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) reject(new Error(`${message.error.message}（${message.error.code}）`));
      else resolve(message.result);
      return;
    }
    const handlers = this.handlers.get(message.method);
    if (handlers) for (const handler of handlers) handler(message.params, message.sessionId);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
    return () => {
      const list = this.handlers.get(method) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    };
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

/** 采集页面未捕获异常 / console.error，供失败诊断。 */
function attachPageDiagnostics(cdp, sessionId, errors) {
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params?.exceptionDetails ?? {};
    const text = details.exception?.description ?? details.text ?? "未知异常";
    errors.push(`未捕获异常：${text}`);
  });
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params?.type !== "error" && params?.type !== "assert") return;
    const text = (params.args ?? [])
      .map((arg) => arg?.value ?? arg?.description ?? arg?.unserializableValue ?? "")
      .join(" ");
    errors.push(`console.${params.type}: ${text}`);
  });
  cdp.on("Log.entryAdded", (params) => {
    if (params?.entry?.level !== "error") return;
    errors.push(`log.error: ${params.entry.text}`);
  });
  return sessionId;
}

async function evaluate(cdp, sessionId, expression) {
  const result = await cdp.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: false, userGesture: true },
    sessionId,
  );
  if (result?.exceptionDetails) {
    const text = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
    throw new Error(`页面执行错误：${text}`);
  }
  return result?.result?.value;
}

async function waitForReady(cdp, sessionId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(
      cdp,
      sessionId,
      `({
        ready: document.documentElement.dataset.ready || null,
        reason: document.documentElement.dataset.readyReason || null,
        previewReady: window.__previewReady === true,
        error: window.__previewError || null,
        loadError: window.__previewLoadError ? String(window.__previewLoadError) : null,
        readyState: document.readyState
      })`,
    ).catch(() => null);
    if (last?.ready === "1" && last?.previewReady === true) return last;
    await sleep(120);
  }
  throw new Error(
    `页面没有在 ${timeoutMs}ms 内就绪（ready 标志未置位）。最后状态：${JSON.stringify(last)}`,
  );
}

async function inspectPage(cdp, sessionId) {
  return evaluate(
    cdp,
    sessionId,
    `(() => {
      const main = document.getElementById('main-slot');
      const root = main ? main.querySelector('.dtn-root') : null;
      const text = main ? (main.innerText || '').trim() : '';
      const rect = root ? root.getBoundingClientRect() : null;
      const tabs = Array.from(document.querySelectorAll('.dtn-tab')).map((node) => ({
        text: (node.textContent || '').trim(),
        active:
          node.getAttribute('aria-selected') === 'true' ||
          node.getAttribute('aria-current') === 'page',
        focused: document.activeElement === node,
      }));
      const rows = Array.from(document.querySelectorAll('.dtn-row')).map((node) => ({
        text: (node.innerText || '').trim().replace(/\\s+/g, ' '),
      }));
      const head = document.querySelector('.dtn-head');
      const search = document.querySelector('.dtn-root input');
      const active = document.activeElement;
      const visible = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return false;
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1;
      };
      return {
        ready: document.documentElement.dataset.ready || null,
        reason: document.documentElement.dataset.readyReason || null,
        previewError: window.__previewError || null,
        theme: document.documentElement.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
        previewInfo: window.__previewInfo || null,
        stateLabel: (document.getElementById('preview-state') || {}).textContent || '',
        textLength: text.length,
        textSample: text.slice(0, 420),
        tabs,
        rows,
        sidebarIcon: !!document.querySelector('#sidebar-slot svg'),
        sidebarBadge: !!document.querySelector('#sidebar-slot svg text'),
        panelHeight: rect ? Math.round(rect.height) : 0,
        panelWidth: rect ? Math.round(rect.width) : 0,
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        searchPlaceholder: search ? search.getAttribute('placeholder') : null,
        headText: head ? (head.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 500) : '',
        activeElement: active ? (active.tagName + '.' + String(active.className || '')).slice(0, 120) : null,
        focusVisible: active ? active.matches(':focus-visible') : false,
        bodyText: (document.body.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 1200),
        navLabel: (document.getElementById('nav-label') || {}).textContent || '',
        mainTitle: (document.getElementById('main-title') || {}).textContent || '',
        debugChipVisible: visible('.main-hint'),
        footerVisible: visible('.sidebar-foot'),
        debugFlag: document.documentElement.dataset.previewDebug || null,
      };
    })()`,
  );
}

/** 从 PNG 头读宽高（IHDR 前 24 字节），不依赖 sips。 */
function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") {
    throw new Error("输出不是合法 PNG（缺少 PNG magic）");
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function validateShot(shot, info) {
  const problems = [];
  const isEnglish = shot.locale === "en";
  const expectedLocale = isEnglish ? "en-US" : "zh-CN";
  if (info.previewError) problems.push(`页面报告 __previewError：${info.previewError}`);
  if (info.ready !== "1") problems.push(`ready 标志未置位（${info.ready}）`);
  if (info.theme !== shot.theme) problems.push(`主题不符：期望 ${shot.theme}，实际 ${info.theme}`);
  if (info.previewInfo?.locale !== expectedLocale) {
    problems.push(`界面语言不符：期望 ${expectedLocale}，实际 ${info.previewInfo?.locale}`);
  }

  // 标题 / Tab / 按钮 / 搜索框：按语言断言，防止中英文串台。
  const title = isEnglish ? "Tasks" : "任务面板";
  if (!info.textSample.includes(title)) {
    problems.push(`主区域没有出现标题「${title}」（locale=${info.previewInfo?.locale ?? "?"}）`);
  }
  const expectedTabs = isEnglish
    ? ["Needs input", "Unread", "Running", "Completed", "All"]
    : ["待回复", "已完成未读", "运行中", "已完成", "全部"];
  if (info.tabs.length !== 5) {
    problems.push(`Tab 数量异常：期望 5，实际 ${info.tabs.length}（${info.tabs.map((t) => t.text).join(" / ")}）`);
  } else {
    for (const label of expectedTabs) {
      if (!info.tabs.some((tab) => tab.text.startsWith(label))) {
        problems.push(`缺少 Tab「${label}」（实际：${info.tabs.map((t) => t.text).join(" / ")}）`);
      }
    }
    if (!info.tabs.some((tab) => tab.active)) problems.push("没有选中的 Tab（aria-selected=true）");
  }
  const expectedButtons = isEnglish
    ? ["Browser notifications", "Preview chime", "Send test notification"]
    : ["浏览器通知", "试听提示音", "试发系统通知"];
  if (shot.kind === "filled") {
    expectedButtons.push(isEnglish ? "Mark all read (3)" : "全部标为已读");
  }
  for (const label of expectedButtons) {
    if (!info.headText.includes(label)) {
      problems.push(`顶部按钮缺少「${label}」（实际：${info.headText.slice(0, 240)}）`);
    }
  }
  const searchPlaceholder = isEnglish ? "Search by title" : "按标题搜索";
  if (!info.searchPlaceholder || !info.searchPlaceholder.includes(searchPlaceholder)) {
    problems.push(`搜索框占位符异常：${JSON.stringify(info.searchPlaceholder)}`);
  }
  if (!info.sidebarIcon) problems.push("侧栏 sidebar.panellist 图标没有渲染");
  if (shot.kind === "filled" && info.rows.length < 1) {
    problems.push(`任务列表为空（期望至少 1 行）：${JSON.stringify(info.textSample.slice(0, 160))}`);
  }
  if (shot.rowText && !info.rows.some((row) => row.text.includes(shot.rowText))) {
    problems.push(`任务行缺少「${shot.rowText}」：${JSON.stringify(info.rows.map((row) => row.text).slice(0, 4))}`);
  }
  if (shot.kind === "filled" && isEnglish && !info.rows.some((row) => row.text.includes("Done ·"))) {
    problems.push(`英文任务行没有出现「Done ·」：${JSON.stringify(info.rows.map((r) => r.text).slice(0, 3))}`);
  }
  if (shot.kind === "empty") {
    if (info.rows.length !== 0) problems.push(`空状态却渲染了 ${info.rows.length} 行任务`);
    if (!info.textSample.includes("没有未读的已完成任务")) problems.push("空状态文案没有出现");
  }
  if (info.panelHeight < 300) problems.push(`面板高度异常（${info.panelHeight}px），可能没有渲染`);
  if (info.scrollWidth > info.clientWidth + 2) {
    problems.push(`检测到横向溢出：scrollWidth=${info.scrollWidth} > clientWidth=${info.clientWidth}`);
  }

  // README / marketplace 截图不能出现预览调试信息。
  if (info.debugFlag === "1") problems.push("页面处于 ?debug=1 模式，调试信息不应出现在截图里");
  if (info.debugChipVisible) problems.push("顶部预览状态 chip（.main-hint）仍然可见");
  if (info.footerVisible) problems.push("底部预览署名（.sidebar-foot）仍然可见");
  if (info.bodyText.includes("本地预览") || info.bodyText.includes("Local preview")) {
    problems.push("页面文本里仍包含「本地预览 / Local preview」调试文案");
  }
  if (info.bodyText.includes("mock 数据 ·") || info.bodyText.includes("mock data ·")) {
    problems.push("页面文本里仍包含「mock 数据 / mock data」调试文案");
  }
  return problems;
}

async function captureShot(cdp, shot, baseUrl, pageErrors) {
  const errors = [];
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  attachPageDiagnostics(cdp, sessionId, errors);
  try {
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    await cdp.send("Log.enable", {}, sessionId);
    await cdp.send(
      "Emulation.setDeviceMetricsOverride",
      {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: 1,
        mobile: shot.mobile === true,
      },
      sessionId,
    );

    const url = new URL(shot.url, baseUrl).href;
    log(`打开 ${shot.name}: ${url} (${shot.width}×${shot.height})`);
    await cdp.send("Page.navigate", { url }, sessionId);

    // 等页面生命周期 + preview 的 ready 标志。
    await sleep(120);
    const readyInfo = await waitForReady(cdp, sessionId, 25_000);
    if (readyInfo.error) throw new Error(`页面报告 __previewError：${readyInfo.error}`);
    if (readyInfo.loadError) throw new Error(`页面报告 __previewLoadError：${readyInfo.loadError}`);

    // 留一点时间让 pollLoop 完成一次刷新、字体落定。
    await sleep(settleMs);

    const info = await inspectPage(cdp, sessionId);
    const problems = validateShot(shot, info);
    if (problems.length > 0) {
      throw new Error(`页面校验未通过：\n  - ${problems.join("\n  - ")}\n  页面状态：${JSON.stringify(info, null, 2).slice(0, 2400)}`);
    }

    if (errors.length > 0) {
      const fatal = errors.filter((item) => item.startsWith("未捕获异常"));
      if (fatal.length > 0) throw new Error(`页面抛出未捕获异常：\n${fatal.join("\n")}`);
      pageErrors.push(...errors.map((item) => `${shot.name}: ${item}`));
    }

    const { data } = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true }, sessionId);
    const buffer = Buffer.from(data, "base64");
    const dimensions = pngDimensions(buffer);
    if (dimensions.width !== shot.width || dimensions.height !== shot.height) {
      throw new Error(
        `截图尺寸不符：期望 ${shot.width}×${shot.height}，实际 ${dimensions.width}×${dimensions.height}`,
      );
    }
    if (buffer.length < minPngBytes) {
      throw new Error(`截图疑似空白：${buffer.length} 字节 < ${minPngBytes} 字节下限`);
    }

    const file = join(outDir, `${shot.name}.png`);
    writeFileSync(file, buffer);

    const result = {
      file,
      bytes: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
      ready: info.reason ?? readyInfo.reason,
      theme: info.theme,
      tabs: info.tabs.length,
      rows: info.rows.length,
      textLength: info.textLength,
      notificationPermission: info.previewInfo?.notificationPermission ?? null,
      focusedTab: info.tabs.find((tab) => tab.focused)?.text ?? null,
      state: info.stateLabel,
      consoleErrors: errors.length,
    };
    log(
      `✓ ${shot.name}.png（${Math.round(result.bytes / 1024)} kB，${result.width}×${result.height}，` +
        `tabs=${result.tabs}，rows=${result.rows}，text=${result.textLength}，theme=${result.theme}）`,
    );
    return result;
  } finally {
    await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
  }
}

// ---------------------------------------------------------------- main

async function main() {
  if (!existsSync(CHROME)) {
    throw new Error(`找不到 Chrome：${CHROME}`);
  }
  mkdirSync(outDir, { recursive: true });

  for (const shot of shots) {
    const existing = join(outDir, `${shot.name}.png`);
    if (existsSync(existing)) unlinkSync(existing);
  }

  let server;
  let profileDir;
  let chrome;
  let cdp;
  const pageErrors = [];
  let results = [];
  try {
    log("启动预览服务器…");
    server = await startServer();
    log(`服务器就绪：${server.baseUrl}`);

    profileDir = join(tmpdir(), `dsh-task-notifier-shot-${process.pid}`);
    rmSync(profileDir, { recursive: true, force: true });
    mkdirSync(profileDir, { recursive: true });
    log("启动 Chrome headless…");
    chrome = launchChrome(profileDir);
    const { port, path } = await waitForDevToolsPort(profileDir);
    cdp = await new Cdp(`ws://127.0.0.1:${port}${path}`).open();

    // 给预览页一份「浏览器通知」权限，让头部显示「已开启」而不是「被拒绝」。
    // 失败也不致命（头部会如实显示当前权限）。
    const origin = new URL(server.baseUrl).origin;
    try {
      await cdp.send("Browser.grantPermissions", { origin, permissions: ["notifications"] });
      log(`已授予 ${origin} 通知权限（用于截图里的「浏览器通知：已开启」）`);
    } catch (error) {
      log(`授予通知权限失败（继续）：${error?.message ?? error}`);
    }

    for (const shot of shots) {
      results.push(await captureShot(cdp, shot, server.baseUrl, pageErrors));
    }

    log("");
    log(`已生成 ${results.length} 张截图 → preview/screenshots/`);
    for (const result of results) {
      log(
        `  ${result.file}  ${Math.round(result.bytes / 1024)} kB  ${result.width}×${result.height}  ` +
          `theme=${result.theme} tabs=${result.tabs} rows=${result.rows}`,
      );
    }
    if (pageErrors.length > 0) {
      log("");
      log("页面 console.error / log.error（不致命，供排查）：");
      for (const error of pageErrors.slice(0, 20)) log(`  - ${error}`);
    }
  } finally {
    if (cdp) {
      await cdp.send("Browser.close").catch(() => {});
      cdp.close();
      await sleep(200);
    }
    if (chrome && chrome.child.exitCode === null) chrome.child.kill("SIGKILL");
    if (chrome?.getStderr && process.exitCode) {
      const stderr = chrome.getStderr().trim();
      if (stderr) console.error(`[screenshot] Chrome stderr（尾部）：\n${stderr.split("\n").slice(-8).join("\n")}`);
    }
    if (!keepAlive) {
      await stopServer(server);
      if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    }
    if (server && process.exitCode) {
      console.error(`[screenshot] 服务器输出（尾部）：\n${server.getOutput().split("\n").slice(-12).join("\n")}`);
    }
  }
}

main().catch((error) => {
  fail(error?.stack ?? String(error));
});
