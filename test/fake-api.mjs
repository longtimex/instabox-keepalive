// 假 InstaBox API：给 test/shell.test.sh 用，不需要真账号。
// 故意返回 pretty JSON（多行），用来验证脚本的解析逻辑。
import http from "node:http";

const port = Number(process.argv[2] || 18099);
const machines = [
  { id: "m_1", name: "qqq", state: "running" },
  { id: "m_2", name: "box2", state: "running" },
];

http
  .createServer((req, res) => {
    const key = req.headers["x-api-key"] || "";
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(typeof body === "string" ? body : JSON.stringify(body, null, 2));
    };

    // 告警 webhook：一个正常、一个 500、一个连上就不回（测超时不用，太慢）
    if (req.url === "/hook-ok") return send(200, { ok: true });
    if (req.url === "/hook-500") return send(500, { error: "boom" });

    if (key !== "ibk_good") return send(401, { error: "bad key" });

    if (req.method === "GET" && req.url === "/v1/machines") return send(200, { machines });

    const one = /^\/v1\/machines\/([^/]+)$/.exec(req.url || "");
    if (req.method === "GET" && one) {
      const hit = machines.find((m) => m.id === one[1] || m.name === one[1]);
      return hit ? send(200, hit) : send(404, { error: "not found" });
    }

    if (req.method === "PUT" && /\/activity-leases\//.test(req.url || "")) {
      return send(200, { expiresAt: new Date(Date.now() + 300_000).toISOString() });
    }
    if (req.method === "DELETE" && /\/activity-leases\//.test(req.url || "")) {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "POST" && /\/(resume|start)$/.test(req.url || "")) {
      res.writeHead(202);
      return res.end();
    }
    send(404, { error: "not found" });
  })
  .listen(port, "127.0.0.1", () => console.log("fake api on " + port));
