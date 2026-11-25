import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 通知中心入口（右上角铃铛）的约束。
 *
 * 铃铛是通知的唯一入口，注册在 shell.overlay（root 作用域、跨所有主面板），
 * 不占用侧边栏，也不在会话头再放第二个。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

test("铃铛注册在 shell.overlay，跨所有主面板常驻", () => {
  assert.match(source, /ctx\.slots\.inject\("shell\.overlay"/);
  assert.match(source, /name: "shell\.overlay"/);
  assert.match(source, /id: "task-notifier-center"/);
});

test("只有一个入口：不再注册侧边栏或会话头第二个入口", () => {
  assert.equal(source.includes('name: "sidebar.panellist"'), false);
  assert.equal(source.includes('name: "main"'), false, "三列看板改为通知面板内展开，不再单独占 main");
  assert.equal(source.includes("conversation.session.header.utilities"), false);
  assert.equal(source.includes("PanelIcon("), false);
});

test("铃铛带未读角标，且角标文案来自字典", () => {
  assert.match(source, /className: `dtn-bell/);
  assert.match(source, /className: "dtn-bell__badge"/);
  assert.match(source, /t\("center\.unread", \{ n: totalUnread \}\)/);
});

test("角标计数包含未读通知与待处理任务", () => {
  assert.match(source, /const totalUnread = hostUnread \+ accountUnread \+ todoTasks\.length;/);
  assert.match(source, /state\.notificationUnreadCount\?\.\(\) \?\? 0/);
});
