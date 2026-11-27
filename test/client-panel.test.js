import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 通知面板的视觉结构约束（v2 改版）。
 *
 * client.js 是浏览器 bundle，没法直接 import，这里按源码校验结构：
 *  - 行 = 28px 应用瓦片 + 标题 + 可选副行，不再有色条/chip/「打开」链接；
 *  - 插件来源优先用插件自己的 icon，失败降级到拼图瓦片；
 *  - 重复结果按会话合并，用副行写「完成 N 次」；
 *  - 来源筛选用漏斗菜单，不再用原生 select。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

test("行结构：色条 + 标题 + 可选副行，没有应用瓦片", () => {
  assert.match(source, /dtn-ni__tone dtn-ni__tone--\$\{rowTone\(entry\)\}/);
  assert.match(source, /function rowTone\(entry\)/);
  assert.match(source, /dtn-ni__tone--ok/, "完成=绿");
  assert.match(source, /dtn-ni__tone--warn/, "中断=琥珀");
  assert.match(source, /dtn-ni__tone--err/, "报错=红");
  assert.match(source, /dtn-ni__tone--info/, "账号=蓝");
  assert.match(source, /dtn-ni__unread/, "未读点回到标题前");
  assert.equal(source.includes("dtn-ni__tile"), false, "不再有应用瓦片");
  assert.equal(source.includes("dtn-ni__badge"), false, "异常用色条表达，不再叠徽标");
  assert.equal(source.includes("dtn-ni__tag"), false, "不再有来源/状态 chip");
  assert.equal(source.includes("dtn-ni__open"), false, "不再有「打开」链接");
});

test("每一行都写明发送方：任务 / 账号公告 / 插件：<name>", () => {
  assert.match(source, /function sourceLabelOf\(entry\)/);
  assert.match(source, /if \(entry\.source === "account"\) return t\("center\.accountBadge"\)/);
  assert.match(source, /return t\("center\.source\.task"\)/, "任务来源也要有文字标识");
  assert.match(source, /t\("center\.pluginPrefix", \{ name: entry\.sourceLabel \}\)/);
  assert.match(source, /const source = sourceLabelOf\(entry\)/);
  assert.match(source, /className: "dtn-ni__source"/);
  assert.match(source, /className: "dtn-ni__sep"/);
  assert.match(source, /const metaLabel = \[meta\.source, meta\.text, meta\.group\]\.filter\(Boolean\)\.join\(" · "\)/, "无障碍标签也要带上来源与分组规模");
});

test("不再拉取插件图标（/sources 与 img 都移除）", () => {
  assert.equal(source.includes("/sources"), false, "客户端不再请求图标接口");
  assert.equal(source.includes("dtn-ni__tile-img"), false);
  assert.equal(source.includes("sourceIconCache"), false);
});

test("合并结果用副行表达次数，中断优先显示原因", () => {
  assert.match(source, /center\.countCompleted/, "完成 N 次");
  assert.match(source, /center\.countInterrupted/, "中断 N 次");
  assert.match(source, /function rowMeta\(entry, childCount = 0\)/);
  assert.match(source, /metaTone|dtn-ni__meta--warn/);
  assert.match(source, /badge\.interrupted\.(quota|error|exit)/, "中断原因复用任务看板文案");
});

test("来源筛选是漏斗菜单，不再是原生 select", () => {
  assert.equal(source.includes("dtn-nc__src\""), false, "旧 select 的 class 不再出现");
  assert.match(source, /className: `dtn-nc__funnel/);
  assert.match(source, /className: "dtn-nc__menu"/);
  assert.match(source, /role: "menuitemradio"/);
  assert.match(source, /"aria-expanded": sourceMenu/);
});

test("分段控件的计数只在 > 0 时渲染", () => {
  assert.match(source, /totalUnread > 0 \? h\("i", null, String\(totalUnread\)\) : null/);
  assert.match(source, /todoTasks\.length > 0 \? h\("i", null, String\(todoTasks\.length\)\) : null/);
  assert.match(source, /onClick: \(\) => \{ setFilter\("all"\); setSourceMenu\(false\); \} \}, t\("center\.all"\)\)/, "「全部」不再带总数");
});

test("中英文案都补齐新 key", () => {
  const zh = source.slice(source.indexOf("zh: {"), source.indexOf("en: {"));
  const en = source.slice(source.indexOf("en: {"));
  for (const key of [
    "center.countCompleted",
    "center.countInterrupted",
    "center.childDone",
    "center.childInterrupted",
    "center.moreChildren",
    "center.moreRunning",
    "duration.minutes",
    "duration.seconds",
    "center.sourceMenu",
  ]) {
    assert.ok(zh.includes(`"${key}"`), `中文缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `英文缺 ${key}`);
  }
});

