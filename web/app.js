/* global initSqlJs, vis */

const state = {
  SQL: null,
  db: null,
  manifest: null,
  network: null,
  lastContext: null,
  aiBusy: false,
  aiNextAllowedAt: 0,
};

function $(id) {
  return document.getElementById(id);
}

function setStatus(text, kind = "warn") {
  const el = $("dbStatus");
  el.textContent = text;
  el.className = `mono ${kind}`;
}

function fmt(v) {
  if (v === null || v === undefined) return "-";
  if (typeof v === "number") {
    if (Number.isFinite(v) && Math.abs(v) < 1e6) return String(Math.round(v * 1000) / 1000);
    return String(v);
  }
  return String(v);
}

function kvRender(targetEl, obj) {
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    targetEl.innerHTML = '<div class="muted">-</div>';
    return;
  }
  targetEl.innerHTML = entries
    .map(([k, v]) => `<div class="mono">${k}</div><div class="mono">${fmt(v)}</div>`)
    .join("");
}

function execOne(sql, params = []) {
  const stmt = state.db.prepare(sql);
  stmt.bind(params);
  if (!stmt.step()) {
    stmt.free();
    return null;
  }
  const row = stmt.getAsObject();
  stmt.free();
  return row;
}

function execAll(sql, params = []) {
  const stmt = state.db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function setDatasetHint(text) {
  const el = $("datasetHint");
  if (!el) return;
  el.textContent = text || "";
}

function setDatasetOptions(hits, selectedDataset) {
  const sel = $("datasetSelect");
  if (!sel) return;

  const opts = [{ value: "", label: "（自动：任意数据集）" }];
  (hits || []).forEach((h) => {
    const ds = String(h.dataset || "default");
    opts.push({ value: ds, label: ds });
  });

  sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join("");

  // Choose selected if present, else keep current if valid, else auto, else first hit.
  const cur = String(sel.value || "");
  const allowed = new Set(opts.map((o) => String(o.value)));
  let v = String(selectedDataset || "");
  if (!allowed.has(v)) v = allowed.has(cur) ? cur : "";
  if (!v && hits && hits.length) v = String(hits[0].dataset || "");
  sel.value = v;

  // Disable when only one hit.
  sel.disabled = !(hits && hits.length > 1);
}

function renderMembers(members) {
  if (!members || members.length === 0) {
    $("members").innerHTML = '<span class="err">未找到成员</span>';
    return;
  }
  const html = members
    .slice(0, 200)
    .map((m) => {
      const kp = Number(m.key_person_flag) === 1 ? `<span class="badge">关键人</span>` : "";
      return `<div class="mPill"><span class="avatar" aria-hidden="true"></span><span class="mono">${m.subs_id}</span>${kp}</div>`;
    })
    .join("");
  $("members").innerHTML =
    html + (members.length > 200 ? `<div class="muted">... 还有 ${members.length - 200} 人未展开</div>` : "");
}

function renderEdgeTable(edges) {
  const tbody = $("edgeTable");
  if (!edges || edges.length === 0) {
    tbody.innerHTML = `<tr><td class="muted" colspan="5">无边（可能是单人家庭或 top-k 截断）</td></tr>`;
    return;
  }
  tbody.innerHTML = edges
    .slice(0, 200)
    .map((e) => {
      const rule = e.rule_hit ? `<span class="ok mono">${e.rule_hit}</span>` : `<span class="muted mono">-</span>`;
      return `<tr>
        <td class="mono">${e.u}</td>
        <td class="mono">${e.v}</td>
        <td class="mono">${fmt(e.same_family_prob)}</td>
        <td>${rule}</td>
        <td class="mono">${fmt(e.call_cnt)}</td>
      </tr>`;
    })
    .join("");
}

function renderGraph(members, edges) {
  const container = $("graph");
  const memberSet = new Set((members || []).map((m) => String(m.subs_id)));

  const nodes = (members || []).map((m) => ({
    id: String(m.subs_id),
    label: String(m.subs_id),
    shape: "dot",
    size: Number(m.key_person_flag) === 1 ? 18 : 10,
    color: Number(m.key_person_flag) === 1 ? "#111827" : "#2563eb",
    font: { color: "#111827", size: 12, face: "monospace" },
  }));

  const links = (edges || [])
    .filter((e) => memberSet.has(String(e.u)) && memberSet.has(String(e.v)))
    .slice(0, 400)
    .map((e) => ({
      from: String(e.u),
      to: String(e.v),
      value: Number(e.same_family_prob) || 0,
      title: `prob=${fmt(e.same_family_prob)} rule=${e.rule_hit || "-"}`,
      color: e.rule_hit ? "#111827" : "rgba(37,99,235,0.28)",
      width: e.rule_hit ? 2.5 : 1.0,
    }));

  $("edgeCount").textContent = String(links.length);

  const data = { nodes: new vis.DataSet(nodes), edges: new vis.DataSet(links) };
  const options = {
    physics: { stabilization: false, barnesHut: { gravitationalConstant: -12000, springLength: 140 } },
    interaction: { hover: true, tooltipDelay: 50 },
  };

  if (state.network) {
    state.network.setData(data);
    return;
  }
  state.network = new vis.Network(container, data, options);
}

function setAiStatus(text, kind = "muted") {
  const el = $("aiStatus");
  if (!el) return;
  el.textContent = text;
  el.className = `mono ${kind}`;
}

function renderAiOutput(objOrText) {
  const out = $("aiOutput");
  if (!out) return;
  if (!objOrText) {
    out.textContent = "";
    return;
  }
  if (typeof objOrText === "string") {
    out.textContent = objOrText;
    return;
  }
  out.textContent = JSON.stringify(objOrText, null, 2);
}

function chatEl() {
  return $("chatList");
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeJsonLikeText(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  // Strip ```json fences
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```$/i, "").trim();
  // Normalize smart quotes
  t = t.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  // Python-ish literals -> JSON
  t = t.replace(/\bNone\b/g, "null").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false");
  // Remove trailing commas before } or ]
  t = t.replace(/,\s*([}\]])/g, "$1");
  return t;
}

function tryParseJsonLoose(s) {
  const t = normalizeJsonLikeText(s);
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // Try to repair common single-quote JSON (best-effort; avoid heavy parsing)
    // 1) 'key': -> "key":
    // 2) : 'value' -> : "value"
    const repaired = t
      .replace(/'([^'\\\r\n]+)'\s*:/g, '"$1":')
      .replace(/:\s*'([^'\\\r\n]*)'/g, ': "$1"');
    try {
      return JSON.parse(repaired);
    } catch {
      return null;
    }
  }
}

function addChatMessage(role, html) {
  const list = chatEl();
  if (!list) return;
  const cls = role === "user" ? "msg user" : "msg";
  const div = document.createElement("div");
  div.className = cls;
  div.innerHTML = `<div class="bubble">${html}</div>`;
  list.appendChild(div);
  list.scrollTop = list.scrollHeight;
}

function coerceArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  if (typeof v === "string") return v.trim() ? [v.trim()] : [];
  return [String(v)];
}

function renderStructuredToHtml(obj) {
  if (typeof obj === "string") {
    const parsed = tryParseJsonLoose(obj);
    if (parsed) return renderStructuredToHtml(parsed);
    return `<div class="sec"><div class="secTitle">原始回复</div><pre class="pre mono">${escapeHtml(obj)}</pre></div>`;
  }
  if (!obj || typeof obj !== "object") return escapeHtml(String(obj || ""));

  const evidenceArr = coerceArray(obj.evidence);
  const riskArr = coerceArray(obj.risk_flags);
  const opsArr = coerceArray(obj.ops_actions);
  const qaArr = Array.isArray(obj.qa) ? obj.qa : [];

  const summary = obj.summary ? `<div class="sec"><h4>${escapeHtml(obj.summary)}</h4></div>` : "";

  const evidence =
    evidenceArr.length
      ? `<div class="sec"><div class="secTitle">关键证据</div><ul>${evidenceArr
          .slice(0, 6)
          .map((x) => `<li>${escapeHtml(x)}</li>`)
          .join("")}</ul></div>`
      : "";

  const risks =
    riskArr.length
      ? `<div class="sec"><div class="secTitle">风险提示</div><div class="tags">${riskArr
          .slice(0, 8)
          .map((x) => `<span class="tag risk">${escapeHtml(x)}</span>`)
          .join("")}</div></div>`
      : "";

  const ops =
    opsArr.length
      ? `<div class="sec"><div class="secTitle">运营建议</div><ul>${opsArr
          .slice(0, 6)
          .map((x) => `<li>${escapeHtml(x)}</li>`)
          .join("")}</ul></div>`
      : "";

  const qa =
    qaArr.length
      ? `<div class="sec"><div class="secTitle">常见问答</div>${qaArr
          .slice(0, 6)
          .map((x) => {
            const q = x && typeof x === "object" ? x.q : "";
            const a = x && typeof x === "object" ? x.a : "";
            return `<details class="qa"><summary>${escapeHtml(q || "")}</summary><div class="ans">${escapeHtml(a || "")}</div></details>`;
          })
          .join("")}</div>`
      : "";

  const raw = `<details class="qa raw"><summary>查看原始 JSON</summary><pre class="pre mono">${escapeHtml(
    JSON.stringify(obj, null, 2),
  )}</pre></details>`;

  return `${summary}${evidence}${risks}${ops}${qa}${raw}` || escapeHtml(JSON.stringify(obj));
}

function extractJsonFromText(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  const fenced = normalizeJsonLikeText(s);

  // Try direct parse
  const direct = tryParseJsonLoose(fenced);
  if (direct) return direct;

  // Try find first balanced {...}
  const start = fenced.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < fenced.length; i++) {
    const ch = fenced[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const cand = fenced.slice(start, i + 1);
        return tryParseJsonLoose(cand);
      }
    }
  }
  return null;
}

function buildAiContext() {
  if (!state.lastContext) return null;
  const { subsId, familyId, dataset, members, profile, edges, threshold } = state.lastContext;
  return {
    subs_id: subsId,
    family_id_pred: familyId,
    dataset,
    threshold,
    members_count: members.length,
    key_person: (members.find((m) => Number(m.key_person_flag) === 1) || {}).subs_id || null,
    profile,
    evidence_edges_top: (edges || []).slice(0, 30).map((e) => ({
      u: e.u,
      v: e.v,
      prob: e.same_family_prob,
      rule: e.rule_hit || "",
      call_cnt: e.call_cnt,
      call_days: e.call_days,
      call_bases: e.call_bases,
    })),
  };
}

async function callAi(action) {
  if (state.aiBusy) return;
  const ctx = buildAiContext();
  if (!ctx) {
    setAiStatus("no family", "warn");
    addChatMessage("assistant", "请先查询一个 <span class='mono'>subs_id</span>，我才能结合该家庭圈为你解读。");
    return;
  }

  const now = Date.now();
  if (now < state.aiNextAllowedAt) {
    const sec = Math.ceil((state.aiNextAllowedAt - now) / 1000);
    setAiStatus(`cooldown ${sec}s`, "warn");
    return;
  }

  state.aiBusy = true;
  state.aiNextAllowedAt = now + 6000; // client-side throttle (avoid upstream 429)
  setAiStatus("calling...", "warn");
  // no-op

  const question = String($("aiQuestion")?.value || "").trim();
  const fallbackQ =
    action === "ops"
      ? "请给出该家庭的可落地运营建议（3条），并说明原因。"
      : action === "qa"
        ? "请用一句话总结这个家庭，并回答：这个家庭有几口人？"
        : "请对该家庭圈做结构化解读：一句话总结、证据、风险提示、建议动作。";
  const userQ = question || fallbackQ;
  addChatMessage("user", escapeHtml(userQ));
  try {
    const r = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, question: userQ, context: ctx }),
    });

    const j = await r.json().catch(() => null);
    if (!r.ok) {
      setAiStatus(`error ${r.status}`, "err");
      // If upstream rate-limited, extend cooldown to reduce repeated 429.
      const upstreamStatus = j && j.status !== undefined ? Number(j.status) : null;
      if (r.status === 429 || upstreamStatus === 429) {
        state.aiNextAllowedAt = Date.now() + 15000;
      }
      const err = j && j.error ? String(j.error) : "";
      const detail = j && j.detail ? String(j.detail) : "";
      const upstreamStatusStr = j && j.status !== undefined ? String(j.status) : "";
      const parts = [];
      if (err) parts.push(`error: ${err}`);
      if (upstreamStatusStr) parts.push(`upstream_status: ${upstreamStatusStr}`);
      if (detail) parts.push(`detail: ${detail}`);
      const hint =
        parts.length > 0
          ? parts.join("\n")
          : "AI 接口不可用。若本地测试：请在 web/.env.local 写入 ZHIPU_API_KEY=你的Key，然后重启 local_dev_server.js；或在启动前 export ZHIPU_API_KEY=你的Key。";
      addChatMessage("assistant", `<span class="err">${escapeHtml(hint)}</span>`);
      return;
    }

    setAiStatus("on", "ok");
    const structured = j && j.structured;
    if (structured) {
      addChatMessage("assistant", renderStructuredToHtml(structured));
    } else {
      const raw = (j && (j.reply || "")) || "";
      const maybe = extractJsonFromText(raw);
      if (maybe) {
        addChatMessage("assistant", renderStructuredToHtml(maybe));
      } else {
        addChatMessage("assistant", escapeHtml(raw || "好的"));
      }
    }
  } catch (e) {
    setAiStatus("off", "muted");
    addChatMessage("assistant", "AI 服务暂时不可用，请稍后重试。");
  } finally {
    state.aiBusy = false;
  }
}

async function loadManifest() {
  try {
    // Prefer manifests map (dataset -> manifest); fallback to single manifest.json
    const r2 = await fetch("./data/manifests.json", { cache: "no-store" });
    if (r2.ok) {
      state.manifest = await r2.json();
      return;
    }
    const r = await fetch("./data/manifest.json", { cache: "no-store" });
    if (!r.ok) return;
    state.manifest = { default: await r.json() };
  } catch {
    // ignore
  }
}

async function loadDb() {
  setStatus("downloading db...", "warn");
  const SQL = await initSqlJs({
    locateFile: (file) => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`,
  });
  state.SQL = SQL;

  const r = await fetch("./data/family.db", { cache: "no-store" });
  if (!r.ok) throw new Error("failed to fetch ./data/family.db");
  const buf = await r.arrayBuffer();
  state.db = new SQL.Database(new Uint8Array(buf));
  setStatus("ready", "ok");
}

