# `queue/` — asynchronous execution

BullMQ over Redis. Everything slow, everything that costs money, and everything that can fail halfway happens here.

## Files

| File | Role |
|---|---|
| `queues.ts` | Queue names, job payload types, connection factory, retry policy, `pollDelayMs`. |
| `orchestrator.ts` | `handleGenerate`, `handlePoll`, `fail`, `reconcileOnBoot`. |
| `ingest.ts` | `handleIngest` — download → MinIO → asset + take. Also `createGenerationJob`. |
| `semaphore.ts` | Cross-process provider concurrency limit. |
| `orchestration.int.test.ts` | Real Postgres + Redis + MinIO. |

## Five queues

```
q:generate → submit to provider, return immediately
q:poll     → self-rescheduling progress check
q:ingest   → download artifact, upload to MinIO, create asset + take
q:eval     → automated quality gates (M1+)
q:notify   → payload → Redis pub/sub → SSE
```

## Submit and return

`handleGenerate` acquires a provider slot, calls `provider.submit()`, writes `submitted` plus the provider handle to Postgres, enqueues the first poll, and **finishes**. It never waits for the generation.

Awaiting inside the handler would hold a BullMQ slot for minutes, make lock renewal depend on the event loop yielding, and lose the job on a network blip — with the GPU already paid for.

## `handlePoll` is a self-rescheduling job, not a loop

Each run polls once and enqueues the next with a delay. There is never a pending loop in memory — only delayed entries in Redis — so thousands of concurrent generations do not grow process memory.

`pollDelayMs(n)` backs off 3s → 30s. Past `PROVIDER_TIMEOUT_MS` (15 min) it cancels upstream and fails the job with `timeout` rather than polling forever.

**The `running` branch must publish progress.** `provider.poll()` returns `progressPct` and `stage`; `publishProgress()` turns them into a `job.progress` event on `q:notify`. This step was missing at first: the contract had the event, the SSE layer throttled it, the frontend progress bar waited for it, and nothing ever emitted it. The mock finished too fast for anyone to notice. With a real provider that is a progress bar frozen for minutes — which reads as "hung", so the user hits retry, and on ComfyUI that reloads a 14B model from scratch.

Emit even when `pct` is absent. A `loading_model` stage with a motionless 0% bar says *busy*; sending nothing says *dead*.

## Idempotency, in two layers

1. The provider contract: same `requestId` → same handle, billed once.
2. `UNIQUE(shot_id, attempt)` on `generation_jobs`.

Either alone is enough to prevent double-billing on replay. Both are present because crash recovery replays aggressively and this is the one failure mode with a direct financial cost.

## `reconcileOnBoot`

Redis is disposable; Postgres is the truth. On startup, non-terminal `generation_jobs` rows are re-driven: rows with a provider handle resume polling, rows without are re-queued for submission. Kill the worker mid-episode, restart, and nothing is stranded.

## `semaphore.ts` — why not BullMQ concurrency

Provider quota must hold **across processes**. BullMQ's `concurrency` is per worker instance, so starting a second worker would double the effective quota and trigger the vendor's rate limiter.

Redis `INCR` with a TTL, released by a Lua script that refuses to go negative. The TTL (15 min) returns slots if a holder crashes, so a leak self-heals. Note the slot covers *submission* concurrency, not generation concurrency — it is released in a `finally` right after submit, because queuing on the provider's behalf is the provider's job.

## `ingest.ts`

Downloads the artifact, streams it to MinIO under the `s3Key` layout, computes sha256, writes the `assets` row and the `takes` row, then drives the state machine via the `onTakeAccepted` callback. That callback is not optional plumbing — disconnect it and shots stay `generating` forever.

## Retry policy

`INFRA_RETRY` (exponential backoff) applies to infrastructure faults only. Quality retries are a different mechanism entirely — a new job row created by the state machine, with escalating parameters. Do not merge them; one is "the network flaked", the other is "the model produced something unusable".

## Testing

`orchestration.int.test.ts` runs against real infrastructure because these bugs — idempotency, recovery, rate limiting — are nearly invisible to unit tests and surface in production as "it charged twice" or "it hung".

Two operational requirements: attempts use a reserved `900–1000` range so tests never collide with real data, and **no `worker.js` may be running**, or it will drain the queues out from under the assertions.
