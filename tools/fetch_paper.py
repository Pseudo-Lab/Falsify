#!/usr/bin/env python3
"""논문 원문을 받아 마크다운으로 저장한다.

    python tools/fetch_paper.py PMC12215570
    python tools/fetch_paper.py 2402.06196

- PMCID: Europe PMC fullTextXML(JATS) 을 받아 마크다운으로 옮긴다.
- arXiv: 메타데이터는 API(Atom), 라이선스는 OAI-PMH, 본문은 HTML 판이 있으면 그것을
  마크다운으로, 없으면 초록만 남긴다.

출력: `corpus/raw/<id>.md` 와 `corpus/raw/<id>.meta.json`
(제목, 저자, 라이선스, 출처 URL, 받은 시각 KST, 표와 참고문헌 개수).
"""
from __future__ import annotations

import argparse
import html as html_lib
import json
import pathlib
import re
import sys
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

import jats2md
from _common import REPO_ROOT, FetchError, atomic_write_text, http_get, now_kst_iso, write_json

EPMC_XML = "https://www.ebi.ac.uk/europepmc/webservices/rest/{pmcid}/fullTextXML"
EPMC_SEARCH = "https://www.ebi.ac.uk/europepmc/webservices/rest/search?query={query}&format=json&resultType=core"
ARXIV_ATOM = "https://export.arxiv.org/api/query?id_list={id}"
ARXIV_OAI = "https://export.arxiv.org/oai2?verb=GetRecord&identifier=oai:arXiv.org:{id}&metadataPrefix=arXiv"
ARXIV_HTML = "https://arxiv.org/html/{id}"
ARXIV_ABS = "https://arxiv.org/abs/{id}"
DEFAULT_OUT = REPO_ROOT / "corpus" / "raw"

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"
OAI_NS = "{http://arxiv.org/OAI/arXiv/}"

_ARXIV_NEW = re.compile(r"^(\d{4}\.\d{4,5})(v\d+)?$")
_ARXIV_OLD = re.compile(r"^([a-z\-]+(?:\.[A-Z]{2})?/\d{7})(v\d+)?$")


# ---------------------------------------------------------------- 식별자
def parse_id(s: str) -> tuple[str, str]:
    """'PMC12215570' / '12215570' / '2402.06196' / 'arXiv:2402.06196v3' / arxiv.org URL 을 구분한다."""
    s = s.strip()
    s = re.sub(r"^https?://(www\.)?arxiv\.org/(abs|pdf|html)/", "", s)
    s = re.sub(r"\.pdf$", "", s)
    s = re.sub(r"^arxiv:", "", s, flags=re.I)
    m = re.match(r"^(?:PMC)?(\d{6,9})$", s, flags=re.I)
    if m:
        return "pmc", "PMC" + m.group(1)
    if _ARXIV_NEW.match(s) or _ARXIV_OLD.match(s):
        return "arxiv", s
    raise ValueError(
        f"식별자를 알아보지 못했습니다: {s!r}\n"
        "PMCID(PMC12215570) 또는 arXiv 번호(2402.06196)를 주세요. DOI 는 propose_paper.py 가 받습니다."
    )


def arxiv_base_id(arxiv_id: str) -> str:
    return re.sub(r"v\d+$", "", arxiv_id)


# ---------------------------------------------------------------- Europe PMC
def epmc_search_record(pmcid: str, http) -> dict | None:
    """search API 의 레코드(라이선스, 학술지, 연도). 없으면 None."""
    try:
        text = http(EPMC_SEARCH.format(query=f"PMCID:{pmcid}"))
    except FetchError:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    results = data.get("resultList", {}).get("result", [])
    return results[0] if results else None


