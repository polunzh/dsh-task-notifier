import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULTS,
  LIMITS,
  appleScriptQuote,
  classifyTurnEnd,
  hostMessages,
  isQuotaError,
  normalizeConfig,
  normalizeId,
  normalizeIds,
  normalizeLocale,
  normalizeNotificationEntry,
  notificationScript,
  parseNotifications,
  parseState,
  requestAdmission,
  routeOf,
  sanitizeText,
  transitionTask,
  trimNotifications,
} from "../lib/core.js";

test("sanitizeText 折叠控制字符与空白", () => {
  assert.equal(sanitizeText("  hello\n\tworld  "), "hello world");
  assert.equal(sanitizeText("a\u0000b\u001fc"), "a b c");
  assert.equal(sanitizeText(undefined), "");
  assert.equal(sanitizeText(42), "");
});

test("sanitizeText 按码点截断，不会劈开 emoji", () => {
  const text = "🙂".repeat(10);
  assert.equal(sanitizeText(text, 5), "🙂".repeat(5));
  assert.equal(sanitizeText("abcdef", 3), "abc");
});

test("normalizeConfig 拒绝非法值并回落到默认", () => {
  assert.deepEqual(normalizeConfig(undefined), { ...DEFAULTS });
  assert.equal(normalizeConfig({ osNotify: "evil" }).osNotify, "auto");
  assert.equal(normalizeConfig({ osNotify: "always" }).osNotify, "always");
  assert.equal(normalizeConfig({ sound: "yes" }).sound, false);
  assert.equal(normalizeConfig({ sound: true }).sound, true);
});

test("normalizeConfig 不允许把任意文本塞进 osSound/osTitle", () => {
  const injected = 'Glass" & do shell script "id';
  assert.equal(normalizeConfig({ osSound: injected }).osSound, "Glass");
  assert.equal(normalizeConfig({ osSound: "Ping" }).osSound, "Ping");
  assert.equal(normalizeConfig({ osTitle: "a\u0000b" }).osTitle, "a b");
  assert.equal(normalizeConfig({ osTitle: "   " }).osTitle, DEFAULTS.osTitle);
});

test("appleScriptQuote 中和双引号与反斜杠", () => {
  assert.equal(appleScriptQuote('say "hi"'), '"say \\"hi\\""');
  assert.equal(appleScriptQuote("back\\slash"), '"back\\\\slash"');
  const attack = 'x" & do shell script "id" & "';
  const quoted = appleScriptQuote(attack);
  // 字面量内部不允许出现未转义的双引号：整段必须还是一个字符串
  // 整段必须仍然是一个 AppleScript 字符串字面量：内部只有转义序列，没有裸引号
  assert.match(quoted, /^"(?:[^"\\]|\\.)*"$/);
});

test("appleScriptQuote 把换行折叠掉，避免 AppleScript 语句被拆开", () => {
  const quoted = appleScriptQuote("line1\nline2");
  assert.equal(quoted.includes("\n"), false);
  assert.equal(quoted, '"line1 line2"');
});

test("notificationScript 始终是单条 display notification", () => {
  const script = notificationScript({ body: 'a"b', title: "T", sound: "Glass" });
  assert.equal(script, 'display notification "a\\"b" with title "T" sound name "Glass"');
});

test("normalizeId 拒绝空值、超长与控制字符", () => {
  assert.equal(normalizeId("abc"), "abc");
  assert.equal(normalizeId("  abc  "), "abc");
  assert.equal(normalizeId(""), null);
  assert.equal(normalizeId(123), null);
  assert.equal(normalizeId("a\u0000b"), null);
  assert.equal(normalizeId("x".repeat(LIMITS.maxIdLength + 1)), null);
});

test("normalizeIds 去重、限量、丢弃非法项", () => {
  assert.deepEqual(normalizeIds(["a", "b", "a", 1, "", "c"]), ["a", "b", "c"]);
  const many = Array.from({ length: LIMITS.maxIds + 50 }, (_, index) => `id-${index}`);
  assert.equal(normalizeIds(many).length, LIMITS.maxIds);
  assert.deepEqual(normalizeIds("not-an-array"), []);
});

