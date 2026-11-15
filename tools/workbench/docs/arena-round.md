# Arena 무인 라운드 실행과 규칙 증류 (`arena-round`)

`tools/evaluation/arena_round.py`는 Co-Evolution Arena의 6단계 루프를 무인으로 한 번 돌리는 두 명령을 제공한다. `run-round`는 blind 번들을 cleanroom에 넣고 임의의 BLUE agent를 1..N회 실행해 `arena_runner`로 채점하며, `distill`은 그 라운드 기록을 **정답 키 없는** 일반화 규칙 패치로 바꾼다.

`tools/evaluation`은 계속 표준 라이브러리만 사용한다. 채점·blind 검증은 `arena_runner`를, adapter 실행과 환경/프로세스 정책은 `app/local/harness_adapter.py`를 그대로 import해서 쓴다. 두 구현을 복제하지 않는다.

## 두 명령

```bash
# 1) blind 번들 + agent 명령으로 라운드 실행 (gold를 주면 채점까지)
python tools/evaluation/arena_round.py run-round \
  --pdf BLIND.pdf [--source-pdf SRC.pdf] [--supplement P ...] \
  --gold GOLD.json [--baseline B.json] \
  --agent-cmd /path/to/agent --agent-arg A [--agent-arg B] \
  [--timeout 180] [--runs 1] [--keep-cleanroom] [--out ROUND.json]

# 2) 라운드 기록을 규칙 패치로 증류
python tools/evaluation/arena_round.py distill \
  --round ROUND.json [--gold GOLD.json] [--max-rules 40] [--out PATCH.json]
```

두 명령은 stdout에 JSON 문서 하나를 출력하고 `--out`이 있으면 같은 문서를 파일로도 쓴다.

| 종료 코드 | 의미 |
|---|---|
| `0` | 정상 (스크러빙 실패·blind 누출·timeout 없음) |
| `2` | 입력/실행 오류 (`agent_argv_invalid`, `gold_ledger_invalid`, `process_exit`, `invalid_output`, `env_allow_unsupported` 등) |
| `3` | blindness 위반(`blindness_leak_detected`) 또는 증류 스크러빙 실패(`distill_scrub_failed`) |
| `124` | `timeout` (adapter가 제한 시간 안에 끝나지 않음) |

`--gold` 없이 `run-round`를 실행하면 cleanroom + agent 실행만 수행하고 `"evaluation": null`, `"warning": "gold_ledger_absent"`를 남긴다. 이 기록은 `distill`의 입력이 될 수 없다(채점이 없으므로 `evaluation_absent`로 거부된다).

## 자동화하는 6단계 루프

1. **blind 검증** — `run_round`는 cleanroom을 만들기 전에 `arena_runner.verify_blind_bundle`을 호출한다. DocInfo/XMP/주석/AcroForm/보충자료 어디에서든 RED 흔적이 남으면 cleanroom도 agent 실행도 없이 exit 3으로 끝난다.
2. **cleanroom 준비** — `tempfile` 임시 디렉터리에 `blind.pdf`와(있으면) `supplements/<name>`만 쓴다. gold 원장, 원본 PDF, 원본 경로, 원본을 가리키는 환경변수는 전달하지 않는다.
3. **BLUE 실행** — `harness_adapter.invocation(...)`으로 `falsify.harness-invocation.v1` 봉투를 만들어 stdin으로 넣고, `harness_adapter.run_stdio`로 실행한다(shell 문자열 없음, 재시도 없음, 종료 시 프로세스 트리 정리 포함). stdout은 cleanroom **밖**의 임시 파일로 받는다.
4. **채점** — 실행별 결과를 `arena_runner.evaluate_arena_match`에 그대로 넘겨 tp/fn/pureFp, 층화 지표, stealthYield, agreement(Krippendorff α), selective prediction, `feedbackDigest`를 기존 구현 그대로 얻는다. `--runs 2` 이상은 명령을 run마다 한 번씩 실행하고 **모두 함께** 채점하므로 재현 불일치(flip)가 의미를 가진다.
5. **기록** — `falsify.arena-round.v1` 기록을 남긴다. `blindBundleSha256`, `adapter`(`executableBasename`, `argvShape`), `harnessHash`, `isolation`, `runs[]`, `evaluation`, `leaks`만 담고 cleanroom 절대 경로는 담지 않는다(`cleanroomRetained: bool`만).
6. **증류** — `distill_round`가 실패 클래스(`fn`, `pure_fp`, `pre_existing`, `abstain`, `flip`, `early_red`)를 코드와 건수로만 집계해 `falsify.harness-patch.v1` 패치를 만든다.

## cleanroom의 한계 — OS 샌드박스가 아니다

cleanroom은 **OS 수준 격리가 아니다.** 새 임시 디렉터리를 cwd로 주고, `harness_adapter`의 고정 최소 환경변수만 넘기고, gold/원본 파일을 복사하지 않을 뿐이다. `app/local/harness_adapter.py`가 명시하듯:

> This is not isolation: trusted code can access the user's filesystem/network.

즉 악의적인 adapter는 여전히 사용자 파일시스템을 읽고 네트워크에 접속할 수 있다. `run_round`의 기록도 이를 숨기지 않고 `isolation`에 다음을 남긴다.

```json
{"kind": "cleanroom-tempdir", "osSandbox": false,
 "notice": "cleanroom-tempdir: ... Not an OS sandbox: harness_adapter.py states \"This is not isolation: trusted code can access the user's filesystem/network\". ...",
 "agentCwd": "cleanroom", "filesWritten": ["blind.pdf", "supplements/Table_S1.csv"],
 "cleanroomRetained": false, "envSource": "harness_adapter.run_stdio fixed allowlist (not an OS sandbox)",
 "envAllowRequested": [], "network": "unrestricted"}
```

