"""도구 다섯 개가 함께 쓰는 작은 도우미.

- KST 시각
- HTTP GET (requests). 실패하면 한국어 메시지의 FetchError
- 원자적 파일 쓰기 (임시 파일에 쓰고 os.replace)
"""
from __future__ import annotations

import json
import os
import pathlib
import tempfile
from datetime import datetime, timedelta, timezone

KST = timezone(timedelta(hours=9), name="KST")
REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
USER_AGENT = "Falsify-tools/0.1 (Pseudo-Lab study; contact via GitHub issues)"


class FetchError(Exception):
    """네트워크 조회 실패. 메시지는 사람이 읽을 한국어."""


def now_kst_iso() -> str:
    return datetime.now(KST).isoformat(timespec="seconds")


def http_get(url: str, timeout: float = 30.0, headers: dict | None = None) -> str:
    """URL 의 본문을 문자열로 돌려준다. 200 이 아니면 FetchError."""
    try:
        import requests  # 지연 임포트: 네트워크를 안 쓰는 검사에서는 필요 없다
    except ImportError as e:  # pragma: no cover
        raise FetchError("requests 패키지가 없습니다. `pip install -r requirements.txt` 를 먼저 실행하세요") from e
    h = {"User-Agent": USER_AGENT}
    if headers:
        h.update(headers)
    try:
        r = requests.get(url, timeout=timeout, headers=h)
    except requests.exceptions.ConnectionError as e:
        raise FetchError(f"연결 실패: {url}\n네트워크가 끊겼거나 서버가 응답하지 않습니다 ({e.__class__.__name__})") from e
    except requests.exceptions.Timeout as e:
        raise FetchError(f"시간 초과({timeout:.0f}초): {url}") from e
    except requests.exceptions.RequestException as e:
        raise FetchError(f"요청 실패: {url} ({e})") from e
    if r.status_code == 404:
        raise FetchError(f"404: 서버에 없는 자료입니다: {url}")
    if r.status_code != 200:
        raise FetchError(f"{r.status_code}: {url}\n{r.text[:200]}")
    r.encoding = r.encoding or "utf-8"
    return r.text


def atomic_write_text(path: pathlib.Path, text: str) -> None:
    """같은 폴더의 임시 파일에 쓴 뒤 교체한다. 중간에 죽어도 반쪽 파일이 남지 않는다."""
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            f.write(text)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def write_json(path: pathlib.Path, data) -> None:
    atomic_write_text(path, json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def read_json(path: pathlib.Path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
