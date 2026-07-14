#!/usr/bin/env node
// Wake-Time Observatory — runner (runs on your Mac, NOT on Maritime)
//
// Each cycle, for every sleeper:
//   1. maritime chat <sleeper> ping   -> auto-wakes it     -> COLD sample
//   2. maritime chat <sleeper> ping   -> already awake     -> WARM sample
//   3. maritime sleep <sleeper>       -> next cycle is cold again
// Each sample is POSTed to the station's /ingest endpoint.
//
// Usage:
//   node runner.js https://YOUR-STATION-PUBLIC-URL
//
// Env (optional):
//   SLEEPERS=sleeper-a,sleeper-b   CYCLE_MINUTES=20   INGEST_KEY=...
//
// Requires: maritime CLI logged in on this machine. Keep the Mac awake
// (System Settings > prevent sleep, or run `caffeinate -i node runner.js ...`).

const { execFile } = require("child_process");

const STATION = process.argv[2];
if (!STATION || !STATION.startsWith("http")) {
  console.error("Usage: node runner.js https://YOUR-STATION-PUBLIC-URL");
  process.exit(1);
}
const SLEEPERS = (process.env.SLEEPERS || "sleeper-a,sleeper-b")
  .split(",").map(s => s.trim()).filter(Boolean);
const CYCLE_MINUTES = parseFloat(process.env.CYCLE_MINUTES || "20");
const INGEST_KEY = process.env.INGEST_KEY || "";

function maritime(args) {
  return new Promise(resolve => {
    const t0 = Date.now();
    execFile("maritime", [...args, "--json"], { timeout: 180000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, elapsedMs: Date.now() - t0,
                stderr: (stderr || "").trim().slice(0, 300) });
    });
  });
}

async function report(sample) {
  try {
    const res = await fetch(STATION.replace(/\/$/, "") + "/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 ...(INGEST_KEY ? { "X-Ingest-Key": INGEST_KEY } : {}) },
      body: JSON.stringify(sample),
    });
    if (!res.ok) console.error("  ingest rejected:", res.status, await res.text());
  } catch (e) {
    console.error("  ingest failed (will still continue):", e.message);
  }
}

async function pingOnce(agent, kind) {
  const r = await maritime(["chat", agent, "ping"]);
  const sample = { ts: new Date().toISOString(), agent, kind,
                   elapsedMs: r.elapsedMs, ok: r.ok,
                   ...(r.ok ? {} : { error: r.stderr || "unknown" }) };
  console.log(`  ${agent} ${kind}: ${r.elapsedMs}ms ok=${r.ok}`);
  await report(sample);
}

let cycle = 0;
async function runCycle() {
  cycle += 1;
  console.log(`--- cycle ${cycle} @ ${new Date().toLocaleTimeString()} ---`);
  for (const agent of SLEEPERS) {
    await pingOnce(agent, "cold");
    await pingOnce(agent, "warm");
    const slept = await maritime(["sleep", agent]);
    if (!slept.ok) console.error(`  could not sleep ${agent}: ${slept.stderr}`);
  }
}

console.log(`station: ${STATION}`);
console.log(`sleepers: ${SLEEPERS.join(", ")} | cycle: every ${CYCLE_MINUTES} min`);
runCycle();
setInterval(runCycle, CYCLE_MINUTES * 60 * 1000);
