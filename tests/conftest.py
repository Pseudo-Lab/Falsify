"""pytest 공통 설정.

- `tools/` 를 임포트 경로에 넣는다.
- 녹화된 응답(`tests/fixtures/`)으로 네트워크 없이 도는 가짜 HTTP 를 제공한다.
- 실제 네트워크가 필요한 검사는 `@pytest.mark.network` 로 표시하고 기본 실행에서 뺀다.
"""
from __future__ import annotations

import json
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures"
sys.path.insert(0, str(ROOT / "tools"))


@pytest.fixture
def fixtures() -> pathlib.Path:
    return FIXTURES


class RecordedHTTP:
    """URL 을 녹화 파일에 대응시키는 가짜 HTTP. 모르는 URL 은 즉시 실패한다."""

    def __init__(self, mapping: dict[str, pathlib.Path]):
        self.mapping = mapping
        self.calls: list[str] = []

    def __call__(self, url: str, **kwargs) -> str:
        self.calls.append(url)
        for key, path in self.mapping.items():
            if key in url:
                return path.read_text(encoding="utf-8")
        raise AssertionError(f"녹화되지 않은 URL 요청: {url}")


@pytest.fixture
def recorded_http() -> RecordedHTTP:
    e = FIXTURES / "europepmc"
    a = FIXTURES / "arxiv"
    return RecordedHTTP(
        {
            "rest/PMC12215570/fullTextXML": e / "PMC12215570.fullTextXML.xml",
            "rest/PMC12703818/fullTextXML": e / "PMC12703818.fullTextXML.xml",
            "rest/PMC12853249/fullTextXML": e / "PMC12853249.fullTextXML.xml",
            "query=PMCID:PMC12215570": e / "PMC12215570.search.json",
            "query=PMCID:PMC12703818": e / "PMC12703818.search.json",
            "query=PMCID:PMC12853249": e / "PMC12853249.search.json",
            "query=DOI:": e / "PMC12215570.search.json",
            "api/query?id_list=2402.06196": a / "2402.06196.atom.xml",
            "api/query?id_list=1706.03762": a / "1706.03762.atom.xml",
            "oai:arXiv.org:2402.06196": a / "2402.06196.oai.xml",
            "oai:arXiv.org:1706.03762": a / "1706.03762.oai.xml",
            "arxiv.org/html/2402.06196": a / "2402.06196.html",
            "arxiv.org/html/1706.03762": a / "1706.03762.html",
        }
    )


def load_json(path: pathlib.Path):
    return json.loads(path.read_text(encoding="utf-8"))
