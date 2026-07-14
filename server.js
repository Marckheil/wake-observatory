// Wake-Time Observatory — station (v2)
// Runs on Maritime as a public web agent. Serves the dashboard and accepts
// measurement samples via POST /ingest from an external runner.
//
// v2 note: v1 measured from inside the agent, but Maritime agents currently
// have no outbound network (DNS resolves, all TCP egress fails), so the
// measurement loop moved to an external runner (runner.js). Inbound serving
// is unaffected. Measuring from outside is also the more honest vantage
// point: it captures what a real user experiences.
//
// Zero npm dependencies.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = parseInt(process.env.PORT || "8080", 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.jsonl");
const INGEST_KEY = process.env.INGEST_KEY || "";  // if set, POST /ingest must send it

// ---------- storage ----------
function appendSample(sample) {
  fs.appendFileSync(DATA_FILE, JSON.stringify(sample) + "\n");
}

function readSamples() {
  try {
    return fs.readFileSync(DATA_FILE, "utf8")
      .split("\n").filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ---------- stats ----------
function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function statsFor(samples) {
  const vals = samples.filter(s => s.ok).map(s => s.elapsedMs).sort((a, b) => a - b);
  return {
    n: vals.length,
    p50: pct(vals, 50),
    p95: pct(vals, 95),
    max: vals.length ? vals[vals.length - 1] : null,
    failures: samples.filter(s => !s.ok).length,
  };
}

// ---------- validation for ingested samples ----------
function validSample(s) {
  return s && typeof s === "object"
    && typeof s.agent === "string" && s.agent.length <= 100
    && (s.kind === "cold" || s.kind === "warm")
    && typeof s.elapsedMs === "number" && s.elapsedMs >= 0 && s.elapsedMs < 10 * 60 * 1000
    && typeof s.ok === "boolean";
}

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  const json = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "POST" && req.url === "/ingest") {
    if (INGEST_KEY && req.headers["x-ingest-key"] !== INGEST_KEY) {
      return json(401, { error: "bad ingest key" });
    }
    let body = "";
    req.on("data", c => { body += c; if (body.length > 100000) req.destroy(); });
    req.on("end", () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(400, { error: "invalid JSON" }); }
      const samples = Array.isArray(parsed) ? parsed : [parsed];
      const accepted = [];
      for (const s of samples) {
        if (!validSample(s)) return json(400, { error: "invalid sample shape" });
        accepted.push({
          ts: typeof s.ts === "string" ? s.ts : new Date().toISOString(),
          agent: s.agent, kind: s.kind,
          elapsedMs: Math.round(s.elapsedMs), ok: s.ok,
          ...(s.error ? { error: String(s.error).slice(0, 300) } : {}),
        });
      }
      accepted.forEach(appendSample);
      console.log(`ingested ${accepted.length} sample(s)`);
      json(200, { stored: accepted.length });
    });
    return;
  }

  if (req.url === "/health") {
    const samples = readSamples();
    return json(200, { status: "ok", samples: samples.length, lastSampleAt: samples.length ? samples[samples.length - 1].ts : null });
  }

  if (req.url === "/data.json") return json(200, readSamples());

  if (req.url === "/" || req.url === "/index.html") {
    const samples = readSamples();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderPage({
      samples,
      cold: statsFor(samples.filter(s => s.kind === "cold")),
      warm: statsFor(samples.filter(s => s.kind === "warm")),
    }));
  }

  json(404, { error: "not found" });
});

server.listen(PORT, () => console.log(`observatory station listening on :${PORT}`));

// ---------- dashboard ----------
function fmt(ms) {
  if (ms == null) return "—";
  return ms >= 10000 ? (ms / 1000).toFixed(1) + "s" : ms.toLocaleString() + "ms";
}

