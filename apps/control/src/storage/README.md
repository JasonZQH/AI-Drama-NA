# `storage/` — object storage

One file, `s3.ts`. Every byte of media enters and leaves the system through it.

## The rule

**There is no `fs.writeFile` in this codebase. Only the S3 SDK.**

Local development uses MinIO, which speaks the S3 API. Moving to S3, R2, or anything else is an endpoint change rather than a rewrite of the media layer. Writing to the local filesystem "just for now" would make that swap a project instead of a config edit (ADR-0004).

## Two endpoints, and why it matters

```ts
internalEndpoint  // the control plane's own reads and writes
publicEndpoint    // baked into every URL handed to a worker or a browser
```

They are configured separately because they genuinely differ in deployment. Signing a URL against `localhost:9000` and handing it to a GPU box in another datacentre is the single most common integration failure in this architecture — the signature is valid and the host is unreachable.

`storageFromEnv()` falls back to the internal endpoint when `S3_PUBLIC_ENDPOINT` is unset, which is correct on a laptop and wrong the moment a worker is remote. Set it explicitly for any non-local deployment.

## Surface

`Storage` wraps put / get / head / presign. Uploads stream and compute sha256 in the same pass — the hash is stored on the `assets` row for integrity and for deduplication.

`s3Key` builds the key layout in one place:

```
projects/<projectId>/takes/<takeId>...
```

Keys are derived, never concatenated at call sites. That is what makes a whole project's objects addressable by prefix — and what makes it possible to see, as the repo README notes, that a database reset leaves those prefixes orphaned on disk.

## Presigned PUT is a security boundary

The control plane signs an upload URL and hands it to the Python worker, which uploads directly. The GPU machine therefore needs **no S3 credentials** and no network route back to the control plane's storage.

This is why `workers/*` never receive a database URL or a storage secret — they receive one signed URL, valid for one object, for a limited time. Preserve that property when adding worker calls: pass a signed URL, not credentials.

## Adding an artifact type

1. Add a builder to `s3Key` rather than assembling a path inline.
2. Stream it; do not buffer whole video files in memory.
3. Record `bytes` and `sha256` on the corresponding `assets` row.
4. If a worker produces it, sign a PUT URL and let the worker upload — do not proxy bytes through the control plane.
