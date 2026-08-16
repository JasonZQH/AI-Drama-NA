"""S3 访问。代码里永远只有 S3 SDK，没有本地路径操作（ADR-0004）。"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import Any

import boto3
from botocore.config import Config


def _client() -> Any:
    return boto3.client(
        "s3",
        endpoint_url=os.environ.get("S3_ENDPOINT", "http://localhost:9000"),
        aws_access_key_id=os.environ.get("S3_ACCESS_KEY", "adminlocal"),
        aws_secret_access_key=os.environ.get("S3_SECRET_KEY", "adminlocal123"),
        region_name="us-east-1",
        config=Config(s3={"addressing_style": "path"}),  # MinIO 需要 path style
    )


BUCKET = os.environ.get("S3_BUCKET", "drama")


def download(key: str, dst: Path) -> Path:
    dst.parent.mkdir(parents=True, exist_ok=True)
    _client().download_file(BUCKET, key, str(dst))
    return dst


def upload(src: Path, key: str, content_type: str = "video/mp4") -> dict[str, Any]:
    _client().upload_file(str(src), BUCKET, key, ExtraArgs={"ContentType": content_type})
    return {"key": key, "bytes": src.stat().st_size, "sha256": sha256(src)}


def exists(key: str) -> bool:
    try:
        _client().head_object(Bucket=BUCKET, Key=key)
        return True
    except Exception:
        return False


def sha256(path: Path) -> str:
    """流式计算，不把整个文件读进内存——母版是几十 MB。"""
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()
