import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));

const pkg = readJson("package.json");
const patch = readFileSync(join(root, "cordis.patch.yml"), "utf8");

test("包名是合法的 scoped npm 名，且不标记 private", () => {
  assert.match(pkg.name, /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/);
  assert.equal(pkg.private, undefined, "发布包不能带 private: true");
  assert.equal(pkg.publishConfig?.access, "public", "scoped 包必须显式 public");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
});

test("cordis.patch.yml 的 row name 与包名一致（否则市场安装会挂）", () => {
  const matches = [...patch.matchAll(/name:\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((match) => match[1].trim());
  assert.ok(matches.length >= 1, "补丁里必须有一条 insert row");
  assert.equal(matches.at(-1), pkg.name);
  assert.doesNotMatch(patch, /\/Users\/|\/home\/|file:\/\//);
});

test("bundle 声明与入口文件存在", () => {
  assert.equal(pkg.dsh.bundle.patch, "./cordis.patch.yml");
  assert.equal(pkg.dsh.client.platform, "web");
  assert.equal(pkg.dsh.manifestVersion, 1);
  for (const path of [pkg.main, pkg.dsh.bundle.patch, pkg.exports["./client"], pkg.exports["./icon"]]) {
    assert.ok(existsSync(join(root, path)), `${path} 必须存在`);
  }
});

test("显示元数据导出齐全（Plugin Manager 卡片要用）", () => {
  for (const key of ["./locale/*.json", "./icon"]) {
    assert.ok(pkg.exports[key], `exports 必须包含 ${key}`);
  }
  for (const locale of ["en", "zh"]) {
    const meta = JSON.parse(readFileSync(join(root, "locale", `${locale}.json`), "utf8")).meta;
    assert.ok(meta.title?.trim(), `${locale} 必须有 meta.title`);
    assert.ok(meta.description?.trim(), `${locale} 必须有 meta.description`);
  }
});

test("files[] 覆盖运行时资源，且不把 preview/测试/dev 脚本打进包", () => {
  for (const required of ["lib", "locale", "cordis.patch.yml", "icon.svg", "README.md", "LICENSE"]) {
    assert.ok(pkg.files.includes(required), `files 应包含 ${required}`);
  }
  assert.equal(pkg.files.includes("preview"), false, "截图不应进 npm 包");
  assert.equal(pkg.files.includes("test"), false, "测试不应进 npm 包");
  assert.equal(pkg.files.includes("scripts"), false, "构建/截图脚本不应进 npm 包");
});

test("DSH 兼容范围写在 engines.dsh（市场据此展示兼容性）", () => {
  assert.equal(typeof pkg.engines?.dsh, "string");
  assert.match(pkg.engines.dsh, /^[><=~^]/, "engines.dsh 必须是 semver range");
  assert.equal(pkg.engines.dsh.includes("workspace:"), false);
});

test("发布元数据指向真实仓库（市场会核对归属）", () => {
  assert.ok(pkg.author, "author 必填");
  assert.match(pkg.repository?.url ?? "", /^git\+https:\/\/github\.com\/.+\/.+\.git$/);
  assert.match(pkg.homepage ?? "", /^https:\/\/github\.com\/.+\/.+/);
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length >= 5, "keywords 影响市场搜索");
  assert.equal(pkg.license, "MIT");
});

test("不声明安装期脚本，避免市场安装时的供应链风险", () => {
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublishOnly"]) {
    assert.equal(pkg.scripts?.[lifecycle], undefined, `${lifecycle} 不应存在`);
  }
});

test("icon.svg 是合法 SVG 且体积远小于 256 KiB", () => {
  const svg = readFileSync(join(root, "icon.svg"), "utf8");
  assert.match(svg.trim().slice(0, 4), /^<svg/);
  assert.match(svg, /<\/svg>\s*$/);
  assert.ok(Buffer.byteLength(svg) < 256 * 1024);
});
