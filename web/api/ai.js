/**
 * Vercel Serverless Function: /api/ai
 *
 * IMPORTANT:
 * - Do NOT put API keys in frontend code.
 * - Configure env var: ZHIPU_API_KEY in Vercel project settings.
 *
 * This endpoint calls Zhipu GLM (default: GLM-4-Flash-250414) and returns a structured JSON.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 6; // conservative: upstream key-level limits may be stricter

// best-effort in-memory limiter (resets on cold start)
const ipBuckets = new Map();

function getZhipuModel() {
  return process.env.ZHIPU_MODEL || "GLM-4-Flash-250414";
}

function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  const xrip = req.headers["x-real-ip"];
  if (typeof xrip === "string" && xrip.length) return xrip.trim();
  return req.socket?.remoteAddress || "unknown";
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
  const { action, question, context } = payload || {};
  return JSON.stringify(
    {
      task: action || "explain",
      question: question || "",
      context: context || {},
      constraints: {
        no_external_data: true,
        output_json_only: true,
      },
    },
    null,
    2,
  );
}

module.exports = async (req, res) => {
  // CORS for same-origin + local testing
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
    return;
  }

  const ip = getClientIp(req);
  const rl = rateLimitOk(ip);
  res.setHeader("X-RateLimit-Limit", String(RATE_LIMIT_MAX));
  res.setHeader("X-RateLimit-Remaining", String(rl.remaining));
  res.setHeader("X-RateLimit-ResetMs", String(rl.resetMs));

  if (!rl.ok) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Rate limited. Please slow down." }));
    return;
  }

  const apiKey = process.env.ZHIPU_API_KEY;
  if (!apiKey) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Missing env var ZHIPU_API_KEY" }));
    return;
  }

  let body = "";
  await new Promise((resolve) => {
    req.on("data", (chunk) => (body += chunk));
    req.on("end", resolve);
  });

  const payload = safeJsonParse(body) || {};

  // Keep prompt concise to respect rate limits & latency.
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    { role: "user", content: buildUserPrompt(payload) },
  ];

  try {
    const upstream = await fetch("https://open.bigmodel.cn/api/paas/v4/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: getZhipuModel(),
        messages,
        thinking: { type: "disabled" },
        temperature: 0.2,
        max_tokens: 1200,
        stream: false,
      }),
    });

    const text = await upstream.text();
    if (!upstream.ok) {
      // Pass through upstream rate limit so client can show correct reason/cooldown.
      res.statusCode = upstream.status === 429 ? 429 : 502;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: "Upstream error", status: upstream.status, detail: text.slice(0, 2000) }));
      return;
    }

    const json = safeJsonParse(text) || {};
    const content =
      json?.choices?.[0]?.message?.content ??
      json?.data?.choices?.[0]?.message?.content ??
      json?.choices?.[0]?.delta?.content ??
      "";

    // Try parse JSON result; if model returns non-JSON, wrap it.
    const structured = typeof content === "string" ? safeJsonParse(content) : null;
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify(
        {
          ok: true,
          model: getZhipuModel(),
          structured: structured || null,
          reply: structured ? null : String(content || ""),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "Server error" }));
  }
};


