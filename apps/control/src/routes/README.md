# `routes/` — HTTP surface

Fastify handlers. They validate input, call `pipeline/`, and shape the response. They contain no business rules and never talk to a provider or to BullMQ directly.

## Files

| File | Role |
|---|---|
| `api.ts` | The M0 endpoint set — projects, episodes, shots, takes, render, watch, assets. |
| `stats.ts` | Cross-project aggregates for the admin panel. |
| `sse.ts` | Server-Sent Events: `publishEvent`, throttling, the stream handler. |
| `errors.ts` | `ApiError`, the code table, the global error handler. |
| `api.int.test.ts` | Endpoint tests against real infrastructure. |

## Validation

Every `params`, `query`, and `body` is parsed with a zod schema from `@ai-drama/contracts` — the same schema the frontend types are derived from and the same one exported as JSON Schema for Python. One definition, three consumers, no drift.

A zod failure becomes a `VALIDATION_FAILED` response through `errors.ts`, not a 500.

## `errors.ts`

One error body everywhere:

```jsonc
{ "error": { "code": "...", "message": "...", "details": {}, "requestId": "req-1a" } }
```

`requestId` runs through the logs, so a screenshot of a failure is enough to find the whole request chain. `ApiError` carries the code; anything else becomes `INTERNAL` and gets logged with its stack.

Note `hasZodIssues()` — a real type guard. It replaced an `as unknown as T` double assertion that the repo's own eslint rule (`no-restricted-syntax`) caught. Assertions here would defeat the point of validating at the boundary.

## `sse.ts` — three non-obvious requirements

Progress is a one-way broadcast, so SSE rather than WebSocket: automatic reconnect, HTTP/2 multiplexing, no bidirectional state machine to maintain.

**1. `flushHeaders()` after `writeHead`.** Node does not send headers until the first write. Without the flush the client's `onopen` never fires and the connection looks hung. Classic SSE trap.

**2. CORS headers are written by hand here.** Writing to `reply.raw` bypasses Fastify's reply object, so `@fastify/cors`'s `onSend` hook never runs. `curl` does not enforce CORS, so this bug is invisible outside a real browser.

**3. Throttling applies to `job.progress` only.** One event per job per second, merged server-side, or dozens of concurrent generations will flood the browser. Status transitions and errors are **never** throttled — drop one and the UI stays stuck on a state that is no longer true.

Two paths share one handler: `/api/events` (used by the admin shell) and `/api/projects/:id/events` (legacy, still used by the review page). Be aware that the channel is a **global broadcast** — the `:id` in the path is not a filter and never was. Consumers filter client-side.

## `stats.ts`

Cross-project aggregates; `/api/projects/:id/stats` in `api.ts` is the single-project equivalent.

- Aggregation uses `leftJoin` + `groupBy`, not correlated subqueries. Interpolating a drizzle column object inside a subquery emits unqualified references like `where "project_id" = "id"` — ambiguous SQL. Joins are also a single scan instead of N subqueries per row.
- `count(distinct ...)` is mandatory once `generation_jobs` is joined: that join multiplies shot rows by attempt count, and without `distinct` the shot count silently becomes the attempt count.
- Range → granularity is derived server-side and not caller-selectable. 365 daily points in one card width are neither readable nor drawable.
- Every cost aggregate also returns `mockCostMicroUsd`. A mock dollar and a real dollar render identically; the UI needs the split to label one of them.
- `distribution` and `revenue` are `null` by design. M4 fills those blocks in; the response shape does not change.

## Adding an endpoint

1. Define request and response schemas in `packages/contracts`.
2. Add the handler here; parse with the schema; delegate to `pipeline/`.
3. Throw `ApiError` with a code from the table — never a bare `Error`, never a raw `reply.status(500)`.
4. Register it in `server.ts` through the module's `register*` function.
