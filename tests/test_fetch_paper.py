"""fetch_paper 와 jats2md 검사.

참값: PMC12215570(JAMA Netw Open 2025, 편두통 앱 RCT)은 표 3개, 참고문헌 30개, 그림 2개.
"""
from __future__ import annotations

import json
import re

import pytest

import jats2md
import fetch_paper


@pytest.fixture
def jats_xml(fixtures):
    return (fixtures / "europepmc" / "PMC12215570.fullTextXML.xml").read_text(encoding="utf-8")


def test_counts_match_known_values(jats_xml):
    stats = jats2md.jats_stats(jats_xml)
    assert stats["tables"] == 3
    assert stats["references"] == 30
    assert stats["figures"] == 2


def test_markdown_has_three_tables_and_thirty_refs(jats_xml):
    md = jats2md.jats_to_markdown(jats_xml)
    assert len(re.findall(r"^\*\*Table \d+\. ", md, flags=re.M)) == 3
    refs = md.split("## References", 1)[1]
    numbered = re.findall(r"^(\d+)\. ", refs, flags=re.M)
    assert numbered == [str(i) for i in range(1, 31)]


def test_reference_label_is_not_doubled(jats_xml):
    """과거에 '1. 1. Digital Health...' 로 번호가 두 번 찍힌 이력이 있다."""
    md = jats2md.jats_to_markdown(jats_xml)
    assert not re.search(r"^(\d+)\. \1\. ", md, flags=re.M)
    assert "\n1. Digital Health Applications." in md
    assert "\n30. Porst M, Wengler A" in md


def test_markdown_structure(jats_xml):
    md = jats2md.jats_to_markdown(jats_xml)
    assert md.startswith("# A Prescribed Digital Health App and Number of Migraine Days\n")
    assert "## Abstract" in md
    assert "**Question** Is a prescribed mobile app" in md
    assert "**Trial Registration** German Clinical Trials Register (DRKS) identifier: DRKS00024174" in md
    assert "[Figure 1. Study Design for the Remote Trial]" in md
    assert "| Outcome | Adjusted mean (95% CI) | P value |" in md
    assert "## Conclusions" in md
    # 본문에 참고문헌 절이 두 번 들어가지 않는다
    assert md.count("## References") == 1


def test_meta_from_jats(jats_xml):
    meta = jats2md.jats_meta(jats_xml)
    assert meta["pmcid"] == "PMC12215570"
    assert meta["doi"] == "10.1001/jamanetworkopen.2025.17708"
    assert meta["journal"] == "JAMA Network Open"
    assert meta["year"] == "2025"
    assert meta["authors"][0] == "Daniel Pach"
    assert "CC-BY" in meta["license_text"]


def test_parse_id():
    assert fetch_paper.parse_id("PMC12215570") == ("pmc", "PMC12215570")
    assert fetch_paper.parse_id("pmc12215570") == ("pmc", "PMC12215570")
    assert fetch_paper.parse_id("12215570") == ("pmc", "PMC12215570")
    assert fetch_paper.parse_id("2402.06196") == ("arxiv", "2402.06196")
    assert fetch_paper.parse_id("arXiv:2402.06196v3") == ("arxiv", "2402.06196v3")
    assert fetch_paper.parse_id("https://arxiv.org/abs/1706.03762") == ("arxiv", "1706.03762")
    with pytest.raises(ValueError):
        fetch_paper.parse_id("10.1001/jamanetworkopen.2025.17708")


def test_fetch_pmc_writes_md_and_meta(tmp_path, recorded_http):
    out = fetch_paper.run("PMC12215570", out_dir=tmp_path, http=recorded_http)
    md_path = tmp_path / "PMC12215570.md"
    meta_path = tmp_path / "PMC12215570.meta.json"
    assert md_path.exists() and meta_path.exists()
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["id"] == "PMC12215570"
    assert meta["title"].startswith("A Prescribed Digital Health App")
    assert meta["license"] == "cc by"
    assert meta["source_url"].endswith("PMC12215570/fullTextXML")
    assert meta["counts"] == {"tables": 3, "references": 30, "figures": 2}
    # KST 시각: +09:00 오프셋
    assert meta["fetched_at"].endswith("+09:00")
    assert out["md_path"] == md_path


def test_fetch_arxiv_with_html(tmp_path, recorded_http):
    fetch_paper.run("2402.06196", out_dir=tmp_path, http=recorded_http)
    meta = json.loads((tmp_path / "2402.06196.meta.json").read_text(encoding="utf-8"))
    assert meta["title"] == "Large Language Models: A Survey"
    assert meta["license"] == "http://creativecommons.org/licenses/by/4.0/"
    assert meta["authors"][0] == "Shervin Minaee"
    md = (tmp_path / "2402.06196.md").read_text(encoding="utf-8")
    assert md.startswith("# Large Language Models: A Survey")
    # HTML 판의 본문이 실제로 옮겨졌다. <article class="ltx_document ltx_authors_1line"> 를
    # 통째로 건너뛰어 초록만 남은 적이 있어, 절 제목과 본문 문장을 둘 다 확인한다
    assert re.search(r"^## .*Introduction", md, flags=re.M)
    assert "Language modeling is a long-standing research topic" in md
    # arXiv 안내문(로고, 실험 기능 알림)은 들어오지 않는다
    assert "experimental HTML" not in md and "Back to arXiv" not in md


def test_fetch_arxiv_abstract_only_when_no_html(tmp_path, recorded_http):
    def http_no_html(url, **kw):
        if "arxiv.org/html/" in url:
            raise fetch_paper.FetchError(f"404: {url}")
        return recorded_http(url, **kw)

    fetch_paper.run("1706.03762", out_dir=tmp_path, http=http_no_html)
    meta = json.loads((tmp_path / "1706.03762.meta.json").read_text(encoding="utf-8"))
    assert meta["license"] == "http://arxiv.org/licenses/nonexclusive-distrib/1.0/"
    md = (tmp_path / "1706.03762.md").read_text(encoding="utf-8")
    assert md.startswith("# Attention Is All You Need")
    assert "## Abstract" in md
    assert "dominant sequence transduction models" in md


def test_html_to_markdown_small_sample():
    html = """<html><body><article>
    <h1 class="ltx_title ltx_title_document">T</h1>
    <h2 class="ltx_title ltx_title_section"><span class="ltx_tag">1 </span>Intro</h2>
    <p class="ltx_p">Hello <em>world</em>.</p>
    <table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
    <ul><li>one</li><li>two</li></ul>
    </article></body></html>"""
    md = fetch_paper.html_to_markdown(html)
    assert "## 1 Intro" in md
    assert "Hello world." in md
    assert "| a | b |" in md and "| 1 | 2 |" in md
    assert "- one" in md


@pytest.mark.network
def test_live_pmc_counts(tmp_path):
    fetch_paper.run("PMC12215570", out_dir=tmp_path)
    meta = json.loads((tmp_path / "PMC12215570.meta.json").read_text(encoding="utf-8"))
    assert meta["counts"]["tables"] == 3 and meta["counts"]["references"] == 30
