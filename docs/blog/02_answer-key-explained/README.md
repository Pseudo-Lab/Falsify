# Falsify 정답 해설 — 틀린 문장보다 중요한 것은 확인하는 과정

![cover](cover.png)

> 작성: 이건규 · 게시: 2026-10-19 · [가짜연구소 원문](https://pseudo-lab.com/blog/34c2560c-c249-4a0b-b4cf-76a94458302c)

직접 문제를 풀고 근거를 찾아주신 여러분, 감사합니다! 이 글은 풀이를 마친 뒤 자신의 판단을 비교할 수 있도록 만든 해설입니다. 원문이 무엇이었는지부터, 쉬운 뜻과 근거, 어디까지 고쳐야 하는지를 차례로 정리했습니다.

> **스포일러 안내:** 아래에는 전체 40개 주장의 판정과 해설이 있습니다. 먼저 풀어보고 싶다면 [문제 저장소](https://github.com/Geongyu/falsify-pilot)와 [기록표](https://docs.google.com/spreadsheets/d/1ViSpn-bwqchZp0gGn3x3vIXl4ExbNXSrJLXsRWqQ0Qk/edit)에서 시작해 주세요.
>
> **기준:** 교육용 합성 연구의 K53 파일럿 후보판입니다. 사람의 최종 gold 동결 전이며 C11은 확인 보류입니다. 이 글은 기존 후보 해설을 읽기 쉽게 재구성한 것이며 새 실험이나 문헌 검증을 수행한 결과는 아닙니다.

## 먼저 알아두면 좋은 세 가지

**첫째, 합성 실험입니다.** 실제 환자나 혈액을 대상으로 임상 검증한 연구가 아닙니다. 컴퓨터에서 만든 단백질·RNA 특징으로 여섯 합성 결과를 예측했습니다.

**둘째, 실행마다 조건이 다릅니다.** 한 실행의 분할이 잘못됐다고 다른 실행도 잘못된 것은 아닙니다. 원고가 가리키는 실행 ID부터 확인해야 합니다.

**셋째, 고칠 범위도 다릅니다.** 데이터 누출은 다시 학습·평가해야 할 수 있지만, 표시 숫자나 source 안내 오류는 해당 표시만 고치면 됩니다. 모르는 문헌은 보류할 수 있습니다.

| 판정 | 의미 | 필요한 행동 |
| --- | --- | --- |
| 맞음 · PASS | 해당 범위에서 공개 근거와 일치 | 정상 내용 보존 |
| 아님 · BLOCK | 주장을 그대로 받아들이기 어려움 | 원인에 맞는 수정·재검증 |
| 부분 수정 · REVISE | 표시 등 국소 수정이 필요한 사례 | 근거 원값을 보존하고 최소 구간 수정 |
| 확인 필요 · HOLD | 지금 자료로 확정하기 부족 | 필요한 추가 근거 요청 |

이번 후보 기준은 맞음 24개, 아님 13개, 부분 수정 2개, 확인 필요 1개입니다. 같은 원인에서 두 주장이 파생된 경우도 있어 주장 수와 원인 수는 다릅니다.

## 빠르게 찾아보기

- **1부:** 분할·전처리·미래 정보·표본 연결 — C02, C09, C16, C18
- **2부:** 기준점·평가 분모·미관측 라벨 — C23, C25, C32
- **3부:** 표시 숫자·재현 코드 버전 — C07, C35, C30
- **4부:** 측정·임상·인과 해석·문헌 — C04, C13, C28, C21, C37, C11
- **5부:** 오류가 아닌 24개 주장과 오탐 주의점
- **6부:** 팀별 전체 정답표와 풀이를 돌아보는 방법

각 원문은 전체 문단이 아니라 판단 대상인 최소 구간일 수 있습니다. C30은 문장이 아닌 source 필드 값입니다. 원본 링크는 변경되지 않는 K53 커밋을 가리킵니다.

## 1부. 데이터가 정말 독립적이었을까요?

### C02 · 처음 보는 사람을 예측한 시험이 아니었어요

**원문 · C02**

```text
the reported test performance evaluates previously unseen subjects, with no subject shared between training and testing.
```

[원본 위치: paper/manuscript_en.md:152](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L152)

- 판정: 아님
- 논문의 주장: 학습 때 보지 못한 새로운 사람에게 시험했다고 썼어요.
- 실제 근거: 학습 자료와 시험 자료에 같은 가상 참여자 288명이 겹쳐요. 같은 사람의 두 표본이 서로 다른 집합에 들어갔어요.
- 판정 이유: 표본이 달라도 같은 사람이면 완전히 새로운 사람에 대한 시험이 아니에요.
- 최소 수정: 사람 단위로 다시 나누고, 전처리·학습·평가를 다시 해요.
- 확인할 파일: splits/split_e2a8cd3f88/members.csv

비유: 같은 학생의 연습 답안을 본 뒤 그 학생을 처음 만난 것처럼 시험하는 셈이에요. 이 비유는 새 관측값이 아니라 분할 문제를 설명하기 위한 것입니다.

**근거 바로 열기:** [splits/split_e2a8cd3f88/members.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/splits/split_e2a8cd3f88/members.csv#L1) · [runs/run_sgap/.hydra/config.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_sgap/.hydra/config.yaml#L1) · [protocol/analysis_plan.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/protocol/analysis_plan.yaml#L1)

### C09 · 시험 자료로 전처리 기준을 정했어요

**원문 · C09**

```text
the preprocessing statistics used for the reported test results were fitted only on training specimens.
```

[원본 위치: paper/manuscript_en.md:154](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L154)

- 판정: 아님
- 논문의 주장: 자료를 정리하는 기준을 학습 자료에서만 계산했다고 썼어요.
- 실제 근거: 실제로는 전체 표본 2,400개로 기준을 계산했어요. 그중 960개는 학습용이 아닌 표본이에요.
- 판정 이유: 시험 자료의 정보가 준비 과정에 들어가면 독립적인 시험이라고 보기 어려워요.
- 최소 수정: 학습 자료만으로 기준을 다시 계산하고, 학습·평가를 다시 해요.
- 확인할 파일: runs/run_sdvz/fit_membership.csv

전처리는 값을 일정한 기준으로 정리하는 단계입니다. 고정된 기준을 시험 자료에 적용하는 일과, 시험 자료로 그 기준 자체를 계산하는 일을 구분합니다.

**근거 바로 열기:** [runs/run_sdvz/fit_membership.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_sdvz/fit_membership.csv#L1) · [runs/run_sdvz/.hydra/config.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_sdvz/.hydra/config.yaml#L1) · [protocol/analysis_plan.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/protocol/analysis_plan.yaml#L1)

### C16 · 미래 정보를 예측에 사용했어요

**원문 · C16**

```text
the reported predictions use only features available at the index visit.
```

[원본 위치: paper/manuscript_en.md:156](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L156)

- 판정: 아님
- 논문의 주장: 예측 당일에 알 수 있는 정보만 사용했다고 썼어요.
- 실제 근거: 30일 뒤에 알 수 있는 followup_peak_synthetic을 사용했어요. 예측 기준일은 0일이에요.
- 판정 이유: 당시에는 얻을 수 없는 미래 정보를 넣으면 실제 예측 상황과 달라져요.
- 최소 수정: 미래 정보를 빼고 모델을 다시 학습한 뒤 평가해요.
- 확인할 파일: runs/run_9dqr/inputs.json · data/feature_dictionary.json

비유: 시험 전에 알 수 없던 다음 달의 결과를 답안 작성에 쓰는 문제와 비슷합니다. 이 비유는 해당 특징의 가용 시점을 설명합니다.

**근거 바로 열기:** [runs/run_9dqr/inputs.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_9dqr/inputs.json#L1) · [data/feature_dictionary.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/feature_dictionary.json#L1)

### C18 · 같은 줄이 같은 사람을 뜻하지는 않아요

**원문 · C18**

```text
The preview produced by `examples/paired_preview.py` likewise aligns the two sides of `data/pairing_preview.csv` by canonical specimen ID.
```

[원본 위치: paper/manuscript_en.md:49](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L49)

- 판정: 아님
- 논문의 주장: 예시 미리보기에서 단백질과 RNA를 같은 표본 ID로 연결했다고 썼어요.
- 실제 근거: 미리보기의 12줄 모두 양쪽의 실제 표본 ID가 달라요. ID를 확인하지 않고 줄 순서대로 옆에 붙였어요.
- 판정 이유: 순서가 바뀐 자료를 줄 번호로 붙이면 서로 다른 대상을 짝짓게 돼요.
- 최소 수정: 표본 ID로 일대일 연결하고 미리보기만 다시 만들어요.
- 확인할 파일: examples/paired_preview.py · data/pairing_preview.csv

예시 미리보기에 한정된 결함입니다. 실제16회 학습에 쓰인 자료 연결은 정상입니다. 공개 실패 테스트는 감사 근거이므로 삭제하거나 통과한 것처럼 바꾸지 않습니다.

**근거 바로 열기:** [examples/paired_preview.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/examples/paired_preview.py#L1) · [data/pairing_preview.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/pairing_preview.csv#L1) · [data/modality_crosswalk.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/modality_crosswalk.csv#L1) · [src/pairing.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/pairing.py#L1)

## 2부. 평가 기준과 분모를 확인해 봅시다

### C23 · 시험 자료로 기준점을 골랐어요

**원문 · C23**

```text
the reported test F1 uses thresholds fixed on validation subjects before testing.
```

[원본 위치: paper/manuscript_en.md:158](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L158)

- 판정: 아님
- 논문의 주장: 양성과 음성을 나누는 기준점을 검증 자료에서 정했다고 썼어요.
- 실제 근거: 실제 기준점 선택에는 시험 자료를 썼어요. 그 시험 자료에서 F1 점수도 계산했어요.
- 판정 이유: 평가받을 자료에 맞춰 기준을 고르면 독립적으로 성능을 확인한 것이 아니에요.
- 최소 수정: 검증 자료로 기준점을 고정하고, 아직 쓰지 않은 자료로 평가해요.
- 확인할 파일: runs/run_zabx/selection.json

기준점은 threshold입니다. F1은 그 기준점으로 나눈 판정에 영향을 받습니다. 이 문제만으로 순위 지표인 AUROC도 바뀌었다고 주장하지 않습니다. checkpoint 선택은 validation인 상태를 보존합니다.

**근거 바로 열기:** [runs/run_zabx/selection.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_zabx/selection.json#L1) · [runs/run_zabx/.hydra/config.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_zabx/.hydra/config.yaml#L1) · [splits/split_c321a741e9/members.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/splits/split_c321a741e9/members.csv#L1)

### C25 · 점수가 없는 사람을 빼고 100%라고 했어요

**원문 · C25**

```text
the reported coverage of 1.000 represents all planned test subjects, with no entirely abstaining subjects omitted from its denominator.
```

[원본 위치: paper/manuscript_en.md:160](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L160)

- 판정: 아님
- 논문의 주장: 계획한 모든 사람에게 점수를 냈고, 제외한 사람도 없다고 썼어요.
- 실제 근거: 계획은 240명, 점수가 나온 사람은 223명, 유보는 17명이에요. 223명만 분모에 넣어 100%로 표시했어요.
- 판정 이유: 전체 계획에 대한 비율은 223 ÷ 240 = 92.9%예요.
- 최소 수정: 전체 대상 비율을 0.929로 고쳐요. 없는 점수는 만들어 넣지 않아요.
- 확인할 파일: runs/run_r9my/flow.csv · runs/run_r9my/metrics.json

점수가 나온 일부 집합의 성능을 별도로 보고하는 것은 가능합니다. 그 집합의 성능과 전체 계획 대상의 점수 산출 비율을 구분해야 합니다.

**근거 바로 열기:** [runs/run_r9my/flow.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_r9my/flow.csv#L1) · [runs/run_r9my/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_r9my/metrics.json#L1) · [data/modality_mask.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/modality_mask.csv#L1)

### C32 · 모르는 결과를 음성으로 셌어요

**원문 · C32**

```text
all zero-valued labels included in the reported evaluation represent confirmed event absence within 180 days.
```

[원본 위치: paper/manuscript_en.md:162](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L162)

- 판정: 아님
- 논문의 주장: 평가에 넣은 0은 모두 사건이 없다고 확인된 결과라고 썼어요.
- 실제 근거: 결과를 끝까지 확인하지 못한 사람·과업 조합 200쌍을 평가에서 음성인 0으로 포함했어요.
- 판정 이유: 사건이 없다고 확인한 것과, 결과를 모르는 것은 달라요.
- 최소 수정: 결과가 관찰된 자료만으로 다시 평가해요. 이 문제는 재학습이 필요 없어요.
- 확인할 파일: runs/run_kctu/flow.csv · data/observation_mask.csv

관찰되지 않은 outcome을 평가 때 음성으로 취급한 문제입니다. 학습의 masked loss는 정상입니다. 입력 특징의 결측값을 0으로 채우는 문제와도 구분합니다.

**근거 바로 열기:** [runs/run_kctu/flow.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_kctu/flow.csv#L1) · [data/observation_mask.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/observation_mask.csv#L1) · [data/labels.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/labels.csv#L1) · [src/evaluate.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/evaluate.py#L1) · [src/train.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/train.py#L1)

## 3부. 숫자와 재현 안내를 대조해 봅시다

### C07, C35 · 본문과 그림에 다른 점수를 적었어요

**원문 · C07**

```text
0.815
```

[원본 위치: paper/manuscript_en.md:125](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L125)

**원문 · C35**

```text
0.815
```

[원본 위치: figures/figure3.svg:64](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/figures/figure3.svg#L64)

- 판정: 부분 수정
- 논문의 주장: 본문과 그림의 성능 표시가 모두 0.815예요.
- 실제 근거: 원 실행값은 0.724712285728249예요. 소수 셋째 자리까지 표시하면 0.725가 맞아요.
- 판정 이유: 단순한 반올림 차이가 아니에요. 원값과 다른 숫자가 두 곳에 들어갔어요.
- 최소 수정: 본문과 그림의 표시 두 곳만 0.725로 고쳐요. 원 실행값은 보존해요.
- 확인할 파일: runs/run_52xe/metrics.json · figures/figure3_source.csv

C07과C35는 같은 원인의 두 표시입니다. 원 metrics와 그림 source, 좌표, 신뢰구간은 보존합니다. 새 실험이나 전체 그림의 재설계가 필요하다는 뜻은 아닙니다.

**근거 바로 열기:** [runs/run_52xe/predictions.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/predictions.csv#L1) · [data/labels.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/labels.csv#L1) · [data/observation_mask.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/observation_mask.csv#L1) · [figures/figure3_source.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/figures/figure3_source.csv#L1) · [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1)

### C30 · 실제 실행과 안내한 코드 버전이 달라요

**원문 · C30**

```text
f5ce7fe2e8399fcb2bc6b157e970b8fe2b70bf48
```

[원본 위치: tables/run_registry.csv:9](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/tables/run_registry.csv#L9)

- 판정: 아님
- 논문의 주장: 실행 요약과 README가 이 결과의 코드 버전을 K23으로 안내해요.
- 실제 근거: 실제 실행 기록과 보관된 코드는 K36을 가리켜요. 요약표와 README의 참조만 K23으로 바뀌었어요.
- 판정 이유: 재현하려는 사람이 잘못된 코드 버전으로 따라가게 돼요.
- 최소 수정: 요약표와 README의 참조를 K36으로 고쳐요. 재학습은 필요 없어요.
- 확인할 파일: runs/run_m72s/launch.json · tables/run_registry.csv · README.md

K번호는 설명용 논리 번호이고 실제 Git SHA와 다릅니다. K36의 SHA는 ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51, K23의 SHA는 f5ce7fe2e8399fcb2bc6b157e970b8fe2b70bf48입니다. 이 불일치만으로 실험 자체가 없었다거나 성능값이 조작됐다고 단정하지 않습니다.

**근거 바로 열기:** [runs/run_m72s/launch.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_m72s/launch.json#L1) · [runs/run_m72s/source_index.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_m72s/source_index.json#L1) · [README.md](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/README.md#L1) · [tables/run_registry.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/tables/run_registry.csv#L1)

## 4부. 실험이 뒷받침하는 범위는 어디까지일까요?

### C04 · 계산 분석을 혈액 측정 검증으로 썼어요

**원문 · C04**

```text
validated simultaneous quantification of proteins and RNA from a single drop of blood
```

[원본 위치: paper/manuscript_en.md:9](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L9)

- 판정: 아님
- 논문의 주장: 한 방울 혈액에서 단백질과 RNA를 함께 측정하는 방법을 검증했다고 썼어요.
- 실제 근거: 실제로는 합성한 숫자 자료를 컴퓨터로 분석했어요. 혈액 채취나 실험실 정량은 하지 않았어요.
- 판정 이유: 계산 자료를 통합한 것만으로 실제 혈액의 측정법까지 검증되지는 않아요.
- 최소 수정: 합성 단백질·RNA 특징을 통합해 계산적으로 평가했다고 범위를 좁혀요.
- 확인할 파일: task_contract.yaml · data/generation_manifest.json

여기서는 그 측정이 원리상 불가능하다는 결론을 내리는 것이 아닙니다. 이 연구에서 하지 않은 검증을 했다고 쓴 범위 확대를 고칩니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1) · [data/generation_manifest.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/generation_manifest.json#L1) · [data/feature_dictionary.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/feature_dictionary.json#L1)

### C13, C28 · 가상 과업으로 모든 질병을 설명했어요

**원문 · C13**

```text
These results support prediction of every human disease.
```

[원본 위치: paper/manuscript_en.md:186](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L186)

**원문 · C28**

```text
The model is ready for immediate diagnostic deployment in primary and emergency care.
```

[원본 위치: paper/manuscript_en.md:186](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L186)

- 판정: 아님
- 논문의 주장: 모든 사람의 질병을 예측하고, 바로 진료에 쓸 수 있다고 썼어요.
- 실제 근거: 평가한 것은 합성 자료의 가상 결과 6개예요. 실제 질병에 대한 임상 검증은 하지 않았어요.
- 판정 이유: 검증한 대상과 범위보다 결론이 훨씬 넓어요.
- 최소 수정: 5.3의 두 문장을 합성 평가 범위와 후속 검증 필요에 맞게 고쳐요.
- 확인할 파일: task_contract.yaml · data/label_dictionary.json

정상적인 한계를 설명한5.2는 보존합니다. 원고 안의 모순을 없애려고 정직한 한계를 삭제하면 안 됩니다. C13과C28은 같은 범위 확대에서 나온 두 주장입니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1) · [data/label_dictionary.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/label_dictionary.json#L1) · [data/generation_manifest.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/generation_manifest.json#L1)

### C21, C37 · 계산 가중치를 인과 근거로 읽었어요

**원문 · C21**

```text
establish disease causation
```

[원본 위치: paper/manuscript_en.md:174](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L174)

**원문 · C37**

```text
validate therapeutic targets for clinical drug development
```

[원본 위치: paper/manuscript_en.md:174](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L174)

- 판정: 아님
- 논문의 주장: attention이 질병 원인과 치료 표적을 입증한다고 썼어요.
- 실제 근거: 모델은 단백질·RNA 두 정보 묶음 사이의 가중치를 계산해요. 생물학적 개입이나 기능 검증은 하지 않았어요.
- 판정 이유: 모델 안의 계산 가중치만으로 실제 질병의 원인이나 약물 효과를 입증할 수 없어요.
- 최소 수정: 모델 내부에서 관찰한 정보 결합 양상으로 해석을 좁혀요.
- 확인할 파일: src/model.py · task_contract.yaml · paper/manuscript_en.md:174

가중치는 각 head에서2×2 modality-token 행렬입니다. 개별 단백질·전사체·proteoform의 인과 효과가 아닙니다. 계산 자체와 실제 attention 값, 무개입 한계 문장은 보존합니다.

**근거 바로 열기:** [src/model.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/model.py#L1) · [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1) · [paper/manuscript_en.md](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L1)

### C11 · 문헌의 진위를 아직 확정할 수 없어요

**원문 · C11**

```text
Example and Sample describe a blood-drop diagnostic framework in *OmniDrop Universal Diagnosis* [7].
```

[원본 위치: paper/manuscript_en.md:33](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L33)

- 판정: 확인필요
- 논문의 주장: OmniDrop Universal Diagnosis라는 논문을 근거로 인용했어요.
- 실제 근거: 제공된 검증 목록에서는 확인되지 않아요. 진본 서지와 원문 확인도 끝나지 않았어요.
- 판정 이유: 확인하지 못했다는 것만으로 세상에 없는 논문이라고 단정할 수는 없어요.
- 최소 수정: 확인필요로 보류하고, 진본 서지·원문·연결 근거를 요청해요.
- 확인할 파일: paper/references.bib · evidence/reference_registry.json

운영자 후보 판정도 unknown/HOLD입니다. DOI가 없거나 검색에 실패했다는 이유만으로 비실재를 확정하지 않습니다. 추가 확인이 끝난 듯한 검색 기록을 만들어 내지 않습니다.

**근거 바로 열기:** [paper/references.bib](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/references.bib#L1) · [evidence/reference_registry.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/evidence/reference_registry.json#L1)

## 5부. 오류가 아닌 주장도 지켜야 합니다

틀린 내용을 많이 찾았더라도 정상적인 설명까지 고치면 좋은 검토라고 보기 어렵습니다. 아래는 그대로 보존해야 하는 24개 주장입니다. “맞음”은 이 문장과 해당 실행 범위의 판정이며 연구 전체에 대한 임상적 보증이 아닙니다.

### C01 · 맞음

**원문 · C01**

```text
Multi-head self-attention, introduced by Vaswani and colleagues for sequence representation learning [2], can also be adapted to tabular multimodal features.
```

[원본 위치: paper/manuscript_en.md:15](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L15)

**쉬운 뜻:** attention 참고 문헌은 실제 방법론의 출처입니다.

**왜 그대로 두나요?** 여기서는 계산 구조의 출처를 인용합니다. 그 문헌이 모든 질병 예측이나 혈액 측정까지 입증했다고 읽어서는 안 됩니다.

**근거 바로 열기:** [evidence/reference_registry.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/evidence/reference_registry.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C03 · 맞음

**원문 · C03**

```text
There is no subject overlap between these splits.
```

[원본 위치: paper/manuscript_en.md:63](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L63)

**쉬운 뜻:** 정상 실행에서는 같은 사람이 여러 분할에 겹치지 않습니다.

**왜 그대로 두나요?** 오류 실행 C02와 다른 분할입니다. 한 실행에서 겹침이 나왔다고 모든 실행을 같은 상태로 판정하면 안 됩니다.

**근거 바로 열기:** [splits/split_c321a741e9/members.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/splits/split_c321a741e9/members.csv#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C05 · 맞음

**원문 · C05**

```text
No patients were recruited, human specimens collected, wet-laboratory measurements performed, medical records accessed or clinical trials conducted.
```

[원본 위치: paper/manuscript_en.md:3](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L3)

**쉬운 뜻:** 실제 환자나 생체 시료를 사용하지 않았다는 설명입니다.

**왜 그대로 두나요?** 합성 데이터 실험이라는 범위를 정확히 밝힙니다. 실제 환자 실험을 했다고 바꾸면 새 오류가 됩니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C06 · 맞음

**원문 · C06**

```text
their article appeared online in September 2018 and in a 2019 issue [3].
```

[원본 위치: paper/manuscript_en.md:25](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L25)

**쉬운 뜻:** 논문의 온라인 공개 연도와 정식 권호 연도는 다를 수 있습니다.

**왜 그대로 두나요?** 연도 하나가 다르다는 이유만으로 허위 인용이라고 판단하지 않습니다. 동일 문헌인지 서지 전체를 대조합니다.

**근거 바로 열기:** [evidence/reference_registry.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/evidence/reference_registry.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C08 · 맞음

**원문 · C08**

```text
Validation and test data receive the transformations fixed on training data.
```

[원본 위치: paper/manuscript_en.md:65](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L65)

**쉬운 뜻:** 정상 실행의 전처리 기준은 학습 자료로 계산했습니다.

**왜 그대로 두나요?** 전체 자료로 학습한 C09와 구분합니다. 해당 실행의 fit 대상이 어디인지 확인해야 합니다.

**근거 바로 열기:** [runs/run_xapp/fit_membership.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_xapp/fit_membership.csv#L1) · [src/prepare.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/prepare.py#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C10 · 맞음

**원문 · C10**

```text
All scheduled reference seed results are retained, with no retrospective seed exclusion.
```

[원본 위치: paper/manuscript_en.md:89](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L89)

**쉬운 뜻:** 정해진 기준 실행 결과를 선택적으로 빼지 않고 보존했습니다.

**왜 그대로 두나요?** 기대보다 낮은 성능이 있다는 이유로 실행을 지우거나, 가장 좋은 결과만 남기라는 수정은 부적절합니다.

**근거 바로 열기:** [schedule/cases.jsonl](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/schedule/cases.jsonl#L1) · [tables/results.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/tables/results.csv#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C12 · 맞음

**원문 · C12**

```text
AP uses `average_precision_score`, with task-specific positive counts and prevalence reported [10, 12].
```

[원본 위치: paper/manuscript_en.md:91](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L91)

**쉬운 뜻:** AP는 연속적인 예측 점수를 바탕으로 계산했습니다.

**왜 그대로 두나요?** AP 계산에 반드시 양성·음성 threshold가 필요한 것은 아닙니다. threshold 선택 문제와 순위 지표를 구분합니다.

**근거 바로 열기:** [src/evaluate.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/evaluate.py#L1) · [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C14 · 맞음

**원문 · C14**

```text
Validation subject scores and observed labels determine the threshold maximizing F1; ties select the smallest threshold.
```

[원본 위치: paper/manuscript_en.md:87](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L87)

**쉬운 뜻:** 정상 실행에서는 검증 자료로 판정 기준점을 골랐습니다.

**왜 그대로 두나요?** 검증 자료로 고정한 기준을 test에 적용하는 것은 허용됩니다. test 자체로 고른 C23과 다릅니다.

**근거 바로 열기:** [runs/run_52xe/selection.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/selection.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C15 · 맞음

**원문 · C15**

```text
Two-head scaled dot-product self-attention uses a head dimension of 8 and `key_padding_mask = (mask == 0)` [2].
```

[원본 위치: paper/manuscript_en.md:73](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L73)

**쉬운 뜻:** 원고에 적힌 attention 구조와 실제 코드가 맞습니다.

**왜 그대로 두나요?** 구조가 맞는 것과 그 구조가 인과를 입증한다는 것은 별개입니다. 계산 설명 자체를 지우지 않습니다.

**근거 바로 열기:** [src/model.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/model.py#L1) · [paper/references.bib](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/references.bib#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C17 · 맞음

**원문 · C17**

```text
No biological intervention or functional validation was performed.
```

[원본 위치: paper/manuscript_en.md:174](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L174)

**쉬운 뜻:** 생물학적 개입 실험을 하지 않았다는 한계입니다.

**왜 그대로 두나요?** 하지 않은 검증을 하지 않았다고 밝힌 정상 문장입니다. 과장된 결론과 충돌한다고 이 한계를 지우면 안 됩니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C19 · 맞음

**원문 · C19**

```text
Of 240 planned test subjects, 223 had at least one scored aliquot, giving coverage 92.9% (approximately 0.929), and 17 abstained.
```

[원본 위치: paper/manuscript_en.md:101](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L101)

**쉬운 뜻:** 점수를 낸 223명과 보류한 17명을 나누어 보고했습니다.

**왜 그대로 두나요?** 보류가 있다는 사실 자체는 오류가 아닙니다. 이를 숨기고 전체 100%라고 한 C25가 문제입니다.

**근거 바로 열기:** [runs/run_52xe/flow.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/flow.csv#L1) · [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C20 · 맞음

**원문 · C20**

```text
Held-out subject performance is internal evaluation under that generator, not external validation in independent hospital cohorts [3, 4].
```

[원본 위치: paper/manuscript_en.md:180](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L180)

**쉬운 뜻:** 외부 병원에서 성능을 검증한 결과가 아니라고 명시했습니다.

**왜 그대로 두나요?** 기관 이름이 여러 개 있어도 합성 기관이 외부 임상 검증이 되지는 않습니다. 좁게 적힌 범위를 보존합니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1) · [data/generation_manifest.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/generation_manifest.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C22 · 맞음

**원문 · C22**

```text
We neither performed nor validated simultaneous protein/RNA extraction and quantification from a blood drop, including a 10 μL sample [1].
```

[원본 위치: paper/manuscript_en.md:178](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L178)

**쉬운 뜻:** 혈액에서 단백질과 RNA를 함께 정량하는 측정법은 검증하지 않았습니다.

**왜 그대로 두나요?** 합성 feature 통합과 실험실 측정법 검증의 경계를 정확히 설명한 문장입니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1) · [data/generation_manifest.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/generation_manifest.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C24 · 맞음

**원문 · C24**

```text
Pajouheshnia, R., Groenwold, R. H. H., Peelen, L. M., Moons, K. G. M. and Reitsma, J. B. How variation in predictor measurement affects the discriminative ability and transportability of a prediction model.
```

[원본 위치: paper/manuscript_en.md:218](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L218)

**쉬운 뜻:** 해당 참고 문헌의 제목과 서지는 확인된 내용과 맞습니다.

**왜 그대로 두나요?** 낯선 제목이라는 인상 대신 제공된 서지 근거로 판단합니다. C11의 미확인을 다른 인용으로 확장하지 않습니다.

**근거 바로 열기:** [evidence/reference_registry.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/evidence/reference_registry.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C26 · 맞음

**원문 · C26**

```text
Loading the entire CSV before selecting training indices, or transforming and evaluating the test set with a fixed transformer, does not itself constitute fitting on test data [10].
```

[원본 위치: paper/manuscript_en.md:65](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L65)

**쉬운 뜻:** 파일 전체를 읽고, 이미 정해진 기준으로 test를 변환하는 것은 가능합니다.

**왜 그대로 두나요?** 데이터를 메모리에 올린 행위가 곧 정보 누출은 아닙니다. 학습 대상에 test가 들어갔는지를 확인합니다.

**근거 바로 열기:** [src/prepare.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/prepare.py#L1) · [runs/run_xapp/fit_membership.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_xapp/fit_membership.csv#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C27 · 맞음

**원문 · C27**

```text
macro AUROC mean±sample SD was 0.7250±0.0003, with range 0.7247–0.7253
```

[원본 위치: paper/manuscript_en.md:129](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L129)

**쉬운 뜻:** 지정한 세 seed의 평균과 표본 표준편차 보고가 맞습니다.

**왜 그대로 두나요?** 원문은 sample SD입니다. 모집단 SD로 다시 계산해 다르다고 지적하거나, 반올림 값만으로 오류라고 단정하면 안 됩니다.

**근거 바로 열기:** [runs/run_xapp/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_xapp/metrics.json#L1) · [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1) · [runs/run_ras4/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_ras4/metrics.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C29 · 맞음

**원문 · C29**

```text
| SYN_T01 | 207 | 33 | 190 | 41 | 0.216 | 0.35 | 0.822 (0.752–0.886) | 0.590 (0.442–0.728) | 0.472 (0.324–0.604) |
```

[원본 위치: paper/manuscript_en.md:109](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L109)

**쉬운 뜻:** 해당 과업의 평가 분모와 원 지표가 일치합니다.

**왜 그대로 두나요?** 과업마다 관측된 라벨 수가 다를 수 있습니다. 전체 사람 수를 모든 과업의 분모로 강제하지 않습니다.

**근거 바로 열기:** [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1) · [data/labels.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/labels.csv#L1) · [data/observation_mask.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/observation_mask.csv#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C31 · 맞음

**원문 · C31**

```text
The 95% intervals use a subject cluster bootstrap with 1,000 resamples and seed 2718.
```

[원본 위치: paper/manuscript_en.md:93](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L93)

**쉬운 뜻:** 같은 사람의 검체를 묶어 사람 단위로 불확실성을 계산했습니다.

**왜 그대로 두나요?** 독립 단위가 사람인 연구에서 검체 행을 따로 재표집하면 다른 계산이 됩니다. 정상 계산을 행 단위로 바꾸지 않습니다.

**근거 바로 열기:** [src/evaluate.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/evaluate.py#L1) · [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C33 · 맞음

**원문 · C33**

```text
Vaswani, A. et al. Attention Is All You Need.
```

[원본 위치: paper/manuscript_en.md:217](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L217)

**쉬운 뜻:** attention 방법론에 대한 인용의 서지가 맞습니다.

**왜 그대로 두나요?** 정확한 인용도 문제 안에 있습니다. 참고 문헌 전체를 의심해서 일괄 삭제하는 것은 정답이 아닙니다.

**근거 바로 열기:** [evidence/reference_registry.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/evidence/reference_registry.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C34 · 맞음

**원문 · C34**

```text
Its attention layer therefore produces a 2×2 modality-token weight matrix per head, not weights for individual proteins, transcripts or proteoforms.
```

[원본 위치: paper/manuscript_en.md:168](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L168)

**쉬운 뜻:** 가중치는 단백질·RNA 두 정보 묶음 사이에서 계산한 값입니다.

**왜 그대로 두나요?** 개별 유전자·단백질 각각의 인과 효과를 측정했다는 뜻이 아닙니다. 모델이 실제 계산한 단위를 유지합니다.

**근거 바로 열기:** [src/model.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/model.py#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C36 · 맞음

**원문 · C36**

```text
A subject whose follow-up ends before day 180 without an event has `y = null`, `observed = false`.
```

[원본 위치: paper/manuscript_en.md:57](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L57)

**쉬운 뜻:** 끝까지 결과를 확인하지 못한 경우를 미관측으로 표시했습니다.

**왜 그대로 두나요?** 결과를 모르는 것과 사건이 없다고 확인한 음성을 구분하는 정상 처리입니다.

**근거 바로 열기:** [data/labels.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/labels.csv#L1) · [data/observation_mask.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/data/observation_mask.csv#L1) · [src/labels.py](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/src/labels.py#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C38 · 맞음

**원문 · C38**

```text
No real or invented IRB approval number is assigned.
```

[원본 위치: paper/manuscript_en.md:190](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L190)

**쉬운 뜻:** 실제 사람 연구를 했다는 가짜 IRB 승인 번호를 만들지 않았습니다.

**왜 그대로 두나요?** 교육용 합성 데이터의 설명에 실제 임상 연구처럼 승인 번호를 꾸며 넣으면 안 됩니다.

**근거 바로 열기:** [task_contract.yaml](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/task_contract.yaml#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C39 · 맞음

**원문 · C39**

```text
The subject split contained 720/240/240 training/validation/test subjects, with 1,440/480/480 aliquots and no subject overlap.
```

[원본 위치: paper/manuscript_en.md:99](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L99)

**쉬운 뜻:** 정상 분할은 사람 720/240/240명, 검체 1440/480/480개입니다.

**왜 그대로 두나요?** 대상자당 검체가 두 개이므로 사람 수와 검체 수는 다릅니다. 숫자가 두 배라는 이유만으로 모순이 아닙니다.

**근거 바로 열기:** [splits/split_c321a741e9/summary.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/splits/split_c321a741e9/summary.csv#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

### C40 · 맞음

**원문 · C40**

```text
AUROC, AP and F1 therefore describe the scored-and-observed subset, alongside the coverage limits of the planned population.
```

[원본 위치: paper/manuscript_en.md:181](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/paper/manuscript_en.md#L181)

**쉬운 뜻:** 점수를 낸 일부 대상의 성능이라는 점을 명시했습니다.

**왜 그대로 두나요?** 부분집합 성능 보고는 그 범위를 밝히면 가능합니다. 전체 대상 coverage와 같은 지표로 읽지 않습니다.

**근거 바로 열기:** [runs/run_52xe/flow.csv](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/flow.csv#L1) · [runs/run_52xe/metrics.json](https://github.com/Geongyu/falsify-pilot/blob/14cadf4fa5686076e755a0d59f71ba37fdba6d51/runs/run_52xe/metrics.json#L1)

**수정:** 이 주장 자체에 대한 과학적 수정은 필요하지 않습니다.

## 6부. 팀별 전체 정답표

### 팀1 · 분할과 전처리 전체 판정

| 주장 | 판정 | 이유 |
| --- | --- | --- |
| C02 | 아님 | 학습과 시험에 같은 사람이 겹침 |
| C03 | 맞음 | 정상 실행에는 사람 중복이 없음 |
| C08 | 맞음 | 정상 실행은 학습 자료로만 기준 계산 |
| C09 | 아님 | 전처리 기준 계산에 시험 자료도 사용 |
| C16 | 아님 | 예측 뒤에 알 수 있는 미래 정보를 사용 |
| C18 | 아님 | 미리보기에서 다른 표본끼리 연결 |
| C26 | 맞음 | 고정 기준으로 시험 자료를 변환해도 됨 |
| C39 | 맞음 | 정상 분할의 인원과 표본 수가 맞음 |

### 팀2 · 라벨과 분모 전체 판정

| 주장 | 판정 | 이유 |
| --- | --- | --- |
| C14 | 맞음 | 정상 실행은 검증 자료로 기준점 선택 |
| C19 | 맞음 | 점수 223명과 유보 17명을 명시 |
| C23 | 아님 | 시험 자료로 기준점을 선택하고 평가 |
| C25 | 아님 | 점수 없는 사람을 빼고 100%로 보고 |
| C31 | 맞음 | 사람 단위 불확실성 계산이 맞음 |
| C32 | 아님 | 모르는 결과를 확인된 음성으로 평가 |
| C36 | 맞음 | 추적 미완료를 미관찰로 표시 |
| C40 | 맞음 | 일부 대상의 성능이라고 명시 |

### 팀3 · 숫자와 출처 전체 판정

| 주장 | 판정 | 이유 |
| --- | --- | --- |
| C07 | 부분 수정 | 본문 표시 0.815를 0.725로 수정 |
| C10 | 맞음 | 지정한 기준 실행 결과를 모두 보존 |
| C12 | 맞음 | 연속 점수로 AP를 계산한 방법이 맞음 |
| C15 | 맞음 | 코드와 attention 구조 설명이 일치 |
| C27 | 맞음 | 지정한 3개 seed의 평균과 SD가 맞음 |
| C29 | 맞음 | 해당 과업의 분모와 원 지표가 일치 |
| C30 | 아님 | 재현 안내의 코드 버전이 실제와 다름 |
| C35 | 부분 수정 | 그림 표시 0.815를 0.725로 수정 |

### 팀4 · 해석과 결론 전체 판정

| 주장 | 판정 | 이유 |
| --- | --- | --- |
| C13 | 아님 | 가상 과업으로 모든 질병 예측 주장 |
| C17 | 맞음 | 개입 검증을 하지 않았다는 한계가 맞음 |
| C20 | 맞음 | 외부 병원 검증이 아님을 명시 |
| C21 | 아님 | 계산 가중치를 질병 원인 입증으로 확대 |
| C28 | 아님 | 임상 검증 없이 즉시 진료 사용 주장 |
| C34 | 맞음 | 가중치는 두 정보 묶음 사이의 값 |
| C37 | 아님 | 계산 가중치를 치료 표적 입증으로 확대 |
| C38 | 맞음 | 가짜 IRB 번호를 만들지 않음 |

### 숙제 · 문헌과 범위 전체 판정

| 주장 | 판정 | 이유 |
| --- | --- | --- |
| C01 | 맞음 | 계산 구조에 대한 실제 문헌 인용 |
| C04 | 아님 | 하지 않은 혈액 측정 검증을 주장 |
| C05 | 맞음 | 실제 환자와 시료를 쓰지 않았음 |
| C06 | 맞음 | 온라인 연도와 권호 연도는 다를 수 있음 |
| C11 | 확인필요 | 문헌 진본을 추가로 확인해야 함 |
| C22 | 맞음 | 혈액 동시 측정을 검증하지 않았음 |
| C24 | 맞음 | 실제 문헌의 제목과 서지가 맞음 |
| C33 | 맞음 | 실제 attention 논문의 서지가 맞음 |

## 내 풀이와 비교할 때는 이렇게 봐주세요

1. **판정:** 맞음·아님·부분 수정·보류를 구분했나요?
2. **근거:** 실제 실행과 파일의 위치를 특정했나요? 다른 실행의 근거를 가져오지는 않았나요?
3. **설명:** 문제가 생기는 원리를 설명했나요? 예를 들어 sample SD를 population SD로 바꿔 계산하지 않았나요?
4. **수정:** 표시만 고치면 되는 곳에서 실험 전체를 다시 만들거나, 정상 한계를 삭제하지 않았나요?
5. **불확실성:** 확인하지 못한 문헌을 곧바로 허위라고 단정하지 않았나요?

판정이 같아도 이유가 틀릴 수 있고, 정답 후보와 다른 답이어도 새로운 근거가 있다면 검토할 가치가 있습니다. 차이가 있다면 원문 위치와 근거 파일, 관측한 값을 함께 알려주세요.

## 자료 모음

- [문제와 실행 근거 · GitHub](https://github.com/Geongyu/falsify-pilot)
- [논문 PDF](https://github.com/Geongyu/falsify-pilot/blob/main/paper/paper.pdf)
- [팀별 기록표와 에이전트·스킬·하네스 안내](https://docs.google.com/spreadsheets/d/1ViSpn-bwqchZp0gGn3x3vIXl4ExbNXSrJLXsRWqQ0Qk/edit)
- [슬라이드 정답 해설](https://docs.google.com/presentation/d/1P09S2zXM-tA635aXzYhgcVQouY0l15mUO-E-5NQPc-g/edit) — 현재 제한 공유이므로 접근이 안 되면 진행자에게 요청해 주세요.

## 함께 풀어주셔서 감사합니다

저도 이런 문제를 처음 만들어봤습니다. 직접 파일을 확인하고, AI의 답을 다시 의심하고, 근거를 찾아 설명해 주시는 과정에서 저도 많이 배웠습니다. 재미있게 참여하고 꼼꼼하게 풀어주셔서 정말 감사합니다.

쉽게 찾은 부분, 헷갈린 표현, 문제 자체에서 이상하다고 느낀 부분까지 편하게 알려주세요. 이번 해설도 완성된 권위 있는 정답이라기보다, 여러분과 근거를 맞춰가며 다듬는 출발점으로 읽어주시면 좋겠습니다!
