import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 入口与图标的约束。
 *
 * 1.4.1 起：右上角铃铛（shell.overlay）是通知中心入口，同时保留侧边栏「任务面板」
 * 入口（sidebar.panellist + main），两者共用同一个 store。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

test("铃铛注册在 shell.overlay，跨所有主面板常驻", () => {
  assert.match(source, /ctx\.slots\.inject\("shell\.overlay"/);
  assert.match(source, /name: "shell\.overlay"/);
  assert.match(source, /id: "task-notifier-center"/);
});

test("保留侧边栏任务面板入口与主面板", () => {
  assert.match(source, /ctx\.slots\.inject\("sidebar\.panellist"/);
  assert.match(source, /name: "sidebar\.panellist", id: PANEL_ID/);
  assert.match(source, /ctx\.slots\.inject\("main"/);
  assert.match(source, /name: "main", key: PANEL_ID/);
});

test("铃铛带未读角标，且角标文案来自字典", () => {
  assert.match(source, /className: `dtn-bell/);
  assert.match(source, /className: "dtn-bell__badge"/);
  assert.match(source, /t\("center\.unread", \{ n: totalUnread \}\)/);
});

test("侧栏图标带未读角标", () => {
  assert.match(source, /function TaskSidebarIcon/);
  assert.match(source, /className: "dtn-panel-mark__badge"/);
});

test("角标计数包含未读通知与待处理任务", () => {
  assert.match(source, /const totalUnread = hostUnread \+ accountUnread \+ todoTasks\.length;/);
  assert.match(source, /state\.notificationUnreadCount\?\.\(\) \?\? 0/);
});
