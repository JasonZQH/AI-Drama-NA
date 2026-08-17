# `pipeline/` — business rules

What *should* happen, decided here. What actually happens — queues, HTTP, S3 — is performed elsewhere. Keeping that split is the reason a shot's lifecycle is testable without any infrastructure.

## Files

| File | Role |
|---|---|
| `shotMachine.ts` | Pure state machine. Zero IO. |
| `applyTransition.ts` | The **single** place transitions are executed. |
| `batch.ts` | Batch planning, dependency resolution, budget gate. |
| `render.ts` | Timeline assembly and the media-worker call. |
| `shotMachine.test.ts` | Exhaustive `(status × event)` matrix. |

## `shotMachine.ts` — pure, and enforced

```ts
transition(shot: ShotState, event: ShotEvent, ctx: TransitionContext): TransitionResult
//  → { ok: true, next: ShotStatus, effects: Effect[] }
//  | { ok: false, reason: string }
```

It returns a **description** of side effects, never performs one. No `db`, no `queues`, no `fetch` — an eslint rule blocks those imports so the purity cannot rot. Consequences worth understanding:

- The `(status × event)` matrix is exhaustively unit-tested with no Postgres, no Redis, and no clock.
- An illegal transition is `{ ok: false, reason }`, not a thrown exception. Callers decide whether that is a 409 or a no-op.
- Retry policy lives in `afterFailure()`. **Infrastructure retry and quality retry are different things**: an infra failure replays with identical parameters (BullMQ `attempts`), while a quality failure opens a *new* job row and escalates seed → prompt → provider. `content_filtered`, `quota_exceeded`, and `invalid_output` never retry at all — the same prompt gets rejected again and only burns quota.
- `TERMINAL_STATUSES` and `isEnqueueable()` are exported so batch planning and boot reconciliation agree on "still in flight" without duplicating the rule.

## `applyTransition.ts` — one execution point

Reads the shot, calls `transition()`, performs each returned `Effect`, then writes `status` and `updatedAt`.

**Every path must go through it.** Both an HTTP route and a queue handler need to move a shot, and when ingest updated rows directly instead, shots reached `review` in the database while the machine never ran the accompanying effects — they sat in `generating` in the UI forever. That bug is why this file exists.

Effects it knows how to perform: enqueue a generation (creating the `generation_jobs` row and pushing to `q:generate`), set/clear `selectedTakeId`, archive candidate takes, and publish an SSE event via `q:notify`. Archive rather than delete — the system never destroys something it already paid to generate.

## `batch.ts` — spend before you spend

`planBatch()` produces the `BatchPlan` behind the confirmation dialog: `planned`, `blocked`, `skipped`, `estimatedCostMicroUsd`, and a budget block. The UI calls it with `dryRun: true` first, which is what makes rule R2 (never let a user spend without seeing the amount) real rather than aspirational.

- `resolveDependencies()` handles `continuityFromShotId` — a shot whose predecessor has no locked take is `blocked`, not `planned`. Generating it first would produce continuity nonsense.
- `spentTodayForShot()` / `spentToday()` are live sums over `generation_jobs`, not counters. Counters drift; a sum cannot. The sum includes **in-flight reservations**: `applyShotTransition` writes the estimate into `cost_micro_usd` at row creation, so a queued batch starts consuming the budget immediately instead of the gate seeing zero until money has already been spent.
- `budgetFromEnv()` reads the daily limit and the on-exceed policy, and the policy decides who wins:
  - `warn` — the confirm button turns red and still works. A warning, not parental control; the decision belongs to the operator.
  - `block` (the default) — the server returns 402 and the confirm button is disabled, because letting someone click a button that is guaranteed to fail is not respecting their decision, it is wasting their click.

  This file used to claim the budget only ever warns. It did not: the default has always been `block`, and the frontend ignored the flag, so the operator got a clickable red button and a 402. Both `08-screen-specs.md` §2 and the M1 acceptance criterion were right; the bug was that nobody read `onExceed`.

**Where the gate lives.** In `applyShotTransition`'s `enqueue.generation` branch — the single point every spend flows through (single-shot API, batch, and the retry that `fail()` schedules). `planBatch()` still checks up front so the dialog can promise an all-or-nothing batch, but that is a pre-flight for the UI, not the invariant.

## `render.ts` — assembly

`ensureTimeline()` auto-drafts a timeline from locked takes in shot order, so "render this episode" works without a manual edit step. `renderEpisode()` then calls the media worker through `MediaWorkerClient`.

That interface is the seam. `httpMediaWorker(baseUrl)` is the real implementation; tests substitute a fake. The control plane never runs FFmpeg itself — it hands over a clip list and receives a storage key.

## Adding a status or an event

1. Extend the enum in `packages/contracts/src/enums.ts` and mirror it in `db/schema.ts` + a migration.
2. Add the case to `transition()`.
3. Extend the matrix in `shotMachine.test.ts` — including which transitions must be **rejected**.
4. If it needs a new side effect, add it to `Effect` and implement it in `applyTransition.ts`, not at the call site.
