import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 入口与图标的约束。
 *
 * 1.4.3 起：铃铛注册在会话头顶栏 utilities，紧挨「更多（…）」左侧；
 * 侧边栏「任务面板」入口（sidebar.panellist + main）保留，两者共用同一个 store。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

test("铃铛注册在会话头顶栏 utilities，排在「更多」之前", () => {
  assert.match(source, /ctx\.slots\.inject\("conversation\.session\.header\.utilities"/);
  assert.match(source, /name: "conversation\.session\.header\.utilities"/);
  assert.match(source, /id: "task-notifier-bell"/);
  assert.match(source, /order: 100/);
  assert.equal(source.includes('"shell.overlay"'), false, "不要再在全局浮层放第二个入口");
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
