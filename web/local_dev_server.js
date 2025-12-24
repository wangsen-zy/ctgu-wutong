/**
 * Local dev server for Node 14:
 * - Serves static files under ./ (index.html, app.js, data/*)
 * - Implements POST /api/ai (same behavior as Vercel serverless)
 *
 * Usage:
 *   cd web
 *   export ZHIPU_API_KEY=...
 *   node local_dev_server.js --port 5173
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = (() => {
  const i = process.argv.indexOf("--port");
  if (i >= 0 && process.argv[i + 1]) return Number(process.argv[i + 1]) || 5173;
  return 5173;
})();

const ROOT = __dirname;

// Load env from web/.env.local if present (Node14-friendly, no dependency).
// Format: KEY=VALUE per line, supports comments (#).
try {
  const envPath = path.join(ROOT, ".env.local");
  if (!process.env.ZHIPU_API_KEY && fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const s = String(line || "").trim();
      if (!s || s.startsWith("#")) return;
      const eq = s.indexOf("=");
      if (eq <= 0) return;
      const k = s.slice(0, eq).trim();
      let v = s.slice(eq + 1).trim();
      if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (k && !process.env[k]) process.env[k] = v;
    });
  }
} catch (e) {
  // ignore
}

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
// Keep conservative locally too; upstream key-level limits may be stricter.
const RATE_LIMIT_MAX = 6;
const ipBuckets = new Map();

function getZhipuModel() {
  return process.env.ZHIPU_MODEL || "GLM-4-Flash-250414";
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const xrip = req.headers["x-real-ip"];
  if (typeof xrip === "string" && xrip.length) return xrip.trim();
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

function rateLimitOk(ip) {
  const now = Date.now();
  const b = ipBuckets.get(ip);
  if (!b || now - b.ts > RATE_LIMIT_WINDOW_MS) {
    ipBuckets.set(ip, { ts: now, cnt: 1 });
    return { ok: true, remaining: RATE_LIMIT_MAX - 1, resetMs: RATE_LIMIT_WINDOW_MS };
  }
  if (b.cnt >= RATE_LIMIT_MAX) {
    return { ok: false, remaining: 0, resetMs: RATE_LIMIT_WINDOW_MS - (now - b.ts) };
  }
  b.cnt += 1;
  return { ok: true, remaining: RATE_LIMIT_MAX - b.cnt, resetMs: RATE_LIMIT_WINDOW_MS - (now - b.ts) };
}

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(obj, null, 2));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function buildSystemPrompt() {
  return [
    "你是中国移动家庭运营与数据挖掘专家。",
    "你会根据输入的家庭圈离线预计算结果（家庭成员、画像、证据边等），输出可解释的分析与建议。",
    "要求：1) 只基于输入内容推断；2) 严谨、可落地；3) 用中文；4) 输出必须是 JSON（不要 markdown/不要代码块）。",
    "禁止：不要输出 ```json 或 ``` 这样的代码块标记；不要输出任何 markdown 标题/列表语法。",
    "JSON 格式：",
    "{",
    '  "summary": "一句话总结",',
    '  "evidence": ["证据1", "证据2", "证据3"],',
    '  "risk_flags": ["风险点1", "风险点2"],',
    '  "ops_actions": ["运营动作1", "运营动作2", "运营动作3"],',
    '  "qa": [{"q":"问题","a":"回答"}]',
    "}",
  ].join("\n");
}

function buildUserPrompt(payload) {
  const action = (payload && payload.action) || "explain";
  const question = (payload && payload.question) || "";
  const context = (payload && payload.context) || {};
  return JSON.stringify(
    {
      task: action,
      question: question,
      context: context,
      constraints: { no_external_data: true, output_json_only: true },
    },
    null,
    2,
  );
}

function zhipuChatCompletion(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      model: getZhipuModel(),
      messages: [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: buildUserPrompt(payload) },
      ],
      thinking: { type: "disabled" },
      temperature: 0.2,
      max_tokens: 1200,
      stream: false,
    });

    const req = https.request(
      {
        hostname: "open.bigmodel.cn",
        path: "/api/paas/v4/chat/completions",
        method: "POST",
        headers: {
          Authorization: "Bearer " + apiKey,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: data }));
      },
    );
    req.on("error", reject);
    req.write(postData);
    req.end();
  });
}

function contentTypeFor(p) {
  if (p.endsWith(".html")) return "text/html; charset=utf-8";
  if (p.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (p.endsWith(".json")) return "application/json; charset=utf-8";
  if (p.endsWith(".css")) return "text/css; charset=utf-8";
  if (p.endsWith(".db")) return "application/octet-stream";
  if (p.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || "/");
  const pathname = parsed.pathname || "/";

  // CORS for local testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (pathname === "/api/ai") {
    if (req.method !== "POST") return sendJson(res, 405, { ok: false, error: "Method Not Allowed" });
    const ip = getClientIp(req);
    const rl = rateLimitOk(ip);
    res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
    res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
    res.setHeader("X-RateLimit-ResetMs", String(rl.resetMs));
    if (!rl.ok) return sendJson(res, 429, { ok: false, error: "Rate limited. Please slow down." });

    const apiKey = process.env.ZHIPU_API_KEY;
    if (!apiKey) return sendJson(res, 500, { ok: false, error: "Missing env var ZHIPU_API_KEY" });

    const body = await readBody(req);
    const payload = safeJsonParse(body) || {};
    try {
      const upstream = await zhipuChatCompletion(apiKey, payload);
      if (upstream.status < 200 || upstream.status >= 300) {
        try {
          console.error("[AI] upstream error:", upstream.status, String(upstream.body).slice(0, 500));
        } catch {
          // ignore
        }
        // Pass through upstream rate limit so client can show correct reason/cooldown.
        const code = upstream.status === 429 ? 429 : 502;
        return sendJson(res, code, { ok: false, error: "Upstream error", status: upstream.status, detail: String(upstream.body).slice(0, 2000) });
      }
      const json = safeJsonParse(upstream.body) || {};
      const content = (json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content) || "";
      const structured = typeof content === "string" ? safeJsonParse(content) : null;
      return sendJson(res, 200, { ok: true, model: getZhipuModel(), structured: structured || null, reply: structured ? null : String(content || "") });
    } catch (e) {
      try {
        console.error("[AI] server error:", e && (e.stack || e.message || String(e)));
      } catch {
        // ignore
      }
      return sendJson(res, 500, { ok: false, error: "Server error" });
    }
  }

  // Static files
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(ROOT, filePath);
  if (!abs.startsWith(ROOT)) return sendJson(res, 403, { ok: false, error: "Forbidden" });

  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeFor(abs));
    res.end(buf);
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("Local dev server running at http://0.0.0.0:" + PORT);
  console.log("Static root:", ROOT);
  console.log("API: POST /api/ai (requires env ZHIPU_API_KEY)");
});