test("routeOf 只接管本插件前缀", () => {
  assert.equal(routeOf("/task-notifier/api/state?rev=1"), "state");
  assert.equal(routeOf("/task-notifier/api"), "");
  assert.equal(routeOf("/task-notifier/api/"), "");
  assert.equal(routeOf("/task-notifier/api/read"), "read");
  assert.equal(routeOf("/other/route"), null);
  assert.equal(routeOf("/task-notifier/apix"), null);
});

test("requestAdmission 在守卫缺失时 fail-closed", () => {
  assert.deepEqual(requestAdmission(undefined, { method: "GET", headers: {} }), {
    ok: false,
    status: 503,
    reason: "no-connection-guard",
  });
  assert.equal(requestAdmission({}, { method: "GET", headers: {} }).ok, false);
});

test("requestAdmission 透传宿主裁决", () => {
  const connection = { requestRejection: () => 401 };
  assert.deepEqual(requestAdmission(connection, { method: "GET", headers: {} }), {
    ok: false,
    status: 401,
    reason: "rejected",
  });
  const throwing = { requestRejection: () => { throw new Error("boom"); } };
  assert.equal(requestAdmission(throwing, { method: "GET", headers: {} }).status, 403);
});

test("requestAdmission 允许已鉴权的读请求", () => {
  const connection = { requestRejection: () => undefined };
  assert.deepEqual(requestAdmission(connection, { method: "GET", headers: {} }), { ok: true });
});

test("requestAdmission 拒绝非 JSON 的写请求（挡跨站简单请求）", () => {
  const connection = { requestRejection: () => undefined };
  const textPlain = { method: "POST", headers: { "content-type": "text/plain" } };
  assert.deepEqual(requestAdmission(connection, textPlain), {
    ok: false,
    status: 415,
    reason: "unsupported-media-type",
  });
  const noType = { method: "POST", headers: {} };
  assert.equal(requestAdmission(connection, noType).ok, false);
  const json = { method: "POST", headers: { "content-type": "application/json; charset=utf-8" } };
  assert.equal(requestAdmission(connection, json).ok, true);
});

test("parseState 校验版本、过滤非法任务、截断标题", () => {
  assert.equal(parseState(null), null);
  assert.equal(parseState({ version: 2, tasks: [] }), null);
  assert.equal(parseState({ version: 1, tasks: "x" }), null);
  const parsed = parseState({
    version: 1,
    tasks: [
      { id: "a", title: "x".repeat(LIMITS.maxTitle + 20), completedAt: 5, unread: true, changeAt: 6 },
      { id: "", title: "bad" },
      { id: "b\u0000" },
      "not-an-object",
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].id, "a");
  assert.equal(parsed[0].title.length, LIMITS.maxTitle);
  assert.equal(parsed[0].unread, true);
});

test("parseState 解析谱系字段并净化非法父 id / 夹紧深度", () => {
  const parsed = parseState({
    version: 1,
    tasks: [
      { id: "c", completedAt: 1, unread: true, changeAt: 1, parentId: "p", depth: 2, origin: "subagent" },
      { id: "d", parentId: "", depth: -3 },
      { id: "e", parentId: "x\u0000", depth: 99 },
    ],
  });
  const c = parsed.find((item) => item.id === "c");
  assert.equal(c.parentId, "p");
  assert.equal(c.depth, 2);
  assert.equal(c.origin, "subagent");
  const d = parsed.find((item) => item.id === "d");
  assert.equal(d.parentId, null, "空父 id 归一化为 null");
  assert.equal(d.depth, 0, "负深度夹到 0");
  const e = parsed.find((item) => item.id === "e");
  assert.equal(e.parentId, null, "含控制字符的父 id 被丢弃");
  assert.equal(e.depth, 8, "超深夹到上限 8");
});

test("transitionTask 只在状态翻转时推进时间", () => {
  const task = { running: false, startedAt: 0, completedAt: 0, unread: false, changeAt: 0 };
  assert.deepEqual(transitionTask(task, false, 100), { changed: false, completed: false });
  const started = transitionTask(task, true, 100);
  assert.deepEqual(started, { changed: true, completed: false });
  assert.equal(task.startedAt, 100);
  assert.equal(task.completedAt, 0);
  const finished = transitionTask(task, false, 200);
  assert.deepEqual(finished, { changed: true, completed: true });
  assert.equal(task.completedAt, 200);
  assert.equal(task.unread, true);
  assert.equal(task.changeAt, 200);
});

test("transitionTask 在轮次翻转时清掉等待输入状态", () => {
  const task = { running: true, needsInput: true, inputKind: "approval", startedAt: 1, completedAt: 0, unread: false, changeAt: 1 };
  transitionTask(task, false, 200);
  assert.equal(task.needsInput, false);
  assert.equal(task.inputKind, null);
  const next = { running: false, needsInput: true, inputKind: "question", startedAt: 0, completedAt: 1, unread: true, changeAt: 1 };
  transitionTask(next, true, 300);
  assert.equal(next.needsInput, false);
  assert.equal(next.inputKind, null);
});

test("normalizeLocale 与 hostMessages 跟随 en/zh", () => {
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("fr"), "zh");
  assert.equal(normalizeLocale(undefined), "zh");
  assert.equal(hostMessages("en").unnamed, "Untitled session");
  assert.match(hostMessages("en").completed("Review"), /Review.*done/);
  assert.match(hostMessages("zh").completed("改稿"), /改稿.*已完成/);
});

