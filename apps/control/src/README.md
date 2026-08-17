# `apps/control/src` — the control plane

The only process that writes to Postgres, and the only one that knows what a Project, Episode, or Shot *is*. Providers and Python workers are dumb by design: they take parameters and return artifacts. All business meaning lives here.

## Two entrypoints, one codebase

| File | Process | Responsibility |
|---|---|---|
| `server.ts` | HTTP (`:4000`) | Fastify app — routes, SSE, error handler, CORS. Wires `db`/`storage`/`queues` and hands them to each `register*` function. |
| `worker.ts` | BullMQ consumer | Five queue workers plus `reconcileOnBoot`. No HTTP surface. |

They are deliberately separate processes. A stuck generation must not stop the API from answering, and restarting the API must not drop in-flight jobs. `pnpm dev` runs both under `node --watch`.

Both are thin. They construct dependencies and delegate — if you are looking for logic, it is in one of the modules below.

## Module map

```
routes/     HTTP surface        → validates input, calls pipeline/, never touches providers
pipeline/   business rules      → state machine, batch planning, budget, render orchestration
queue/      async execution     → BullMQ queues, submit/poll/ingest handlers, provider semaphore
providers/  vendor adapters     → the ONLY place a vendor SDK may be imported
db/         persistence         → drizzle schema, migrations, seed, connection factory
storage/    object storage      → S3/MinIO wrapper, presigned URLs, key layout
```

Read them in that order the first time. Each has its own README.

## Rules that hold across every module

**1. Postgres is the source of truth (ADR-0003).** Everything in Redis is disposable. A wiped Redis must be recoverable by re-reading non-terminal rows — that is exactly what `reconcileOnBoot` does. Never store state that exists only in a queue.

**2. Business code never imports a vendor SDK.** Only `providers/` may. This is enforced mechanically by `no-restricted-imports` in `eslint.config.js`, not by convention. The same rule keeps `pipeline/` free of `bullmq` imports — the state machine returns *descriptions* of side effects, and `pipeline/applyTransition.ts` performs them.

**3. Submit and return; never block a worker on a provider.** A BullMQ handler that awaits a generation holds its slot for minutes, makes lock renewal depend on the event loop yielding, and loses the job on a network blip — after the GPU has already been paid for. Submission writes `submitted` to Postgres and finishes; progress is a self-rescheduling `q:poll` job.

**4. Money is integer micro-USD.** No floats anywhere near cost. Every attempt — including failures — gets a `generation_jobs` row, because unit economics computed from successes only are a fiction.

**5. Errors carry a code, a message, and a `requestId`.** See `routes/errors.ts`. A UI that can only say "generation failed" is a UI the user cannot act on.

## Where a request actually goes

Generating one episode, end to end:

```
POST /api/episodes/:id/generate-batch     routes/api.ts
  → planBatch()                           pipeline/batch.ts    dry-run: cost, blocked, budget
  → applyShotTransition() per shot        pipeline/applyTransition.ts
      → transition()                      pipeline/shotMachine.ts   pure: (state, event) → effects
      → createGenerationJob()             queue/ingest.ts
      → q:generate.add()                  queue/queues.ts
  → handleGenerate()                      queue/orchestrator.ts     acquire slot → provider.submit()
  → handlePoll()  (self-rescheduling)     queue/orchestrator.ts     progress → q:notify → SSE
  → handleIngest()                        queue/ingest.ts           download → MinIO → asset + take
  → applyShotTransition('take.accepted')  → shot reaches `review`
```

Every arrow crossing into `providers/` or `storage/` is an interface, not a concrete type. That is what makes the whole chain runnable on a laptop with no GPU and no API key.

## Testing layers

- `*.test.ts` — pure unit, no infrastructure. `pnpm test`.
- `*.int.test.ts` — real Postgres, Redis, MinIO. `pnpm test:int`.
- `providers/contractSuite.ts` — the shared suite every provider must pass.

Integration tests assume the seeded demo project exists and that **no queue worker is running**. A live `worker.js` will drain the queues underneath them and produce confusing failures.
