// 把 ui.js 里的面板 HTML / 登录页 HTML、telegram.js 里的机器人逻辑内联进 worker.js，
// 产出一个可以直接粘到 Cloudflare 网页面板的单文件版本：worker/dist/worker.js
//
//   node build.mjs        （或 npm run build）
//
// 平时改代码只改 worker.js / ui.js / telegram.js，dist 是生成物，别手改。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

const IMPORT_RE = /^import \{ UI_HTML, LOGIN_HTML \} from "\.\/ui\.js";\s*$/m;
// 只匹配「从 telegram.js 拿东西」这件事本身，具体导出哪些名字不管 ——
// 以后加导出（比如 tgView）不用回来改构建脚本
const TG_IMPORT_RE = /^import \{[^}]*\} from "\.\/telegram\.js";\s*$/m;

let worker = read("worker.js");
if (!IMPORT_RE.test(worker)) {
  console.error('构建失败：worker.js 里找不到 import { UI_HTML, LOGIN_HTML } from "./ui.js"; 这一行');
  process.exit(1);
}
if (!TG_IMPORT_RE.test(worker)) {
  console.error('构建失败：worker.js 里找不到 import { ... } from "./telegram.js"; 这一行');
  process.exit(1);
}

const ui = read("ui.js").replace(/^export\s+const\s+/gm, "const ");
for (const name of ["UI_HTML", "LOGIN_HTML"]) {
  if (!new RegExp("^const " + name + " = String\\.raw`", "m").test(ui)) {
    console.error("构建失败：ui.js 里没有 export const " + name + " = String.raw`…`");
    process.exit(1);
  }
}

// 机器人模块里只有函数/常量导出，去掉 export 前缀就能当普通代码内联
const tg = read("telegram.js").replace(/^export\s+/gm, "");
if (!/^(async )?function handleTelegram\b/m.test(tg)) {
  console.error("构建失败：telegram.js 里没有 handleTelegram");
  process.exit(1);
}

const banner = [
  "// ---------------------------------------------------------------",
  "// 自动生成，请勿直接修改：源码在 worker/worker.js + worker/ui.js + worker/telegram.js",
  "// 重新生成： node worker/build.mjs",
  "// ---------------------------------------------------------------",
  "",
].join("\n");

// 用函数式 replace，避免 HTML 里的 $& / $1 被当成替换模式
const out = banner + worker.replace(IMPORT_RE, () => ui.trim()).replace(TG_IMPORT_RE, () => tg.trim());
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "worker.js"), out);
console.log("已生成 worker/dist/worker.js（" + out.length + " 字节）");