def fetch_pmc(pmcid: str, http=http_get) -> tuple[str, dict]:
    url = EPMC_XML.format(pmcid=pmcid)
    xml_text = http(url)
    if "<article" not in xml_text[:2000]:
        raise FetchError(
            f"{pmcid}: Europe PMC 에 전문 XML 이 없습니다. 오픈액세스 묶음이 아니거나 아직 적재되지 않은 논문입니다"
        )
    md = jats2md.jats_to_markdown(xml_text)
    jm = jats2md.jats_meta(xml_text)
    rec = epmc_search_record(pmcid, http) or {}
    journal = jm["journal"] or (rec.get("journalInfo", {}) or {}).get("journal", {}).get("title", "")
    meta = {
        "id": pmcid,
        "source": "europepmc",
        "title": jm["title"] or rec.get("title", ""),
        "authors": jm["authors"] or [a.strip() for a in rec.get("authorString", "").rstrip(".").split(",") if a.strip()],
        "journal": journal,
        "year": jm["year"] or str(rec.get("pubYear", "")),
        "doi": jm["doi"] or rec.get("doi", ""),
        "pmid": jm["pmid"] or rec.get("pmid", ""),
        "license": rec.get("license", "") or "",
        "license_text": jm["license_text"],
        "license_url": jm["license_url"],
        "source_url": url,
        "landing_url": f"https://europepmc.org/article/PMC/{pmcid}",
        "fetched_at": now_kst_iso(),
        "counts": jats2md.jats_stats(xml_text),
    }
    return md, meta


# ---------------------------------------------------------------- arXiv
def parse_arxiv_atom(text: str) -> dict:
    root = ET.fromstring(text)
    entry = root.find(ATOM + "entry")
    if entry is None:
        raise FetchError("arXiv API 응답에 논문이 없습니다")
    title = jats2md._norm(entry.findtext(ATOM + "title") or "")
    if title.startswith("Error") or entry.find(ATOM + "id") is None:
        raise FetchError(f"arXiv API 오류: {jats2md._norm(entry.findtext(ATOM + 'summary') or '')}")
    authors = [jats2md._norm(a.findtext(ATOM + "name") or "") for a in entry.findall(ATOM + "author")]
    lic = entry.findtext(ARXIV_NS + "license") or entry.findtext(ATOM + "rights") or ""
    return {
        "title": title,
        "authors": [a for a in authors if a],
        "summary": jats2md._norm(entry.findtext(ATOM + "summary") or ""),
        "published": (entry.findtext(ATOM + "published") or "")[:10],
        "doi": entry.findtext(ARXIV_NS + "doi") or "",
        "journal_ref": entry.findtext(ARXIV_NS + "journal_ref") or "",
        "license": lic.strip(),
        "abs_url": (entry.findtext(ATOM + "id") or "").strip(),
    }


def parse_arxiv_oai(text: str) -> dict:
    root = ET.fromstring(text)
    meta = root.find(f".//{OAI_NS}arXiv")
    if meta is None:
        return {}
    return {
        "license": (meta.findtext(OAI_NS + "license") or "").strip(),
        "title": jats2md._norm(meta.findtext(OAI_NS + "title") or ""),
        "doi": (meta.findtext(OAI_NS + "doi") or "").strip(),
        "journal_ref": (meta.findtext(OAI_NS + "journal-ref") or "").strip(),
    }


