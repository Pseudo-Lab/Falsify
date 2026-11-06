#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""현장 시연: 러너가 결함을 심은 **변조본**을 그 자리에서 1단과 2단에 걸어 본다.

논문이 무엇인지 미리 몰라도 된다. 변조본 PDF 를 주면 검사 문장을 스스로 고른다.

누가 무엇을 보는가
  탐지기(1단, 2단)  **변조본만** 본다. 근거 글도 검사 문장도 모두 변조본에서 나온다
  채점자            원본을 볼 수 있다. 어디가 바뀌었는지 가리는 데만 쓴다
  3단 맹검 중이면   --orig 를 주지 않는다. 변조본만으로도 대조군이 만들어진다

대조군을 어떻게 만드나
  --orig 없을 때   숫자가 든 본문 문장을 골라 숫자를 바꾼 판을 만든다. 원문이 대조군이다
  --orig 줄 때     원본과 달라진 문장을 검사 문장으로 쓰고,
                   같은 쪽에서 바뀌지 않은 문장을 대조군으로 쓴다

대조군 없이 숫자 하나만 보여 주면 그 숫자가 성능처럼 읽힌다. 그래서 어느 쪽이든 쌍으로 건다.

사용법
  python3 demo.py 변조본.pdf                       1단과 2단 모두
  python3 demo.py 변조본.pdf --orig 원본.pdf       채점자가 정답지를 가지고 있을 때
  python3 demo.py 변조본.pdf --step 1 --n 4        1단만, 4쌍
  python3 demo.py --replay 결과.json               호출 없이 저장된 결과를 다시 보여 준다

사전 점검
  python3 demo.py --check
