"""propose_paper 검사.

참값(녹화 응답): PMC12215570 → CC BY, 표 3, 참고문헌 30, DRKS00024174.
ND 라이선스(PMC12703818, EFSA Journal 2025, cc by-nd) → 종료 코드 2.
arXiv 기본 라이선스(1706.03762) → 종료 코드 2. arXiv CC BY(2402.06196) → 0.
"""
from __future__ import annotations

import pytest

import propose_paper as pp


@pytest.mark.parametrize(
    "text,status,code",
    [
        ("cc by", "ok", 0),
        ("CC-BY", "ok", 0),
        ("cc0", "ok", 0),
        ("http://creativecommons.org/licenses/by/4.0/", "ok", 0),
        ("http://creativecommons.org/publicdomain/zero/1.0/", "ok", 0),
        ("cc by-nd", "no", 2),
        ("cc by-nc-nd", "no", 2),
        ("http://creativecommons.org/licenses/by-nc-nd/4.0/", "no", 2),
        ("http://arxiv.org/licenses/nonexclusive-distrib/1.0/", "no", 2),
        ("cc by-nc", "check", 1),
        ("cc by-sa", "check", 1),
        ("cc by-nc-sa", "check", 1),
        ("", "unknown", 1),
        (None, "unknown", 1),
        ("author manuscript", "unknown", 1),
    ],
)
def test_classify_license(text, status, code):
    verdict = pp.classify_license(text)
    assert verdict.status == status
    assert verdict.exit_code == code


def test_registration_patterns():
    text = "registered NCT04567890 and DRKS00024174; also ISRCTN12345678 and KCT0001234. Not NCT123."
    assert pp.extract_registrations(text) == ["DRKS00024174", "ISRCTN12345678", "KCT0001234", "NCT04567890"]


def test_repo_patterns():
    text = "code at https://github.com/org/repo-name and (github.com/org/other). Not gitlab.com/x."
    assert pp.extract_repos(text) == ["https://github.com/org/other", "https://github.com/org/repo-name"]


def test_pmc_known_values(recorded_http):
    info = pp.resolve("PMC12215570", http=recorded_http)
    assert info["license"] == "cc by"
    assert info["title"].startswith("A Prescribed Digital Health App")
    assert info["journal"] == "JAMA Network Open"
    assert info["year"] == "2025"
    assert info["tables"] == 3
    assert info["references"] == 30
    assert info["registrations"] == ["DRKS00024174"]
    assert info["repos"] == []
    body = pp.build_issue_body(info)
    assert "CC BY (쓸 수 있음)" in body
    assert "DRKS00024174" in body
    assert "표 3개" in body and "참고문헌 30개" in body
    assert "PMC12215570" in body
    assert pp.classify_license(info["license"]).exit_code == 0


def test_doi_resolves_to_pmc(recorded_http):
    info = pp.resolve("10.1001/jamanetworkopen.2025.17708", http=recorded_http)
    assert info["id"] == "PMC12215570"
    assert info["tables"] == 3


def test_nd_license_exits_2(recorded_http, capsys):
    code = pp.main(["PMC12703818"], http=recorded_http)
    assert code == 2
    out = capsys.readouterr()
    assert "CC BY-ND" in out.out
    assert "쓸 수 없" in out.out or "쓸 수 없" in out.err


def test_nc_license_exits_1(recorded_http):
    assert pp.main(["PMC12853249"], http=recorded_http) == 1


def test_arxiv_default_license_exits_2(recorded_http, capsys):
    def http_no_html(url, **kw):
        if "arxiv.org/html/" in url:
            raise pp.FetchError("404")
        return recorded_http(url, **kw)

    code = pp.main(["1706.03762"], http=http_no_html)
    assert code == 2
    assert "nonexclusive-distrib" in capsys.readouterr().out


def test_arxiv_cc_by_exits_0(recorded_http, capsys):
    code = pp.main(["2402.06196"], http=recorded_http)
    assert code == 0
    out = capsys.readouterr().out
    assert "Large Language Models: A Survey" in out
    assert "CC BY (쓸 수 있음)" in out


@pytest.mark.network
def test_live_pmc():
    info = pp.resolve("PMC12215570")
    assert info["license"] == "cc by" and info["registrations"] == ["DRKS00024174"]
