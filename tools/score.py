#!/usr/bin/env python3
"""Blue 판정 CSV 를 모아 재현율, 정밀도, 유보율, 일치도를 내고 논문별 다음 수를 정한다.

    python tools/score.py results/w4/ --keys ../Falsify-keys/w3 --papers corpus/papers.csv

입력
  results/wN/*.csv   Blue 판정. 열은 고정이다:
      paper_id, team, judge_type, model, iteration, location, defect_type, label,
      evidence, time_sec, tokens, is_holdout
      label 은 맞음 / 아님 / 확인필요.
  --keys <dir>       Red 정답지 JSON (비공개 저장소). 파일마다 결함 목록:
      paper_id, team, defect_type, location, before, after, iterations,
      self_check_model, patch_v1, patch_final, why_hard
  --papers <csv>     corpus/papers.csv. `id`(또는 paper_id), `role`(team/demo/holdout), `level`.

출력
  benchmark/<week>.json  (week = results 폴더 이름)
  표준 출력에 사람이 읽을 표

정의 (논문마다, 팀마다 마지막 iteration 의 행만 제출로 본다)
  잡음(TP)   정답 결함 하나에 label=맞음 행이 같은 위치(줄 번호 ±2)에 있다
  오탐(FP)   label=맞음인데 어느 정답과도 위치가 안 맞는다. 홀드아웃 논문의 맞음은 전부 오탐
  재현율     TP / 정답 결함 수 (팀이 둘이면 정답 수도 두 번 센다)
  정밀도     TP / (TP + FP). 홀드아웃 오탐도 분모에 넣는다
  유보율     확인필요 행 / 전체 행
  일치도     한 논문을 두 팀 이상이 판정하면 결함 위치 단위의 Cohen's kappa (맞음 여부, 쌍별 평균)

논문별 다음 수 (plans "논문별 승급 루프" 표)
  human_review    확인필요 비율 > 0.5   (다른 수치가 믿기 어려우니 먼저 본다)
  blue_rematch    놓친 결함이 있다
  blue_precision  다 잡았는데 오탐이 있다
  red_up          다 잡았고 오탐 0, 반복 1회
  hold            다 잡았고 오탐 0 이지만 반복이 2회 이상. 승급 보류
  holdout         정답이 없는 홀드아웃 논문. 오탐 수만 본다
  no_judgment     정답은 있는데 판정 행이 없다
  no_key          판정 행은 있는데 정답도 없고 홀드아웃 표시도 없다 (입력 오류 의심)
"""
from __future__ import annotations

import argparse
import csv
import json
import pathlib
import re
import sys
from collections import defaultdict
from itertools import combinations

from _common import REPO_ROOT, now_kst_iso, write_json

REQUIRED_COLUMNS = ["paper_id", "team", "judge_type", "model", "iteration", "location",
                    "defect_type", "label", "evidence", "time_sec", "tokens", "is_holdout"]
LABEL_ALIASES = {
    "맞음": "yes", "yes": "yes", "true": "yes", "defect": "yes", "y": "yes", "결함": "yes",
    "아님": "no", "no": "no", "false": "no", "ok": "no", "n": "no", "정상": "no",
    "확인필요": "unsure", "확인 필요": "unsure", "unsure": "unsure", "review": "unsure", "?": "unsure",
}
TRUTHY = {"true", "1", "yes", "y", "예", "홀드아웃", "holdout"}
LINE_TOL = 2
LOC_RE = re.compile(r"^\s*(?:l|line|ln\.?|줄|행)?\s*(\d+)\s*(?:행|줄)?\s*$", flags=re.I)
MOVES_KO = {
    "red_up": "Red 승급", "blue_rematch": "Blue 재방어", "blue_precision": "Blue 정밀도 수정",
    "human_review": "사람 재판정", "hold": "승급 보류", "holdout": "홀드아웃", "no_judgment": "판정 없음",
    "no_key": "정답 없음(확인)",
}


class SchemaError(Exception):
    pass


# ---------------------------------------------------------------- 위치
def parse_location(s: str) -> int | None:
    m = LOC_RE.match(s or "")
    return int(m.group(1)) if m else None


