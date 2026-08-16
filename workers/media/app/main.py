"""媒体 worker（09-python-worker.md §6、10-media-storage.md §2）。

与 video worker 共用同一套 Worker Contract 骨架，只是引擎换成 FFmpeg 子进程。

**它不连 Postgres，不懂业务**——收一份 clip 清单，吐一个 storage key。
这条边界让它可以独立部署、随时被 mock 掉（09 §1）。
"""

from __future__ import annotations

import shutil
import tempfile
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import storage
from .ffmpeg import Clip, FfmpegError, concat, normalize, probe, thumbnail

app = FastAPI(title="ai-drama media worker")

STARTED_AT = time.time()


class ClipSpec(BaseModel):
    """一条 clip。storage_key 指向已在 S3 里的 take 产物。"""

    storage_key: str
    trim_start_sec: float = 0.0
    trim_end_sec: float | None = None
    # 规范化产物的缓存位置。命中就跳过最贵的那一步
    normalized_key: str | None = None


class RenderRequest(BaseModel):
    request_id: str
    clips: list[ClipSpec] = Field(min_length=1)
    output_key: str
    # preview 用更快的参数；M0 两档都走同一条路径，差异留给 M3
    quality: str = "preview"


class RenderResult(BaseModel):
    storage_key: str
    bytes: int
    sha256: str
    duration_sec: float
    width_px: int
    height_px: int
    fps: float
    normalized_reused: int
    normalized_built: int


@app.get("/v1/health")
def health() -> dict[str, object]:
    return {
        "ok": shutil.which("ffmpeg") is not None,
        "service": "media",
        "ffmpeg": shutil.which("ffmpeg") is not None,
        "uptime_sec": int(time.time() - STARTED_AT),
    }


@app.post("/v1/render", response_model=RenderResult)
def render(req: RenderRequest) -> RenderResult:
    """两段式：先规范化（可缓存），再无损拼接。"""
    with tempfile.TemporaryDirectory(prefix="render-") as tmp:
        work = Path(tmp)
        prepared: list[Clip] = []
        reused = 0
        built = 0

        for i, spec in enumerate(req.clips):
            norm_local = work / f"norm-{i:04d}.mp4"

            # 缓存命中就直接下载规范化产物，跳过最贵的一步
            if spec.normalized_key and storage.exists(spec.normalized_key):
                storage.download(spec.normalized_key, norm_local)
                reused += 1
            else:
                src = work / f"src-{i:04d}.mp4"
                try:
                    storage.download(spec.storage_key, src)
                except Exception as e:
                    raise HTTPException(404, f"取不到 {spec.storage_key}: {e}") from e
                try:
                    normalize(src, norm_local)
                except FfmpegError as e:
                    raise HTTPException(422, str(e)) from e
                built += 1
                if spec.normalized_key:
                    storage.upload(norm_local, spec.normalized_key)

            prepared.append(
                Clip(
                    path=norm_local,
                    trim_start_sec=spec.trim_start_sec,
                    trim_end_sec=spec.trim_end_sec,
                )
            )

        master = work / "master.mp4"
        try:
            info = concat(prepared, master, work)
        except FfmpegError as e:
            raise HTTPException(422, str(e)) from e

        meta = storage.upload(master, req.output_key)

    return RenderResult(
        storage_key=req.output_key,
        bytes=int(meta["bytes"]),
        sha256=str(meta["sha256"]),
        duration_sec=info.duration_sec,
        width_px=info.width,
        height_px=info.height,
        fps=info.fps,
        normalized_reused=reused,
        normalized_built=built,
    )


class ProbeRequest(BaseModel):
    storage_key: str


@app.post("/v1/probe")
def probe_endpoint(req: ProbeRequest) -> dict[str, object]:
    """T0 技术校验用：能否解码、时长 / 帧率 / 分辨率是否符合请求。"""
    with tempfile.TemporaryDirectory(prefix="probe-") as tmp:
        local = Path(tmp) / "in.mp4"
        try:
            storage.download(req.storage_key, local)
            info = probe(local)
        except FfmpegError as e:
            # 解不了码本身就是 T0 的结论，不是服务错误
            return {"decodable": False, "detail": str(e)}
        except Exception as e:
            raise HTTPException(404, f"取不到 {req.storage_key}: {e}") from e

    return {
        "decodable": True,
        "width_px": info.width,
        "height_px": info.height,
        "fps": info.fps,
        "duration_sec": info.duration_sec,
        "has_audio": info.has_audio,
        "codec": info.codec,
    }


class ThumbnailRequest(BaseModel):
    storage_key: str
    output_key: str
    width: int = 270


@app.post("/v1/thumbnail")
def thumbnail_endpoint(req: ThumbnailRequest) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="thumb-") as tmp:
        work = Path(tmp)
        src = work / "in.mp4"
        out = work / "thumb.jpg"
        try:
            storage.download(req.storage_key, src)
            thumbnail(src, out, width=req.width)
        except FfmpegError as e:
            raise HTTPException(422, str(e)) from e
        meta = storage.upload(out, req.output_key, content_type="image/jpeg")
    return {"storage_key": req.output_key, "bytes": meta["bytes"]}
