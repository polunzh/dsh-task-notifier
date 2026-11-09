import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 通知链路的回归约束。
 *
 * client.js 是浏览器 bundle（window.__ModuleLoader__.load），没法直接 import，
 * 所以这里按源码校验几个曾经把通知吞掉的关键点：
 *  - /test 缺 Content-Type 被宿主 415，自检按钮永远报错；
 *  - 去重按会话 id 记住，同一会话第二次完成起全部静默；
 *  - 会话级失败只标 changeAt，按 completedAt 过滤时永远漏；
 *  - 浏览器通知构造失败时没有系统通知兜底；
 *  - 所有通知共用一个 tag，连续完成会被系统折叠。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

test("写接口统一带 application/json，自检按钮不再裸 POST", () => {
  assert.match(source, /function postJson\(path, body, options = \{\}\)/, "应该有一个统一的写接口封装");
  assert.match(
    source,
    /headers: \{ "Content-Type": "application\/json", \.\.\.headers \}/,
    "postJson 必须补上 application/json，否则宿主 415",
  );
  // 宿主对非 GET 要求 JSON，裸 fetchJson POST 会被 415 拒掉
  const barePosts = [...source.matchAll(/fetchJson\([^)]*\{\s*method:\s*"POST"/g)];
  assert.deepEqual(barePosts, [], "不应再出现绕开 postJson 的裸 POST");
  assert.match(source, /postJson\(`\$\{API\}\/test`\)/, "自检按钮必须走 postJson");
});

test("去重按「这一次完成」判断，同一会话可以反复提醒", () => {
  assert.equal(source.includes("notified: new Set()"), false, "按会话 id 记住已通知会让后续完成全静默");
  assert.match(source, /notifiedAt: new Map\(\)/, "去重表要记每个会话已通知到的完成时刻");
  assert.match(source, /function resultAt\(task\)/, "完成时刻应集中在一个函数里");
  assert.match(source, /at > state\.watermark && at > \(state\.notifiedAt\.get\(task\.id\) \?\? 0\)/);
});

test("中断任务没有 completedAt 时退回 changeAt", () => {
  assert.match(source, /return task\?\.completedAt \|\| task\?\.changeAt \|\| 0;/);
});

test("浏览器通知构造失败要落到宿主系统通知", () => {
  assert.match(source, /function notifyBrowser\([^)]*\)[\s\S]*?return false;/, "构造失败必须回报 false");
  assert.match(source, /const shown =[\s\S]*?notifyBrowser\(/, "必须接住 notifyBrowser 的结果");
  assert.match(source, /if \(!shown\) fallbackIds\.push\(task\.id\)/);
  assert.match(source, /fallbackOsNotify\(fallbackIds\)/, "一次请求带上所有兜底 id，逐个发会被 /notify 冷却挡掉");
});

test("通知 tag 按会话区分，避免连续完成被系统折叠成一条", () => {
  assert.match(source, /`\$\{NS\}:\$\{task\.id\}`/);
  assert.doesNotMatch(source, /tag: NS \}/, "所有通知共用一个 tag 会互相替换");
});

test("提示音在 AudioContext 还是 suspended 时先恢复再排音", () => {
  assert.match(source, /function scheduleChime\(ctx\)/);
  assert.match(source, /ctx\.resume\?\.\(\)/, "suspended 时必须 resume");
  assert.match(source, /\.then\(\(\) => \{\s*if \(ctx\.state === "running"\) scheduleChime\(ctx\);/);
  // 载入后借第一次手势唤醒音频，避免启动后的完成没有声音
  assert.match(source, /document\.addEventListener\("pointerdown", warmAudio/);
  assert.match(source, /document\.addEventListener\("keydown", warmAudio/);
});
