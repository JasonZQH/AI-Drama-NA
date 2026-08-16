"""FFmpeg 层的测试。**用真实 ffmpeg 跑真实文件**——命令构造对不对，
只有真跑一遍才知道，而拼接的失败模式（音画错位、画面拉伸、切片漂移）
恰恰都是「命令看起来没问题但结果不对」。
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app.ffmpeg import Clip, FfmpegError, concat, concat_list, normalize, normalize_cmd, probe, thumbnail


def make_clip(
    path: Path, *, seconds: int = 2, width: int = 480, height: int = 854, audio: bool = True
) -> Path:
    """造一条真视频。刻意用非目标分辨率，好验证规范化真的改了它。"""
    cmd = [
        "ffmpeg",
        "-y",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        f"color=c=blue:s={width}x{height}:d={seconds}:r=30",
    ]
    if audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    cmd += ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "40", "-pix_fmt", "yuv420p"]
    if audio:
        cmd += ["-c:a", "aac", "-shortest"]
    cmd += [str(path)]
    subprocess.run(cmd, check=True, capture_output=True)
    return path


def test_probe_reads_real_metadata(tmp_path: Path) -> None:
    src = make_clip(tmp_path / "a.mp4", seconds=2, width=640, height=360)
    info = probe(src)
    assert info.width == 640
    assert info.height == 360
    assert info.has_audio is True
    assert 1.8 < info.duration_sec < 2.4


def test_probe_rejects_non_video(tmp_path: Path) -> None:
    bad = tmp_path / "not-video.mp4"
    bad.write_bytes(b"definitely not a video")
    with pytest.raises(FfmpegError):
        probe(bad)


def test_normalize_unifies_everything(tmp_path: Path) -> None:
    """规范化的全部意义：不同来源的参数要变成同一套，否则拼不了。"""
    src = make_clip(tmp_path / "odd.mp4", width=640, height=360)  # 横屏 30fps
    out = normalize(src, tmp_path / "norm.mp4")

    assert out.width == 1080
    assert out.height == 1920  # 竖屏
    assert abs(out.fps - 24) < 0.1
    assert out.has_audio is True


def test_normalize_adds_silent_track_when_missing(tmp_path: Path) -> None:
    """没有音轨的 clip 必须补静音轨，否则 concat 时音画会错位。"""
    src = make_clip(tmp_path / "mute.mp4", audio=False)
    assert probe(src).has_audio is False

    out = normalize(src, tmp_path / "norm.mp4")
    assert out.has_audio is True


def test_normalize_cmd_pins_gop_for_hls(tmp_path: Path) -> None:
    """固定 GOP 是后续切 HLS 能对齐的前提，不固定切片会漂。"""
    cmd = normalize_cmd(tmp_path / "a.mp4", tmp_path / "b.mp4", has_audio=True)
    assert "-sc_threshold" in cmd and cmd[cmd.index("-sc_threshold") + 1] == "0"
    assert cmd[cmd.index("-g") + 1] == "48"  # 24fps × 2 秒
    assert "setsar=1" in " ".join(cmd)  # 不统一 SAR 拼完会被拉伸
    assert "+faststart" in cmd  # moov 前置，浏览器可边下边播


def test_concat_produces_sum_of_durations(tmp_path: Path) -> None:
    """两段式的验收：拼出来的时长应当是各段之和。"""
    norm = []
    for i, sec in enumerate([2, 3]):
        src = make_clip(tmp_path / f"s{i}.mp4", seconds=sec)
        dst = tmp_path / f"n{i}.mp4"
        normalize(src, dst)
        norm.append(Clip(path=dst))

    out = concat(norm, tmp_path / "master.mp4", tmp_path)
    assert 4.5 < out.duration_sec < 5.6  # 2 + 3，容忍关键帧对齐的误差
    assert out.width == 1080
    assert out.has_audio is True


def test_concat_respects_trim(tmp_path: Path) -> None:
    src = make_clip(tmp_path / "s.mp4", seconds=4)
    n = tmp_path / "n.mp4"
    normalize(src, n)

    out = concat([Clip(path=n, trim_start_sec=1.0, trim_end_sec=3.0)], tmp_path / "t.mp4", tmp_path)
    assert out.duration_sec < 3.5  # 裁过了，不是原始 4 秒


def test_concat_list_escapes_quotes() -> None:
    """路径里的单引号不转义会截断清单——安静地少拼几段。"""
    text = concat_list([Clip(path=Path("/tmp/it's here.mp4"))])
    assert r"'\''" in text


def test_concat_rejects_empty() -> None:
    with pytest.raises(FfmpegError):
        concat([], Path("/tmp/x.mp4"), Path("/tmp"))


def test_thumbnail_is_a_real_image(tmp_path: Path) -> None:
    src = make_clip(tmp_path / "s.mp4")
    out = tmp_path / "t.jpg"
    thumbnail(src, out, width=270)
    assert out.stat().st_size > 0
    # JPEG 魔数
    assert out.read_bytes()[:2] == b"\xff\xd8"