class _HTML2MD(HTMLParser):
    """arXiv HTML(LaTeXML) 을 단순 마크다운으로. 제목, 문단, 목록, 표, 그림 설명만 옮긴다."""

    BLOCK = {"p", "li", "figcaption", "pre", "blockquote", "dd", "dt"}
    SKIP = {"script", "style", "head", "nav", "footer", "math", "svg", "noscript", "button"}
    # class 토큰이 정확히 일치할 때만 건너뛴다. 부분 일치로 하면 "ltx_authors_1line" 이 붙은
    # <article> 전체가 빠져 본문이 사라진다 (실제로 그랬다).
    SKIP_CLASS = {"ltx_page_header", "ltx_page_footer", "ltx_page_logo", "ltx_role_footnote", "ltx_note",
                  "ltx_authors", "ltx_dates", "ltx_toc", "ltx_pagination", "ltx_note_outer"}

    def __init__(self, article_only: bool = True):
        super().__init__(convert_charrefs=True)
        self.blocks: list[str] = []
        self.buf: list[str] = []
        self.skip_depth = 0
        self.skip_stack: list[bool] = []
        self.list_depth = 0
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None
        self.heading: int | None = None
        self.in_pre = False
        self.article_only = article_only
        self.article_depth = 0  # <article> 안에서만 글을 모은다 (안내문, 로고 같은 바깥 요소를 뺀다)

    # 닫는 태그가 없는 요소. skip 스택에 넣으면 </head> 가 <meta> 의 항목을 꺼내는 식으로
    # 어긋나 문서 전체가 skip 상태로 남는다 (실제로 그랬다).
    VOID = {"br", "img", "meta", "link", "input", "hr", "area", "base", "col", "embed", "param",
            "source", "track", "wbr"}

    def _outside(self) -> bool:
        return self.article_only and self.article_depth == 0

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in self.VOID:
            self.handle_endtag(tag)

    def _flush(self):
        text = "".join(self.buf)
        text = text if self.in_pre else re.sub(r"[ \t\r\n]+", " ", text).strip()
        self.buf = []
        if not text:
            return
        if self.heading:
            level = self.heading
            if text.strip().lower() == "abstract":
                level = 2  # LaTeXML 은 초록 제목을 h6 으로 둔다
            self.blocks.append("#" * level + " " + text)
        elif self.list_depth:
            self.blocks.append("  " * (self.list_depth - 1) + "- " + text)
        else:
            self.blocks.append(text)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in self.VOID:
            if tag == "br" and not self.skip_depth and not self._outside():
                (self.cell if self.cell is not None else self.buf).append("\n" if self.in_pre else " ")
            return
        if tag == "article":
            self.article_depth += 1
        cls_tokens = set((a.get("class", "") or "").split())
        skip = tag in self.SKIP or bool(cls_tokens & self.SKIP_CLASS)
        self.skip_stack.append(skip)
        if skip:
            if tag == "math" and a.get("alttext") and not self.skip_depth and not self._outside():
                (self.cell if self.cell is not None else self.buf).append(" " + a["alttext"] + " ")
            self.skip_depth += 1
            return
        if self.skip_depth or self._outside():
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self.heading = int(tag[1])
        elif tag in self.BLOCK:
            self._flush()
            if tag == "pre":
                self.in_pre = True
        elif tag in ("ul", "ol"):
            self._flush()
            self.list_depth += 1
        elif tag == "table":
            self._flush()
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []
        elif tag in ("div", "section", "article", "figure") and self.cell is None:
            self._flush()

    def handle_endtag(self, tag):
        if tag in self.VOID:
            return
        was_skip = self.skip_stack.pop() if self.skip_stack else False
        if was_skip:
            self.skip_depth = max(0, self.skip_depth - 1)
            return
        if self.skip_depth or self._outside():
            return
        if tag == "article":
            self._flush()
            self.article_depth = max(0, self.article_depth - 1)
            return
        if tag in ("h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush()
            self.heading = None
        elif tag in self.BLOCK:
            self._flush()
            if tag == "pre":
                self.in_pre = False
        elif tag in ("ul", "ol"):
            self._flush()
            self.list_depth = max(0, self.list_depth - 1)
        elif tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip().replace("|", "\\|"))
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            if self.row:
                self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            rows = self.table
            self.table = None
            if rows:
                width = max(len(r) for r in rows)
                lines = ["| " + " | ".join(rows[0] + [""] * (width - len(rows[0]))) + " |", "|" + "---|" * width]
                for r in rows[1:]:
                    lines.append("| " + " | ".join(r + [""] * (width - len(r))) + " |")
                self.blocks.append("\n".join(lines))

    def handle_data(self, data):
        if self.skip_depth or self._outside():
            return
        if self.cell is not None:
            self.cell.append(data)
        else:
            self.buf.append(data)

    def result(self) -> str:
        self._flush()
        return "\n\n".join(self.blocks).strip() + "\n"


def html_to_markdown(html_text: str) -> str:
    """<article> 가 있으면 그 안만, 없으면 문서 전체를 옮긴다."""
    p = _HTML2MD(article_only="<article" in html_text)
    p.feed(html_text)
    p.close()
    return p.result()


