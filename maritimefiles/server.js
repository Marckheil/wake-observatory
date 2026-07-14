// Wake-Time Observatory
// A Maritime-hosted agent that measures Maritime's own cold-start latency.
//
// Each cycle, for every sleeper agent:
//   1. `maritime chat <sleeper> ping`  -> agent auto-wakes  -> log as COLD
//   2. `maritime chat <sleeper> ping`  -> agent already up  -> log as WARM
//   3. `maritime sleep <sleeper>`      -> guarantee the next cycle is cold
//
// Zero npm dependencies. Requires: maritime-cli on PATH, MARITIME_TOKEN env var.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

// ---------- config (all overridable via env) ----------
const PORT = parseInt(process.env.PORT || "8080", 10);
const SLEEPERS = (process.env.SLEEPERS || "sleeper-a,sleeper-b")
  .split(",").map(s => s.trim()).filter(Boolean);
const CYCLE_MINUTES = parseFloat(process.env.CYCLE_MINUTES || "20");
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.jsonl");
const CHAT_TIMEOUT_MS = 120000;

// ---------- maritime CLI wrapper ----------
function maritime(args) {
  return new Promise(resolve => {
    const t0 = Date.now();
    execFile("maritime", [...args, "--json"], { timeout: CHAT_TIMEOUT_MS }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        elapsedMs: Date.now() - t0,
        stdout: (stdout || "").trim(),
        stderr: (stderr || "").trim(),
      });
    });
  });
}

function appendSample(sample) {
  fs.appendFile(DATA_FILE, JSON.stringify(sample) + "\n", err => {
    if (err) console.error("write failed:", err.message);
  });
}

function readSamples() {
  try {
    return fs.readFileSync(DATA_FILE, "utf8")
      .split("\n").filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

// ---------- the measurement cycle ----------
let cycleCount = 0;
let lastCycleAt = null;

async function pingOnce(agent, kind) {
  const res = await maritime(["chat", agent, "ping"]);
  const sample = {
    ts: new Date().toISOString(),
    agent,
    kind,                    // "cold" | "warm"
    elapsedMs: res.elapsedMs,
    ok: res.ok,
  };
  if (!res.ok) sample.error = (res.stderr || "unknown error").slice(0, 300);
  appendSample(sample);
  console.log(`[${sample.ts}] ${agent} ${kind}: ${res.elapsedMs}ms ok=${res.ok}`);
  return sample;
}

async function runCycle() {
  cycleCount += 1;
  lastCycleAt = new Date().toISOString();
  console.log(`--- cycle ${cycleCount} ---`);
  for (const agent of SLEEPERS) {
    await pingOnce(agent, "cold");   // wakes the sleeper (auto-wake on chat)
    await pingOnce(agent, "warm");   // second ping while it is awake
    const slept = await maritime(["sleep", agent]);  // force cold next cycle
    if (!slept.ok) console.error(`could not sleep ${agent}: ${slept.stderr.slice(0, 200)}`);
  }
}

// stagger start so a fresh deploy doesn't hammer immediately after build
setTimeout(() => {
  runCycle();
  setInterval(runCycle, CYCLE_MINUTES * 60 * 1000);
}, 10000);

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

// ---------- HTTP ----------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", cycles: cycleCount, lastCycleAt }));
  }
  if (req.url === "/data.json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(readSamples()));
  }
  if (req.url === "/" || req.url === "/index.html") {
    const samples = readSamples();
    const cold = samples.filter(s => s.kind === "cold");
    const warm = samples.filter(s => s.kind === "warm");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(renderPage({
      samples,
      cold: statsFor(cold),
      warm: statsFor(warm),
      cycleCount,
      lastCycleAt,
    }));
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => console.log(`observatory listening on :${PORT}`));

// ---------- dashboard ----------
function fmt(ms) {
  if (ms == null) return "—";
  return ms >= 10000 ? (ms / 1000).toFixed(1) + "s" : ms.toLocaleString() + "ms";
}

function renderPage({ samples, cold, warm, cycleCount, lastCycleAt }) {
  const points = samples.filter(s => s.ok).map(s => ({
    t: s.ts, agent: s.agent, kind: s.kind, y: s.elapsedMs,
  }));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wake-Time Observatory</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js"></script>
<style>
  :root {
    --paper: #f6f4ee;
    --ink: #14263b;
    --rule: #d8d3c6;
    --cold: #d95d39;
    --warm: #2e7d6e;
    --dim: #6b7686;
  }
  * { box-sizing: border-box; margin: 0; }
  body {
    background: var(--paper);
    color: var(--ink);
    font-family: Georgia, "Times New Roman", serif;
    padding: 40px 24px 64px;
    max-width: 960px;
    margin: 0 auto;
  }
  .eyebrow {
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    font-size: 11px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--dim);
  }
  h1 { font-size: 34px; font-weight: 400; margin: 6px 0 4px; }
  .sub { color: var(--dim); font-style: italic; margin-bottom: 32px; }
  .board {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1px;
    background: var(--rule);
    border: 1px solid var(--rule);
    margin-bottom: 36px;
  }
  .cell { background: var(--paper); padding: 18px 20px; }
  .cell h2 {
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
    font-size: 11px; font-weight: 400;
    letter-spacing: 0.14em; text-transform: uppercase;
    margin-bottom: 12px;
  }
  .cell.cold h2 { color: var(--cold); }
  .cell.warm h2 { color: var(--warm); }
  .row { display: flex; justify-content: space-between; padding: 3px 0; font-size: 15px; }
  .row .k { color: var(--dim); }
  .row .v { font-family: "SF Mono", ui-monospace, Menlo, monospace; }
  .chartwrap { border: 1px solid var(--rule); background: #fffdf8; padding: 16px; }
  canvas { width: 100% !important; }
  footer {
    margin-top: 28px; font-size: 13px; color: var(--dim);
    font-family: "SF Mono", ui-monospace, Menlo, monospace;
  }
  footer a { color: inherit; }
  @media (max-width: 560px) { .board { grid-template-columns: 1fr; } }
</style>
</head>
<body>
  <div class="eyebrow">Instrument · hosted on Maritime · measuring Maritime</div>
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
    cycles run: ${cycleCount} · last cycle: ${lastCycleAt || "warming up"} ·
    raw data: <a href="/data.json">/data.json</a> ·
    method: chat wakes the sleeper (cold), a second chat measures warm, then the sleeper is put back to sleep.
  </footer>

<script>
  const pts = ${JSON.stringify(points)};
  const toXY = kind => pts.filter(p => p.kind === kind)
    .map(p => ({ x: new Date(p.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) + " " + p.agent.slice(-1).toUpperCase(), y: p.y, label: p.agent }));
  const labels = pts.map(p => new Date(p.t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}));
  new Chart(document.getElementById("chart"), {
    type: "scatter",
    data: {
      datasets: [
        { label: "cold", data: pts.filter(p=>p.kind==="cold").map((p,i)=>({x:i, y:p.y, meta:p})), backgroundColor: "#d95d39" },
        { label: "warm", data: pts.filter(p=>p.kind==="warm").map((p,i)=>({x:i, y:p.y, meta:p})), backgroundColor: "#2e7d6e" }
      ]
    },
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
