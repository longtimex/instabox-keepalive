#!/usr/bin/env node
// 发布前敏感信息扫描：检查已跟踪文件中的真实凭据、Cloudflare ID、私人邮箱。
//
//   node tools/check_sensitive.mjs [仓库目录]
//
// 退出码：0 = 通过；1 = 发现疑似敏感信息。测试夹具与文档占位符有明确白名单。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 默认扫描脚本所在仓库；可选参数只用于自测/CI 指向临时仓库。
const root = process.argv[2]
  ? resolve(process.argv[2])
  : dirname(dirname(fileURLToPath(import.meta.url)));

const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

const TEXT_EXT = new Set([
  ".sh", ".mjs", ".js", ".cjs", ".json", ".toml", ".yml", ".yaml",
  ".md", ".txt", ".html", ".css", ".py", ".example",
]);

const isText = (file) => {
  if ([".gitignore", ".gitattributes", "LICENSE"].includes(file)) return true;
  const dot = file.lastIndexOf(".");
  return dot >= 0 && TEXT_EXT.has(file.slice(dot).toLowerCase());
};

const findings = [];
const add = (file, line, message) => findings.push({ file, line, message });

// 测试 / 文档中明确允许的假 key。
const FAKE_KEY = /^ibk_(?:testkey|test_key|xxx|aaa|bbb|ccc|second|good|bad)/;
const REAL_KEY = /\bibk_[A-Za-z0-9_-]{8,}\b/g;
const HEX32 = /\b[0-9a-f]{32}\b/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SHAPED_SECRETS = [
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Telegram token：只拦截不以 999 开头、也不含 test 的形态。
  /\b(?!999)\d{6,10}:[A-Za-z0-9_-]{20,}\b/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
];
const allowedHex = new Set([
  "00000000000000000000000000000000",
  "11111111111111111111111111111111",
]);

for (const file of files) {
  if (!isText(file)) continue;
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }

  text.split(/\r?\n/).forEach((line, index) => {
    const lineNo = index + 1;

    for (const match of line.matchAll(REAL_KEY)) {
      if (FAKE_KEY.test(match[0])) continue;
      add(file, lineNo, `疑似真实 InstaBox API key：${match[0].slice(0, 4)}...`);
    }

    for (const match of line.matchAll(HEX32)) {
      if (allowedHex.has(match[0].toLowerCase())) continue;
      add(file, lineNo, `疑似 Cloudflare account/KV ID：${match[0].slice(0, 6)}...`);
    }

    for (const match of line.matchAll(EMAIL)) {
      const value = match[0].toLowerCase();
      if (
        value.endsWith("@users.noreply.github.com") ||
        value.endsWith("@example.com") ||
        value.endsWith("@example.org")
      ) {
        continue;
      }
      add(file, lineNo, `疑似私人邮箱：${value}`);
    }

    for (const pattern of SHAPED_SECRETS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) add(file, lineNo, `疑似真实密钥：${match[0].slice(0, 10)}...`);
    }
  });
}

if (findings.length) {
  console.error("敏感信息检查失败，发现以下内容：");
  for (const f of findings) console.error(`  ${f.file}:${f.line}: ${f.message}`);
  console.error(`\n共 ${findings.length} 处。请改为占位符或从仓库移除。`);
  process.exit(1);
}
console.log(`敏感信息检查通过（扫描 ${files.length} 个已跟踪文件）`);