"""
import argparse, difflib, json, os, random, re, shutil, subprocess, sys, time
from pathlib import Path

# 계정에 묶인 값은 환경변수로만 받는다. 기본값으로 박으면 저장소에 리소스 이름이 공개된다.
# 검사 test_no_account_identifier_is_hardcoded 가 이것을 막는다.
PROFILE = os.environ.get("FALSIFY_AWS_PROFILE", "")
REGION  = os.environ.get("FALSIFY_AWS_REGION", "us-east-1")
GUARD   = os.environ.get("FALSIFY_GUARDRAIL_ID", "")
MODEL   = os.environ.get("FALSIFY_MODEL_ID", "amazon.nova-lite-v1:0")
QUERY   = "Is the following statement supported by the evidence in this section of the paper?"
THRESH  = 0.5

C = {"b": "\033[1m", "d": "\033[2m", "r": "\033[31m", "g": "\033[32m",
     "y": "\033[33m", "c": "\033[36m", "x": "\033[0m"}
if not sys.stdout.isatty():
    C = {k: "" for k in C}


def say(s=""): print(s, flush=True)
def head(s): say(f"\n{C['b']}{C['c']}━━ {s} {'━' * max(0, 56 - len(s))}{C['x']}")


# ── PDF ────────────────────────────────────────────────────────────────────
def pages_of(pdf):
    """pdftotext 로 쪽마다 글을 뽑는다. 추가 설치가 필요 없는 쪽을 골랐다."""
    if not shutil.which("pdftotext"):
        sys.exit("pdftotext 가 없습니다. brew install poppler")
    n = int(re.search(r"Pages:\s+(\d+)",
            subprocess.run(["pdfinfo", pdf], capture_output=True, text=True).stdout).group(1))
    out = []
    for i in range(1, n + 1):
        t = subprocess.run(["pdftotext", "-f", str(i), "-l", str(i), pdf, "-"],
                           capture_output=True, text=True).stdout
        out.append(re.sub(r"\s+", " ", t).strip())
    return out


SENT = re.compile(r"(?<=[.!?])\s+(?=[A-Z(])")


def sentences(text):
    return [s.strip() for s in SENT.split(text) if 40 <= len(s.strip()) <= 320]


def english(s):
    return len(re.findall(r"[A-Za-z]", s)) >= 25 and not re.search(r"[가-힣]", s)


# 참고문헌 항목은 숫자가 많아 잘 뽑히는데, 시연에서 보여 줄 문장이 아니다.
BIB = re.compile(r"\bpages?\s+\d+|\barXiv[:.]|\bIn Proceedings\b|\bet al\.|\bdoi[:.]|"
                 r"\bpreprint\b|\bConference on\b|\bJournal of\b|\bvol\.|\bpp\.", re.I)
REFHEAD = re.compile(r"^\s*(references|bibliography|참고문헌)\b", re.I)


def body_pages(pages):
    """참고문헌이 시작되는 쪽부터는 버린다."""
    for i, p in enumerate(pages):
        if REFHEAD.match(p) or re.search(r"\bReferences\b\s*\[?1[\].]", p[:400]):
            return pages[:i] if i else pages
    return pages


def body_sentence(s):
    return english(s) and not BIB.search(s)


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


# ── 검사 문장 고르기 ────────────────────────────────────────────────────────
NUM = re.compile(r"(?<![\w.])(\d+\.\d+|\d{1,4})(?![\w])")


def perturb(sent, rng):
    """숫자 하나를 눈에 띄게 바꾼다. 바꿀 숫자가 없으면 None."""
    ms = [m for m in NUM.finditer(sent) if m.group(0) not in ("1", "2", "19", "20")]
    if not ms:
        return None, None
    m = rng.choice(ms)
    old = m.group(0)
    if "." in old:
        new = f"{float(old) * rng.choice([1.8, 2.4, 0.35]):.{len(old.split('.')[1])}f}"
    else:
        new = str(max(1, int(int(old) * rng.choice([2, 3, 5]))))
    if new == old:
        return None, None
    return sent[:m.start()] + new + sent[m.end():], f"{old} -> {new}"


def pick_pairs_auto(pages, n, seed=7):
    """변조본만 있을 때. 숫자가 든 문장을 골라 (원문, 숫자 변조판) 쌍을 만든다."""
    rng = random.Random(seed)
    cand = []
    for pi, p in enumerate(body_pages(pages)):
        for s in sentences(p):
            if body_sentence(s) and NUM.search(s):
                cand.append((pi, s))
    rng.shuffle(cand)
    pairs, seen = [], set()
    for pi, s in cand:
        if norm(s)[:50] in seen:
            continue
        bad, how = perturb(s, rng)
        if not bad:
            continue
        seen.add(norm(s)[:50])
        pairs.append({"page": pi, "true": s, "altered": bad, "how": how})
        if len(pairs) >= n:
            break
    return pairs


def pick_pairs_diff(pages_bad, pages_orig, n):
    """원본은 **어디가 바뀌었나를 가리는 데만** 쓴다. 채점자의 정답지이지 탐지기 입력이 아니다.

      검사 문장  변조본에서 원본과 달라진 문장
      대조군     같은 쪽에서 **바뀌지 않은** 문장. 변조본 안에 그대로 있으니 준 글에 담긴다

    원본 문장을 그대로 대조군으로 쓰면 안 된다. 그 문장은 변조본에 없어서 준 글에 담기지 않고,
    그러면 참인데도 낮게 나와 대조가 무너진다. 10/29 2차 설계의 C 갈래가 그 경우였다.
    """
    orig = {norm(x) for pg in body_pages(pages_orig) for x in sentences(pg) if body_sentence(x)}
    pairs = []
    for pi, pg in enumerate(body_pages(pages_bad)):
        sents = [x for x in sentences(pg) if body_sentence(x)]
        changed = [x for x in sents if norm(x) not in orig]
        intact = sorted([x for x in sents if norm(x) in orig], key=len, reverse=True)
        for x in changed:
            if not intact:
                break
            pairs.append({"page": pi, "true": intact.pop(0), "altered": x,
                          "how": "원본과 달라진 문장"})
            if len(pairs) >= n:
                return pairs
    return pairs


def best_page(pages):
    """2단에 넣을 쪽. 본문 가운데 숫자가 가장 많은 쪽을 고른다.

    기본값을 '글자가 가장 많은 쪽' 으로 뒀더니 참고문헌 쪽이 걸렸고, 모델이 참고문헌 번호를
    숫자 모순으로 오인했다. 결과와 표가 있는 쪽에 숫자가 몰리므로 그쪽을 고른다.
    """
    body = body_pages(pages) or pages
    def score(k):
        return len(NUM.findall(body[k])) if len(body[k]) > 1200 else -1
    return max(range(len(body)), key=score)


def window(full, quote, chars=2500):
    """검사 문장이 든 자리 둘레를 근거로 잘라 낸다. 1단 2차 설계와 같은 방식."""
    i = full.find(quote[:60])
    if i < 0:
        i = full.lower().find(norm(quote)[:60])
    if i < 0:
        return None
    a = max(0, i - chars // 2)
    return full[a:a + chars]


# ── AWS ────────────────────────────────────────────────────────────────────
def client(kind):
    import boto3
    if not PROFILE or not GUARD:
        sys.exit("FALSIFY_AWS_PROFILE 과 FALSIFY_GUARDRAIL_ID 를 먼저 설정하세요. "
                 "README 의 '준비' 절에 만드는 법이 있습니다.")
    return boto3.Session(profile_name=PROFILE).client(kind, region_name=REGION)


def ground(br, src, claim):
    """1단. 근거 글과 검사 문장을 함께 주고 점수를 받는다."""
    r = br.apply_guardrail(
        guardrailIdentifier=GUARD, guardrailVersion="DRAFT", source="OUTPUT",
        content=[{"text": {"text": src[:40000], "qualifiers": ["grounding_source"]}},
                 {"text": {"text": QUERY, "qualifiers": ["query"]}},
                 {"text": {"text": claim, "qualifiers": ["guard_content"]}}])
    out = {"action": r["action"], "grounding": None, "relevance": None}
    for a in r.get("assessments", []):
        for f in a.get("contextualGroundingPolicy", {}).get("filters", []):
            out[f["type"].lower()] = f["score"]
    return out


REVIEW = """You are a strict reviewer checking one section of a scientific paper.
Find defects of these kinds: a number that contradicts another number in the same text,
a claim the text does not support, a conclusion stronger than the result, a wrong unit or
percentage, an internal inconsistency between text and table.

