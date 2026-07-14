# Wake-Time Observatory

An agent hosted on Maritime that measures Maritime's own cold-start latency —
independent, continuous verification of the platform's core claim: agents
sleep when idle and wake fast on the next message.

## How it works

Two ZeroClaw "sleeper" agents exist only to be woken. On a fixed cycle, this
probe (itself a Maritime public web agent) uses the Maritime CLI:

1. `maritime chat <sleeper> ping` — the sleeping agent auto-wakes → logged as a **cold** sample
2. `maritime chat <sleeper> ping` — agent already running → logged as a **warm** sample
3. `maritime sleep <sleeper>` — guarantees the next cycle measures a true cold start

Every sample is appended to `data.jsonl`. The dashboard (served by this same
agent at `/`) shows p50 / p95 / worst-case for cold vs warm, plus every raw
data point.

## Why cold *and* warm?

Warm replies are the control group. The gap between the two series isolates
the actual cost of the sleep/wake transition from ordinary chat latency —
that gap *is* Maritime's sleep/wake architecture, made visible.

## Endpoints

- `/` — dashboard
- `/data.json` — raw samples
- `/health` — liveness + cycle count

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `MARITIME_TOKEN` | — (required) | Scoped API key (`maritime keys create`) |
| `SLEEPERS` | `sleeper-a,sleeper-b` | Comma-separated sleeper agent names |
| `CYCLE_MINUTES` | `20` | Minutes between measurement cycles |
| `PORT` | `8080` | HTTP port |

## Notes

- The probe measures **user-experienced time-to-reply** (stopwatch around the
  CLI call). The CLI's chat response contains no server-side timing field, so
  this is the honest, reproducible metric.
- The probe drives Maritime through its documented machine contract
  (`maritime guide --json`) — an AI-agent-operated CLI running inside a
  Maritime agent.