function renderPage({ samples, cold, warm }) {
  const points = samples.filter(s => s.ok).map(s => ({ t: s.ts, agent: s.agent, kind: s.kind, y: s.elapsedMs }));
  const last = samples.length ? samples[samples.length - 1].ts : null;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wake-Time Observatory</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root { --paper:#f6f4ee; --ink:#14263b; --rule:#d8d3c6; --cold:#d95d39; --warm:#2e7d6e; --dim:#6b7686; }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--paper); color: var(--ink); font-family: Georgia, "Times New Roman", serif;
         padding: 40px 24px 64px; max-width: 960px; margin: 0 auto; }
  .eyebrow { font-family: ui-monospace, Menlo, monospace; font-size: 11px; letter-spacing: .18em;
             text-transform: uppercase; color: var(--dim); }
  h1 { font-size: 34px; font-weight: 400; margin: 6px 0 4px; }
  .sub { color: var(--dim); font-style: italic; margin-bottom: 32px; }
  .board { display: grid; grid-template-columns: repeat(2,1fr); gap: 1px; background: var(--rule);
           border: 1px solid var(--rule); margin-bottom: 36px; }
  .cell { background: var(--paper); padding: 18px 20px; }
  .cell h2 { font-family: ui-monospace, Menlo, monospace; font-size: 11px; font-weight: 400;
             letter-spacing: .14em; text-transform: uppercase; margin-bottom: 12px; }
  .cell.cold h2 { color: var(--cold); } .cell.warm h2 { color: var(--warm); }
  .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 15px; }
  .row .k { color: var(--dim); } .row .v { font-family: ui-monospace, Menlo, monospace; }
  .chartwrap { border: 1px solid var(--rule); background: #fffdf8; padding: 16px; }
  canvas { width: 100% !important; }
  footer { margin-top: 28px; font-size: 13px; color: var(--dim); font-family: ui-monospace, Menlo, monospace; }
  footer a { color: inherit; }
  @media (max-width: 560px) { .board { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <div class="eyebrow">Instrument &middot; hosted on Maritime &middot; measuring Maritime</div>
  <h1>Wake-Time Observatory</h1>
  <p class="sub">How long does a sleeping agent take to answer? Every dot below is a real wake.</p>

  <div class="board">
    <div class="cell cold">
      <h2>Cold starts — woken from sleep</h2>
      <div class="row"><span class="k">median (p50)</span><span class="v">${fmt(cold.p50)}</span></div>
      <div class="row"><span class="k">p95</span><span class="v">${fmt(cold.p95)}</span></div>
      <div class="row"><span class="k">slowest</span><span class="v">${fmt(cold.max)}</span></div>
      <div class="row"><span class="k">samples / failures</span><span class="v">${cold.n} / ${cold.failures}</span></div>
    </div>
    <div class="cell warm">
      <h2>Warm replies — already awake</h2>
      <div class="row"><span class="k">median (p50)</span><span class="v">${fmt(warm.p50)}</span></div>
      <div class="row"><span class="k">p95</span><span class="v">${fmt(warm.p95)}</span></div>
      <div class="row"><span class="k">slowest</span><span class="v">${fmt(warm.max)}</span></div>
      <div class="row"><span class="k">samples / failures</span><span class="v">${warm.n} / ${warm.failures}</span></div>
    </div>
  </div>

  <div class="chartwrap"><canvas id="chart" height="130"></canvas></div>

  <footer>
    ${samples.length} samples &middot; last: ${last || "waiting for first ingest"} &middot;
    raw: <a href="/data.json">/data.json</a> &middot;
    method: an external runner wakes a sleeping agent via chat (cold), chats again (warm),
    puts it back to sleep, and reports each timing here.
  </footer>

<script>
  const pts = ${JSON.stringify(points)};
  new Chart(document.getElementById("chart"), {
    type: "scatter",
    data: { datasets: [
      { label: "cold", data: pts.filter(p=>p.kind==="cold").map((p,i)=>({x:i, y:p.y, meta:p})), backgroundColor: "#d95d39" },
      { label: "warm", data: pts.filter(p=>p.kind==="warm").map((p,i)=>({x:i, y:p.y, meta:p})), backgroundColor: "#2e7d6e" }
    ]},
    options: {
      scales: {
        x: { title: { display: true, text: "sample # (chronological)" }, grid: { color: "#eee8da" } },
        y: { title: { display: true, text: "time to reply (ms)" }, grid: { color: "#eee8da" }, beginAtZero: true }
      },
      plugins: {
        tooltip: { callbacks: { label: ctx => {
          const m = ctx.raw.meta;
          return m.agent + " · " + m.kind + " · " + ctx.raw.y + "ms · " + new Date(m.t).toLocaleString();
        }}},
        legend: { labels: { font: { family: "monospace" } } }
      }
    }
  });
</script>
</body>
</html>`;
}
