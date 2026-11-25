import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 通知链路回归约束（通知中心版）。
 *
 * client.js 是浏览器 bundle（window.__ModuleLoader__.load），没法直接 import，
 * 所以这里按源码校验几个关键点：
 *  - 写接口统一带 application/json；
 *  - 新结果按通知 id + 时间水位线去重，同一会话多次完成仍会提醒；
 *  - 浏览器通知弹不出来时按通知 id 落到宿主系统通知；
 *  - 通知 tag 按会话/通知区分；
 *  - 铃铛在会话头顶栏 utilities（紧挨「更多」），侧边栏任务面板入口保留。
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
  const barePosts = [...source.matchAll(/fetchJson\([^)]*\{\s*method:\s*"POST"/g)];
  assert.deepEqual(barePosts, [], "不应再出现绕开 postJson 的裸 POST");
  assert.match(source, /postJson\(`\$\{API\}\/test`\)/, "自检按钮必须走 postJson");
});

test("新结果按通知 id + 时间水位线去重，同一会话可反复提醒", () => {
  assert.match(source, /notifiedIds: new Set\(\)/, "去重表按通知 id 记住已提醒过的结果");
  assert.match(source, /notifWatermark: 0/, "通知也要有自己的时间水位线");
  assert.match(
    source,
    /\(entry\.ts \?\? 0\) > state\.notifWatermark &&\s*!state\.notifiedIds\.has\(entry\.id\)/,
    "只有晚于水位线且没提醒过的通知才算新结果",
  );
  assert.match(source, /state\.notifiedIds\.add\(entry\.id\)/);
});

test("提醒的是通知而不是任务，任务/插件来源都覆盖、账号来源不弹", () => {
  assert.match(source, /entry\.source !== "account"/, "账号公告只进收件箱，不弹系统/浏览器通知");
  assert.match(source, /const body =\s*entry\.source === "task"/, "任务来源用文案表拼正文");
});

test("浏览器通知构造失败要落到宿主系统通知", () => {
  assert.match(source, /function notifyBrowser\([^)]*\)[\s\S]*?return false;/, "构造失败必须回报 false");
  assert.match(source, /const shown =[\s\S]*?notifyBrowser\(/, "必须接住 notifyBrowser 的结果");
  assert.match(source, /if \(!shown\) fallbackIds\.push\(entry\.id\)/);
  assert.match(source, /fallbackOsNotify\(fallbackIds\)/, "一次请求带上所有兜底 id，逐个发会被 /notify 冷却挡掉");
});

test("通知 tag 按会话（或通知 id）区分，避免连续完成被系统折叠", () => {
  assert.match(source, /`\$\{NS\}:\$\{entry\.sessionId \|\| entry\.id\}`/);
  assert.doesNotMatch(source, /tag: NS \}/, "所有通知共用一个 tag 会互相替换");
});

test("入口：铃铛在会话头顶栏 utilities，任务面板保留在侧边栏", () => {
  assert.match(source, /function NotificationCenterRoot\(/, "应有通知中心组件");
  assert.match(source, /ctx\.slots\.inject\("conversation\.session\.header\.utilities"/, "铃铛注册在会话头顶栏");
  assert.match(source, /id: "task-notifier-bell"/);
  assert.match(source, /ctx\.slots\.inject\("sidebar\.panellist"/, "保留侧边栏任务面板入口");
  assert.equal(source.includes("PanelIcon("), false, "旧侧栏图标已替换为 TaskSidebarIcon");
});

test("通知面板：弹出、筛选、全部已读，点击通知直接跳会话", () => {
  assert.match(source, /className: "dtn-nc__panel"/, "有通知面板");
  assert.match(source, /className: "dtn-nc__seg"/, "有全部/未读/待处理分段");
  assert.match(source, /store\.markAllRead\?\.\(\)/, "全部已读走 store");
  assert.equal(source.includes("setExpanded"), false, "不再提供展开任务面板");
  assert.match(source, /ctx\.uiWorkspace\?\.openSession\(entry\.sessionId\)/, "点击通知直接打开会话");
});

test("提示音在 AudioContext 还是 suspended 时先恢复再排音", () => {
  assert.match(source, /function scheduleChime\(ctx\)/);
  assert.match(source, /ctx\.resume\?\.\(\)/, "suspended 时必须 resume");
  assert.match(source, /\.then\(\(\) => \{\s*if \(ctx\.state === "running"\) scheduleChime\(ctx\);/);
  assert.match(source, /document\.addEventListener\("pointerdown", warmAudio/);
  assert.match(source, /document\.addEventListener\("keydown", warmAudio/);
});

test("禁用后必须停掉轮询（dispose + abort）", () => {
  assert.match(source, /function dispose\(\)/);
  assert.match(source, /lifetime\.abort\(\)/);
  assert.match(source, /while \(!disposed\)/);
});
