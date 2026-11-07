import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = dirname(here);
const config = join(here, "wrangler.local.toml");

function fail(message) {
  console.error(`\n部署已中止：${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || here,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) {
    if (options.capture) process.stderr.write(result.stderr || "");
    process.exit(result.status || 1);
  }
  return result.stdout || "";
}

let allowDirty = false;
const forwarded = [];
for (const arg of process.argv.slice(2)) {
  if (arg === "--allow-dirty") allowDirty = true;
  else forwarded.push(arg);
}

if (!existsSync(config)) {
  fail("缺少 worker/wrangler.local.toml。请先复制 wrangler.local.example.toml，填入自己的 KV namespace ID。");
}

const configText = readFileSync(config, "utf8");
const bindings = new Set();
for (const match of configText.matchAll(/\[\[kv_namespaces\]\]([\s\S]*?)(?=\n\[\[|$)/g)) {
  const block = match[1];
  const binding = /^\s*binding\s*=\s*"([^"]+)"/m.exec(block);
  const id = /^\s*id\s*=\s*"([^"]+)"/m.exec(block);
  if (binding && id && !id[1].includes("<")) bindings.add(binding[1]);
}
for (const required of ["LOG", "CONFIG"]) {
  if (!bindings.has(required)) fail(`wrangler.local.toml 缺少有效 KV 绑定 ${required}。`);
}

console.log("构建 Worker 产物…");
run(process.execPath, ["build.mjs"]);

if (!allowDirty) {
  const dirty = run("git", ["status", "--porcelain"], { cwd: repo, capture: true }).trim();
  if (dirty) {
    fail("工作区有未提交改动。请先提交代码，或仅在本地验证时使用 npm run deploy:dry-run。");
  }
}

const pkg = JSON.parse(readFileSync(join(here, "package.json"), "utf8"));
const sha = run("git", ["rev-parse", "--short", "HEAD"], { cwd: repo, capture: true }).trim() || "unknown";
const args = ["deploy", "--config", "wrangler.local.toml", "--keep-vars", "--strict"];
if (!forwarded.includes("--message")) args.push("--message", `deploy v${pkg.version || "unknown"} ${sha}`);
args.push(...forwarded);

const wranglerBin = String(process.env.WRANGLER_BIN || "").trim();
const version = String(process.env.WRANGLER_VERSION || "4.158.0").trim();
const command = wranglerBin || (process.platform === "win32" ? "npx.cmd" : "npx");
const commandArgs = wranglerBin ? args : ["--yes", `wrangler@${version}`, ...args];
console.log(`执行安全部署：${wranglerBin || `npx --yes wrangler@${version}`} ${args.join(" ")}`);
const quoteCmd = (value) => `"${String(value).replace(/"/g, '""')}"`;
let result;
if (process.platform === "win32") {
  // cmd.exe 负责执行 .cmd；手动拼接并逐个引用参数，兼容含空格的全局 wrangler 路径。
  const line = [command, ...commandArgs].map(quoteCmd).join(" ");
  result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${line}"`], {
    cwd: here,
    stdio: "inherit",
    env: process.env,
    windowsVerbatimArguments: true,
  });
} else {
  result = spawnSync(command, commandArgs, {
    cwd: here,
    stdio: "inherit",
    env: process.env,
  });
}
if (result.error) fail(result.error.message);
process.exit(result.status || 0);
