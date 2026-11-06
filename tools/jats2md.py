"""JATS XML(Europe PMC fullTextXML) 을 마크다운으로 옮긴다.

OT 시연(`_lab/ot-demo/paper.xml` → `paper_original.md`)에서 쓴 변환을 옮겨 왔다.
출력 모양은 시연 때와 같다.

- `# 제목`
- `## Abstract` 아래 `**Question** 본문` 식의 한 줄 항목
- `## 절`, `### 소절`
- 그림은 `[Figure 1. 설명]` 한 줄
- 표는 `**Table 1. 제목**` 다음에 파이프 표, 각주는 `_..._`
- `## References` 아래 `1. 인용문`

참고문헌 번호가 "1. 1. ..." 로 두 번 찍히던 문제는 라벨을 버리고 번호를 새로 매긴 뒤
정규식으로 한 번 더 걸러서 막는다.
"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

XLINK = "{http://www.w3.org/1999/xlink}href"
SKIP_SEC_TYPES = {"ref-list", "associated-data", "supplementary-materials", "history"}
SKIP_IN_BODY = {"supplementary-material"}
DOUBLE_LABEL = re.compile(r"^(\d+)\. \1\. ", flags=re.M)


def _parse(xml_text: str) -> ET.Element:
    try:
        return ET.fromstring(xml_text)
    except ET.ParseError as e:
        raise ValueError(f"JATS XML 을 읽지 못했습니다: {e}") from e


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def _text(el: ET.Element | None, skip: set[str] = frozenset()) -> str:
    """요소 안의 글자를 전부 이어 붙인다. skip 에 든 태그의 하위 트리는 건너뛴다."""
    if el is None:
        return ""
    parts: list[str] = []

    def walk(e: ET.Element) -> None:
        if e.tag in skip:
            return
        if e.text:
            parts.append(e.text)
        for c in e:
            walk(c)
            if c.tail:
                parts.append(c.tail)

    walk(el)
    return _norm("".join(parts))


# ---------------------------------------------------------------- 통계와 메타
def jats_stats(xml_text: str) -> dict[str, int]:
    root = _parse(xml_text)
    return {
        "tables": len(root.findall(".//table-wrap")),
        "references": len(root.findall(".//ref-list//ref")),
        "figures": len(root.findall(".//fig")),
    }


def jats_meta(xml_text: str) -> dict:
    root = _parse(xml_text)
    am = root.find(".//article-meta")
    title = _text(root.find(".//article-meta/title-group/article-title"))
    subtitle = _text(root.find(".//article-meta/title-group/subtitle"))
    full_title = f"{title}: {subtitle}" if subtitle else title
    authors = []
    for c in root.findall(".//article-meta//contrib"):
        if c.get("contrib-type") not in (None, "author"):
            continue
        given = _text(c.find("name/given-names"))
        sur = _text(c.find("name/surname"))
        name = " ".join(x for x in (given, sur) if x)
        if not name:
            name = _text(c.find("collab"))
        if name:
            authors.append(name)
    ids = {a.get("pub-id-type"): _text(a) for a in root.findall(".//article-meta/article-id")}
    year = ""
    for pd in root.findall(".//article-meta/pub-date"):
        y = _text(pd.find("year"))
        if y:
            year = y
            break
    lic = root.find(".//permissions/license")
    lic_url = ""
    if lic is not None:
        lic_url = lic.get(XLINK, "") or ""
        if not lic_url:
            for el in lic.iter("ext-link"):
                lic_url = el.get(XLINK, "") or ""
                if lic_url:
                    break
    return {
        "title": full_title,
        "short_title": title,
        "authors": authors,
        "journal": _text(root.find(".//journal-meta/journal-title-group/journal-title"))
        or _text(root.find(".//journal-meta/journal-title")),
        "year": year,
        "doi": ids.get("doi", ""),
        "pmcid": ids.get("pmcid", "") or (("PMC" + ids["pmcaid"]) if ids.get("pmcaid") else ""),
        "pmid": ids.get("pmid", ""),
        "license_text": _text(lic),
        "license_url": lic_url,
        "_has_article_meta": am is not None,
    }


# ---------------------------------------------------------------- 본문 변환
def _render_table(tw: ET.Element) -> list[str]:
    out: list[str] = []
    label = _text(tw.find("label")).rstrip()
    cap = _text(tw.find("caption"))
    head = f"{label} {cap}".strip() if label else cap
    if head:
        out.append(f"**{head}**")
        out.append("")
    table = tw.find(".//table")
    if table is not None:
        rows: list[list[str]] = []
        header_done = False
        for section in list(table.findall("thead")) + list(table.findall("tbody")) + (
            [table] if table.find("tr") is not None else []
        ):
            for tr in section.findall("tr"):
                cells = [_text(c) for c in tr if c.tag in ("th", "td")]
                if not header_done:
                    out.append("| " + " | ".join(cells) + " |")
                    out.append("|" + "---|" * max(1, len(cells)))
                    header_done = True
                else:
                    rows.append(cells)
        for cells in rows:
            out.append("| " + " | ".join(cells) + " |")
        out.append("")
    foot = tw.find("table-wrap-foot")
    if foot is not None:
        notes = []
        for fn in foot.findall(".//fn"):
            lab = _text(fn.find("label"))
            body = " ".join(_text(p) for p in fn.findall("p"))
            notes.append(f"{lab} {body}".strip())
        for p in foot.findall("p"):
            notes.append(_text(p))
        if notes:
            out.append("_" + " ".join(notes) + "_")
            out.append("")
    return out


def _render_fig(fig: ET.Element) -> list[str]:
    label = _text(fig.find("label")).rstrip()
    cap = _text(fig.find("caption"))
    return [f"[{(label + ' ' + cap).strip()}]", ""]


def _render_list(lst: ET.Element) -> list[str]:
    out = []
    ordered = lst.get("list-type", "") in ("order", "alpha-lower", "alpha-upper", "roman-lower", "roman-upper")
    for i, item in enumerate(lst.findall("list-item"), 1):
        txt = _text(item)
        out.append(f"{i}. {txt}" if ordered else f"- {txt}")
    out.append("")
    return out


def _render_block(el: ET.Element, level: int) -> list[str]:
    out: list[str] = []
    tag = el.tag
    if tag == "sec":
        if el.get("sec-type") in SKIP_SEC_TYPES:
            return out
        if el.find("ref-list") is not None:
            return out
        title = _text(el.find("title"))
        if title:
            out.append("#" * min(level, 6) + " " + title)
            out.append("")
        for c in el:
            if c.tag == "title":
                continue
            out.extend(_render_block(c, level + 1))
    elif tag == "p":
        txt = _text(el, skip={"fig", "table-wrap", "supplementary-material"})
        if txt:
            out.append(txt)
            out.append("")
        for c in el:
            if c.tag in ("fig", "table-wrap"):
                out.extend(_render_block(c, level))
    elif tag == "fig":
        out.extend(_render_fig(el))
    elif tag == "fig-group":
        for f in el.findall("fig"):
            out.extend(_render_fig(f))
    elif tag == "table-wrap":
        out.extend(_render_table(el))
    elif tag == "table-wrap-group":
        for t in el.findall("table-wrap"):
            out.extend(_render_table(t))
    elif tag == "list":
        out.extend(_render_list(el))
    elif tag in ("disp-quote", "boxed-text", "statement", "notes"):
        for c in el:
            out.extend(_render_block(c, level))
    elif tag in ("title", "label", "ref-list") or tag in SKIP_IN_BODY:
        return out
    else:
        txt = _text(el)
        if txt:
            out.append(txt)
            out.append("")
    return out


def _render_abstracts(root: ET.Element) -> list[str]:
    out: list[str] = []
    for ab in root.findall(".//article-meta/abstract"):
        if ab.get("abstract-type") == "teaser":
            continue
        for c in ab:
            if c.tag == "title":
                continue
            if c.tag == "sec":
                t = _text(c.find("title"))
                body = " ".join(_text(p) for p in c.findall("p"))
                out.append(f"**{t}** {body}".strip() if t else body)
            elif c.tag == "p":
                out.append(_text(c))
    return [line for line in out if line]


def _render_references(root: ET.Element) -> list[str]:
    out: list[str] = []
    refs = root.findall(".//ref-list//ref")
    for i, ref in enumerate(refs, 1):
        cit = ref.find("mixed-citation")
        if cit is None:
            cit = ref.find("element-citation")
        if cit is None:
            cit = ref.find("citation")
        txt = _text(cit) if cit is not None else _text(ref, skip={"label"})
        out.append(f"{i}. {txt}")
    return out


def jats_to_markdown(xml_text: str) -> str:
    root = _parse(xml_text)
    meta = jats_meta(xml_text)
    lines: list[str] = [f"# {meta['short_title']}", ""]

    abstract = _render_abstracts(root)
    if abstract:
        lines += ["## Abstract", ""] + abstract + [""]

    body = root.find("body")
    if body is not None:
        for sec in body:
            lines.extend(_render_block(sec, 2))

    refs = _render_references(root)
    if refs:
        lines += ["## References", ""] + refs + [""]

    md = "\n".join(lines)
    md = re.sub(r"\n{3,}", "\n\n", md).rstrip() + "\n"
    md = DOUBLE_LABEL.sub(r"\1. ", md)  # "1. 1. " 로 겹친 번호를 한 번 더 걸러 낸다
    return md
