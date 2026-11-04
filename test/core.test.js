import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULTS,
  LIMITS,
  appleScriptQuote,
  hostMessages,
  normalizeConfig,
  normalizeId,
  normalizeIds,
  normalizeLocale,
  notificationScript,
  parseState,
  requestAdmission,
  routeOf,
  sanitizeText,
  transitionTask,
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

test("normalizeLocale 与 hostMessages 跟随 en/zh", () => {
  assert.equal(normalizeLocale("en-US"), "en");
  assert.equal(normalizeLocale("zh-CN"), "zh");
  assert.equal(normalizeLocale("fr"), "zh");
  assert.equal(normalizeLocale(undefined), "zh");
  assert.equal(hostMessages("en").unnamed, "Untitled session");
  assert.match(hostMessages("en").completed("Review"), /Review.*done/);
  assert.match(hostMessages("zh").completed("改稿"), /改稿.*已完成/);
});
