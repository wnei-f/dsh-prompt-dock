/**
 * 测试前置：把 DSH 自带的两个包链接进本仓库的 node_modules。
 *
 * 宿主半的 Config schema 用 DSH 自带的 `@deepseek-ai/schemastery` 声明（这是官方
 * 设置表单读取 volatile 字段的唯一接口），所以它必须是 peerDependency——真实运行
 * 时由 DSH profile 提供，而不是随本插件发布一份可能版本漂移的拷贝。
 *
 * 但单独 clone 仓库跑 `npm test` 时没有 profile 的 node_modules，因此这里按顺序
 * 找几处 DSH 安装位置，找到就把目录**软链**过来（不复制、不写入被链接的包）。
 * 一个都找不到时只提示、不失败：插件本身仍能正常工作，只有本地单测跑不了。
 *
 * 用法：由 package.json 的 `pretest` 自动调用。
 */
import { existsSync, mkdirSync, readdirSync, statSync, symlinkSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NEEDED = ["schemastery", "cosmokit"];

/** 候选：直接含 @deepseek-ai/* 的 node_modules 目录。 */
function candidates() {
  const home = process.env.DSH_HOME || join(homedir(), ".dsh");
  const out = [];
  // 1) 各 profile 的 node_modules（最常见的安装方式）
  const profiles = join(home, "profiles");
  if (existsSync(profiles)) {
    for (const name of readdirSync(profiles)) {
      out.push(join(profiles, name, "node_modules"));
    }
  }
  // 2) harness home 自身
  out.push(join(home, "node_modules"));
  // 3) 环境变量显式指定
  if (process.env.DSH_NODE_MODULES) out.push(process.env.DSH_NODE_MODULES);
  return out.filter((p) => existsSync(p));
}

function findSource(name) {
  for (const base of candidates()) {
    const pkgDir = join(base, "@deepseek-ai", name);
    if (existsSync(join(pkgDir, "package.json"))) return pkgDir;
  }
  return null;
}

function linkOne(destRoot, name) {
  const dest = join(destRoot, "@deepseek-ai", name);
  if (existsSync(join(dest, "package.json"))) return "present";
  const src = findSource(name);
  if (!src) return "missing";
  mkdirSync(dirname(dest), { recursive: true });
  try {
    // Windows 下给目录建符号链接需要开发者模式或管理员；失败时退化为 junction
    symlinkSync(src, dest, process.platform === "win32" ? "junction" : "dir");
    return "linked";
  } catch (e) {
    try {
      symlinkSync(src, dest, "junction");
      return "linked";
    } catch (e2) {
      return "failed";
    }
  }
}

function main() {
  const root = join(ROOT, "node_modules");
  // 已存在真实目录（开发者在跑 npm install）就不要动
  let isReal = false;
  try { isReal = existsSync(root) && !lstatSync(root).isSymbolicLink(); } catch (e) {}
  if (isReal && existsSync(join(root, "@deepseek-ai", "schemastery"))) return;

  const results = NEEDED.map((n) => [n, linkOne(root, n)]);
  const missing = results.filter(([, r]) => r === "missing" || r === "failed");
  if (missing.length) {
    console.warn(
      `[pretest] 未找到 DSH 自带的 ${missing.map(([n]) => n).join(", ")}。\n` +
      "[pretest] 宿主半只依赖 DSH 运行时的这两个包；本地跑测试需要先安装 DSH，\n" +
      "[pretest] 或用 DSH_NODE_MODULES=<含 @deepseek-ai/schemastery 的 node_modules> 指定位置。"
    );
  }
}

main();