test("isQuotaError 只认额度/欠费这类终态错误", () => {
  assert.equal(isQuotaError("insufficient_quota"), true);
  assert.equal(isQuotaError("Insufficient Balance"), true);
  assert.equal(isQuotaError("you have run out of credits"), true);
  assert.equal(isQuotaError("余额不足"), true);
  assert.equal(isQuotaError("rate limit exceeded"), false);
  assert.equal(isQuotaError(""), false);
  assert.equal(isQuotaError(undefined), false);
});

test("classifyTurnEnd 把中断、欠费、报错与主动停止区分开", () => {
  // 崩溃恢复补写的收尾 = 进程退出
  assert.deepEqual(classifyTurnEnd({ kind: "interrupted" }), {
    interrupted: true,
    kind: "process_exit",
    message: null,
  });
  // 关进程/父会话级联取消也是退出
  assert.deepEqual(classifyTurnEnd({ kind: "aborted", reason: { kind: "disposed" } }), {
    interrupted: true,
    kind: "process_exit",
    message: null,
  });
  assert.equal(classifyTurnEnd({ kind: "aborted", reason: { kind: "parent" } }).kind, "process_exit");
  // 用户主动点停止是有意为之
  assert.equal(classifyTurnEnd({ kind: "aborted", reason: { kind: "user" } }), null);
  // 插件取消（如账号退出）按报错算
  assert.deepEqual(classifyTurnEnd({ kind: "aborted", reason: { kind: "hook", reason: "deepseek-account/signed-out" } }), {
    interrupted: true,
    kind: "error",
    message: "deepseek-account/signed-out",
  });
  // 额度错误码与文案都识别为欠费
  assert.deepEqual(
    classifyTurnEnd({ kind: "error", error: { code: "ACCOUNT_QUOTA", message: "余额不足" } }),
    { interrupted: true, kind: "quota", message: "余额不足" },
  );
  assert.deepEqual(
    classifyTurnEnd({ kind: "error", error: { code: "PROVIDER", message: "Insufficient balance" } }),
    { interrupted: true, kind: "quota", message: "Insufficient balance" },
  );
  // 其它失败按报错
  assert.deepEqual(
    classifyTurnEnd({ kind: "error", error: { code: "UNKNOWN", message: "boom" } }),
    { interrupted: true, kind: "error", message: "boom" },
  );
  // 正常收尾 / 脏数据都不算中断
  assert.equal(classifyTurnEnd({ kind: "completed" }), null);
  assert.equal(classifyTurnEnd(undefined), null);
  assert.equal(classifyTurnEnd("completed"), null);
});

test("classifyTurnEnd 截断与净化错误原因", () => {
  const result = classifyTurnEnd({
    kind: "error",
    error: { code: "UNKNOWN", message: `a\u0000b\n${"长".repeat(400)}` },
  });
  assert.equal(result.kind, "error");
  assert.equal(result.message.includes("\u0000"), false);
  assert.equal(result.message.includes("\n"), false);
  assert.ok(result.message.length <= LIMITS.maxReason);
});

