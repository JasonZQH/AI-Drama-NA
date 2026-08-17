# `providers/` — vendor adapters

The only directory permitted to import a vendor SDK. Everything upstream speaks `VideoProvider` from `@ai-drama/contracts` and cannot tell Vidu from Kling from a fixture on disk.

## Files

| File | Role |
|---|---|
| `mock.ts` | `MockProvider` — the reference implementation. |
| `registry.ts` | Builds the provider pool from env; resolves by id. |
| `contractSuite.ts` | The suite **every** provider must pass. Exports functions only — it does not register itself. |
| `mock.test.ts` | Mock-specific behaviour (determinism, injection), and where the suite is registered for mock. |

The import restriction is enforced by `no-restricted-imports` in `eslint.config.js`. It is a lint failure, not a code-review norm — vendor coupling leaks quietly otherwise, and by the time you notice, switching providers means touching thirty files.

## The interface

```ts
validate(req)      // no IO, no network — reject capability mismatches before spending
estimateCost(req)  // micro-USD, for routing and the budget gate
submit(req)        // MUST be idempotent: same requestId → same handle, billed once
poll(handle)       // → ProviderProgress | GenerationResult | ProviderFailure
cancel(handle)
health()           // lets the router drop a failing provider
capabilities       // what it can do; the router filters on this
```

Four obligations that are easy to get wrong:

**`submit` must be idempotent.** Crash recovery replays it. Without this, a restart during a batch bills the whole batch twice.

**`validate` must not do IO.** It runs before spending, on every request. A network call here turns a cheap guard into a latency tax.

**Map every vendor status into the shared enums yourself.** Upstream code must never branch on a vendor's raw status string. `FailureCode` in particular carries a `retryable` decision that the state machine depends on.

**Never return `null` cost.** If the vendor does not report one, estimate from the price table and set `providerMeta.costEstimated`. One `null` poisons every aggregate that touches it — and the admin panel now distinguishes real, estimated, and mock money, which only works if this field is honest.

## `MockProvider` is not a toy

It is the load-bearing piece of constraint C3: full pipeline on a Mac, no GPU, no API keys. The entire M0 acceptance run executes on it, so it behaves like a real provider on purpose:

- **Fails.** Default `failureRate` 0.15, cycling through retryable and non-retryable codes. If retry logic and error UI are never exercised during development, they all break at once the day a real provider is connected.
- **Costs money.** ~$0.08 per 4s of 720p, so cost reports have realistic magnitudes from day one.
- **Takes time**, with a `latencyScale` knob (CI sets `0.05`; set it above 1 to watch progress in a browser).
- **Reports stages** shaped like ComfyUI's: the first 20% is `loading_model`, then `denoising`, `decoding`, `uploading`. Real model loading takes 60–90 seconds at 0%, and the UI must survive that *before* M2 attaches a GPU, not after.
- **Is deterministic on demand.** `MOCK_SEED_DETERMINISTIC=1` derives every roll from the seed — same input, same fixture, no random failures.
- **Accepts injected failures** through `providerParams.mock.failFirstAttempt`. `providerParams` is the spec's documented escape hatch, so e2e gets a guaranteed retry without gambling on a 15% dice roll.

## `contractSuite.ts`

A shared suite, not a mock test:

```ts
runContractSuite('openrouter:google/veo-3.1', () => new OpenRouterProvider(cfg), {
  timeoutMs: 15 * 60_000, // also becomes drain()'s deadline — see below
  cancelEffective: false, // if the vendor has no cancel endpoint
})
```

It checks idempotent `submit`, the `PollOutcome` union, capability consistency, cancellation, and cost sanity. A provider that has not passed it is not finished.

Two things this file is deliberately shaped around, both of which cost real money when you get them wrong:

**`timeoutMs` sets two clocks, not one.** It is `drain()`'s deadline *and* the vitest suite timeout. Vitest's default `testTimeout` is 5000 ms, so raising only the drain deadline just gets the test killed at 5 s — after `submit` has already billed.

**Only 3 cases submit anything.** Capability consistency runs through `validate()` (which the contract requires to be IO-free), and the two cost assertions share one submission. Proving a declared mode works by submitting to it costs one abandoned billable generation per mode per model entry, and proves less than the `validate` check does.

Failure-mapping cases live in a **separate** export, `runMockFailureSuite`, because they inject failures through `providerParams.mock.failFirstAttempt` — a field only `mock.ts` reads. A cloud adapter physically cannot register that half. Recorded fixtures for cloud adapters land with the first cloud adapter (M1 P5); until then the guard against spending in CI is the outbound-network block in `vitest.setup.ts`.

## Adding a provider

1. Implement `VideoProvider` in this directory. SDK imports are legal only here.
2. Register it in `registry.ts`, gated on its env credentials — unconfigured providers must not enter the pool. `buildProviderPool` currently returns mock only; cloud adapters land in M1, self-host in M2.
3. Run `runContractSuite` against it from its own `*.test.ts`.
4. Map its failure modes into `FailureCode`, and decide retryability for each. Self-hosted engines bring shapes the cloud APIs do not have — VRAM OOM (retryable at lower resolution), a missing custom node or a workflow JSON that does not match the image tag (never retryable; it needs a rebuild).

Do not create empty adapter classes ahead of time. Scaffolding with no implementation only pretends the provider is supported.
