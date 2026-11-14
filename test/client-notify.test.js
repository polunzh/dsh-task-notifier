import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transitionTask } from "../lib/core.js";

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
 *  - 运行中任务的 changeAt 被当成完成时刻，连续提问时开跑瞬间误弹通知。
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

test("resultAt 只把真正收尾的结果当新完成", () => {
  // 从浏览器 bundle 里取出 resultAt 直接跑，避免只靠源码正则在措辞上打滑。
  const match = source.match(/function resultAt\(task\) \{[\s\S]*?\n      \}/);
  assert.ok(match, "应能找到 resultAt");
  const resultAt = new Function(`${match[0]}; return resultAt;`)();
  // 运行中的普通任务：completedAt 被重置为 0，changeAt 只是开跑时刻，不能当结果
  assert.equal(resultAt({ running: true, completedAt: 0, changeAt: 4000 }), 0);
  // 正常完成
  assert.equal(resultAt({ running: false, completedAt: 3000, changeAt: 3000 }), 3000);
  // 旧版宿主：会话级失败只写 changeAt，但标了 interrupted，仍要能兜底
  assert.equal(resultAt({ interrupted: true, completedAt: 0, changeAt: 2500 }), 2500);
  // 当前宿主中断：completedAt 已写，优先用它
  assert.equal(resultAt({ interrupted: true, completedAt: 2600, changeAt: 2600 }), 2600);
});

test("连续提问：第二轮开跑不再误报，收尾与会话级失败仍提醒", () => {
  const match = source.match(/function resultAt\(task\) \{[\s\S]*?\n      \}/);
  const resultAt = new Function(`${match[0]}; return resultAt;`)();

  const task = {
    id: "s",
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
  };
  const notified = new Map();
  let watermark = 1000;
  const isFresh = () =>
    task.unread && resultAt(task) > watermark && resultAt(task) > (notified.get(task.id) ?? 0);
  const settle = () => {
    if (!isFresh()) return false;
    notified.set(task.id, resultAt(task));
    watermark = Math.max(watermark, resultAt(task));
    return true;
  };

  transitionTask(task, true, 2000); // Q1 开跑
  assert.equal(isFresh(), false, "开跑不是结果");
  transitionTask(task, false, 3000); // Q1 完成
  assert.equal(settle(), true, "Q1 完成要提醒");
  assert.equal(task.unread, true, "用户还没看，上一轮仍是未读");

  transitionTask(task, true, 4000); // 用户接着问 Q2（同一会话、未 markRead）
  assert.equal(isFresh(), false, "Q2 开跑瞬间不能当成一次新完成");

  transitionTask(task, false, 5000); // Q2 完成
  assert.equal(settle(), true, "Q2 收尾仍要提醒");

  // 会话级失败：status 可能还没翻成 idle（running 仍为 true），但已标中断并写了 completedAt
  transitionTask(task, true, 6000);
  Object.assign(task, { running: true, interrupted: true, completedAt: 6500, changeAt: 6500, unread: true });
  assert.equal(isFresh(), true, "会话级失败即使 running 未翻转也要提醒");
});

test("未读角标与「未读结果」列同口径，运行中的任务不计入", () => {
  assert.match(
    source,
    /if \(task\.unread && !task\.running && !task\.needsInput\) count \+= 1;/,
    "角标要忽略运行中/等人中的任务，否则开跑后角标亮、未读列却是空的",
  );
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