test("parseState 解析中断字段并丢弃非法类型", () => {
  const parsed = parseState({
    version: 1,
    tasks: [
      {
        id: "a",
        title: "欠费中断",
        completedAt: 5,
        unread: true,
        changeAt: 6,
        interrupted: true,
        interruptedKind: "quota",
        interruptedMessage: "Insufficient balance",
      },
      { id: "b", interrupted: true, interruptedKind: "evil", completedAt: 1 },
      { id: "c", interrupted: false, interruptedKind: "quota", interruptedMessage: "x" },
      { id: "d", interrupted: true, interruptedMessage: `a\u0000b${"长".repeat(400)}` },
    ],
  });
  assert.equal(parsed[0].interrupted, true);
  assert.equal(parsed[0].interruptedKind, "quota");
  assert.equal(parsed[0].interruptedMessage, "Insufficient balance");
  assert.equal(parsed[1].interruptedKind, null, "未知中断类型不应被信任");
  assert.equal(parsed[1].interrupted, true);
  assert.equal(parsed[2].interrupted, false);
  assert.equal(parsed[2].interruptedMessage, null);
  assert.equal(parsed[3].interruptedKind, null);
  assert.equal(parsed[3].interruptedMessage.includes("\u0000"), false);
  assert.ok(parsed[3].interruptedMessage.length <= LIMITS.maxReason);
});

test("transitionTask 重新开跑时清掉中断标记，收尾时保留", () => {
  const task = {
    running: false,
    startedAt: 0,
    completedAt: 10,
    unread: true,
    changeAt: 10,
    interrupted: true,
    interruptedKind: "quota",
    interruptedMessage: "余额不足",
  };
  transitionTask(task, true, 100);
  assert.equal(task.interrupted, false);
  assert.equal(task.interruptedKind, null);
  assert.equal(task.interruptedMessage, null);

  task.interrupted = true;
  task.interruptedKind = "error";
  task.interruptedMessage = "boom";
  transitionTask(task, false, 200);
  assert.equal(task.interrupted, true, "停止时不能把中断标记抹掉");
  assert.equal(task.interruptedKind, "error");
});

/* ---------------------------- 通知中心 ---------------------------- */

test("normalizeNotificationEntry 净化文本、校验来源与 tone", () => {
  const entry = normalizeNotificationEntry(
    {
      id: "task:s1:100",
      source: "task",
      kind: "interrupted",
      title: "  会话\n标题  ",
      body: "x".repeat(400),
      tone: "nonsense",
      ts: 100,
      sessionId: "s1",
      interruptedKind: "quota",
      interruptedMessage: "余额不足",
    },
    999,
  );
  assert.equal(entry.title, "会话 标题");
  assert.equal(entry.tone, "default", "非法 tone 回落 default");
  assert.equal(entry.ts, 100);
  assert.equal(entry.sessionId, "s1");
  assert.equal(entry.interruptedKind, "quota");
  assert.ok(entry.body.length <= LIMITS.maxBody + 2);

  assert.equal(normalizeNotificationEntry({ id: "x", source: "weird", title: "t" }), null, "未知来源丢弃");
  assert.equal(normalizeNotificationEntry({ id: "x", source: "task", title: "   " }), null, "空标题丢弃");
  assert.equal(normalizeNotificationEntry({ source: "task", title: "t" }), null, "缺 id 丢弃");
});

test("parseNotifications 只接受匹配版本，trimNotifications 未读优先保留", () => {
  assert.equal(parseNotifications({ version: 999, notifications: [] }), null);
  const parsed = parseNotifications({
    version: 1,
    notifications: [
      { id: "a", source: "task", title: "A", ts: 1 },
      { id: "b", source: "plugin", title: "B", ts: 2, read: true },
    ],
  });
  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].source, "plugin");

  const list = [];
  for (let i = 0; i < 10; i += 1) list.push({ id: `n${i}`, ts: i, read: i < 6 });
  const trimmed = trimNotifications(list, 4);
  assert.equal(trimmed.length, 4);
  assert.equal(trimmed.filter((item) => !item.read).length, 4, "先保未读");
});
