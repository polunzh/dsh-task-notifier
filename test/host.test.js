import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { apply } from "../lib/index.js";

/**
 * 最小 ctx 替身：只实现 apply 真正用到的成员。
 * @param {{connection?: unknown, config?: object, sessionQuery?: object}} [options] 覆盖项
 * @returns {{ctx: object, handlers: Map<string, Function>, call: Function, effectCount: number}}
 */
function createHarness(options = {}) {
  const handlers = new Map();
  const registrations = [];
  const effects = [];
  // 每个 harness 用独立的 DSH_HOME：插件现在会在 apply 时读取持久化状态，
  // 共享目录会让前一个用例的任务泄漏到下一个用例。
  const home = options.home ?? mkdtempSync(join(tmpdir(), "dtn-host-test-"));
  homes.push(home);
  process.env.DSH_HOME = home;
  const ctx = {
    logger: { debug() {}, info() {}, warn() {} },
    connection: "connection" in options ? options.connection : { requestRejection: () => undefined },
    sessionQuery: options.sessionQuery,
    on(name, handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    effect(callback) {
      effects.push(callback());
      return () => {};
    },
    webServer: {
      register(registration) {
        registrations.push(registration);
        return () => {};
      },
    },
  };
  // osNotify: "off" 保证测试永远不会真的 spawn osascript 弹系统通知
  apply(ctx, options.config ?? { osNotify: "off" });

  async function call({ method = "GET", url = "/task-notifier/api/state", headers = {}, body } = {}) {
    const payload = body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))];
    const req = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() {
        for (const chunk of payload) yield chunk;
      },
    };
    const out = { status: 0, headers: {}, body: "" };
    const res = {
      writeHead(status, responseHeaders = {}) {
        out.status = status;
        Object.assign(out.headers, responseHeaders);
      },
      end(value) {
        out.body = value === undefined ? "" : String(value);
      },
    };
    await registrations[0].handler(req, res);
    return { status: out.status, headers: out.headers, json: out.body ? JSON.parse(out.body) : null };
  }

  return { ctx, handlers, call, registrations, home };
}

const previousHome = process.env.DSH_HOME;
const homes = [];

test.after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const JSON_HEADERS = { "content-type": "application/json" };

test("连接守卫缺失时 fail-closed（503），不暴露任何数据", async () => {
  const harness = createHarness({ connection: undefined });
  for (const request of [
    { method: "GET", url: "/task-notifier/api/state" },
    { method: "GET", url: "/task-notifier/api/wait?rev=0" },
    { method: "POST", url: "/task-notifier/api/read", headers: JSON_HEADERS, body: { all: true } },
  ]) {
    const response = await harness.call(request);
    assert.equal(response.status, 503);
    assert.equal(response.json.error, "no-connection-guard");
    assert.equal(response.json.tasks, undefined);
  }
});

test("宿主守卫拒绝时透传状态码", async () => {
  const harness = createHarness({ connection: { requestRejection: () => 403 } });
  const response = await harness.call({ method: "GET", url: "/task-notifier/api/state" });
  assert.equal(response.status, 403);
});

test("写接口只接受 application/json", async () => {
  const harness = createHarness();
  const response = await harness.call({
    method: "POST",
    url: "/task-notifier/api/read",
    headers: { "content-type": "text/plain" },
    body: { all: true },
  });
  assert.equal(response.status, 415);
});

test("GET /state 返回任务表与设置，并带安全响应头", async () => {
  const harness = createHarness({ config: { osNotify: "off", sound: false } });
  const response = await harness.call();
  assert.equal(response.status, 200);
  assert.equal(response.json.settings.sound, false);
  assert.equal(response.json.settings.osNotify, "off");
  assert.ok(Array.isArray(response.json.tasks));
  assert.equal(response.headers["X-Content-Type-Options"], "nosniff");
  assert.equal(response.headers["Cache-Control"], "no-store");
});