test("每条消息都能单独标已读：未读行渲染对勾，已读行不渲染", () => {
  assert.match(source, /className: `dtn-ni__shell\$\{entry\.read \? "" : " is-unread"\}`/, "行外再包一层 shell");
  assert.match(source, /entry\.read\s*\? null\s*: h\(\s*"button"/, "按钮只在未读行出现");
  assert.match(source, /className: "dtn-ni__read"/);
  assert.match(source, /t\("action\.markRead"\)/, "复用已有文案，不新增 key");
  assert.match(source, /onMarkRead: markEntryRead/, "行拿到单条已读回调");
  assert.match(source, /const markEntryRead = \(entry\) => \{/, "账号与宿主两条路径收在一个函数里");
  assert.match(source, /const openEntry = async \(entry\) => \{\s*markEntryRead\(entry\);/, "点开行复用同一个已读入口");
});

test("对勾按钮与 role=button 的行平级，hover / 聚焦才让时间让位", () => {
  const rowStart = source.indexOf("function NotificationRow(props)");
  const rowSource = source.slice(rowStart, source.indexOf("/** 侧边栏任务面板入口图标", rowStart));
  const rowButton = rowSource.indexOf('role: "button"');
  const actionButton = rowSource.indexOf('className: "dtn-ni__read"');
  assert.ok(rowButton >= 0, "行仍是可聚焦的按钮");
  assert.ok(actionButton > rowButton, "对勾在行节点之后，不嵌进 role=button 里");
  assert.match(
    rowSource,
    /\n        entry\.read\n          \? null\n          : h\(\n              "button",\n              \{\n                type: "button",\n                className: "dtn-ni__read",/,
    "对勾是外层 h() 的第三个参数，与行平级",
  );
  assert.match(source, /\.dtn-ni__shell:hover \.dtn-ni__read/);
  assert.match(source, /\.dtn-ni__shell:focus-within \.dtn-ni__read/);
  assert.match(source, /\.dtn-ni__shell:hover \.dtn-ni__time/);
  assert.match(source, /transition: opacity 120ms ease/);
});

test("触屏与窄屏没有 hover：未读行常驻对勾，时间照常显示", () => {
  assert.match(source, /@media \(hover: none\), \(max-width: 640px\) \{/);
  assert.match(source, /\.dtn-ni\.is-unread \{ padding-right: 40px; \}/);
  assert.match(source, /\.dtn-ni__read \{ opacity: 1; pointer-events: auto; right: 10px; \}/);
});

test("运行中行混进「今天」，只在全部筛选与任务来源下出现", () => {
  assert.match(source, /function runningGroups\(tasks\)/);
  assert.match(source, /const showRunning = filter === "all" && \(sourceFilter === "all" \|\| sourceFilter === "task"\)/);
  assert.match(source, /const todayBlock = \[\.\.\.runningRows, \.\.\.todayRows\]/);
  assert.match(source, /key: "g:today"/);
  assert.match(source, /key: "g:earlier"/);
  assert.match(source, /MAX_RUNNING_GROUPS = 3/);
  assert.match(source, /MAX_RUNNING_CHILDREN = 3/);
});

test("运行中行：色条 + 已运行 + 流动条 + 子代理树，没有标已读动作", () => {
  assert.match(source, /className: "dtn-nr__row"/);
  assert.match(source, /dtn-ni__tone dtn-ni__tone--info/);
  assert.match(source, /t\("card\.runningFor"/);
  assert.match(source, /className: "dtn-live dtn-nr__live"/);
  assert.match(source, /className: "dtn-nr__kids"/);
  assert.match(source, /dtn-nr__kid-ico--\$\{tone\}/);
  assert.match(source, /center\.moreChildren/);
  assert.match(source, /center\.moreRunning/);
  const start = source.indexOf("function RunningGroup");
  const seg = source.slice(start, start + 4000);
  assert.equal(seg.includes("dtn-ni__read"), false, "运行中行不渲染单条已读按钮");
});

test("结果行带子代理规模；账号与插件行不加", () => {
  assert.match(
    source,
    /const group = entry\.source === "task" && childCount > 0 \? t\("tree\.children", \{ n: childCount \}\) : null/,
  );
  assert.match(source, /entry\.source === "task" && entry\.sessionId \? childCounts\.get\(entry\.sessionId\) \?\? 0 : 0/);
});

test("空态把运行中行算进列表", () => {
  assert.match(source, /!pinnedRows\.length && !todayBlock\.length && !earlierRows\.length/);
});