def fetch_arxiv(arxiv_id: str, http=http_get) -> tuple[str, dict]:
    base = arxiv_base_id(arxiv_id)
    atom = parse_arxiv_atom(http(ARXIV_ATOM.format(id=arxiv_id)))
    oai: dict = {}
    try:
        oai = parse_arxiv_oai(http(ARXIV_OAI.format(id=base)))
    except (FetchError, ET.ParseError):
        oai = {}
    license_ = atom["license"] or oai.get("license", "")

    html_url = ARXIV_HTML.format(id=arxiv_id)
    body_md = ""
    has_html = False
    try:
        html_text = http(html_url)
        if "ltx_document" in html_text or "<article" in html_text:
            has_html = True
            body_md = html_to_markdown(html_text)
    except FetchError:
        has_html = False

    title = atom["title"] or oai.get("title", "")
    lines = [f"# {title}", ""]
    if has_html:
        # HTML 판의 첫 h1(제목)은 이미 위에 적었으니 뺀다
        body = re.sub(r"^# .*\n\n?", "", body_md, count=1)
        if "## Abstract" not in body and atom["summary"]:
            lines += ["## Abstract", "", atom["summary"], ""]
        lines.append(body)
    else:
        lines += ["## Abstract", "", atom["summary"], ""]
        lines += ["", "_arXiv HTML 판이 없어 초록만 담았다. 전문은 PDF 를 참고._", ""]
    md = "\n".join(lines).rstrip() + "\n"

    ref_section = md.split("## References", 1)[1] if "## References" in md else ""
    bracket_refs = re.findall(r"^(?:- )?\[\d+\]", ref_section, flags=re.M)  # LaTeXML 서지 항목
    numbered_refs = re.findall(r"^\d+\. ", ref_section, flags=re.M)  # 부록의 번호 목록과 섞일 수 있어 둘째 후보
    counts = {
        "tables": len(re.findall(r"^\|---", md, flags=re.M)),
        "references": len(bracket_refs) or len(numbered_refs),
        "figures": len(re.findall(r"^Figure \d+[:.]", md, flags=re.M)),
    }
    meta = {
        "id": arxiv_id,
        "source": "arxiv",
        "title": title,
        "authors": atom["authors"],
        "journal": atom["journal_ref"] or oai.get("journal_ref", "") or "arXiv",
        "year": atom["published"][:4],
        "doi": atom["doi"] or oai.get("doi", ""),
        "license": license_,
        "license_text": license_,
        "license_url": license_,
        "source_url": html_url if has_html else ARXIV_ABS.format(id=arxiv_id),
        "landing_url": ARXIV_ABS.format(id=arxiv_id),
        "has_html": has_html,
        "fetched_at": now_kst_iso(),
        "counts": counts,
    }
    return md, meta


# ---------------------------------------------------------------- 실행
def run(identifier: str, out_dir: pathlib.Path | None = None, http=None) -> dict:
    http = http or http_get
    kind, pid = parse_id(identifier)
    md, meta = fetch_pmc(pid, http) if kind == "pmc" else fetch_arxiv(pid, http)
    out_dir = pathlib.Path(out_dir) if out_dir else DEFAULT_OUT
    md_path = out_dir / f"{pid}.md"
    meta_path = out_dir / f"{pid}.meta.json"
    atomic_write_text(md_path, md)
    write_json(meta_path, meta)
    return {"md_path": md_path, "meta_path": meta_path, "meta": meta}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="PMCID 또는 arXiv 번호로 논문 원문을 받아 corpus/raw/ 에 마크다운으로 저장한다")
    ap.add_argument("identifier", help="PMC12215570, 12215570, 2402.06196, arXiv:2402.06196v3")
    ap.add_argument("--out-dir", default=None, help=f"저장 폴더 (기본 {DEFAULT_OUT.relative_to(REPO_ROOT)})")
    args = ap.parse_args(argv)
    try:
        r = run(args.identifier, out_dir=args.out_dir)
    except (ValueError, FetchError) as e:
        print(f"실패: {e}", file=sys.stderr)
        return 1
    m = r["meta"]
    c = m["counts"]
    print(f"저장: {r['md_path']}")
    print(f"메타: {r['meta_path']}")
    print(f"제목: {m['title']}")
    print(f"라이선스: {m['license'] or '(모름)'}  표 {c['tables']}개, 참고문헌 {c['references']}개, 그림 {c['figures']}개")
    if m["source"] == "arxiv" and not m.get("has_html"):
        print("주의: arXiv HTML 판이 없어 초록만 저장했습니다")
    return 0


if __name__ == "__main__":
    sys.exit(main())
