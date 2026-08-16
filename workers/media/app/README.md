# `workers/media/app` — FFmpeg worker

FastAPI service on `:8002`. Turns a list of clips into one playable master, and answers technical questions about media files.

## The boundary

**It does not connect to Postgres and it does not understand the business.** It has never heard of a Project, an Episode, or a Shot. It receives a clip list and an output key; it returns a storage key and metadata.

That boundary is what lets it be deployed independently, scaled independently, and mocked entirely. It also means the machine running it needs no database credentials — a security property, not just a tidy one.

It shares the Worker Contract skeleton with `workers/video` (GPU, M2) and `workers/eval` (M1). Same protocol shape, different engine.

## Files

| File | Role |
|---|---|
| `main.py` | FastAPI app: `/v1/render`, `/v1/probe`, `/v1/thumbnail`, `/v1/health`. |
| `ffmpeg.py` | Command construction and execution. All FFmpeg knowledge lives here. |
| `storage.py` | S3/MinIO download, upload, existence check, sha256. |

`ffmpeg.py` is deliberately split from `main.py` so command construction is unit-testable without running FFmpeg or standing up a server.

## Two-pass assembly, and why

The obvious approach — point the concat demuxer at the clips and `-c copy` — does not work. Clips come from different providers with different profiles, GOP structures, and colour spaces, and lossless concat requires *identical* parameters. In practice they never are.

So:

1. **Normalize** every clip to one target (1080×1920, 24 fps, fixed GOP). Expensive: a real re-encode.
2. **Concat** the normalized files with `-c copy`. Nearly free.

Normalized output is cached by `normalized_key`. Re-rendering an episode after changing one shot re-encodes only that shot — minutes become seconds. The response reports `normalized_reused` and `normalized_built` so the cache is observable rather than assumed.

## Details in `normalize_cmd` that are load-bearing

- **`GOP = fps × 2`, with `-keyint_min` and `-sc_threshold 0`.** A fixed 2-second keyframe interval is what lets HLS segments align later. Leave it adaptive and segmentation drifts.
- **`setsar=1`.** Mismatched sample aspect ratios make concat produce subtly stretched output — no error, just wrong pixels.
- **Silent-track fallback.** Clips without audio get a generated silent track. Concatenating audio-bearing and audio-less files otherwise desynchronizes everything after the first gap. `probe()` decides per clip.
- **Single-quote escaping in `concat_list`.** The demuxer's list format uses `'` as a delimiter; an unescaped filename breaks the file.

## Errors carry stderr

`FfmpegError` includes the last 2000 characters of stderr. Without it, debugging a failed encode is guesswork. `main.py` maps it to HTTP 422 — the input was bad, not the service.

`/v1/probe` is the exception: an undecodable file returns `{"decodable": false, "detail": ...}` with HTTP 200, because *that is the answer* the T0 technical gate asked for, not a service failure.

## Storage

Downloads inputs, uploads the master, all through S3. `sha256` is computed streaming — video files must never be buffered whole in memory.

The control plane may hand over a presigned PUT URL instead of credentials; that is the intended pattern for remote deployments, and the reason nothing here needs long-lived secrets.

## Working on it

```bash
uv sync
uv run ruff check . && uv run ruff format --check .
uv run mypy .
uv run pytest                    # command construction + real 2-3s fixture clips
uv run uvicorn app.main:app --port 8002 --reload
```

FFmpeg must be on `PATH`; `/v1/health` reports whether it is. The container image pins a version — encoder defaults shift between FFmpeg releases and would change output bit-for-bit.

## Adding an operation

1. Put command construction in `ffmpeg.py` as a pure `-> list[str]` function, and unit-test the argument list. Do not build commands inside a route handler.
2. Add the endpoint in `main.py` with pydantic request and response models.
3. Work inside a `TemporaryDirectory`; every path stays scoped to the request.
4. Raise `FfmpegError` for bad input (→ 422), let genuine faults surface as 500.
5. Keep it stateless and business-free. If it needs to know what a Shot is, it belongs in the control plane instead.