test("未知路径与错误方法返回 404", async () => {
  const harness = createHarness();
  assert.equal((await harness.call({ url: "/task-notifier/api/nope" })).status, 404);
  assert.equal((await harness.call({ method: "POST", url: "/task-notifier/api/state", headers: JSON_HEADERS, body: {} })).status, 404);
});

test("任务完成事件会置未读、写入 0600 状态文件，removed 后消失", async () => {
  const harness = createHarness();
  const status = harness.handlers.get("api-session/status");
  const added = harness.handlers.get("api-session/added");
  const removed = harness.handlers.get("api-session/removed");
  assert.equal(typeof status, "function");

  added({ id: "sess-1", title: "重构通知去重逻辑" });
  status("sess-1", true);
  status("sess-1", false);

  const state = await harness.call();
  const task = state.json.tasks.find((item) => item.id === "sess-1");
  assert.ok(task, "任务应出现在任务表里");
  assert.equal(task.unread, true);
  assert.equal(task.running, false);
  assert.equal(task.title, "重构通知去重逻辑");

  await new Promise((resolve) => setTimeout(resolve, 800));
  const file = join(harness.home, "storages", "dsh-task-notifier", "state.json");
  const fileStat = statSync(file);
  assert.equal(fileStat.mode & 0o777, 0o600, "状态文件必须只有属主可读写");
  const dirStat = statSync(join(harness.home, "storages", "dsh-task-notifier"));
  assert.equal(dirStat.mode & 0o777, 0o700, "状态目录必须只有属主可进入");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);

  removed("sess-1");
  const after = await harness.call();
  assert.equal(after.json.tasks.find((item) => item.id === "sess-1"), undefined);
});

test("启动时恢复持久化的未读任务与标题", async () => {
  const home = mkdtempSync(join(tmpdir(), "dtn-host-seed-"));
  const dir = join(home, "storages", "dsh-task-notifier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      version: 1,
      savedAt: 1,
      tasks: [{ id: "sess-restored", title: "上次完成的任务", completedAt: 10, unread: true, changeAt: 10 }],
    }),
  );

  const harness = createHarness({ home });
  const state = await harness.call();
  const task = state.json.tasks.find((item) => item.id === "sess-restored");
  assert.ok(task, "重启后未读快照必须恢复");
  assert.equal(task.title, "上次完成的任务");
  assert.equal(task.unread, true);
  assert.equal(task.running, false);
  assert.equal(task.needsInput, false);
});

test("启动时从 sessionQuery 预热 live 会话标题", async () => {
  const records = [
    { header: { id: "sess-live", createdAt: 1 }, live: true, persisted: true },
    { header: { id: "sess-cold", createdAt: 2 }, live: false, persisted: true },
  ];
  const seen = [];
  let resolveTitles;
  const titlesRead = new Promise((resolve) => {
    resolveTitles = resolve;
  });
  const sessionQuery = {
    async listSessions() {
      return records;
    },
    async readTitleSnapshots(ids) {
      seen.push(...ids);
      resolveTitles();
      return [{ status: "fulfilled", value: { session: { id: "sess-live" }, title: { title: "启动预热标题" } } }];
    },
  };

  const harness = createHarness({ sessionQuery });
  await titlesRead;
  // 让 seedFromSessionQuery 的 await 链把标题写回任务表
  await new Promise((resolve) => setTimeout(resolve, 10));
  const state = await harness.call();
  const task = state.json.tasks.find((item) => item.id === "sess-live");
  assert.ok(task, "live 会话应在启动时预热进任务表");
  assert.equal(task.title, "启动预热标题");
  assert.deepEqual(seen, ["sess-live"], "只为 live 会话读取标题快照");
  assert.equal(state.json.tasks.find((item) => item.id === "sess-cold"), undefined, "历史会话不预热");
});

