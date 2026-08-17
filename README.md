# ai-drama-studio

A local-first production system for AI-generated short-form drama: **feed it a story, get back playable episodes.**

It is both the factory (Studio) and the storefront (Player). The goal of this phase is not monetisation — it is to make the path from **text to a playable master** run end to end on a laptop, with every link in that chain replaceable, observable, and priced.

```
Story → Episodes → Scenes → Shots → Reference assets → Batch generation
      → Evaluation & selection → Voice/subtitles → FFmpeg assembly → Playback
```

---

## Status

**M0 complete.** The trunk runs end to end with **no GPU and no API keys** — every generation call is served by a first-class mock provider that fails 15% of the time on purpose, so retry logic and error states are exercised from day one.

A verified run of the full acceptance path:

| Step | Result |
|---|---|
| Batch-generate one episode | 12 shots, **14 attempts, 2 automatic retries** |
| Select takes | 12 locked |
| Render | **36.02 s master, 1080×1920, 24 fps** |
| Re-render after a change | 12 normalised clips reused, **4 s → 0 s** |

Three test layers, all run in CI as separate jobs: **unit** (pure functions and the state machine —
the transition matrix is generated exhaustively, not sampled), **integration** (real Postgres +
Redis + MinIO, because idempotency and recovery bugs are invisible against mocks), and **media**
(real FFmpeg on real files — whether the command line is right is only knowable by running it).

<sub>Counts deliberately omitted: they went stale three times in as many PRs. The CI run on any
commit is the answer.</sub>

Next milestone is M1 — a real cloud provider behind the same adapter, with cost per usable shot measured against the mock baseline.

---

## Quick start

No GPU. No API keys. Nothing to sign up for.

```bash
git clone https://github.com/JasonZQH/AI-Drama-NA.git ai-drama-studio
cd ai-drama-studio

pnpm install
cp .env.example .env

docker compose -f infra/docker-compose.yml up -d --wait postgres redis minio
docker compose -f infra/docker-compose.yml run --rm minio-init
docker compose -f infra/docker-compose.yml up -d --wait media-worker

pnpm build
pnpm db:migrate && pnpm db:seed     # demo: 1 episode / 12 shots / 2 characters
pnpm dev                            # web :3000 · control :4000 · queue worker
```

Open <http://localhost:3000>, pick the demo project, and press **Generate episode**. A confirmation dialog shows the shot count and the estimated spend before anything is queued. Watch the cards move through `generating → review` over SSE, select takes, render, and play the master.

> **Port 5432 already taken?** A native Postgres is common on dev machines. Every host port is overridable:
> `POSTGRES_PORT=5433 docker compose -f infra/docker-compose.yml up -d` — then update `DATABASE_URL` in `.env`.

### Useful commands

