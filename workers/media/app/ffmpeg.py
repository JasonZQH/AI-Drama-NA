"""FFmpeg 命令构造与执行（10-media-storage.md §2）。

**为什么不用 concat demuxer 直接拼**：各镜头来自不同 provider，编码参数
五花八门（不同 profile、不同 GOP、不同色彩空间）。`-c copy` 的无损拼接
要求参数完全一致，实际做不到。

所以是两段式：先把每个 clip 规范化到统一参数，再无损拼接。规范化产物
缓存，重渲染时只重跑变化的 clip——这让「改一个镜头重渲染整集」从几分钟
降到几秒。
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

# 竖屏 1080x1920。固定 GOP = 2 秒是后续切 HLS 能对齐的前提，不固定切片会漂
TARGET_W = 1080
TARGET_H = 1920
TARGET_FPS = 24
GOP = TARGET_FPS * 2


class FfmpegError(RuntimeError):
    """带上 ffmpeg 的 stderr——不带的话排查等于盲猜。"""

    def __init__(self, cmd: list[str], stderr: str) -> None:
        super().__init__(f"ffmpeg 失败: {' '.join(cmd[:6])}…\n{stderr[-2000:]}")
        self.stderr = stderr


def _run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise FfmpegError(cmd, p.stderr)
    return p.stdout


@dataclass(frozen=True)
class MediaInfo:
    width: int
    height: int
    fps: float
    duration_sec: float
    has_audio: bool
    codec: str


def probe(path: Path) -> MediaInfo:
    """ffprobe 元数据提取。T0 评测的技术校验也用它。"""
    out = _run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration",
            "-of",
            "json",
            str(path),
        ]
    )
    data = json.loads(out)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    if video is None:
        raise FfmpegError(["ffprobe"], f"{path} 里没有视频轨")

    num, _, den = (video.get("r_frame_rate") or "0/1").partition("/")
    fps = float(num) / float(den) if den and float(den) != 0 else 0.0

    return MediaInfo(
        width=int(video.get("width", 0)),
        height=int(video.get("height", 0)),
        fps=fps,
        duration_sec=float(data.get("format", {}).get("duration", 0.0)),
        has_audio=any(s.get("codec_type") == "audio" for s in streams),
        codec=str(video.get("codec_name", "")),
    )


def normalize_cmd(src: Path, dst: Path, *, has_audio: bool) -> list[str]:
    """第 ① 步：统一 codec / 分辨率 / 帧率 / SAR / 色彩空间 / 音频轨。

    三个关键点：
    - `setsar=1` 统一像素宽高比，否则拼接后画面会被拉伸
    - 固定 GOP 与 `-sc_threshold 0`，让 HLS 切片能落在关键帧上
    - **没有音频的 clip 必须补静音轨**，否则 concat 时音画会错位
    """
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)]

    if not has_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"]

    cmd += [
        "-vf",
        f"scale={TARGET_W}:{TARGET_H}:force_original_aspect_ratio=increase,"
        f"crop={TARGET_W}:{TARGET_H},setsar=1,fps={TARGET_FPS}",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-pix_fmt",
        "yuv420p",
        "-profile:v",
        "high",
        "-level",
        "4.1",
        "-g",
        str(GOP),
        "-keyint_min",
        str(GOP),
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-movflags",
        "+faststart",
    ]
    if not has_audio:
        cmd += ["-shortest"]
    cmd += [str(dst)]
    return cmd


def normalize(src: Path, dst: Path) -> MediaInfo:
    info = probe(src)
    _run(normalize_cmd(src, dst, has_audio=info.has_audio))
    return probe(dst)


@dataclass(frozen=True)
class Clip:
    path: Path
    trim_start_sec: float = 0.0
    trim_end_sec: float | None = None


def concat_list(clips: list[Clip]) -> str:
    """concat demuxer 的清单。inpoint/outpoint 直接对应 timeline_clips 的 trim。"""
    lines: list[str] = []
    for c in clips:
        # 路径里的单引号要转义，否则清单会被截断
        safe = str(c.path).replace("'", r"'\''")
        lines.append(f"file '{safe}'")
        if c.trim_start_sec:
            lines.append(f"inpoint {c.trim_start_sec}")
        if c.trim_end_sec is not None:
            lines.append(f"outpoint {c.trim_end_sec}")
    return "\n".join(lines) + "\n"


def concat(clips: list[Clip], dst: Path, workdir: Path) -> MediaInfo:
    """第 ② 步：无损拼接。全部 clip 已规范化，所以 `-c copy` 成立。"""
    if not clips:
        raise FfmpegError(["concat"], "没有任何 clip 可拼接")
    listfile = workdir / "concat.txt"
    listfile.write_text(concat_list(clips), encoding="utf-8")
    _run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(listfile),
            "-c",
            "copy",
            "-movflags",
            "+faststart",
            str(dst),
        ]
    )
    return probe(dst)


def thumbnail(src: Path, dst: Path, *, width: int = 270) -> None:
    """首帧缩略图。分镜页几十个卡片同时加载原始 mp4 会把浏览器打爆。"""
    _run(
        [
            "ffmpeg",
            "-y",
            "-loglevel",
            "error",
            "-i",
            str(src),
            "-vf",
            f"select=eq(n\\,0),scale={width}:-2",
            "-vframes",
            "1",
            str(dst),
        ]
    )