async function loadCvMetrics() {
  try {
    const r = await fetch("./data/cv_metrics.json", { cache: "no-store" });
    if (!r.ok) {
      kvRender($("cvInfo"), {});
      return;
    }
    const j = await r.json();
    kvRender($("cvInfo"), {
      mean_precision: j.mean_precision,
      mean_recall: j.mean_recall,
      mean_f1: j.mean_f1,
      mean_threshold: j.mean_threshold,
    });
  } catch {
    kvRender($("cvInfo"), {});
  }
}

function querySubs(subsIdRaw) {
  const subsId = String(subsIdRaw || "").trim();
  if (!subsId) return;

  const hits = execAll(
    "SELECT dataset, family_id_pred, key_person_flag FROM families WHERE subs_id = ? ORDER BY dataset ASC LIMIT 50",
    [subsId],
  );
  if (!hits || hits.length === 0) {
    kvRender($("basicInfo"), { subs_id: subsId, status: "NOT_FOUND" });
    $("members").innerHTML = '<span class="err">未找到该 subs_id（请确认输入或换一个）</span>';
    kvRender($("profile"), {});
    renderEdgeTable([]);
    renderGraph([], []);
    setDatasetHint("");
    return;
  }

  const preferredDataset = String($("datasetSelect")?.value || "").trim();
  const selected =
    (preferredDataset ? hits.find((h) => String(h.dataset || "") === preferredDataset) : null) || hits[0];

  setDatasetOptions(hits, preferredDataset);
  setDatasetHint(
    hits.length > 1
      ? `命中 ${hits.length} 个数据集：请选择一个数据集后查看该数据集下的家庭圈。`
      : "",
  );

  const familyId = selected.family_id_pred;
  const dataset = selected.dataset || "default";
  const members = execAll(
    "SELECT subs_id, key_person_flag FROM families WHERE family_id_pred = ? ORDER BY key_person_flag DESC, subs_id ASC",
    [familyId],
  );
  const profile = execOne("SELECT * FROM family_profile WHERE family_id_pred = ? LIMIT 1", [familyId]) || {};
  const edges = execAll(
    "SELECT u,v,same_family_prob,rule_hit,call_cnt,call_days,call_bases FROM edges WHERE family_id_pred = ? ORDER BY same_family_prob DESC LIMIT 200",
    [familyId],
  );

  // threshold display: dataset-specific if manifests.json exists
  const m = (state.manifest && state.manifest[dataset]) || (state.manifest && state.manifest.default) || null;
  if (m && m.threshold !== undefined) $("threshold").textContent = fmt(m.threshold);
  const threshold = m && m.threshold !== undefined ? m.threshold : null;

  kvRender($("basicInfo"), {
    subs_id: subsId,
    dataset,
    hits: hits.length,
    family_id_pred: familyId,
    key_person_flag: selected.key_person_flag,
    members: members.length,
  });
  renderMembers(members);
  kvRender($("profile"), profile);
  renderEdgeTable(edges);
  renderGraph(members, edges);

  // Save context for AI
  state.lastContext = {
    subsId,
    familyId,
    dataset,
    threshold,
    members,
    profile,
    edges,
  };
  setAiStatus("off", "muted");
}