def _norm_loc(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())


def locations_match(a: str, b: str, tol: int = LINE_TOL) -> bool:
    la, lb = parse_location(a), parse_location(b)
    if la is not None and lb is not None:
        return abs(la - lb) <= tol
    if la is None and lb is None:
        return _norm_loc(a) == _norm_loc(b)
    return False


# ---------------------------------------------------------------- 입력
def load_blue_rows(results_dir: pathlib.Path) -> list[dict]:
    files = sorted(p for p in pathlib.Path(results_dir).rglob("*.csv"))
    if not files:
        raise SchemaError(f"{results_dir} 에 CSV 가 없습니다")
    rows: list[dict] = []
    for f in files:
        with f.open(encoding="utf-8-sig", newline="") as fh:
            reader = csv.DictReader(fh)
            fields = [c.strip() for c in (reader.fieldnames or [])]
            missing = [c for c in REQUIRED_COLUMNS if c not in fields]
            if missing:
                raise SchemaError(
                    f"{f}: 열이 빠졌습니다: {', '.join(missing)}\n"
                    f"  필요한 열(순서 무관): {', '.join(REQUIRED_COLUMNS)}"
                )
            for n, raw in enumerate(reader, 2):
                r = {k.strip(): (v or "").strip() for k, v in raw.items() if k is not None}
                if not r.get("paper_id"):
                    continue
                label = LABEL_ALIASES.get(r["label"].lower())
                if label is None:
                    raise SchemaError(f"{f} {n}행: label 값을 모릅니다: {r['label']!r} (맞음 / 아님 / 확인필요 중 하나)")
                try:
                    it = int(r["iteration"]) if r["iteration"] else 1
                except ValueError:
                    raise SchemaError(f"{f} {n}행: iteration 이 정수가 아닙니다: {r['iteration']!r}")
                r["_label"] = label
                r["_iteration"] = it
                r["_holdout"] = r["is_holdout"].lower() in TRUTHY
                r["_file"] = str(f)
                r["_line"] = n
                rows.append(r)
    return rows