| Command | What it does |
|---|---|
| `pnpm dev` | Web + control plane + queue worker, all watching |
| `pnpm test` | Unit tests (no infrastructure needed) |
| `pnpm test:int` | Integration tests against real Postgres/Redis/MinIO |
| `pnpm db:reset` | Drop **both** `public` and `drizzle` schemas. Does **not** re-migrate — see [Clearing the demo data](#clearing-the-demo-data) |
| `pnpm contracts:build` | zod → JSON Schema for the Python side |
| `python3 scripts/build-docs.py` | Re-render `docs/_src/*.md` into the HTML doc site |

### Clearing the demo data

Everything `db:seed` creates is **mock data**: costs come from a fixed price table, failures are injected, and the video files are bundled fixtures. The admin panel labels it — every figure that traces back to `provider_id = 'mock'` carries a `MOCK` chip, and the top bar says so outright. None of it is real billing.

Wiping it takes **two** commands, because the data lives in two stores:

```bash
# 1. Postgres — drops both schemas, so migrations must be re-applied
pnpm db:reset && pnpm db:migrate

# 2. MinIO — db:reset does not touch object storage
docker compose -f infra/docker-compose.yml run --rm --entrypoint sh minio-init -c \
  "mc alias set local http://minio:9000 adminlocal adminlocal123 && \
   mc rm -r --force local/drama && mc mb -p local/drama"
```

Then either `pnpm db:seed` for a fresh demo, or skip it and start empty — the panel handles the no-data case and tells you what to run.

**Why the second command matters.** `db:reset` drops the `projects` rows but leaves every generated clip under `drama/projects/<uuid>/takes/` on disk. Re-seeding mints new UUIDs, so the old objects are never referenced again and never cleaned up. A few episodes of experimentation leaves hundreds of megabytes that nothing points at.

**Why `db:reset` alone leaves you with an empty database.** It drops the `drizzle` schema too — deliberately, because that is where the migration ledger lives. Dropping only `public` would make the migrator believe `0000` had already run, report success, and create no tables at all. That failure is silent and thoroughly misleading, which is why resetting and migrating are two explicit steps rather than one.

---

## Architecture

Three planes, split by **responsibility rather than by tech stack**. Nothing crosses a plane boundary except over HTTP — no shared database connections, no shared memory.

```
┌─ PRESENTATION ─┐   Next.js 16 · TypeScript      Studio UI · Player · live progress
        │ REST + SSE
┌─ CONTROL ──────┐   Fastify 5 · Drizzle · BullMQ  Domain model · state machine
        │                                          Provider routing · Generation Ledger
        │ HTTP Worker Contract                     ── the only process that writes Postgres ──
┌─ GENERATION ───┐   Python · FastAPI · FFmpeg     Media assembly (CPU, local)
        └──────────→ MinIO (S3)                    Wan2.2 / ComfyUI (remote GPU, M2)
```

**Why the control plane is TypeScript and not Python.** Domain types — `Shot`, `Asset`, `JobStatus` — are shared with the frontend. Writing them twice is a permanent source of drift. `packages/contracts` defines them once in zod and emits three things: TS types, runtime validation, and JSON Schema for the Python workers. The language boundary sits at **business logic vs. computation**, not at frontend vs. backend.

The generated schema carries real constraints, not just shapes:

```json
"durationSec": { "type": "number", "minimum": 1, "maximum": 10 }
"role": { "type": "string", "enum": ["character","location","style","first_frame","last_frame"] }
```

Module boundaries are enforced at build time, not by convention — ESLint blocks vendor SDK imports outside `providers/` and any I/O inside `domain/`. Try it: adding `import { createDb } from '../db/client'` to the state machine fails lint.

### Repository layout

```
apps/
  web/          Next.js · admin panel (dashboard, project, episode, assets), review, player
  control/      Fastify · routes, pipeline, queue, providers, db, storage
packages/
  contracts/    zod schemas — the single source of truth for all three languages
workers/
  media/        Python · FFmpeg normalise/concat/probe/thumbnail
infra/          docker compose: postgres · redis · minio · media-worker
docs/           14 design documents + 11 ADRs (rendered to HTML)
```

---

## How a shot becomes video

The pipeline has eight stages. S4 gates S5: batch generation stays disabled until reference assets are locked, because starting a 3000-shot run on unlocked characters is the industry's most expensive known mistake.

```
S1 STORY → S2 SCRIPT → S3 SHOTLIST → S4 ASSETS → S5 GENERATE
                                   → S6 AUDIO  ↗
                                   → S7 ASSEMBLE → S8 PROMOTE
```

Inside S5, one shot's journey:

1. **Shot Intent → prompt.** Intent is structured narrative data (framing, camera move, action, emotion, duration). It is deliberately **not** a prompt — prompts are provider-specific, intent is not. Swapping providers changes a template, not the script layer.
2. **Router picks a backend.** Hard capability filters first, then failure avoidance, then historical `usd_per_accepted` — rules before statistics.
3. **Submit and return.** The queue job writes the job row and finishes immediately. It never blocks waiting for generation; a self-rescheduling poll job tracks progress with exponential backoff. No persistent loops means thousands of concurrent jobs cost nothing but Redis entries.
4. **Ingest.** Output lands in MinIO, hashed for content-addressed dedup, recorded as an asset plus a take.
5. **Evaluate.** Tier 0 technical checks first — cheap checks reject cheaply, before anything expensive runs.
6. **Retry, correctly.** Infrastructure failures replay with identical parameters. Quality failures escalate: new seed → reinforced prompt → different provider. `content_filtered` never retries at all — the same prompt will be rejected again, and retrying only burns quota.
7. **Human selects.** The review screen is built for keyboard: `J/K` to move, `Space` to play all candidates in sync, `1–9` to pick, `Enter` to confirm and jump to the next. Target is three seconds per shot.

Assembly is two-pass by necessity. Clips from different providers carry different profiles, GOPs and colour spaces, so lossless `-c copy` concatenation cannot work directly. Each clip is normalised to identical parameters first — and that normalised output is cached, which is why changing one shot re-renders an episode in seconds rather than minutes.

### Three constraints that shape everything

1. **The generation backend is replaceable.** Every capability hides behind a provider adapter. Business code never imports a vendor SDK. Without this, comparing "Vidu on close-ups vs. self-hosted Wan2.2" is impossible — and that comparison is the entire point of the architecture.
2. **It runs with no GPU.** `MockProvider` is a first-class implementation, not a stub: real fixtures, real latency, real cost figures, real failures.
3. **Every generation is recorded.** Each attempt — including failures — writes a Generation Ledger row: parameters, seed, latency, cost, verdict. Cost is stored as integer micro-USD, because floating point and money do not mix.

That ledger answers the only question that matters long-term:

```sql
SELECT provider_id, shot_type,
       count(*)                                  AS attempts,
       avg((accepted)::int)                      AS pass_rate,
       sum(cost_micro_usd)/1e6
         / nullif(sum((accepted)::int), 0)       AS usd_per_accepted
FROM generation_jobs JOIN shots ON shots.id = shot_id
GROUP BY 1, 2 ORDER BY usd_per_accepted;
```

**Cost per usable shot** — not cost per second — is the real unit price, because it folds in the retry rate.

---

## Positioning

This targets the **North American R-rated (MPA R / TV-MA) vertical short-drama market**, and that choice is architectural, not editorial:

- **Marketing outspends production roughly 9:1.** The system's primary output is therefore not 80–100 finished episodes but 600–1200 deliverables — episodes *plus* promo cuts, store assets, and affiliate packages. `HookConcept` and `Render` are first-class entities, not afterthoughts.
- **Three content tiers, separated at the shot level.** L0 (ad-safe) / L1 (store-safe) / L2 (full TV-MA). Plot-bearing shots and explicit shots are never the same shot, so downgrading swaps clips instead of re-cutting scenes. Generating two extra covers costs 10–20% of a shot; re-shooting a version costs 80–100%.
- **Format:** 80–100 episodes × 60–90 seconds, 10–25 shots per episode.

---

## Documentation

The design docs are the specification this code is written against. They are rendered to a browsable site — open **[`docs/index.html`](docs/index.html)** (dark/light, cross-linked, Mermaid diagrams). Sources live in `docs/_src/`; run `python3 scripts/build-docs.py` after editing, or CI will reject the change.

> Design documents are written in Chinese.

**Read these three first:** [00-overview](docs/00-overview.html) → [01-architecture](docs/01-architecture.html) → [12-roadmap](docs/12-roadmap.html)

| Document | Contents |
|---|---|
| [00-overview](docs/00-overview.html) | Scope, eight design constraints, glossary |
| [01-architecture](docs/01-architecture.html) | Three planes, process topology, module boundaries |
| [02-data-model](docs/02-data-model.html) | Schema, status enums, Generation Ledger |
| [03-pipeline](docs/03-pipeline.html) | Eight stages, shot state machine, eval tiers, continuity |
| [04-provider-adapter](docs/04-provider-adapter.html) | Provider contract, capabilities, router |
| [05-job-orchestration](docs/05-job-orchestration.html) | Queues, concurrency, polling, retries, accounting, recovery |
| [06-api-spec](docs/06-api-spec.html) | Control plane REST + SSE |
| [07-design-system](docs/07-design-system.html) | Tokens, components, interaction, accessibility |
| [08-screen-specs](docs/08-screen-specs.html) | Seven screens, layout and behaviour |
| [09-python-worker](docs/09-python-worker.html) | Worker Contract, model selection, remote GPU |
| [10-media-storage](docs/10-media-storage.html) | S3, FFmpeg, TTS, HLS, capacity |
| [11-dev-setup](docs/11-dev-setup.html) | Environment, variables, troubleshooting |
| [12-roadmap](docs/12-roadmap.html) | M0–M6 milestones and acceptance criteria |
| [13-character-assets](docs/13-character-assets.html) | Three-way asset separation, prompt strategy |

### Architecture decisions

Each ADR records the alternatives rejected and — where relevant — the conditions under which the decision should be revisited.

| ADR | Decision |
|---|---|
| [0001](docs/adr/0001-monorepo-and-language-split.md) | Monorepo; language boundary at business vs. computation |
| [0002](docs/adr/0002-provider-adapter-over-direct-sdk.md) | Provider adapter, never a direct SDK |
| [0003](docs/adr/0003-postgres-as-system-of-record.md) | Postgres is the system of record; Redis is only a queue |
| [0004](docs/adr/0004-s3-compatible-storage-from-day-one.md) | S3-compatible storage from day one |
| [0005](docs/adr/0005-remote-gpu-worker-http-contract.md) | GPU workers speak HTTP, not a shared queue |
| [0006](docs/adr/0006-comfyui-over-diffusers.md) | ComfyUI as the inference executor, not diffusers |
| [0007](docs/adr/0007-bullmq-over-temporal.md) | Stay on BullMQ; explicit triggers for migrating to Temporal |
| [0008](docs/adr/0008-character-asset-separation.md) | Character assets split into face / body / wardrobe |
| [0009](docs/adr/0009-modular-monolith-not-microservices.md) | Modular monolith plus stateless compute workers |
| [0010](docs/adr/0010-http-over-grpc.md) | HTTP/JSON across processes, not gRPC |
| [0011](docs/adr/0011-drizzle-over-alternatives.md) | Drizzle for the data layer; SafeQL deferred to M1 |
| [0012](docs/adr/0012-openrouter-m1-comfyui-m2.md) | OpenRouter in M1, ComfyUI added in M2; both live in one provider pool |

---

## Roadmap

| | Goal | Key acceptance |
|---|---|---|
| **M0** ✅ | Skeleton — fake generation, real pipeline | Clean clone runs end to end with no GPU and no keys |
| **M1** | First cloud provider | Cost visible; dry-run estimate within 20% of actual |
| **M2** | Self-hosted GPU worker | Cloud vs. self-hosted compared on identical accounting |
| **M3** | Audio and masters | Clean master + M&E stems; single-shot re-render under 30 s |
| **M4** | Promo pipeline *(deliberately ahead of the player)* | One-click L2/L1/L0; ≥40 hook concepts extracted |
| **M5** | End-to-end loop | Character consistency holds across 5 consecutive episodes |
| **M6** | Quality and cost | Cost per usable shot down ≥20% via routing |

**Deliberately out of scope this phase:** payments, multi-tenancy, CDN distribution, content-moderation gates, mobile apps, Kubernetes. The data model reserves fields and hooks for these; none are implemented.

---

## Contributing

CI runs two independent chains. Every check must pass before merge.

```
docs   ───────────────────────────────────────────  doc site is in sync with source
python ───────────────────────────────────────────  ruff · format · mypy strict · pytest

contracts → format → lint → typecheck → test → db → integration
```

Cheap checks fail first; the expensive ones (real containers, real migrations, real queues) run last. Failure attribution is visible in the job graph rather than buried in a log.

Two rules worth knowing before you open a PR:

- **Generated output is committed and verified.** `docs/*.html` and `packages/contracts/generated/` are checked for drift. Change the source without regenerating and CI rejects it.
- **`as any`, `as never`, and `as unknown as T` are lint errors.** They exist to silence the type checker, and the type checker is usually right. This rule was added after one of them caused a delete statement to silently match zero rows.