List every defect you find. Report ONLY JSON, no prose:
{"verdict":"pass|caution|reject","issues":[{"kind":"...","where":"<quote 6-12 words>","why":"..."}]}
Use "reject" when at least one defect is clear, "caution" when you suspect one.

--- SECTION ---
%s
--- END ---"""


def nova(br, section):
    """2단. 같은 입력으로 독립 호출. 호출마다 새 대화라 서로 영향을 주지 않는다."""
    t = time.time()
    r = br.converse(modelId=MODEL,
                    messages=[{"role": "user", "content": [{"text": REVIEW % section[:12000]}]}],
                    inferenceConfig={"maxTokens": 1500})
    txt = r["output"]["message"]["content"][0]["text"]
    u = r.get("usage", {})
    try:
        j = json.loads(re.search(r"\{.*\}", txt, re.S).group(0))
        verdict = j.get("verdict", "?")
        issues = [i.get("kind", "?") for i in j.get("issues", [])]
        ok = True
    except Exception:
        verdict, issues, ok = "형식 어김", [], False
    return {"verdict": verdict, "issues": issues, "schema_ok": ok, "secs": round(time.time() - t, 1),
            "in": u.get("inputTokens"), "out": u.get("outputTokens"), "raw": txt[:600]}


# ── 보여 주기 ───────────────────────────────────────────────────────────────
def cut(s, n):
    s = re.sub(r"\s+", " ", s).strip()
    return s if len(s) <= n else s[:n - 1] + "…"


def show_step1(rows):
    head("1단 근거 확인 (Bedrock Guardrails)")
    say(f"{C['d']}점수가 높을수록 '준 글이 뒷받침한다'. {THRESH} 아래면 차단.{C['x']}\n")
    say(f"  {'':3} {'대조군':>12}  {'검사 문장':>10}   대조군이 무엇인가")
    say(f"  {'─'*3} {'─'*12}  {'─'*10}   {'─'*28}")
    split = 0
    for i, r in enumerate(rows, 1):
        t, a = r["true_score"], r["alt_score"]
        gap = (t is not None and a is not None and t - a >= 0.3)
        split += gap
        mark = f"{C['g']}갈림{C['x']}" if gap else f"{C['r']}  —  {C['x']}"
        say(f"  {i:>2}. {fmt(t):>12}  {fmt(a):>10}   {cut(r['how'], 28):28} {mark}")
    say()
    for i, r in enumerate(rows[:2], 1):
        say(f"  {C['d']}{i}. 대조 {C['x']}{cut(r['true'], 92)}")
        say(f"  {C['d']}   검사 {C['x']}{cut(r['altered'], 92)}")
    say()
    n = len(rows)
    if split >= max(1, n // 2):
        say(f"  {C['b']}{C['g']}판정. {n}쌍 가운데 {split}쌍이 갈렸습니다. 대조군과 검사 문장을 구별합니다.{C['x']}")
        say(f"  {C['d']}10/29 측정에서는 숫자만 바꾼 문장 20건 가운데 6건이 걸렸습니다. 표본이 작으니 비율로 읽지 마세요.{C['x']}")
    else:
        say(f"  {C['b']}{C['r']}판정. {n}쌍 가운데 {split}쌍만 갈렸습니다. 둘을 구별하지 못합니다.{C['x']}")
        say(f"  {C['d']}10/29 측정에서도 같았습니다. 점수는 참거짓이 아니라 준 글에 그 문장이 들어 있는지를 따라갑니다.{C['x']}")
    return split


def fmt(v):
    return "호출 실패" if v is None else f"{v:.3f}"


def show_step2(a, b):
    head("2단 모델 호출 (Bedrock Nova, 독립 2회)")
    say(f"  {'':8} {'판정':<10} {'찾은 결함':<28} {'초':>5}  {'입력':>7} {'출력':>6}")
    say(f"  {'─'*8} {'─'*10} {'─'*28} {'─'*5}  {'─'*7} {'─'*6}")
    for lab, r in (("1회차", a), ("2회차", b)):
        say(f"  {lab:<8} {r['verdict']:<10} {cut(', '.join(r['issues']) or '없음', 28):<28} "
            f"{r['secs']:>5}  {str(r['in']):>7} {str(r['out']):>6}")
    say()
    same = a["verdict"] == b["verdict"] and a["schema_ok"] and b["schema_ok"]
    if same:
        say(f"  {C['b']}{C['y']}판정. 두 번이 같았습니다. 더 돌려 봐야 합니다.{C['x']}")
    else:
        say(f"  {C['b']}{C['r']}판정. 같은 입력인데 두 번이 갈렸습니다.{C['x']}")
        say(f"  {C['d']}검토를 모델에 맡기면 그 검수자부터 측정해야 하는 이유입니다.{C['x']}")
    return same


# ── 사전 점검 ───────────────────────────────────────────────────────────────
def check():
    head("사전 점검")
    ok = True
    for name, fn in (
        ("pdftotext", lambda: bool(shutil.which("pdftotext"))),
        ("boto3", lambda: __import__("boto3") and True),
    ):
        try:
            good = fn()
        except Exception:
            good = False
        ok &= good
        say(f"  {'O' if good else 'X'}  {name}")
    try:
        g = client("bedrock").get_guardrail(guardrailIdentifier=GUARD, guardrailVersion="DRAFT")
        say(f"  O  guardrail {GUARD} ({g['status']})")
    except Exception as e:
        ok = False; say(f"  X  guardrail {GUARD}: {type(e).__name__}")
    try:
        r = client("bedrock-runtime").converse(
            modelId=MODEL, messages=[{"role": "user", "content": [{"text": "say OK"}]}],
            inferenceConfig={"maxTokens": 8})
        say(f"  O  {MODEL} ({r['output']['message']['content'][0]['text'].strip()[:12]})")
    except Exception as e:
        ok = False; say(f"  X  {MODEL}: {type(e).__name__}")
    say(f"\n  {'준비됐습니다.' if ok else '위의 X 를 먼저 고쳐 주세요.'}")
    return 0 if ok else 1


# ── 본체 ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("pdf", nargs="?", help="러너가 결함을 심은 변조본 PDF. 탐지기에 들어가는 유일한 글")
    ap.add_argument("--orig", help="원본 PDF. 어디가 바뀌었는지 가리는 데만 쓴다. "
                                   "--unblinded 와 함께 줘야 한다")
    ap.add_argument("--unblinded", action="store_true",
                    help="라운드 전원이 3단을 제출해 맹검이 풀렸음을 밝힌다. --orig 에 필요하다")
    ap.add_argument("--n", type=int, default=6, help="검사 쌍 수 (기본 5)")
    ap.add_argument("--step", choices=["1", "2", "all"], default="all")
    ap.add_argument("--page", type=int, help="2단에 넣을 쪽 번호. 기본은 결과가 많은 쪽")
    ap.add_argument("--save", help="결과를 JSON 으로 저장")
    ap.add_argument("--replay", help="저장한 JSON 을 호출 없이 다시 보여 준다")
    ap.add_argument("--check", action="store_true", help="사전 점검만")
    a = ap.parse_args()

    if a.check:
        return check()

    # 맹검 해제는 사람이 밝혀야 한다. 한 사람이 3단을 끝낸 것과 라운드가 끝난 것은 다르다.
    if a.orig and not a.unblinded:
        say(f"{C['r']}--orig 는 맹검이 풀린 뒤에만 씁니다.{C['x']}")
        say("  라운드 전원이 3단 결과를 제출했으면 --unblinded 를 함께 주세요.")
        say("  아직이면 원본 없이 돌립니다. 변조본만으로도 대조군이 만들어집니다.")
        return 2

    if a.replay:
        d = json.loads(Path(a.replay).read_text(encoding="utf-8"))
        say(f"{C['d']}저장된 결과입니다. {d['when']} · {d['pdf']}{C['x']}")
        if d.get("step1"): show_step1(d["step1"])
        if d.get("step2"): show_step2(*d["step2"])
        return 0
    if not a.pdf:
        ap.error("PDF 를 주거나 --replay 또는 --check 를 쓰세요")

    say(f"{C['b']}{Path(a.pdf).name}{C['x']}")
    pages = pages_of(a.pdf)
    full = " ".join(pages)
    say(f"{C['d']}{len(pages)}쪽, 글자 {len(full):,}자{C['x']}")

    rec = {"when": time.strftime("%Y-%m-%d %H:%M"), "pdf": Path(a.pdf).name,
           "step1": None, "step2": None}

    if a.step in ("1", "all"):
        if a.orig:
            pairs = pick_pairs_diff(pages, pages_of(a.orig), a.n)
            say(f"{C['d']}원본과 견줘 바뀐 문장 {len(pairs)}개를 찾았습니다. 대조군은 같은 쪽의 바뀌지 않은 문장입니다.{C['x']}")
        else:
            pairs = pick_pairs_auto(pages, a.n)
            say(f"{C['d']}숫자가 든 문장 {len(pairs)}개를 골라 숫자를 바꾼 판을 만들었습니다. 원문이 대조군입니다.{C['x']}")
        if not pairs:
            say(f"{C['r']}검사 문장을 못 골랐습니다. --orig 를 주거나 --n 을 줄여 보세요.{C['x']}")
        else:
            br = client("bedrock-runtime")
            rows = []
            for i, p in enumerate(pairs, 1):
                src = window(full, p["true"]) or window(full, p["altered"])
                if not src:
                    continue
                print(f"\r  {i}/{len(pairs)} 호출 중…", end="", file=sys.stderr)
                def sc(claim):
                    try:
                        return ground(br, src, claim).get("grounding")
                    except Exception as e:
                        say(f"\n  {C['r']}호출 실패: {type(e).__name__}{C['x']}"); return None
                rows.append({**p, "true_score": sc(p["true"]), "alt_score": sc(p["altered"])})
            print("\r" + " " * 24 + "\r", end="", file=sys.stderr)
            if rows:
                show_step1(rows)
                rec["step1"] = rows

    if a.step in ("2", "all"):
        i = a.page - 1 if a.page else best_page(pages)
        sec = pages[i]
        say(f"\n{C['d']}2단에 넣을 글은 {i+1}쪽입니다 ({len(sec):,}자, 숫자 {len(NUM.findall(sec))}개).{C['x']}")
        br = client("bedrock-runtime")
        try:
            r1, r2 = nova(br, sec), nova(br, sec)
            show_step2(r1, r2)
            rec["step2"] = [r1, r2]
        except Exception as e:
            say(f"  {C['r']}호출 실패: {type(e).__name__}: {e}{C['x']}")

    if a.save:
        Path(a.save).write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        say(f"\n{C['d']}저장: {a.save}  (나중에 --replay {a.save} 로 호출 없이 재생){C['x']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