test("启动时补齐持久化任务里缺失的标题", async () => {
  const home = mkdtempSync(join(tmpdir(), "dtn-host-heal-"));
  const dir = join(home, "storages", "dsh-task-notifier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      version: 1,
      savedAt: 1,
      tasks: [{ id: "sess-old", title: null, completedAt: 10, unread: true, changeAt: 10 }],
    }),
  );

  let readIds = null;
  let resolveRead;
  const readStarted = new Promise((resolve) => {
    resolveRead = resolve;
  });
  const sessionQuery = {
    async listSessions() {
      return [];
    },
    async readTitleSnapshots(ids) {
      readIds = ids;
      resolveRead();
      return [{ status: "fulfilled", value: { title: { title: "从日志补回的标题" } } }];
    },
  };

  const harness = createHarness({ home, sessionQuery });
  await readStarted;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(readIds, ["sess-old"], "缺标题的持久化任务也要读快照");
  const task = (await harness.call()).json.tasks.find((item) => item.id === "sess-old");
  assert.equal(task.title, "从日志补回的标题");
});

test("session/title 事件在轮次进行中就更新标题", async () => {
  const harness = createHarness();
  harness.handlers.get("api-session/status")("sess-title", true);
  let task = (await harness.call()).json.tasks.find((item) => item.id === "sess-title");
  assert.equal(task.title, null, "状态事件本身不带标题");

  harness.handlers.get("session/event")(
    { id: "sess-title" },
    { type: "session/title", data: { title: "首轮提示生成的标题" } },
  );
  task = (await harness.call()).json.tasks.find((item) => item.id === "sess-title");
  assert.equal(task.title, "首轮提示生成的标题");
});

test("api-session/added 的 projections.values.title 也能取到标题", async () => {
  const harness = createHarness();
  harness.handlers.get("api-session/added")({
    sessionId: "sess-projection",
    projections: { kind: "sequenced", asOfSeq: 3, values: { title: "投影里的标题" } },
  });
  const task = (await harness.call()).json.tasks.find((item) => item.id === "sess-projection");
  assert.ok(task);
  assert.equal(task.title, "投影里的标题");
});

test("阻塞提问、计划审阅与审批会标记「需要输入」，并在落地后清除", async () => {
  const harness = createHarness();
  const onEvent = harness.handlers.get("session/event");
  const status = harness.handlers.get("api-session/status");
  assert.equal(typeof onEvent, "function", "应订阅 session/event 观察等待状态");
  harness.handlers.get("api-session/added")({ id: "sess-need-1", title: "确认是否覆盖线上数据" });
  status("sess-need-1", true);

  const read = async () => (await harness.call()).json.tasks.find((item) => item.id === "sess-need-1");

  onEvent(
    { id: "sess-need-1" },
    { type: "tool/call", data: { name: "ask_user_question", callId: "call-q1", arguments: "{}" } },
  );
  let task = await read();
  assert.equal(task.needsInput, true);
  assert.equal(task.inputKind, "question");
  assert.equal(task.running, true);

  // 定时提问超时 / 作答后都会有 tool/result，两种情况下都不再阻塞。
  onEvent({ id: "sess-need-1" }, { type: "tool/result", data: { message: { toolCallId: "call-q1", content: [] } } });
  task = await read();
  assert.equal(task.needsInput, false);
  assert.equal(task.inputKind, null);

  onEvent({ id: "sess-need-1" }, { type: "tool/call", data: { name: "exit_plan_mode", callId: "call-p1" } });
  task = await read();
  assert.equal(task.needsInput, true);
  assert.equal(task.inputKind, "plan");

  onEvent({ id: "sess-need-1" }, { type: "approval/asked", data: { id: "ap-1", toolName: "bash" } });
  task = await read();
  assert.equal(task.inputKind, "approval", "审批优先于计划审阅");

  onEvent({ id: "sess-need-1" }, { type: "approval/decided", data: { id: "ap-1", outcome: "rejected" } });
  task = await read();
  assert.equal(task.inputKind, "plan", "审批落地后回到仍在等待的计划审阅");

  onEvent({ id: "sess-need-1" }, { type: "turn/end", data: { turn: 1, reason: "completed" } });
  task = await read();
  assert.equal(task.needsInput, false);
  assert.equal(task.inputKind, null);

  // 轮次翻转是兜底：旧轮次上的等待不能跨轮次残留。
  onEvent({ id: "sess-need-1" }, { type: "tool/call", data: { name: "ask_user_question", callId: "call-q2" } });
  assert.equal((await read()).needsInput, true);
  status("sess-need-1", false);
  task = await read();
  assert.equal(task.needsInput, false);
  assert.equal(task.running, false);
});