def load_keys(keys_dir: pathlib.Path) -> list[dict]:
    keys_dir = pathlib.Path(keys_dir)
    if not keys_dir.exists():
        raise SchemaError(f"정답지 폴더가 없습니다: {keys_dir}")
    out: list[dict] = []
    for f in sorted(keys_dir.rglob("*.json")):
        try:
            data = json.loads(f.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            raise SchemaError(f"{f}: JSON 을 읽지 못했습니다 ({e})")
        items = data if isinstance(data, list) else data.get("defects", [data]) if isinstance(data, dict) else []
        for d in items:
            if not isinstance(d, dict) or not d.get("paper_id") or not d.get("location"):
                raise SchemaError(f"{f}: 정답 항목에 paper_id 와 location 이 있어야 합니다: {str(d)[:80]}")
            d = dict(d)
            d["_file"] = str(f)
            out.append(d)
    return out


def load_papers(papers_csv: pathlib.Path | None) -> dict[str, dict]:
    if not papers_csv:
        return {}
    p = pathlib.Path(papers_csv)
    if not p.exists():
        raise SchemaError(f"papers.csv 가 없습니다: {p}")
    out: dict[str, dict] = {}
    with p.open(encoding="utf-8-sig", newline="") as fh:
        for r in csv.DictReader(fh):
            r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
            pid = r.get("paper_id") or r.get("id")
            if pid:
                out[pid] = {"role": r.get("role", ""), "level": r.get("level", "")}
    return out


# ---------------------------------------------------------------- 계산
def cohen_kappa(a: list[bool], b: list[bool]) -> float:
    if len(a) != len(b) or not a:
        return float("nan")
    n = len(a)
    po = sum(1 for x, y in zip(a, b) if x == y) / n
    pa, pb = sum(a) / n, sum(b) / n
    pe = pa * pb + (1 - pa) * (1 - pb)
    if pe == 1.0:
        return 1.0 if po == 1.0 else 0.0
    return (po - pe) / (1 - pe)


def _final_rows(rows: list[dict]) -> list[dict]:
    """(논문, 팀)마다 마지막 iteration 의 행만 남긴다."""
    last: dict[tuple[str, str], int] = {}
    for r in rows:
        k = (r["paper_id"], r["team"])
        last[k] = max(last.get(k, 0), r["_iteration"])
    return [r for r in rows if r["_iteration"] == last[(r["paper_id"], r["team"])]]


def _match(keys: list[dict], flags: list[dict]) -> tuple[int, list[str], int, int]:
    """정답 결함과 맞음 행을 짝짓는다. (TP, 놓친 위치, FP, 유형 불일치)"""
    used: set[int] = set()
    tp, missed, type_mismatch = 0, [], 0
    for k in keys:
        best = None
        for i, f in enumerate(flags):
            if i in used or not locations_match(k["location"], f["location"]):
                continue
            dist = abs((parse_location(k["location"]) or 0) - (parse_location(f["location"]) or 0))
            if best is None or dist < best[0]:
                best = (dist, i)
        if best is None:
            missed.append(str(k["location"]))
        else:
            used.add(best[1])
            tp += 1
            kt, ft = (k.get("defect_type") or "").strip(), (flags[best[1]].get("defect_type") or "").strip()
            if kt and ft and kt.lower() != ft.lower():
                type_mismatch += 1
    fp = len(flags) - len(used)
    return tp, missed, fp, type_mismatch


def _ratio(num: float, den: float) -> float | None:
    return num / den if den else None


def next_move(p: dict) -> tuple[str, str]:
    if p["judgments"] == 0:
        return "no_judgment", "판정 행이 없다"
    if p.get("is_holdout"):
        return "holdout", f"홀드아웃. 맞음 {p['false_positives']}건은 전부 오탐"
    if p["key_defects"] == 0:
        return "no_key", "정답이 없고 홀드아웃 표시도 없다. papers.csv 와 정답지를 확인"
    if (p["abstain_rate"] or 0) > 0.5:
        return "human_review", f"확인필요가 {p['abstain_rate']:.0%}. 기계가 못 가른다"
    if p["recall"] < 1:
        return "blue_rematch", f"놓침 {len(p['missed'])}건: {', '.join(p['missed'])}"
    if p["false_positives"] > 0:
        return "blue_precision", f"다 잡았지만 오탐 {p['false_positives']}건"
    if p["max_iteration"] == 1:
        return "red_up", "다 잡았고 오탐 0, 반복 1회"
    return "hold", f"다 잡았고 오탐 0 이지만 반복 {p['max_iteration']}회. 승급 보류"


def score_rows(rows: list[dict], keys: list[dict], papers: dict[str, dict]) -> dict:
    final = _final_rows(rows)
    keys_by_paper: dict[str, list[dict]] = defaultdict(list)
    for k in keys:
        keys_by_paper[k["paper_id"]].append(k)
    rows_by_paper: dict[str, list[dict]] = defaultdict(list)
    for r in final:
        rows_by_paper[r["paper_id"]].append(r)

    def is_holdout(pid: str) -> bool:
        if papers.get(pid, {}).get("role", "").lower() == "holdout":
            return True
        return pid not in keys_by_paper and any(r["_holdout"] for r in rows_by_paper.get(pid, []))

    paper_ids = sorted(set(keys_by_paper) | set(rows_by_paper))
    result_papers: dict[str, dict] = {}
    tot = dict(tp=0, fp=0, keys=0, unsure=0, judgments=0, type_mismatch=0)
    hold = dict(papers=[], flags=0, judgments=0)

    for pid in paper_ids:
        prow = rows_by_paper.get(pid, [])
        pkeys = keys_by_paper.get(pid, [])
        holdout = is_holdout(pid)
        teams = sorted({r["team"] for r in prow})
        tp = fp = tm = 0
        missed: list[str] = []
        for team in teams:
            trow = [r for r in prow if r["team"] == team]
            flags = [r for r in trow if r["_label"] == "yes"]
            if holdout:
                fp += len(flags)
            else:
                t, m, f, x = _match(pkeys, flags)
                tp += t
                fp += f
                tm += x
                missed += [loc for loc in m if loc not in missed]
        unsure = sum(1 for r in prow if r["_label"] == "unsure")
        key_total = 0 if holdout else len(pkeys) * max(1, len(teams))
        p = {
            "paper_id": pid,
            "role": papers.get(pid, {}).get("role", "holdout" if holdout else ""),
            "level": papers.get(pid, {}).get("level", ""),
            "is_holdout": holdout,
            "teams": teams,
            "n_teams": len(teams),
            "key_defects": len(pkeys),
            "true_positives": tp,
            "false_positives": fp,
            "type_mismatch": tm,
            "missed": missed,
            "recall": None if holdout else _ratio(tp, key_total),
            "precision": _ratio(tp, tp + fp),
            "abstain_rate": _ratio(unsure, len(prow)),
            "judgments": len(prow),
            "max_iteration": max((r["_iteration"] for r in prow), default=0),
        }
        if p["recall"] is None and not holdout:
            p["recall"] = 0.0
        p["next_move"], p["reason"] = next_move(p)
        p["next_move_ko"] = MOVES_KO[p["next_move"]]
        result_papers[pid] = p
        if holdout:
            hold["papers"].append(pid)
            hold["flags"] += fp
            hold["judgments"] += len(prow)
        else:
            tot["tp"] += tp
            tot["keys"] += key_total
        tot["fp"] += fp
        tot["unsure"] += unsure
        tot["judgments"] += len(prow)
        tot["type_mismatch"] += tm

    overall = {
        "papers": len(paper_ids),
        "key_defects": tot["keys"],
        "true_positives": tot["tp"],
        "false_positives": tot["fp"],
        "type_mismatch": tot["type_mismatch"],
        "recall": _ratio(tot["tp"], tot["keys"]),
        "precision": _ratio(tot["tp"], tot["tp"] + tot["fp"]),
        "abstain_rate": _ratio(tot["unsure"], tot["judgments"]),
        "judgments": tot["judgments"],
    }
    holdout = {
        "papers": hold["papers"],
        "flags": hold["flags"],
        "judgments": hold["judgments"],
        "false_positive_rate": _ratio(hold["flags"], hold["judgments"]),
    }

    # 반복 회차별 재현율 (그 회차에 판정한 (논문, 팀)만 분모)
    by_iter: dict[str, dict] = {}
    for it in sorted({r["_iteration"] for r in rows}):
        tp_k = keys_k = fp_k = 0
        pairs = {(r["paper_id"], r["team"]) for r in rows if r["_iteration"] == it}
        for pid, team in sorted(pairs):
            if is_holdout(pid):
                continue
            pkeys = keys_by_paper.get(pid, [])
            flags = [r for r in rows if r["_iteration"] == it and r["paper_id"] == pid and r["team"] == team and r["_label"] == "yes"]
            t, _, f, _ = _match(pkeys, flags)
            tp_k += t
            fp_k += f
            keys_k += len(pkeys)
        by_iter[str(it)] = {"recall": _ratio(tp_k, keys_k), "true_positives": tp_k, "false_positives": fp_k,
                            "key_defects": keys_k, "pairs": len(pairs)}

    # 팀 간 일치도
    agreement: dict[str, dict] = {}
    for pid in paper_ids:
        teams = result_papers[pid]["teams"]
        if len(teams) < 2:
            continue
        prow = rows_by_paper[pid]
        units: list[str] = []
        for loc in [k["location"] for k in keys_by_paper.get(pid, [])] + [r["location"] for r in prow if r["_label"] == "yes"]:
            if not any(locations_match(loc, u) for u in units):
                units.append(loc)
        vec = {}
        for team in teams:
            flagged = [r["location"] for r in prow if r["team"] == team and r["_label"] == "yes"]
            vec[team] = [any(locations_match(u, f) for f in flagged) for u in units]
        pairs = []
        for a, b in combinations(teams, 2):
            pairs.append({"teams": [a, b], "kappa": round(cohen_kappa(vec[a], vec[b]), 4)})
        agreement[pid] = {"teams": teams, "units": len(units), "pairs": pairs,
                          "kappa": round(sum(p["kappa"] for p in pairs) / len(pairs), 4)}

    return {"papers": result_papers, "overall": overall, "holdout": holdout,
            "by_iteration": by_iter, "agreement": agreement}


def score_dir(results_dir, keys_dir, papers_csv=None) -> dict:
    rows = load_blue_rows(pathlib.Path(results_dir))
    keys = load_keys(pathlib.Path(keys_dir))
    papers = load_papers(papers_csv)
    return score_rows(rows, keys, papers)


# ---------------------------------------------------------------- 출력
def _fmt(v) -> str:
    if v is None:
        return "-"
    if isinstance(v, float):
        return f"{v:.2f}"
    return str(v)


def render_table(result: dict, week: str) -> str:
    lines = [f"## {week} 집계", "",
             "| 논문 | 역할 | 단계 | 팀 | 정답 | 잡음 | 오탐 | 재현율 | 정밀도 | 유보율 | 반복 | 다음 수 |",
             "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for pid, p in result["papers"].items():
        lines.append("| " + " | ".join([
            pid, p["role"] or "-", p["level"] or "-", str(p["n_teams"]), str(p["key_defects"]),
            str(p["true_positives"]), str(p["false_positives"]), _fmt(p["recall"]), _fmt(p["precision"]),
            _fmt(p["abstain_rate"]), str(p["max_iteration"]), f"{p['next_move']} ({p['next_move_ko']})",
        ]) + " |")
    o = result["overall"]
    lines += ["", f"전체: 정답 {o['key_defects']}건 중 잡음 {o['true_positives']}건, 오탐 {o['false_positives']}건. "
                  f"재현율 {_fmt(o['recall'])}, 정밀도 {_fmt(o['precision'])}, 유보율 {_fmt(o['abstain_rate'])}, 판정 {o['judgments']}행"]
    h = result["holdout"]
    if h["papers"]:
        lines.append(f"홀드아웃 {', '.join(h['papers'])}: 판정 {h['judgments']}행 중 맞음 {h['flags']}건, 거짓양성률 {_fmt(h['false_positive_rate'])}")
    if result["by_iteration"]:
        lines.append("회차별 재현율: " + ", ".join(f"{k}회 {_fmt(v['recall'])}" for k, v in result["by_iteration"].items()))
    for pid, a in result["agreement"].items():
        lines.append(f"일치도 {pid}: kappa {_fmt(a['kappa'])} ({', '.join(a['teams'])}, 위치 단위 {a['units']}개)")
    for pid, p in result["papers"].items():
        lines.append(f"- {pid}: {p['next_move_ko']}. {p['reason']}")
    return "\n".join(lines) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Blue 판정 CSV 를 집계해 재현율, 정밀도, 유보율, 일치도와 논문별 다음 수를 낸다")
    ap.add_argument("results_dir", help="results/wN/ (CSV 들)")
    ap.add_argument("--keys", required=True, help="정답지 JSON 폴더")
    ap.add_argument("--papers", default=None, help="corpus/papers.csv (role=holdout, level 을 읽는다)")
    ap.add_argument("--out-dir", default=str(REPO_ROOT / "benchmark"), help="JSON 을 둘 폴더 (기본 benchmark/)")
    ap.add_argument("--week", default=None, help="주차 이름 (기본: results 폴더 이름)")
    args = ap.parse_args(argv)

    results_dir = pathlib.Path(args.results_dir)
    if not results_dir.exists():
        print(f"실패: 결과 폴더가 없습니다: {results_dir}", file=sys.stderr)
        return 2
    week = args.week or results_dir.resolve().name
    try:
        result = score_dir(results_dir, args.keys, args.papers)
    except SchemaError as e:
        print(f"실패: {e}", file=sys.stderr)
        return 2
    result = {"week": week, "generated_at": now_kst_iso(),
              "inputs": {"results_dir": str(results_dir), "keys": str(args.keys), "papers": str(args.papers or "")},
              "rules": {"location_tolerance_lines": LINE_TOL, "submission": "마지막 iteration 의 행",
                        "next_move_order": ["human_review", "blue_rematch", "blue_precision", "red_up", "hold"]},
              **result}
    out = pathlib.Path(args.out_dir) / f"{week}.json"
    write_json(out, result)
    print(render_table(result, week))
    print(f"저장: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
