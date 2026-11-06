#!/usr/bin/env python3
"""논문 제안 이슈(📄) 에 붙여 넣을 본문을 만든다.

    python tools/propose_paper.py PMC12215570
    python tools/propose_paper.py 10.1001/jamanetworkopen.2025.17708
    python tools/propose_paper.py 2402.06196

라이선스, 제목, 학술지, 연도, 표 수, 참고문헌 수, 임상시험 등록번호(NCT, DRKS, ISRCTN, KCT),
코드 저장소(github.com) 를 뽑아 이슈 양식 순서로 표준 출력에 낸다.

종료 코드
  0  CC0, CC BY: 쓸 수 있음
  1  CC BY-NC, CC BY-SA: 확인 필요.  라이선스를 모를 때도 1 (함께 확인)
  2  CC BY-ND, CC BY-NC-ND, arXiv 기본 라이선스: 개작 또는 재배포가 막혀 쓸 수 없음
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass

import fetch_paper
from _common import FetchError, http_get

REG_PATTERN = re.compile(r"\b(NCT\d{8}|DRKS\d{8}|ISRCTN\d{8}|KCT\d{7})\b")
REPO_PATTERN = re.compile(r"(?:https?://)?(?:www\.)?github\.com/[\w.\-]+/[\w.\-]+", flags=re.I)
DOI_PATTERN = re.compile(r"^(?:https?://(?:dx\.)?doi\.org/|doi:\s*)?(10\.\d{4,9}/\S+)$", flags=re.I)
ARXIV_DEFAULT = "nonexclusive-distrib"

RED = "\033[31;1m"
YELLOW = "\033[33;1m"
GREEN = "\033[32;1m"
RESET = "\033[0m"


@dataclass(frozen=True)
class LicenseVerdict:
    status: str      # ok / check / no / unknown
    exit_code: int   # 0 / 1 / 2 / 1
    label: str       # 이슈 양식의 드롭다운 문구
    note: str        # 사람에게 보여 줄 한 줄


def classify_license(text: str | None) -> LicenseVerdict:
    s = (text or "").strip().lower()
    s = re.sub(r"[\s_]+", "-", s)
    if not s:
        return LicenseVerdict("unknown", 1, "모르겠음 (함께 확인)", "라이선스 정보를 찾지 못했습니다. 논문 첫 장이나 출판사 페이지에서 함께 확인합니다")
    if ARXIV_DEFAULT in s:
        return LicenseVerdict("no", 2, "arXiv 기본 라이선스 (재배포 제한, 쓸 수 없음)",
                              "arXiv 기본 라이선스(nonexclusive-distrib)는 개작과 재배포를 허락하지 않습니다. 이 논문은 쓸 수 없습니다")
    if "cc0" in s or "publicdomain/zero" in s or "public-domain" in s:
        return LicenseVerdict("ok", 0, "CC0 (쓸 수 있음)", "CC0 입니다. 쓸 수 있습니다")
    if re.search(r"by[-/](?:nc[-/])?nd", s):
        label = "CC BY-NC-ND (개작 금지, 쓸 수 없음)" if "nc" in s else "CC BY-ND (개작 금지, 쓸 수 없음)"
        return LicenseVerdict("no", 2, label, "개작 금지(ND) 라이선스입니다. 결함을 심은 변조본을 만들 수 없으니 이 논문은 쓸 수 없습니다")
    if re.search(r"by[-/]nc|by[-/]sa|nc[-/]sa", s):
        if "sa" in s and "nc" in s:
            label = "CC BY-NC-SA (확인 필요)"
        elif "sa" in s:
            label = "CC BY-SA (확인 필요)"
        else:
            label = "CC BY-NC (확인 필요)"
        return LicenseVerdict("check", 1, label, "비영리(NC) 또는 동일조건(SA) 조건이 붙어 있습니다. 공개 벤치마크로 내도 되는지 빌더와 확인합니다")
    if re.search(r"cc[-/]?by|licenses/by/|^by$|^by[-/]\d", s):
        return LicenseVerdict("ok", 0, "CC BY (쓸 수 있음)", "CC BY 입니다. 쓸 수 있습니다")
    return LicenseVerdict("unknown", 1, "모르겠음 (함께 확인)", f"라이선스 문구를 해석하지 못했습니다: {text!r}. 함께 확인합니다")


def extract_registrations(text: str) -> list[str]:
    return sorted(set(REG_PATTERN.findall(text or "")))


def extract_repos(text: str) -> list[str]:
    found = set()
    for m in REPO_PATTERN.findall(text or ""):
        url = re.sub(r"^(?:https?://)?(?:www\.)?", "https://", m)
        url = url.rstrip(".,;:)]}>'\"")
        found.add(url)
    return sorted(found)


# ---------------------------------------------------------------- 조회
def _doi_to_pmcid(doi: str, http) -> str:
    text = http(fetch_paper.EPMC_SEARCH.format(query=f'DOI:"{doi}"'))
    try:
        results = json.loads(text).get("resultList", {}).get("result", [])
    except json.JSONDecodeError as e:
        raise FetchError("Europe PMC 응답을 읽지 못했습니다") from e
    for r in results:
        if r.get("pmcid"):
            return r["pmcid"]
    if results:
        raise FetchError(f"DOI {doi} 는 Europe PMC 에 있지만 PMC 전문(PMCID)이 없습니다. 오픈액세스 전문이 있는 논문만 다룹니다")
    raise FetchError(f"DOI {doi} 를 Europe PMC 에서 찾지 못했습니다. 생의학 논문이 아니거나 아직 색인되지 않았습니다")


def resolve(identifier: str, http=None) -> dict:
    http = http or http_get
    ident = identifier.strip()
    m = DOI_PATTERN.match(ident)
    if m and not re.match(r"^\d{4}\.\d{4,5}", ident):
        pmcid = _doi_to_pmcid(m.group(1), http)
        kind, pid = "pmc", pmcid
    else:
        kind, pid = fetch_paper.parse_id(ident)
    md, meta = fetch_paper.fetch_pmc(pid, http) if kind == "pmc" else fetch_paper.fetch_arxiv(pid, http)
    counts = meta.get("counts", {})
    return {
        "id": pid,
        "kind": kind,
        "input": identifier,
        "title": meta.get("title", ""),
        "authors": meta.get("authors", []),
        "journal": meta.get("journal", ""),
        "year": meta.get("year", ""),
        "doi": meta.get("doi", ""),
        "license": meta.get("license", "") or meta.get("license_text", ""),
        "tables": counts.get("tables", 0),
        "references": counts.get("references", 0),
        "figures": counts.get("figures", 0),
        "registrations": extract_registrations(md),
        "repos": extract_repos(md),
        "url": meta.get("landing_url", ""),
        "has_html": meta.get("has_html", kind == "pmc"),
    }


# ---------------------------------------------------------------- 이슈 본문
def build_issue_body(info: dict) -> str:
    v = classify_license(info["license"])
    ids = [info["id"]]
    if info.get("doi"):
        ids.append(info["doi"])
    evidence = [f"표 {info['tables']}개", f"참고문헌 {info['references']}개"]
    if info.get("figures"):
        evidence.append(f"그림 {info['figures']}개")
    if info["registrations"]:
        evidence.append("임상시험 등록부 " + ", ".join(info["registrations"]))
    if info["repos"]:
        evidence.append("코드 저장소 " + ", ".join(info["repos"]))
    lines = [
        "### 논문",
        f"{info['title']}, {info['journal']}, {info['year']}".rstrip(", "),
        "",
        "### 식별자",
        " / ".join(ids),
        "",
        "### 라이선스",
        v.label,
        f"(출처 표기: {info['license'] or '없음'})",
        "",
        "### 왜 이 논문인가",
        "(직접 적어 주세요. 어떤 점이 끌리는지, 어떤 결함을 심어 볼 만한지)",
        "",
        "### 대조할 근거가 있나",
        ", ".join(evidence),
        "",
        "### 분야",
        "(직접 적어 주세요)",
    ]
    if info.get("kind") == "arxiv" and not info.get("has_html"):
        lines += ["", "주의: arXiv HTML 판이 없어 표와 참고문헌 수는 세지 못했습니다"]
    return "\n".join(lines) + "\n"


def main(argv=None, http=None) -> int:
    ap = argparse.ArgumentParser(description="논문 제안 이슈에 붙여 넣을 본문을 만들고 라이선스를 판정한다")
    ap.add_argument("identifier", help="PMCID, arXiv 번호, DOI 중 하나")
    ap.add_argument("--no-color", action="store_true", help="경고에 색을 쓰지 않는다")
    args = ap.parse_args(argv)
    try:
        info = resolve(args.identifier, http=http)
    except (ValueError, FetchError) as e:
        print(f"실패: {e}", file=sys.stderr)
        return 1
    print(build_issue_body(info))
    v = classify_license(info["license"])
    color = "" if (args.no_color or not sys.stdout.isatty()) else {"no": RED, "check": YELLOW, "ok": GREEN}.get(v.status, YELLOW)
    reset = RESET if color else ""
    marker = {"no": "경고", "check": "확인 필요", "ok": "통과", "unknown": "함께 확인"}[v.status]
    print(f"{color}[{marker}] {v.note}{reset}")
    return v.exit_code


if __name__ == "__main__":
    sys.exit(main())
