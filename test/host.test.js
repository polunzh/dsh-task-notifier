import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
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

  return { ctx, handlers, call, registrations };
}

const previousHome = process.env.DSH_HOME;
const home = mkdtempSync(join(tmpdir(), "dtn-host-test-"));
process.env.DSH_HOME = home;

test.after(() => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
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
  const file = join(home, "storages", "dsh-task-notifier", "state.json");
  const fileStat = statSync(file);
  assert.equal(fileStat.mode & 0o777, 0o600, "状态文件必须只有属主可读写");
  const dirStat = statSync(join(home, "storages", "dsh-task-notifier"));
  assert.equal(dirStat.mode & 0o777, 0o700, "状态目录必须只有属主可进入");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);

  removed("sess-1");
  const after = await harness.call();
  assert.equal(after.json.tasks.find((item) => item.id === "sess-1"), undefined);
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
});