test("只有阻塞工具才标记需要输入，脏事件不会凭空造任务", async () => {
  const harness = createHarness();
  const onEvent = harness.handlers.get("session/event");
  const before = (await harness.call()).json.tasks.length;

  onEvent({ id: "sess-noise" }, { type: "tool/call", data: { name: "bash", callId: "call-x" } });
  onEvent({ id: "sess-noise" }, { type: "tool/call", data: { name: "ask_user_question" } });
  onEvent({ id: "" }, { type: "approval/asked", data: { id: "ap-x" } });
  onEvent({ id: "sess-noise" }, { type: "tool/result", data: {} });
  onEvent({ id: "sess-noise" }, null);

  const after = (await harness.call()).json.tasks;
  assert.equal(after.length, before, "非等待事件不应造出任务");
  assert.equal(after.find((item) => item.id === "sess-noise"), undefined);
});

test("等待输入的任务即便还没有 added 事件也能进入任务表", async () => {
  const harness = createHarness();
  const onEvent = harness.handlers.get("session/event");
  onEvent("sess-need-2", { type: "approval/asked", data: { id: "ap-2", toolName: "bash" } });
  const task = (await harness.call()).json.tasks.find((item) => item.id === "sess-need-2");
  assert.ok(task);
  assert.equal(task.needsInput, true);
  assert.equal(task.inputKind, "approval");
});

test("标题在入库前被净化与截断（控制字符/换行/超长）", async () => {
  const harness = createHarness();
  harness.handlers.get("api-session/added")({
    id: "sess-2",
    title: `换行\n标题\u0000注入${"长".repeat(400)}`,
  });
  const state = await harness.call();
  const task = state.json.tasks.find((item) => item.id === "sess-2");
  assert.ok(task);
  assert.equal(task.title.includes("\n"), false);
  assert.equal(task.title.includes("\u0000"), false);
  assert.ok(task.title.length <= 120);
});

test("非法会话 id 不会进入任务表", async () => {
  const harness = createHarness();
  harness.handlers.get("api-session/added")({ id: "", title: "x" });
  harness.handlers.get("api-session/added")({ id: "a\u0000b", title: "y" });
  harness.handlers.get("api-session/status")(null, true);
  const state = await harness.call();
  assert.equal(state.json.tasks.length, 0);
});

test("POST /read 支持按 id 与全部标记已读", async () => {
  const harness = createHarness();
  const status = harness.handlers.get("api-session/status");
  status("sess-3", true);
  status("sess-3", false);
  status("sess-4", true);
  status("sess-4", false);

  const one = await harness.call({
    method: "POST",
    url: "/task-notifier/api/read",
    headers: JSON_HEADERS,
    body: { ids: ["sess-3"] },
  });
  assert.equal(one.status, 200);
  assert.equal(one.json.tasks.find((item) => item.id === "sess-3").unread, false);
  assert.equal(one.json.tasks.find((item) => item.id === "sess-4").unread, true);

  const all = await harness.call({
    method: "POST",
    url: "/task-notifier/api/read",
    headers: JSON_HEADERS,
    body: { all: true },
  });
  assert.equal(all.json.tasks.every((item) => item.unread === false), true);
});

