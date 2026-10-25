// 把 ui.js 里的面板 HTML / 登录页 HTML 内联进 worker.js，产出一个可以直接粘到
// Cloudflare 网页面板的单文件版本：worker/dist/worker.js
//
//   node build.mjs        （或 npm run build）
//
// 平时改代码只改 worker.js / ui.js，dist 是生成物，别手改。
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => readFileSync(join(here, name), "utf8");

const IMPORT_RE = /^import \{ UI_HTML, LOGIN_HTML \} from "\.\/ui\.js";\s*$/m;

let worker = read("worker.js");
if (!IMPORT_RE.test(worker)) {
  console.error('构建失败：worker.js 里找不到 import { UI_HTML, LOGIN_HTML } from "./ui.js"; 这一行');
  process.exit(1);
}

const ui = read("ui.js").replace(/^export\s+const\s+/gm, "const ");
for (const name of ["UI_HTML", "LOGIN_HTML"]) {
  if (!new RegExp("^const " + name + " = String\\.raw`", "m").test(ui)) {
    console.error("构建失败：ui.js 里没有 export const " + name + " = String.raw`…`");
    process.exit(1);
  }
}

const banner = [
  "// ---------------------------------------------------------------",
  "// 自动生成，请勿直接修改：源码在 worker/worker.js + worker/ui.js",
  "// 重新生成： node worker/build.mjs",
  "// ---------------------------------------------------------------",
  "",
].join("\n");

// 用函数式 replace，避免 HTML 里的 $& / $1 被当成替换模式
const out = banner + worker.replace(IMPORT_RE, () => ui.trim());
mkdirSync(join(here, "dist"), { recursive: true });
writeFileSync(join(here, "dist", "worker.js"), out);
console.log("已生成 worker/dist/worker.js（" + out.length + " 字节）");