async function main() {
  await loadManifest();
  await loadCvMetrics();
  await loadDb();

  $("btnQuery").addEventListener("click", () => querySubs($("subsInput").value));
  $("subsInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") querySubs($("subsInput").value);
  });
  if ($("datasetSelect")) {
    $("datasetSelect").addEventListener("change", () => querySubs($("subsInput").value));
  }

  // Chat UI
  if (chatEl()) {
    addChatMessage("assistant", "你好，我可以帮你解读当前家庭圈、给出运营建议，也可以回答你关于该家庭的任何问题。");
  }
  if ($("btnAiSend")) $("btnAiSend").addEventListener("click", () => callAi("qa"));
  if ($("aiQuestion")) {
    $("aiQuestion").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        callAi("qa");
      }
    });
  }
  if ($("chipExplain")) $("chipExplain").addEventListener("click", () => callAi("explain"));
  if ($("chipOps")) $("chipOps").addEventListener("click", () => callAi("ops"));
  if ($("chipRisk")) {
    $("chipRisk").addEventListener("click", () => {
      if ($("aiQuestion")) $("aiQuestion").value = "请从风险与稳定性角度分析该家庭，并给出需要关注的点（Top3）。";
      callAi("qa");
    });
  }
  if ($("chipWhy")) {
    $("chipWhy").addEventListener("click", () => {
      if ($("aiQuestion")) $("aiQuestion").value = "为什么这个家庭的关键人是当前标记的成员？请给出可解释的理由。";
      callAi("qa");
    });
  }

  // Parallax background
  const bg1 = document.getElementById("bg1");
  const bg2 = document.getElementById("bg2");
  let mx = 0, my = 0;
  window.addEventListener("mousemove", (ev) => {
    mx = (ev.clientX / window.innerWidth - 0.5) * 2;
    my = (ev.clientY / window.innerHeight - 0.5) * 2;
  });
  window.addEventListener("scroll", () => {
    const s = window.scrollY || 0;
    if (bg1) bg1.style.transform = `translate3d(${mx * 10}px, ${my * 10 + s * 0.02}px, 0)`;
    if (bg2) bg2.style.transform = `translate3d(${mx * 18}px, ${my * 14 + s * 0.04}px, 0)`;
  }, { passive: true });
  // initial tick
  setTimeout(() => {
    const s = window.scrollY || 0;
    if (bg1) bg1.style.transform = `translate3d(0px, ${s * 0.02}px, 0)`;
    if (bg2) bg2.style.transform = `translate3d(0px, ${s * 0.04}px, 0)`;
  }, 50);
}

main().catch((e) => {
  setStatus("error", "err");
  console.error(e);
});


