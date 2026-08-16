# `db/` — schema, migrations, seed

Drizzle over `postgres-js`. This module owns the shape of every table and nothing else; no business logic lives here.

## Files

| File | What it is |
|---|---|
| `schema.ts` | All 16 tables. The single definition from which migrations are generated. |
| `client.ts` | `createDb(url, max)` → `{ db, client }`. |
| `migrate.ts` | Applies `drizzle/*.sql`. Run via `pnpm db:migrate`. |
| `seed.ts` | The demo project: 1 episode / 3 scenes / 12 shots / 2 characters / 2 locations. |
| `reset.ts` | Drops `public` **and** `drizzle`, recreates `public`. Refuses to run with `NODE_ENV=production`. |

## Two things here will bite you

**`createDb` returns `client`, not `sql`.** Drizzle also exports a `sql` template tag. If the raw postgres client is named `sql`, then `db.delete(x).where(sql\`...\`)` silently binds the wrong one: the condition is dropped, the statement still executes, and nothing errors. A `DELETE` that deletes nothing, an `UPDATE` that updates nothing. This happened once; the name is deliberate.

The same family of bug: `and(...)` with every condition `undefined` returns `undefined`, and `.where(undefined)` produces an unconditional statement — a **full-table delete** that typechecks cleanly. Build conditions in an array and assert it is non-empty before spreading.

**`reset` drops the `drizzle` schema on purpose.** That schema holds the migration ledger. Dropping only `public` leaves the ledger claiming `0000` was applied, so the next `migrate` reports success and creates zero tables. Silent and thoroughly misleading. This is also why reset and migrate are two commands rather than one:

```bash
pnpm db:reset && pnpm db:migrate && pnpm db:seed
```

`db:reset` does **not** touch MinIO. Generated clips outlive the rows that referenced them — see the README section *Clearing the demo data* at the repo root.

## Schema conventions

- **Progress is always a status enum plus timestamps.** No `is_done` booleans. Enums live in `packages/contracts/src/enums.ts` and are mirrored here, so a new status is one edit in contracts plus one migration.
- **Money is `bigint` micro-USD**, never numeric or float.
- **Every generation attempt gets a row** in `generation_jobs`, including failures — that table *is* the Generation Ledger. `UNIQUE(shot_id, attempt)` is the second half of idempotency (the first is the provider's `submit` contract); together they mean a crash-replay cannot double-bill.
- **JSONB is for genuinely open payloads only** (`params`, `provider_meta`, character `face_set`/`wardrobe`). Anything queried or constrained gets a real column.
- Foreign keys cascade downward from `projects`; `takes` reference `generation_jobs` **without** cascade, so cleanup order is takes → jobs.

## Connection pools

The API process and the worker process each call `createDb` with their own `max`. Sharing one pool exhausts connections under load. Only this plane opens a write connection at all — the Python workers never see a database URL, which is both an architectural and a security boundary.

## Changing the schema

```bash
# 1. edit schema.ts
pnpm --filter @ai-drama/control db:generate   # drizzle-kit diffs → drizzle/NNNN_*.sql
# 2. read the generated SQL before committing it
pnpm db:migrate
```

The SQL file is the artifact of record and goes into version control. Do not hand-edit an already-applied migration; add a new one.
