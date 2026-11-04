import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "lib", "client.js"), "utf8");

/** 取出 DICT 字面量区域（client.js 是浏览器 bundle，不能直接 import，只能按源码校验）。 */
function dictRegion() {
  const start = source.indexOf("const DICT = {");
  assert.ok(start >= 0, "找不到 DICT");
  const end = source.indexOf("let localeApi = null;", start);
  assert.ok(end > start, "找不到 DICT 结束位置");
  return source.slice(start, end);
}

/** 解析某语言分支里的所有键。 */
function keysOf(language) {
  const region = dictRegion();
  const start = region.indexOf(`${language}: {`);
  assert.ok(start >= 0, `找不到 ${language} 分支`);
  const nextLanguage = language === "zh" ? region.indexOf("en: {", start) : region.length;
  const block = region.slice(start, nextLanguage > start ? nextLanguage : region.length);
  return new Set([...block.matchAll(/^\s*"([a-z][a-zA-Z0-9.]*)":/gm)].map((match) => match[1]));
}

const zhKeys = keysOf("zh");
const enKeys = keysOf("en");

test("中英字典键集合完全一致", () => {
  assert.ok(zhKeys.size > 20, `中文键太少：${zhKeys.size}`);
  const missingInEn = [...zhKeys].filter((key) => !enKeys.has(key));
  const missingInZh = [...enKeys].filter((key) => !zhKeys.has(key));
  assert.deepEqual(missingInEn, [], `英文缺少：${missingInEn.join(", ")}`);
  assert.deepEqual(missingInZh, [], `中文缺少：${missingInZh.join(", ")}`);
});

test("源码里 t(\"key\") 用到的键都在字典里", () => {
  const used = new Set([...source.matchAll(/\bt\(\s*"([a-z][a-zA-Z0-9.]*)"/g)].map((match) => match[1]));
  const missing = [...used].filter((key) => !zhKeys.has(key));
  assert.deepEqual(missing, [], `这些键没有翻译：${missing.join(", ")}`);
});

test("模板键前缀（permission.* / empty.*）都已覆盖", () => {
  for (const prefix of ["permission.", "empty."]) {
    const usedPrefix = source.includes(`t(\`${prefix}`);
    assert.ok(usedPrefix, `源码应使用 ${prefix} 模板键`);
    const missing = [...zhKeys].length ? [] : ["<empty dict>"];
    assert.deepEqual(missing, []);
  }
  assert.deepEqual(
    [...zhKeys].filter((key) => key.startsWith("permission.")).sort(),
    ["permission.default", "permission.denied", "permission.granted", "permission.unsupported"],
  );
  assert.deepEqual(
    [...zhKeys].filter((key) => key.startsWith("empty.")).sort(),
    ["empty.idle", "empty.nomatch", "empty.running", "empty.unread"],
  );
  assert.deepEqual(
    [...zhKeys].filter((key) => key.startsWith("tab.")).sort(),
    ["tab.all", "tab.idle", "tab.running", "tab.unread"],
  );
});

test("字典外没有遗留的硬编码面板文案", () => {
  const region = dictRegion();
  // 去掉 DICT 与注释，只校验真正会被渲染的代码
  const withoutDict = source
    .replace(region, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  for (const leftover of ["任务面板", "浏览器通知：", "全部标为已读", "没有正在运行的任务", "按标题搜索", "试听提示音", "试发系统通知"]) {
    assert.equal(withoutDict.includes(leftover), false, `仍有硬编码文案：${leftover}`);
  }
});

test("浏览器通知正文也走文案表", () => {
  assert.match(source, /new Notification\(title, \{ body: t\("notify\.body"\), tag: NS \}\)/);
});

test("禁用后必须停掉轮询（dispose + abort）", () => {
  assert.match(source, /function dispose\(\)/);
  assert.match(source, /lifetime\.abort\(\)/);
  assert.match(source, /store\.dispose\(\)/);
  assert.match(source, /while \(!disposed\)/);
});

test("不再在后台自动请求通知权限", () => {
  assert.equal(source.includes("requestSystemNotificationSync"), false);
  assert.equal(source.includes("requestPermissionIfDefault"), false);
  // 权限请求只应发生在按钮的 onClick 手势里
  const requestCalls = [...source.matchAll(/requestBrowserPermission\(\)/g)].length;
  assert.equal(requestCalls, 2, "仅按钮点击与权限刷新各一处调用");
});
