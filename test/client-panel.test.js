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

test("行结构：应用瓦片 + 标题 + 可选副行，旧的色条/chip/打开链接都移除", () => {
  assert.match(source, /function SourceTile\(props\)/);
  assert.match(source, /className: "dtn-ni__tile dtn-ni__tile--task"/);
  assert.match(source, /className: "dtn-ni__tile dtn-ni__tile--account"/);
  assert.match(source, /className: "dtn-ni__tile dtn-ni__tile--plugin"/);
  assert.match(source, /dtn-ni__dot/, "未读点画在瓦片上");
  assert.match(source, /dtn-ni__badge--/, "中断徽标画在瓦片上");
  assert.equal(source.includes("dtn-ni__tone"), false, "不再有色条");
  assert.equal(source.includes("dtn-ni__tag"), false, "不再有来源/状态 chip");
  assert.equal(source.includes("dtn-ni__open"), false, "不再有「打开」链接");
});

test("插件图标：从 /sources 拉一次、10 分钟缓存、按来源名匹配、失败降级", () => {
  assert.match(source, /fetchJson\(`\$\{API\}\/sources`\)/);
  assert.match(source, /SOURCE_ICON_TTL = 10 \* 60 \* 1000/);
  assert.match(source, /function sourceLabelKeys\(label\)/);
  assert.match(source, /function sourceIconFor\(label, icons\)/);
  assert.match(source, /className: "dtn-ni__tile-img"/);
  assert.match(source, /onError: \(event\) => \{\s*event\.currentTarget\.style\.opacity = "0";/, "图片失败时露出底层拼图瓦片");
  assert.match(source, /h\(Icon, \{ name: "plugin", size: 15 \}\)/, "降级瓦片是拼图");
  assert.match(source, /data\?\.sources \?\? \[\]/);
});

test("插件名保留在副行开头，缺 sourceLabel 时回落到「插件」", () => {
  assert.match(source, /const source = entry\.source === "plugin" \? entry\.sourceLabel \|\| t\("center\.source\.plugin"\) : null/);
  assert.match(source, /className: "dtn-ni__source"/);
  assert.match(source, /className: "dtn-ni__sep"/);
  assert.match(source, /const metaLabel = \[meta\.source, meta\.text\]\.filter\(Boolean\)\.join\(" · "\)/, "无障碍标签也要带上插件名");
});

test("合并结果用副行表达次数，中断优先显示原因", () => {
  assert.match(source, /center\.countCompleted/, "完成 N 次");
  assert.match(source, /center\.countInterrupted/, "中断 N 次");
  assert.match(source, /function rowMeta\(entry\)/);
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
  for (const key of ["center.countCompleted", "center.countInterrupted", "center.sourceMenu"]) {
    assert.ok(zh.includes(`"${key}"`), `中文缺 ${key}`);
    assert.ok(en.includes(`"${key}"`), `英文缺 ${key}`);
  }
});
