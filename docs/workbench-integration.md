# Falsify Workbench 연동 안내

`Shinick-Han/falsify-workbench`에서 만든 RED 공격 기록과 BLUE 판정 결과를 `Pseudo-Lab/Falsify` 시즌 13 제출·채점 파이프라인(`submissions/`, `gates/`, `eval/`, `tools/score.py`)으로 옮기는 방법입니다. 변환기 `tools/workbench_bridge.py`는 파이썬 3.11+ 표준 라이브러리만 사용합니다.

## 1. 전체 흐름

1. **Workbench 내보내기**:
   - **RED**: `falsify.external-batch.v1` (`role: "red"`), `falsify.external-proposals.v1`, 리뷰 번들 JSON, 또는 `falsify-visual-edits.json` (`change`, `table-cell`, `chart-point`)을 저장합니다.
   - **BLUE**: `falsify.external-batch.v1` (`role: "blue"`) 또는 BLUE 하네스 출력 JSON을 저장합니다.
2. **변환 (`tools/workbench_bridge.py`)**:
   - RED 내보내기는 공개 제출 JSON, **메타데이터 없는 블라인드 변조본**, 운영자 전용 정답지(`answer_key.csv`, `keys/*.json`)로 분리합니다.
   - BLUE 내보내기는 `tools/score.py`와 `submissions/validate_submission.py`가 바로 읽는 `predictions.csv`로 바꿉니다.
3. **검증 및 집계**:
   - `submissions/validate_submission.py`, `eval/run_eval.py`, `tools/score.py`로 통과 여부와 재현율·정밀도·다음 수를 확인합니다.

## 2. RED 내보내기 → Red 제출물 & 블라인드 본문

```bash
python tools/workbench_bridge.py red-to-submission exports/red_batch.json \
  --out-dir work/w4_red \
  --document corpus/raw/PMC12215570.md
```

- `--defect-type D1|D2|D3`: `attackTypes`/`kind`(`table-cell`, `chart-point` → `D1`, `change` → 문맥에 따라 `D1`/`D2`/`D3`) 자동 매핑 대신 결함 유형을 직접 지정합니다.
- 생성 파일:
  - `work/w4_red/submissions/*.json`: `submissions/validate_submission.py`를 통과한 Red 제출 패키지 (`before` → `after` unified diff 포함).
  - `work/w4_red/blind/*.blind.md`: Blue 팀에게 줄 블라인드 변조본. `rationale`, `why_hard`, `intended_label`, `answer_key`, `pageIndex` 등 **Red 메타데이터가 0건**인지 자동 검사합니다.
  - `work/w4_red/organizer/answer_key.csv` 및 `organizer/keys/*.json`: 운영자만 보관하는 정답지 (`before`, `after`, `page_index`, `rationale`, 패치 hunk 보존).

## 3. BLUE 판정 JSON → `score.py`용 `predictions.csv`

```bash
python tools/workbench_bridge.py blue-to-predictions exports/blue_findings.json \
  -o results/w4/blue-workbench.csv
```

- 심각도/상태 매핑 규칙 (결정론적):
  - 결함 탐지 (`critical` / `major` / `error` / `discrepant`) → `verdict = 아님` (`score.py` `label = 맞음`)
  - 보류/재확인 (`uncertain` / `needs-verification`) → `verdict = 확인필요` (`score.py` `label = 확인필요`)
  - 정상/결함 없음 (`clean` / `no-defect` / `verified`) → `verdict = 맞음` (`score.py` `label = 아님`)
- 출력 CSV는 `case_id`, `verdict`, `defect_type`, `confidence`, `evidence_quote`와 `tools/score.py` 필수 12개 열을 모두 포함합니다.

## 4. 왕복 호환성 점검 및 후속 채점

```bash
# 1) 자체 합성 픽스처로 빠른 점검
python tools/workbench_bridge.py roundtrip-check --self-test

# 2) 실제 Workbench RED/BLUE 내보내기 한 쌍 점검
python tools/workbench_bridge.py roundtrip-check \
  --red exports/red_batch.json \
  --blue exports/blue_findings.json \
  --document corpus/raw/PMC12215570.md \
  --papers corpus/papers.csv

# 3) 시즌 13 제출 검증 및 집계
python -m submissions.validate_submission work/w4_red/submissions
python -m submissions.validate_submission results/w4/blue-workbench.csv
python tools/score.py results/w4/ --keys work/w4_red/organizer/keys --papers corpus/papers.csv
```