test("心跳记录语言，/test 回报 locale 并受冷却限制", async () => {
  const harness = createHarness({ config: { osNotify: "off" } });
  const beat = await harness.call({
    method: "POST",
    url: "/task-notifier/api/heartbeat",
    headers: JSON_HEADERS,
    body: { canNotify: true, locale: "en-US" },
  });
  assert.equal(beat.status, 200);
  assert.equal(beat.json.ok, true);

  const first = await harness.call({ method: "POST", url: "/task-notifier/api/test", headers: JSON_HEADERS, body: {} });
  assert.equal(first.status, 200);
  // osNotify=off 时不应真的发通知，但应说明原因
  assert.equal(first.json.ok, false);
  assert.equal(first.json.reason, "disabled");
  assert.equal(first.json.locale, "en");

  const second = await harness.call({ method: "POST", url: "/task-notifier/api/test", headers: JSON_HEADERS, body: {} });
  assert.equal(second.status, 429, "冷却期内必须拒绝，避免被反复触发刷屏");
});

test("写操作缺 application/json 会被 415 挡掉（客户端必须走 postJson）", async () => {
  const harness = createHarness({ config: { osNotify: "off" } });
  // 旧客户端「试发系统通知」就是裸 fetch POST，被这里挡下来后一直报发送失败
  const bare = await harness.call({ method: "POST", url: "/task-notifier/api/test", headers: {}, body: {} });
  assert.equal(bare.status, 415);
  const withJson = await harness.call({ method: "POST", url: "/task-notifier/api/test", headers: JSON_HEADERS, body: {} });
  assert.equal(withJson.status, 200);
});

test("osNotify=off 的 disabled 判定先于平台限制，各平台答案一致", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const harness = createHarness({ config: { osNotify: "off" } });
  try {
    // 非 macOS 上曾因先判平台而回报 unsupported-platform，让 CI（Linux）与本地结论不同。
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const response = await harness.call({ method: "POST", url: "/task-notifier/api/test", headers: JSON_HEADERS, body: {} });
    assert.equal(response.json.ok, false);
    assert.equal(response.json.reason, "disabled");
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
});