`env_allow`는 기본 경로에서 **확장되지 않는다**. `harness_adapter.run_stdio`의 고정 allowlist를 조용히 넓히거나 대체하지 않고, 추가 이름을 요청하면 `env_allow_unsupported`(exit 2)로 실패한다. adapter를 직접 주입하는 임베더만 `env_allow`를 adapter에게 전달받아 스스로 집행할 수 있다.

## 정답 키 없는 출력 계약 (hard requirement)

증류 결과는 코드·건수·일반화 절차만 담는다. 스크러버는 패치 전체를 재귀적으로 검사하고, 하나라도 걸리면 **패치를 내보내지 않고** `distill_scrub_failed`를 발생시킨다(모듈 CLI exit 3).

검사 항목:

- `arena_runner.FORBIDDEN_SUPPLEMENT_KEYS`(+ `findingId`, `paperId`, `fileHash`, `quote`, `excerpt` 등) 키 이름
- `arena_runner.UNAMBIGUOUS_SUPPLEMENT_TOKENS` (`falsify-red`, `red-plan`, `gold_ledger`, `why_hard`, `candidateRationales`, `defectId`, `answer-key` …)
- `app/tests/coevolution-arena.spec.cjs`가 고정한 11개 문자열(`12%`, `24%`, `28%`, `reference [1]`, `reference [99]`, `NCT01234567`, `p = 0.08`, `No difference was observed`, `Treatment reduced mortality`, `Exploratory endpoint`, `=SUM`)
- DOI, p-value, NCT/OSF/GSE/PDB 식별자, 파일명(`.pdf`/`.csv`/`.json` …)
- gold 항목의 원문 인용(12자 이상 정규화 문자열)과 순수 오탐 인용
- 라운드/gold에서 모은 `defectId`·`findingId`·`unitId` 값(3자 이상 토큰 일치)
- 축 코드 형식(`D1`..`D7`, `D4-1`, `S1`, `W1`..`W5`, `L1`..`L4`, `TEXT`/`LAYOUT`/`SUPPLEMENT`, `NA`) 위반 — 코드 자리에 문장이 섞이면 즉시 실패한다

같은 라운드 기록을 두 번 증류하면 `patchId`까지 바이트 단위로 동일하다(`generatedAt`은 `finishedAt`에서, `patchId`는 본문 정규화 JSON의 SHA-256 앞 16자). 규칙 순서는 `(family, failureClass, ruleId)`로 고정되고 `max_rules`로 상한이 걸린다.

## 임의 agent 명령 연결

stdin/stdout 프로토콜만 맞으면 어떤 언어·바이너리든 연결할 수 있다.

- **입력** `falsify.harness-invocation.v1`: `{schema, role: "blue", prompt, outputSchema, settings, call, maxCalls}`. `prompt`에는 `blind.pdf`와 `supplements/<name>`만 언급되고 정답 키를 가정하지 말라는 지시가 들어간다.
- **출력** `falsify.blue-report.v1`: `{"schema": "falsify.blue-report.v1", "findings": [{"id", "decision", "pageIndex", "bbox"?, "supplementName"?, "quote", "confidence"?}]}`. `decision`은 `defect`/`clean`/`확인필요` 중 하나이며, `findings` 배열이 없거나 JSON이 아니면 `invalid_output`(exit 2)이다.

```bash
python tools/evaluation/arena_round.py run-round --pdf blind.pdf --gold gold.json \
  --agent-cmd python3 --agent-arg my_blue_agent.py
```

`--agent-cmd`/`--agent-arg`는 리스트로 그대로 `argv`가 되며 shell 문자열로 해석되지 않는다. 옵션처럼 보이는 인자(`-x`)는 `--agent-arg=-x` 형태로 넘긴다.

## 패치 출력 요약

```json
{"schema": "falsify.harness-patch.v1", "patchId": "patch-...", "generatedAt": "...",
 "basedOnRoundId": "round-...", "source": "falsify.arena-round.v1",
 "summary": {"runCount": 2, "goldCount": 3, "tp": 1, "fn": 2, "pureFp": 0,
             "flipUnion": 1, "missedUnion": 1, "earlyRedCount": 1,
             "axes": {"family": {"D1": {"total": 1, "missed": 0, "flip": 0, "detected": 1}}}},
 "rules": [{"ruleId": "fn-d4-1", "failureClass": "fn", "family": "D4-1",
            "statement": "D4-1(결과지표·등록부 왜곡) 미탐 1건, 재현 불안정 1건: ...",
            "procedure": ["..."], "rationale": "..."}],
 "redBrief": {"title": "...", "instructionsText": "... L1 → L2 → L3 → L4 ..."},
 "blueBrief": {"title": "...", "instructionsText": "... 미탐 1건 ... 순수 오탐 0건 ... Zero-Drop ..."},
 "scrubbed": true, "answerKeyFree": true}
```

## 제약

- 이 모듈은 앱 CLI(`falsify arena ...`)에 아직 연결되어 있지 않다. 앱 배선은 별도 소유자의 작업이며, 이 모듈은 `arena_round.run_round` / `arena_round.distill_round`를 그대로 노출한다.
- 모든 함수는 CCN 15 이하이고 테스트가 `tools/quality/python-functions.py`로 이를 검사한다.
- 테스트는 표준 `unittest`만 쓰고 `python -m unittest discover -s tools/evaluation -p "test_arena_round.py" -v`로 실행된다.
- 이 도구는 채점 결과를 인증하지 않는다. gold 원장과 blind 번들의 품질, agent의 신뢰성은 호출자 책임이다.
