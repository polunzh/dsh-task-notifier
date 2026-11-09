import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * 侧栏入口图标（PanelIcon）的几何约束。
 *
 * 宿主把图标塞进 .panelGlyph —— 一个没有固定尺寸的 inline-flex 容器，
 * 图标方框多宽，标题就被推多远；方框里图形偏一点，图标就和标题错开。
 * 所以这几条不是风格问题，是「标题必须和别的入口对齐」的硬约束。
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

function panelIconSource() {
  const start = source.indexOf("function PanelIcon(");
  assert.ok(start >= 0, "找不到 PanelIcon");
  const end = source.indexOf("/* ============================ 面板页", start);
  assert.ok(end > start, "找不到 PanelIcon 结束位置");
  return source.slice(start, end);
}

const icon = panelIconSource();

test("图标方框就是宿主给的 size，不再自己加画布", () => {
  assert.doesNotMatch(icon, /canvasSize/, "图标画布不能比 size 大，否则标题会被推右");
  assert.match(icon, /width:\s*size,/, "svg 宽度必须等于 size");
  assert.match(icon, /height:\s*size,/, "svg 高度必须等于 size");
  assert.match(icon, /style:\s*\{\s*width:\s*`\$\{size\}px`,\s*height:\s*`\$\{size\}px`\s*\}/, "外层方框也要固定成 size×size");
});

test("图形画在 24 网格上并且居中", () => {
  assert.match(icon, /viewBox:\s*"0 0 24 24"/, "画布必须是宿主同款 24 网格");
  assert.doesNotMatch(icon, /translate\(/, "图形不能整体平移，平移会让图标和标题错开");

  const rect = icon.match(/h\("rect",\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*width:\s*([\d.]+),\s*height:\s*([\d.]+)/);
  assert.ok(rect, "找不到主体矩形的坐标");
  const [x, y, width, height] = rect.slice(1).map(Number);
  assert.equal(x + width / 2, 12, "矩形水平中心必须在 12");
  assert.equal(y + height / 2, 12, "矩形垂直中心必须在 12，否则图标比标题低或高");
});

test("未读角标用 HTML 叠在方框上，不占画布", () => {
  assert.match(icon, /className:\s*"dtn-panel-mark__badge"/, "角标要挂在方框上，不能画进 SVG");
  assert.match(icon, /"data-dtn-badge":\s*""/, "角标要带 data-dtn-badge，截图脚本用它做断言");
  assert.doesNotMatch(icon, /h\("text"/, "SVG 里不该再画角标文字");
});

test("角标样式补上了描边和描边色，深色侧栏里也能和图标分开", () => {
  assert.match(source, /\.dtn-panel-mark\s*\{[^}]*position:\s*relative;/, "方框要能定位角标");
  assert.match(source, /\.dtn-panel-mark__badge\s*\{[^}]*box-shadow:[^}]*sidebar-fill/, "角标描边要取侧栏底色");
});

test("宿主传进来的 size 要透传给图标（折叠侧栏是 16）", () => {
  assert.match(
    source,
    /\(\s*slotProps\s*\)\s*=>\s*PanelIcon\(\{\s*\.\.\.slotProps,\s*store\s*\}\)/,
    "侧栏槽位的渲染函数要把 size 透传进来，不能自己写死 18",
  );
});