test("/notify 限流且只接受合法 id", async () => {
  const harness = createHarness({ config: { osNotify: "off" } });
  const first = await harness.call({
    method: "POST",
    url: "/task-notifier/api/notify",
    headers: JSON_HEADERS,
    body: { ids: ["a", "a", 1, "", "b"] },
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.requested, 2);
  const second = await harness.call({
    method: "POST",
    url: "/task-notifier/api/notify",
    headers: JSON_HEADERS,
    body: { ids: ["a"] },
  });
  assert.equal(second.status, 429);
});

test("超长请求体返回 413", async () => {
  const harness = createHarness();
  const response = await harness.call({
    method: "POST",
    url: "/task-notifier/api/read",
    headers: JSON_HEADERS,
    body: JSON.stringify({ ids: ["x".repeat(80 * 1024)] }),
  });
  assert.equal(response.status, 413);
});

test("长轮询在 rev 变化后立即返回", async () => {
  const harness = createHarness();
  const started = Date.now();
  const response = await harness.call({ method: "GET", url: "/task-notifier/api/wait?rev=0" });
  assert.equal(response.status, 200);
  assert.ok(Date.now() - started < 3_000);
  assert.equal(typeof response.json.rev, "number");

  // 挂起中的长轮询必须能被 rev 变化叫醒：等待器不能 unref，否则事件循环先空掉，
  // Promise 永远不结算（CI 上就是这么挂的）。
  const before = await harness.call({ method: "GET", url: "/task-notifier/api/state" });
  const waiting = harness.call({ method: "GET", url: `/task-notifier/api/wait?rev=${before.json.rev}` });
  await new Promise((resolve) => setTimeout(resolve, 60));
  const woke = Date.now();
  harness.handlers.get("api-session/status")("sess-wait", true);
  const woken = await waiting;
  assert.ok(woken.json.rev > before.json.rev, "rev 变化后必须换一个新 rev 返回");
  assert.ok(Date.now() - woke < 1_000, "应当在一次轮询间隔内被叫醒");
});

test("长轮询的等待器不能 unref（否则事件循环先空掉，Promise 永不结算）", () => {
  const source = readFileSync(new URL("../lib/index.js", import.meta.url), "utf8");
  const start = source.indexOf("function waitForRevision");
  const end = source.indexOf("function runTestNotification");
  assert.ok(start > 0 && end > start, "waitForRevision 应当还在");
  assert.equal(/\.unref\(/.test(source.slice(start, end)), false);
});

test("欠费收尾会标记中断、保持未读，并在重新开跑时清空", async () => {
  const harness = createHarness();
  const status = harness.handlers.get("api-session/status");
  const onEvent = harness.handlers.get("session/event");
  harness.handlers.get("api-session/added")({ id: "sess-quota", title: "跑一个长任务" });
  status("sess-quota", true);

  onEvent(
    { id: "sess-quota" },
    { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "QUOTA", message: "Insufficient balance" } } } },
  );
  status("sess-quota", false);

  let task = (await harness.call()).json.tasks.find((item) => item.id === "sess-quota");
  assert.equal(task.running, false);
  assert.equal(task.unread, true);
  assert.equal(task.interrupted, true);
  assert.equal(task.interruptedKind, "quota");
  assert.equal(task.interruptedMessage, "Insufficient balance");

  // 中断标记要进状态文件，重启后还能显示「欠费中断」
  await new Promise((resolve) => setTimeout(resolve, 800));
  const file = join(harness.home, "storages", "dsh-task-notifier", "state.json");
  const saved = JSON.parse(readFileSync(file, "utf8")).tasks.find((item) => item.id === "sess-quota");
  assert.equal(saved.interrupted, true);
  assert.equal(saved.interruptedKind, "quota");

  // 用户重新发消息开跑：中断状态必须被清掉，不能一直挂着欠费徽章
  status("sess-quota", true);
  task = (await harness.call()).json.tasks.find((item) => item.id === "sess-quota");
  assert.equal(task.running, true);
  assert.equal(task.interrupted, false);
  assert.equal(task.interruptedKind, null);
  assert.equal(task.interruptedMessage, null);
});

test("进程退出与崩溃恢复的收尾都按「退出中断」记录，主动停止不算", async () => {
  const harness = createHarness();
  const status = harness.handlers.get("api-session/status");
  const onEvent = harness.handlers.get("session/event");
  const read = async (id) => (await harness.call()).json.tasks.find((item) => item.id === id);

  status("sess-exit", true);
  onEvent({ id: "sess-exit" }, { type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } });
  status("sess-exit", false);
  let task = await read("sess-exit");
  assert.equal(task.interrupted, true);
  assert.equal(task.interruptedKind, "process_exit");
  assert.equal(task.interruptedMessage, null);
  assert.equal(task.unread, true);

  // 关闭进程时级联取消（disposed）同样算退出中断
  status("sess-disposed", true);
  onEvent({ id: "sess-disposed" }, { type: "turn/end", data: { turn: 2, reason: { kind: "aborted", reason: { kind: "disposed" } } } });
  status("sess-disposed", false);
  task = await read("sess-disposed");
  assert.equal(task.interrupted, true);
  assert.equal(task.interruptedKind, "process_exit");

  // 用户自己点停止：按正常收尾，不挂中断徽章
  status("sess-userstop", true);
  onEvent({ id: "sess-userstop" }, { type: "turn/end", data: { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } } });
  status("sess-userstop", false);
  task = await read("sess-userstop");
  assert.equal(task.interrupted, false);
  assert.equal(task.unread, true);

  // 正常完成也不能被误标成中断
  status("sess-ok", true);
  onEvent({ id: "sess-ok" }, { type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } });
  status("sess-ok", false);
  task = await read("sess-ok");
  assert.equal(task.interrupted, false);
});

