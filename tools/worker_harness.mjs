// tools/worker_harness.mjs —— 在 Node 里跑 worker.js 的 fetch handler
// 用法: node worker_harness.mjs <path?query>   环境变量里给 INSTABOX_* / TOKEN
//
// 只用 node 自带的 fetch 和 KV 桩，不需要 wrangler；worker 里的 fetch 走真网络，
// 但 INSTABOX_API_URL 指向本地假 API，所以不会碰到 instabox.sh。
import worker from "../worker/worker.js";

const argv = process.argv.slice(2);
// run_tests.sh 走 WK_PATH 传路径，而且故意去掉开头的 /（Git Bash 会把以 / 开头的值
// 当 Windows 路径改写）。这里补回来；直接手跑时仍可 `node worker_harness.mjs /accounts`
const path = process.env.WK_PATH !== undefined ? "/" + process.env.WK_PATH : argv[0] || "/";
const BASE = "http://worker.local";

function kvStub() {
  const store = new Map();
  return {
    async get(k) {
      return store.has(k) ? store.get(k) : null;
    },
    async put(k, v) {
      store.set(k, v);
    },
  };
}

const env = { ...process.env };
env.LOG = kvStub();

const req = new Request(BASE + path, { method: "GET" });
const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
const text = await res.text();

// 每行一个断言用的标记：第一行 HTTP 码，其余是 body
console.log(`STATUS ${res.status}`);
console.log(text);