test("重启时把上次仍在运行的任务补成退出中断", async () => {
  const home = mkdtempSync(join(tmpdir(), "dtn-host-interrupt-"));
  const dir = join(home, "storages", "dsh-task-notifier");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "state.json"),
    JSON.stringify({
      version: 1,
      savedAt: 100,
      tasks: [
        { id: "sess-was-running", title: "退出时还在跑", running: true, startedAt: 10, completedAt: 0, unread: false, changeAt: 20 },
        { id: "sess-was-done", title: "已经收过尾", running: false, completedAt: 30, unread: false, changeAt: 30 },
      ],
    }),
  );

  const harness = createHarness({ home });
  const tasks = (await harness.call()).json.tasks;
  const running = tasks.find((item) => item.id === "sess-was-running");
  assert.ok(running, "上次运行中的任务必须还在面板里");
  assert.equal(running.running, false);
  assert.equal(running.interrupted, true);
  assert.equal(running.interruptedKind, "process_exit");
  assert.equal(running.unread, true, "退出中断的任务要等用户查阅");
  assert.equal(running.completedAt > 0, true, "要有收尾时间，历史列表才有排序依据");

  const done = tasks.find((item) => item.id === "sess-was-done");
  assert.equal(done.interrupted, false);
  assert.equal(done.unread, false);
});

test("中断原因会被净化后再进任务表", async () => {
  const harness = createHarness();
  const onEvent = harness.handlers.get("session/event");
  harness.handlers.get("api-session/status")("sess-dirty", true);
  onEvent(
    { id: "sess-dirty" },
    { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "UNKNOWN", message: `炸弹\u0000\n${"长".repeat(400)}` } } } },
  );
  const task = (await harness.call()).json.tasks.find((item) => item.id === "sess-dirty");
  assert.equal(task.interruptedKind, "error");
  assert.equal(task.interruptedMessage.includes("\u0000"), false);
  assert.equal(task.interruptedMessage.includes("\n"), false);
  assert.ok(task.interruptedMessage.length <= 160);
});

test("会话级 Agent 失败也会标成中断（含欠费识别）", async () => {
  const harness = createHarness();
  const onError = harness.handlers.get("api-session/error");
  assert.equal(typeof onError, "function", "应订阅 api-session/error");

  harness.handlers.get("api-session/status")("sess-fatal", true);
  onError("sess-fatal", "Insufficient balance");
  let task = (await harness.call()).json.tasks.find((item) => item.id === "sess-fatal");
  assert.equal(task.interrupted, true);
  assert.equal(task.interruptedKind, "quota");
  assert.equal(task.interruptedMessage, "Insufficient balance");
  assert.equal(task.unread, true);
  assert.ok(task.completedAt > 0, "会话级失败也是一次收尾：客户端靠 completedAt 判断这是不是新结果");

  // 同一个错误反复上报不该重复算成新结果（否则会反复弹通知）
  const firstCompletedAt = task.completedAt;
  onError("sess-fatal", "Insufficient balance");
  task = (await harness.call()).json.tasks.find((item) => item.id === "sess-fatal");
  assert.equal(task.completedAt, firstCompletedAt);

  onError("sess-fatal-2", "boom");
  task = (await harness.call()).json.tasks.find((item) => item.id === "sess-fatal-2");
  assert.equal(task.interruptedKind, "error");
  assert.equal(task.interruptedMessage, "boom");

  onError(null, "ignored");
  onError("", "ignored");
  const tasks = (await harness.call()).json.tasks;
  assert.equal(tasks.length, 2, "非法 id 不应造出任务");
});
