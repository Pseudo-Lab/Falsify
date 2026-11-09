# [교육용 허구·합성 연구 기준본] 다중 오믹스 수치 특성 결합을 통한 6개 합성 사건 분류 절차의 재현성 및 방법론적 경계 평가

> **[교육용 허구 연구 표시 (Educational Fictional Study Notice)]**
> 본 문서는 연구 안전 게이트(Research Safety Gate)의 검증 및 감사 교육을 위해 제작된 **교육용 허구·합성 연구 원고(동결된 국문 기준본)**입니다. 본 연구의 코호트(1,200명), 분취 표본(2,400개), 단백체(24개)·전사체(96개) 특성 및 6개 사건 라벨(`SYN_T01`–`SYN_T06`)은 모두 컴퓨터 시뮬레이션으로 생성된 합성 자료입니다. 실제 환자 모집, 인체유래물 채혈, 습식 실험실 정량 분석, 의무기록 조회 또는 임상시험을 수행하지 않았으며, 본 원고의 어떤 내용도 실제 임상 진단 성능이나 의학적 유효성의 근거로 해석하거나 인용할 수 없습니다.

- **투고 대상 프로필 (Target Venue Profile)**: `Aster Methods Forum (AMF)` | `track: methods` | `stage: initial (double-blind review)` | `profile_version: edu-1.0` *(교육용 자체 규정이며 실제 학술지 정책이 아님)*
- **저자 표시 (Anonymized Submission)**: `Anonymous Authors (Synthetic Benchmark Study)`
- **원고 상태**: `author/author_draft_ko.md` (동결된 국문 기준본 — 사전 등록된 정상 실행 캡슐 및 독립 재계산으로 검증된 실제 실험 결과 수치를 반영한 확정본)

---

## 초록

소량 생체 표본에서 다중 오믹스 특성을 결합하는 기계학습 파이프라인은 표본 식별자 정렬, 참여자 단위 분할, 결측 양상 처리, 우측 중도절단 라벨 마스킹과 같은 방법론적 계약이 엄격히 유지될 때에만 신뢰할 수 있는 내부 평가 지표를 제공한다. 본 연구는 컴퓨터 시뮬레이션으로 생성한 합성 참여자 1,200명(3개 가상 기관, 동일 기준 방문당 분취 표본 2개씩 총 2,400개 표본)의 단백체 모사 수치 특성 24개와 전사체 모사 수치 특성 96개(기준 시점 $t_0$ 가용 기저 특성 95개 및 시간 창 누출 감사용 $t_0+30$일 후발 대조 변수 1개)를 대상으로, 기준 시점($t_0$) 이전에 가용한 119개 기저 특성만을 사용하여 180일 이내의 6개 합성 사건(`SYN_T01`–`SYN_T06`)을 분류하는 기준 파이프라인을 구축하고 평가 절차를 검증했다. 참여자 식별자(`subject_id`) 기준 60%/20%/20% 분할(`split_c321a741e9`)을 적용하여 분할 간 참여자 중복을 배제했고, 결측 대체와 표준화 변환은 학습 분할에서만 적합했으며, 검증 분할에서 체크포인트와 과업별 F1 임계값을 고정했다. 테스트 분할의 계획된 참여자(`n_planned = 240`) 중 두 분취 표본 모두에서 두 오믹스 양상이 전부 결측되어 예측을 유보(`abstain`)한 17명(`n_abstain = 17`)을 제외한 223명(`n_scored = 223`, 커버리지 92.9%)에서 가용 분취 표본 점수를 참여자별로 평균하여 평가한 결과, 소형 2-head attention 주 기준 실행(`run_52xe`, `seed = 1733`)의 6개 과업 매크로 평균 AUROC는 0.725(95% 참여자 군집 부트스트랩 신뢰구간 0.691–0.759), 평균 정밀도(AP)는 0.518(95% 신뢰구간 0.469–0.589), F1 점수는 0.507(95% 신뢰구간 0.457–0.550)이었고, 동일 조건의 3개 독립 시드(`1729`, `1733`, `1741`) 간 매크로 AUROC 평균±표준편차는 0.7250±0.0003이었다. 선형 기준모델(`run_yy4a`, `seed = 1729`)의 테스트 매크로 평균 AUROC는 0.713(95% 신뢰구간 0.679–0.748), AP는 0.508(95% 신뢰구간 0.454–0.575), F1 점수는 0.512(95% 신뢰구간 0.464–0.555)였다. 본 결과는 정의된 6개 합성 과업과 내부 보류 분할 범위에 한정되며, 실제 혈액 습식 정량이나 외부 임상 코호트 일반화를 입증하지 않는다.

---

## 1. 서론

최근 미량 혈액 채취(microsampling) 기법과 다중 오믹스 분석 기술이 발전함에 따라 소량의 생체 시료로부터 단백체(proteomics)와 전사체(transcriptomics) 등 다층적인 분자 지표를 측정하려는 시도가 활발히 이루어지고 있다 [1]. 예를 들어 Shen 등(2023년 온라인 선공개, 2024년 정식 출판)은 10 $\mu\text{L}$ 미량 혈액 표본에서 다중 오믹스 분자 프로파일링을 수행하여 생활습관 및 생리적 변화와의 연관성을 탐색할 수 있음을 보고했다 [1]. 그러나 이러한 선행 연구는 제한된 실험 조건에서의 분자 측정 가능성과 종단적 연관성을 다룬 것일 뿐, 단 한 방울의 혈액으로 인간의 모든 질병을 예측하거나 즉각적인 임상 진단 도구를 확립했음을 입증한 연구가 아니다 [1].

한편 다중 양상(multimodal) 생물의학 데이터를 결합하기 위해 Vaswani 등(2017)이 시퀀스 표현 학습을 위해 제안한 멀티헤드 자기주목(multi-head self-attention) 아키텍처 [2]를 표 형식 오믹스 특징 결합에 응용하는 연구가 늘어나고 있다. 하지만 다중 오믹스 예측 파이프라인에서는 아키텍처의 복잡성보다 데이터 계보(lineage)와 평가 프로토콜의 정합성이 결과의 타당성을 좌우하는 경우가 많다. 구체적으로 (i) 동일 참여자로부터 얻은 반복 분취 표본(aliquot specimens)이 학습 분할과 테스트 분할에 나뉘어 들어가는 참여자 누출, (ii) 전체 데이터셋에서 전처리 변환기를 적합(fit)하거나 테스트 분할에서 분류 임계값을 사후 선택하는 평가 오염, (iii) 기준 시점($t_0$) 이후에 측정된 후발 변수의 혼입, (iv) 180일 추적 관찰이 완료되기 전에 중도절단된 미관찰 라벨을 확인된 음성으로 간주하는 오류, (v) 두 오믹스 양상이 모두 결측되어 예측을 유보(`abstain`)한 사례를 계획 분모에서 제외하고도 전체 모집단 성능으로 보고하는 문제 등이 발생할 경우 예측 지표는 심각하게 왜곡된다.

본 연구의 목적은 실제 환자 자료나 습식 실험 없이, 생성 규칙과 참값 계보가 완전히 통제된 **합성 다중 오믹스 코호트**를 구축하여 위와 같은 방법론적 계약들이 예측 지표와 감사 추적성(auditability)에 미치는 영향을 체계적으로 검증하는 것이다. 본 연구에서 다루는 ‘단백체 24개 특성’과 ‘전사체 96개 특성’은 실제 혈액에서 추출·정량한 생물학적 분자가 아니라 두 오믹스 양상의 통계적 분포와 결측 구조를 모사한 수치형 합성 특징(synthetic features)이며, 예측 대상 역시 6개의 추상 합성 사건(`SYN_T01`–`SYN_T06`)으로 제한된다. 따라서 본 원고는 다중 오믹스 결합 파이프라인의 계산적 재현성과 평가 경계를 점검하는 방법론 보고서로서, 실제 임상 진단 성능이나 질병 원인 규명을 주장하지 않는다.

---

## 2. 관련 연구

### 2.1 다중 오믹스 프로파일링의 범위와 예측 모형의 이동가능성 한계
미량 생체 시료를 활용한 오믹스 연구는 채취 편의성과 다중 지표 측정 측면에서 중요한 기술적 진전을 이루었으나, 측정 가능한 분자 수와 임상적 질병 예측의 타당성은 엄격히 구분되어야 한다 [1]. Shen 등(2023년 온라인 공개, 2024년 권호 출판)의 미량 혈액 다중 오믹스 연구는 소량 시료의 분자 프로파일링 절차를 제시했을 뿐 범용적인 임상 질병 스크리닝을 보증하지 않으며, 학술 인용 시 온라인 선공개 연도(2023년)와 정식 권호 연도(2024년)는 서지 맥락에 따라 모두 정확한 표기로 인정된다 [1].

또한 예측 모형의 판별 성능은 데이터 수집 프로토콜과 기관별 측정 환경에 크게 좌우된다. Pajouheshnia 등(2018년 9월 온라인 선공개, 2019년 정식 출판)은 예측 변수 측정 방식의 기관·시점 간 변동(predictor measurement heterogeneity)이 모형의 판별력(discriminative ability)과 외부 집단으로의 이동가능성(transportability)을 저하시키거나 왜곡할 수 있음을 수리적·역학적으로 규명했다 [3]. 아울러 Zech 등(2018)은 다기관 흉부 방사선 딥러닝 연구에서 병원 간 유병률 차이와 기관 특이적 교란 요인으로 인해 내부 분할(internal split)에서 높은 AUROC를 보인 모델이라도 독립된 외부 의료기관에서는 성능이 유의하게 하락함을 실증했다 [4]. 이러한 선행 근거에 따라 본 연구는 3개 가상 기관(`SITE_A`, `SITE_B`, `SITE_C`)을 포함한 합성 코호트 내 보류 참여자에 대한 평가를 ‘내부 평가(internal evaluation)’로만 정의하며, 외부 병원 검증 완료로 해석하지 않는다 [3, 4].

### 2.2 자기주목 메커니즘과 모델 내부 가중치 해석의 경계
본 연구의 비선형 결합 모형은 Vaswani 등(2017)이 제안한 스케일드 내적 주목(scaled dot-product attention) 및 멀티헤드 구조 [2]를 소형 오믹스 양상 임베딩 공간에 맞게 축소 적용한 것이다. 해당 문헌은 신경망 시퀀스 변환을 위한 계산 아키텍처의 정의를 제공할 뿐, 혈액 오믹스 변수의 생물학적 작용 기전을 뒷받침하는 근거가 아니다 [2].

특히 주목 가중치(attention weights)를 모델 예측의 설명이나 인과적 근거로 해석할 수 있는지에 관해서는 기계학습 분야에서 중요한 방법론적 논쟁이 존재한다. Jain과 Wallace(2019)는 다양한 자연어 처리 분류 과제에서 주목 가중치가 경사도(gradient) 기반 특성 중요도나 특성 제거 효과와 일관되게 부합하지 않으며, 서로 다른 주목 가중치 분포가 동일한 예측 출력을 생성할 수 있음을 보여 주목 가중치를 곧바로 예측의 설명으로 간주해서는 안 된다고 지적했다 [10]. 이어 Wiegreffe와 Pinter(2019)는 설명 가능성의 정의를 세분화하고 대조 실험을 통해 특정 과제 조건에서는 주목 가중치가 모델 내부 동작을 진단하는 유용한 기제가 될 수 있음을 보였다 [11]. 그러나 두 연구 모두 주목 가중치가 관찰 데이터 외부의 생물학적 인과 경로(causal mechanism)나 임상적 약물 치료 표적(therapeutic target)을 입증한다고 주장하지 않는다 [10, 11]. 본 연구는 이러한 문헌적 합의를 준수하여 주목 가중치를 오직 합성 표현 공간 내의 통계적 연관성 요약치로만 다룬다.

---

## 3. 자료 및 방법

### 3.1 합성 코호트 설계, 표본 계보 및 단백체 동형체(`proteoform`) 특성
본 연구의 모든 합성 원자료는 코드 내 고정 상수 시드(`SEED = 1729`)를 사용하는 결정론적 합성 데이터 생성기(`src/generate.py`)를 통해 생성되었으며, 생성 파라미터와 파일별 해시는 `data/generation_manifest.json`에 기록된다(데이터 생성기는 `configs/config.yaml`을 읽지 않고 자체 고정 시드 상수를 사용한다). 코호트는 총 1,200명의 가상 참여자(`subject_id`: `SYN-P0001`–`SYN-P1200`)로 구성되며, 각 참여자는 3개의 가상 기관(`SITE_A` 477명, `SITE_B` 410명, `SITE_C` 313명) 중 한 곳에 배정된다(`data/subjects.csv`). 실제 의료기관이나 환자 집단을 차용하지 않았으며, 기관 변수는 기관별 잠재 생물학적 상태 이동(`site_latent_shift_sd = 0.25`), 과업별 기저 위험 로그오즈 오프셋(`site_task_effect_sd = 0.3`), 그리고 특성별 측정 배치 오프셋(`batch_sd`)을 모사하는 합성 잠재 요인이다 [4].

각 참여자에 대해 기준 방문 시점($t_0 = 0$일)에서 동시에 분취된 2개의 반복 분취 표본(aliquot specimens, `aliquot_index` $\in \{1, 2\}$)을 생성하여 전체 표본 수는 2,400개(`specimen_id`: `SYN-P0001-A1`, `SYN-P0001-A2` 등)가 된다(`data/specimens.csv`). 동일한 `subject_id`에 속한 두 분취 표본은 동일한 참여자의 잠재 생물학적 상태와 기관 배치 오프셋을 공유하면서 표본 수준의 기술적 측정 잡음(`technical_sd`)과 분취 표본별 양상·원소 결측 패턴만 다르게 부여되므로, 통계적으로 독립된 참여자로 취급할 수 없다.

오믹스 특성 공간은 총 120개의 수치형 변수로 정의된다(`data/feature_dictionary.json`):
1. **단백체 모사 특성 (`data/protein.csv`, 24개)**: `PROT_01`부터 `PROT_24`까지의 연속형 변수로, 단일 유전자에서 유전적 변이, 대안적 스플라이싱 및 번역 후 변형(post-translational modification)에 의해 파생되는 개별 단백질 분자 형태인 단백체 동형체(`proteoform`) 정량 신호를 모사한다 [5]. 여기서 `proteoform`은 Smith와 Kelleher(2013)가 정립한 표준 단백체학 전문용어다 [5].
2. **전사체 모사 특성 (`data/rna.csv`, 96개)**: 기준 시점($t_0$)에 측정 가능한 95개의 기저 전사체 모사 변수(`RNA_001`–`RNA_095`, `available_day = 0`)와, 시간 창 누출 감사를 위해 설계된 1개의 후발 대조 변수(`followup_peak_synthetic`, `available_day = 30`, $t_0 + 30$일 시점의 사건 연관 대리 변수)를 합쳐 총 96개 열로 구성된다.
3. **사전 시점 특성 선택 불변식**: 정상 기준 파이프라인(`configs/data/synthetic.yaml`의 `features.allow_post_index: false`)에서는 `src/prepare.py::select_features`가 `available_day <= 0` 조건을 검사하여 후발 변수인 `followup_peak_synthetic`을 입력에서 엄격히 배제하고, 기준 방문 시점($t_0$) 이전에 가용한 **119개 기저 특성(단백체 24개 + 기저 전사체 95개)**만을 모델 학습과 평가에 사용한다.

두 오믹스 테이블(`protein.csv`, `rna.csv`)은 서로 다른 로컬 표본 식별자(`protein_local_id`, `rna_local_id`)와 상이한 행 순서로 저장된다. 표본 결합 모듈(`src/pairing.py`)은 행 순서(row index)에 의존하지 않고 반드시 교차매핑 테이블(`data/modality_crosswalk.csv`)을 참조하여 두 로컬 식별자를 정규 표본 식별자(`canonical_specimen_id`)로 변환한 뒤 일대일(`validate="one_to_one"`) 조인을 수행한다. 또한 결합 확인용 미리보기 스크립트(`examples/paired_preview.py`)가 생성하는 `data/pairing_preview.csv` 역시 양쪽 오믹스 행이 동일한 `canonical_specimen_id`를 가리키도록 검증하여 정렬한다.

### 3.2 180일 합성 사건 라벨과 관찰 마스크(`observation_mask`)의 분리
예측 대상은 기준 방문($t_0 = 0$) 이후 180일 추적 기간(`horizon_days: 180`) 내에 발생하는 6개의 합성 이진 사건(`SYN_T01`–`SYN_T06`)이다(`data/label_dictionary.json`, `src/labels.py`). 각 참여자 $i$와 과업 $t$의 쌍 `(subject_id, task_id)`는 `data/labels.csv`와 `data/observation_mask.csv`에서 유일한 기본 키(총 $1{,}200 \times 6 = 7{,}200$개 항목)를 형성하며, 사건 발생일(`event_day`)과 참여자별 추적 종료일(`followup_end_day`)에 따라 다음과 같이 결정된다:
- **확인된 양성 (`y = 1`, `observed = true`)**: $0 < \text{event\_day} \le 180$이고 $\text{event\_day} \le \text{followup\_end\_day}$인 경우(181일 이후에 기록된 지연 사건은 180일 엔드포인트 양성에 해당하지 않으며, 전체 코호트 7,200개 항목 중 `event_day > 180`인 지연 사건은 189건 존재한다).
- **확인된 음성 (`y = 0`, `observed = true`)**: 180일 이내에 사건이 발생하지 않았고 추적 관찰이 180일 시점까지 완전히 유지된 경우($\text{followup\_end\_day} \ge 180$).
- **우측 중도절단 미관찰 (`y = null`, `observed = false`)**: 180일 이전에 사건 없이 추적이 종료된 경우($\text{followup\_end\_day} < 180$ 및 180일 내 무사건). 이 경우 남은 기간($\text{followup\_end\_day} \sim 180$일) 동안의 사건 발생 여부를 알 수 없으므로 결측(`null`)으로 보존하며, 이를 확인된 음성(`0`)으로 대체하지 않는다.

본 파이프라인은 라벨의 180일 추적 완료 여부를 기록하는 **관찰 마스크(`data/observation_mask.csv`)**와 입력 오믹스 측정값의 존재 여부를 기록하는 **양상 마스크(`data/modality_mask.csv`)**를 별도의 테이블로 분리하여 관리한다.

### 3.3 참여자 단위 분할과 학습 분할 전용 전처리 적합
학습된 모델이 학습 과정에 등장하지 않은 새로운 참여자(unseen subjects)에게 일반화되는지 평가하기 위해, 데이터 분할(`src/split.py`)은 개별 분취 표본(`specimen_id`)이 아닌 **참여자 식별자(`subject_id`)**를 군집 단위로 수행한다(`configs/config.yaml`: `split.unit = subject_id`, `split.seed = 1729`, `fractions = [0.6, 0.2, 0.2]`). 이 설정으로 생성된 정규 분할(`splits/split_c321a741e9/members.csv`, `summary.csv`)에서 전체 1,200명의 참여자는 학습 분할(`train`) 720명(1,440개 표본), 검증 분할(`val`) 240명(480개 표본), 테스트 분할(`test`) 240명(480개 표본)으로 배정되며, 세 분할 간 `subject_id` 교집합은 정확히 0명(`overlap_subjects = 0`)이다.

고차원 생물의학 데이터 분석에서 평가 분할의 통계 정보가 전처리나 특성 선택 과정에 유입되면 성능 추정치에 심각한 낙관적 편향이 발생한다 [6, 7]. 이를 방지하기 위해 전처리 모듈(`src/prepare.py::fit_preprocessor`)은 `preprocess.fit_scope: train` 계약에 따라 **오직 학습 분할(`train`)에 속한 표본만을 사용하여** 특성별 결측 대체값(중앙값, median)과 표준화 변환 통계량(평균 및 표준편차)을 적합(`fit`)한다. 적합에 사용된 실제 참여자 및 표본 식별자 목록(학습 분할 720명, 1,440개 표본)은 `runs/<run_id>/fit_membership.csv`에, 적합된 통계량 배열은 `runs/<run_id>/preprocess_state.npz`에 기록된다. 검증 분할(`val`)과 테스트 분할(`test`)에는 학습 분할에서 이미 고정된 변환(`transform`) 함수만을 적용한다 [7]. 파이프라인 초기화 단계에서 전체 코호트 CSV 파일을 메모리에 로드한 뒤 분할 인덱스를 적용하거나, 테스트 분할 배열을 고정된 `transform` 및 `evaluate` 함수에 전달하는 절차 자체는 학습 정보 유출이 아닌 정상적인 소프트웨어 동작이다 [7].

### 3.4 양상 결측 처리, 예측 유보(`abstain`) 및 다중 오믹스 결합 아키텍처
분취 표본 수준에서 단백체(24개 기저 특성) 또는 전사체(95개 기저 특성) 양상 전체가 결측될 수 있으며, 이는 `data/modality_mask.csv`에 기록된다(전체 2,400개 표본 중 한 양상만 가용한 표본은 309개, 두 양상이 모두 결측된 표본은 165개이다). 정상 파이프라인(`configs/data/synthetic.yaml`)은 두 가지 결측 상황을 다음과 같이 구분하여 처리한다:
1. **단일 양상 결측 (`missing_modality.one: masked_token`)**: 단백체와 전사체 중 한 양상만 가용한 표본은 결측된 양상의 특성 벡터를 영 토큰(zero token)으로 채우고, 각 양상의 가용 여부를 나타내는 이진 양상 마스크 벡터 $\mathbf{m} \in \{0, 1\}^2$를 모델에 함께 전달하여 예측 확률을 정상적으로 산출한다.
2. **양쪽 양상 모두 결측 (`missing_modality.both: abstain`)**: 표본의 두 오믹스 양상이 모두 결측된 경우에는 기저 절편만으로 임의의 예측 점수를 생성하지 않고, 예측 유보(`score = null`, `score_status = "abstain"`)로 분류하여 `runs/<run_id>/predictions.csv`와 `runs/<run_id>/flow.csv`에 명시적으로 기록한다. 참여자 수준 집계 시 두 분취 표본(`A1`, `A2`)이 모두 `abstain`인 참여자는 테스트 계획 모집단(`n_planned = 240`) 내에서 미산출 유보 사례(`n_abstain = 17`)로 집계하며, 실제 점수가 산출된 참여자 수(`n_scored = n_planned - n_abstain = 223`)와 계획 분모(`denominator_scope: planned`)를 함께 보고한다.

비교 평가하는 두 분류 모형(`src/model.py`)은 다음과 같다:
- **선형 기준모델 (`kind: linear`, `src/model.py::LinearModel`)**: 전처리된 가용 기저 특성 벡터(119차원, 결측 양상 블록은 마스크를 곱해 0으로 처리)와 이진 양상 마스크 $\mathbf{m} \in \{0, 1\}^2$(2차원)를 이어붙인 121차원 입력 벡터에 단일 선형 계층(`nn.Linear(121, 6)`)과 시그모이드 함수를 적용하여 6개 과업 각각의 사건 발생 확률을 산출하는 다중 과업 로지스틱 회귀 모형이다.
- **소형 2-Head Attention 결합 모델 (`kind: attention`, `src/model.py::AttentionFusion`)**: 단백체 기저 특성(24차원)과 전사체 기저 특성(95차원)을 각각 은닉 차원 $d = 16$ (`width: 16`)의 양상 토큰(`protein` 토큰 및 `rna` 토큰, 시퀀스 길이 2)으로 선형 투영하고, 결측된 양상 토큰을 영 벡터(`tokens * mask`)로 마스킹한 뒤 `key_padding_mask = (mask == 0)`이 적용된 2-헤드 스케일드 내적 자기주목 층(`heads: 2`, 각 헤드 차원 $d_k = 8$) [2]을 수행한다. 잔차 연결(`hidden = tokens + out`)을 거친 뒤, 가용한 양상 토큰들에 대해서만 마스킹된 평균 풀링(masked mean pooling, `(hidden * mask).sum / mask.sum`)을 수행하여 16차원 결합 표현을 얻는다. 최종적으로 이 16차원 풀링 벡터에 2차원 이진 양상 마스크 $\mathbf{m}$을 연결(concatenate)한 **18차원 벡터**를 선형 분류 헤드(`nn.Linear(18, 6)`)와 시그모이드 함수에 통과시켜 6개 과업의 예측 확률 $\hat{\mathbf{p}} \in [0, 1]^6$을 출력한다.

두 모형 모두 학습(`src/train.py`, `configs/model/fusion.yaml`) 시 `Adam` 최적화기(`learning_rate = 0.001`), 미니배치 크기 `batch_size = 64`, 최대 에포크 `max_epochs = 20`을 사용한다. 학습 및 검증 손실 계산에는 적어도 한 양상이 가용하여 점수가 산출되는 표본 행(학습 분할 1,440개 표본 중 49명의 유보 참여자 표본 등을 제외한 1,336개 표본 행; 검증 분할 480개 표본 중 11명의 유보 참여자 표본 등을 제외한 454개 표본 행)만 사용된다. 각 미니배치 내 손실 함수는 `observation_mask`에서 `observed == true`로 확인된 `(specimen_row, task_id)` 항목에 대해서만 계산하는 마스킹된 이진 교차 엔트로피이며, 배치 내 관찰된 항목 수($\sum_{n,t} o_{n,t}$)로 정규화한다:

$$\mathcal{L} = -\frac{1}{\sum_{n,t} o_{n,t}} \sum_{n,t} o_{n,t} \left[ y_{n,t} \log \hat{p}_{n,t} + (1 - y_{n,t}) \log (1 - \hat{p}_{n,t}) \right]$$

여기서 $o_{n,t} \in \{0, 1\}$는 라벨 관찰 마스크(`observed`)이며, 에포크 단위 손실(`train_loss`, `val_loss`)은 전체 미니배치에 걸쳐 관찰된 라벨 항목 수로 가중 평균하여 산출한다.

### 3.5 검증 기반 선택, 참여자 수준 집계, 평가 지표 및 군집 부트스트랩 신뢰구간
모형의 구조적·최적화 하이퍼파라미터(`width = 16`, `heads = 2`, `max_epochs = 20`, `learning_rate = 0.001`, `batch_size = 64`)는 별도의 격자 탐색 없이 설정 파일(`configs/model/fusion.yaml`)에 사전 지정되었으며, 검증 분할(`val`)은 테스트 분할(`test`)을 완전히 배제한 상태에서 오직 체크포인트 에포크 선택과 과업별 F1 결정 임계값 고정(`src/train.py`, `runs/<run_id>/selection.json`)에만 사용한다 [6, 7]:
- **체크포인트(에포크) 선택 (`selection.checkpoint_split: val`)**: 전체 학습 에포크(`1..20`) 중 검증 분할의 관찰 라벨 평균 손실(`val_loss`)이 최소인 에포크의 가중치를 최종 체크포인트로 선택한다. 모든 에포크의 학습·검증 손실은 `runs/<run_id>/epoch_metrics.csv`에, 체크포인트 파라미터 해시·검증 손실·선택 여부는 `checkpoint_index.jsonl`에 보존한다.
- **F1 결정 임계값 선택 (`selection.threshold_split: val`)**: 선택된 체크포인트의 검증 분할(`val`) 참여자 수준 예측 점수에서 과업 $t$별로 후보 임계값 격자(`0.05`부터 `0.95`까지 `0.01` 간격, 총 91개 후보; 동점 시 가장 작은 임계값 선택) 중 검증 F1 점수를 최대화하는 임계값 $\tau_t^*$를 선택하여 `selection.json`에 고정하고, 테스트 분할 평가 시에는 검증에서 고정된 $\tau_t^*$를 그대로 적용한다 [7].
- **사전 지정 시드 역할 분리 및 실행 캡슐 보존**: 본 파이프라인은 (i) 합성 데이터 생성 시드(`src/generate.py`의 `SEED = 1729`), (ii) 참여자 분할 시드(`configs/config.yaml`의 `split.seed = 1729`), (iii) 모델 가중치 초기화 및 미니배치 셔플을 제어하는 실행 시드(`seed` $\in \{1729, 1733, 1741\}$), (iv) 군집 부트스트랩 재표집 시드(`bootstrap_seed = 2718`)의 역할을 명시적으로 분리한다. 무작위 초기화 변동을 확인하기 위해 사전 지정된 시드의 정상 실행을 모두 수행하고 사후 제외 없이 전체 시드 결과를 공개한다. 각 실행은 동결된 소스 커밋에서 수행되며, 설정 합성과 명령행 오버라이드는 `Hydra` (`hydra-core 1.3.7`, `version_base="1.3"`)를 통해 처리되어 각 캡슐의 `.hydra/` 디렉터리(`config.yaml`, `hydra.yaml`, `overrides.yaml`) 및 `run_manifest.json`(`config_system`), `inputs.json`(`effective_config_sha256`), `launch.json`, `source_index.json`, `source.tar`에 기록된다 [9] (단, 설정 파일과 캡슐 구조가 존재한다는 사실 자체를 방법론적 무결성의 자동 증명으로 간주하지 않고 내부 설정값을 직접 대조한다 [9]).

최종 테스트 분할 평가(`src/evaluate.py`, `tools/recompute_metrics.py`)는 다음 순서를 따른다:
1. **참여자 수준 점수 평균**: 테스트 분할 내 각 참여자 $i$와 과업 $t$에 대해, 해당 참여자의 분취 표본(`A1`, `A2`) 중 유효 점수가 산출된(`score_status == "scored"`) 표본들의 연속 예측 확률을 산술 평균하여 참여자 수준 점수 $\bar{p}_{i,t}$를 계산한다.
2. **과업별 평가지표 산출 (`unknown_policy: mask`)**: 각 과업 $t \in \{\text{SYN\_T01}, \dots, \text{SYN\_T06}\}$별로 유효 참여자 점수 $\bar{p}_{i,t}$가 존재하고(`n_scored = 223`) 라벨이 실제 관찰된(`observed == true`) 테스트 참여자 집합 $\mathcal{I}_t^{\text{eval}}$에서 다음 세 지표를 계산한다:
   - **AUROC**: 연속 확률 점수 $\bar{p}_{i,t}$와 관찰 이진 라벨 $y_{i,t} \in \{0, 1\}$ 간의 수신자 조작 특성 곡선 아래 면적 (`sklearn.metrics.roc_auc_score`) [7].
   - **AP (Average Precision)**: 클래스 불균형과 양성 유병률 차이를 반영하는 정밀도-재현율 곡선 요약 지표 (`sklearn.metrics.average_precision_score`) [8]. 과업별 관찰 양성 건수와 양성 비율(prevalence)을 함께 보고한다 [8].
   - **F1 점수**: 검증 분할에서 고정한 임계값 $\tau_t^*$를 적용한 이진 판정 $\hat{y}_{i,t} = \mathbb{I}(\bar{p}_{i,t} \ge \tau_t^*)$ 기준의 조화 평균 점수.
3. **과업 간 매크로 평균 (`averaging: macro`)**: 6개 개별 과업 지표의 비가중 산술 평균($\frac{1}{6}\sum_{t=1}^6 M_t$)을 종합 지표로 보고한다. 이는 모든 과업의 예측-라벨 쌍을 단일 벡터로 평탄화(flatten)하여 계산하는 마이크로(micro) 집계와 구별된다.
4. **참여자 군집 부트스트랩 신뢰구간 (`bootstrap_unit: subject_id`)**: 분취 표본 간의 참여자 내 상관관계를 보존하기 위해, 개별 표본 행이 아닌 **점수가 산출된 테스트 참여자 집합(`n_scored = 223`, `pool = scored subjects of the evaluation split`)**에서 `subject_id`를 고정 시드(`bootstrap_seed = 2718`)로 $B = 1{,}000$회 복원추출(cluster bootstrap)하고, 추출된 참여자에 속한 모든 유효 분취 표본 점수를 함께 가져와 참여자 평균 점수와 과업별·매크로 지표를 재계산한 뒤 선형 백분위수(`numpy.percentile`, 2.5% 및 97.5%)로 95% 신뢰구간을 산출한다. 두 양상이 모두 결측되어 점수가 산출되지 않은 유보 참여자(`n_abstain = 17`)는 유효 예측 점수가 없으므로 부트스트랩 풀에 포함되지 않으며, 계획 분모(`n_planned = 240`) 대비 유보 인원으로 별도 명시한다.

---

## 4. 실험 결과

### 4.1 합성 코호트 분할, 양상 결측 유보(`abstain`) 및 라벨 관찰 흐름
전체 합성 코호트는 1,200명의 참여자(2,400개 분취 표본)로 생성되었으며, 참여자 단위(`subject_id`, `split.seed = 1729`) 60/20/20 분할(`splits/split_c321a741e9/summary.csv`) 결과 학습 분할 720명(1,440개 표본), 검증 분할 240명(480개 표본), 테스트 분할 240명(480개 표본)으로 배정되었고 분할 간 참여자 중복은 0명(`overlap_subjects = 0`)이었다. 학습 분할에서는 720명 중 671명(1,336개 표본)에서 최소 한 양상이 가용하여 학습에 사용되었고(49명 유보), 검증 분할에서는 240명 중 229명(454개 표본)이 검증 손실 및 임계값 선택에 사용되었다(11명 유보).

테스트 분할의 계획된 전체 참여자(`n_planned = 240`, 480개 표본) 중 적어도 하나의 분취 표본에서 한 가지 이상의 오믹스 양상이 가용하여 참여자 수준 예측 점수가 산출된 참여자는 `n_scored = 223`명(커버리지 `92.9%`, 비율 `0.929`; 테스트 표본 480개 중 유효 점수가 산출된 표본 445개 [두 양상이 모두 가용한 표본 382개, 단일 양상만 가용한 표본 63개] 및 두 양상이 모두 결측되어 유보된 표본 35개)이었고, 두 분취 표본 모두에서 단백체와 전사체가 전부 결측되어 참여자 수준 예측이 유보(`abstain`)된 참여자는 `n_abstain = 17`명(유보 참여자 17명의 34개 표본과 산출 참여자 중 1명의 유보 분취 표본 1개를 합쳐 유보 표본은 총 35개)이었다(`runs/run_52xe/flow.csv`, `runs/run_52xe/predictions.csv`, `data/modality_mask.csv`). 표 1은 테스트 분할에서 6개 합성 사건(`SYN_T01`–`SYN_T06`) 각각의 관찰 완료 참여자 수(`observed = true`), 180일 이전 우측 중도절단으로 인한 미관찰 제외 참여자 수(`observed = false`), 유효 평가 분모(`scored` $\cap$ `observed`), 관찰된 양성 사건 수 및 양성 유병률(prevalence), 검증 분할에서 고정된 임계값($\tau_t^*$), 그리고 소형 2-head attention 주 기준 실행(공개 ID `run_52xe`, `seed = 1733`, 선택 에포크 7)의 과업별 및 매크로 평균 테스트 성능을 요약한다.

#### 표 1. 테스트 분할(`n_planned = 240`)의 과업별 라벨 관찰 현황, 양성 비율 및 정상 2-Head Attention 주 기준 실행(`run_52xe`, `seed = 1733`) 성능

| 합성 과업 ID | 관찰 완료 (`observed=true`) | 미관찰 중도절단 (`observed=false`) | 유효 평가 참여자 (`scored & observed`) | 양성 사건 수 ($y=1$) | 양성 비율 (Prevalence) | 검증 고정 임계값 ($\tau_t^*$) | 테스트 AUROC (95% CI) | 테스트 AP (95% CI) | 테스트 F1 (95% CI) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `SYN_T01` | `207` | `33` | `190` | `41` | `0.216` | `0.35` | `0.822` (`0.752–0.886`) | `0.590` (`0.442–0.728`) | `0.472` (`0.324–0.604`) |
| `SYN_T02` | `205` | `35` | `188` | `31` | `0.165` | `0.15` | `0.746` (`0.641–0.838`) | `0.405` (`0.264–0.605`) | `0.351` (`0.246–0.459`) |
| `SYN_T03` | `206` | `34` | `189` | `49` | `0.259` | `0.21` | `0.792` (`0.715–0.862`) | `0.620` (`0.483–0.741`) | `0.574` (`0.471–0.667`) |
| `SYN_T04` | `206` | `34` | `189` | `54` | `0.286` | `0.28` | `0.761` (`0.675–0.836`) | `0.572` (`0.447–0.714`) | `0.580` (`0.471–0.676`) |
| `SYN_T05` | `207` | `33` | `190` | `61` | `0.321` | `0.29` | `0.547` (`0.457–0.631`) | `0.364` (`0.277–0.484`) | `0.461` (`0.366–0.548`) |
| `SYN_T06` | `209` | `31` | `192` | `78` | `0.406` | `0.30` | `0.680` (`0.599–0.759`) | `0.556` (`0.461–0.683`) | `0.605` (`0.522–0.682`) |
| **매크로 평균 (Macro)** | — | — | `n_scored = 223` (`n_abstain = 17`) | — | `0.275` *(6개 과업 평균)* | — | **`0.725`** (`0.691–0.759`) | **`0.518`** (`0.469–0.589`) | **`0.507`** (`0.457–0.550`) |

> *주*: 본문 및 표의 AUROC, AP, F1 수치와 95% 신뢰구간은 소수점 셋째 자리로 반올림하여 표기했으며(`rounding_decimals: 3`), `runs/run_52xe/metrics.json`에 기록된 배정밀도 원시 매크로 지표는 `AUROC = 0.724712`, `AP = 0.517718`, `F1 = 0.507119`이다. 각 과업에서 관찰 완료 인원(`205`–`209`명)과 유효 평가 인원(`188`–`192`명)의 차이(과업별 17명)는 두 오믹스 양상이 모두 결측되어 예측이 유보된 테스트 참여자(`n_abstain = 17`명)에 해당한다.

---

### 4.2 선형 기준모델과 소형 2-Head Attention 모델의 정상 기준선 비교 및 다중 시드 안정성
참여자 단위 분할(`split.unit = subject_id`, `split_c321a741e9`), 학습 분할 전용 전처리 적합(`preprocess.fit_scope = train`), $t_0$ 기저 특성 전용 입력(`allow_post_index = false`, 119개 특성), 검증 분할 체크포인트 및 임계값 고정(`checkpoint_split = val`, `threshold_split = val`), 계획 분모 투명 보고(`denominator_scope = planned`), 미관찰 라벨 마스킹(`unknown_policy = mask`)을 모두 준수한 정상 기준 설정에서, 선형 기준모델 1회 실행(`run_yy4a`)과 소형 2-head attention 모델의 3개 사전 지정 시드(`1729`, `1733`, `1741`)에 걸친 정상 설정 실행 9회(`run_52xe`, `run_b3f9`, `run_xapp`, `run_adnm`, `run_sh3j`, `run_7fba`, `run_3tjm`, `run_ras4`, `run_m72s`; 총 10회 정상 설정 실행)의 테스트 분할 종합 성능을 비교했다(표 2).

- **선형 기준모델 (`run_yy4a`, `seed = 1729`)**: 검증 손실이 에포크 20까지 지속적으로 감소하여 `selected_epoch = 20`(`val_loss = 0.5286`)이 선택되었으며, 테스트 매크로 평균 AUROC는 `0.713` (95% CI `0.679–0.748`, 원시값 `0.713048`), 매크로 AP는 `0.508` (95% CI `0.454–0.575`, 원시값 `0.508394`), 매크로 F1은 `0.512` (95% CI `0.464–0.555`, 원시값 `0.511593`)였다.
- **소형 2-head attention 주 기준 실행 (`run_52xe`, `seed = 1733`)**: 에포크 7(`val_loss = 0.4877`)이 최적 체크포인트로 선택되었으며, 테스트 매크로 평균 AUROC는 `0.725` (95% CI `0.691–0.759`, 원시값 `0.724712`), 매크로 AP는 `0.518` (95% CI `0.469–0.589`, 원시값 `0.517718`), 매크로 F1은 `0.507` (95% CI `0.457–0.550`, 원시값 `0.507119`)였다. `run_id`를 제외한 모든 설정값과 시드(`seed = 1733`)가 동일한 반복 실행 `run_b3f9`는 모든 참여자·표본에서 완전히 동일한 예측 확률과 평가지표를 산출했다(`predictions.csv`는 `run_id` 열 문자열만 상이하며, `.hydra/config.yaml` 내부에 `run_id`가 포함되므로 `effective_config_sha256` 해시는 `run_52xe`가 `ac72c0a2c3a6...`, `run_b3f9`가 `29226b88d656...`로 실행별 고유값을 가진다). 이 수치는 동결된 예측 파일(`runs/run_52xe/predictions.csv`)과 관찰 라벨 마스크(`data/observation_mask.csv`)로부터 독립 검산 스크립트(`tools/recompute_metrics.py`)를 통해 재계산한 결과와 허용 오차 1e-9 이내에서 일치한다.
- **다중 시드 안정성 및 동일 시드 결정론적 재현성**: 소형 2-head attention 모델에 대해 사전 지정된 3개 고유 시드(`1729`, `1733`, `1741`) 전체에서 사후 제외된 시드는 없었다. 시드 `1729`(`run_xapp` 및 각 방법론 대조 쌍의 정상 기준선으로 동일 설정에서 반복 실행된 `run_adnm`, `run_sh3j`, `run_7fba`, `run_3tjm`, 모두 `selected_epoch = 7`, `val_loss = 0.4865`)는 5회 실행 모두 동일하게 매크로 AUROC `0.725` (`0.692–0.759`, 원시값 `0.725086`), 매크로 AP `0.511` (`0.466–0.578`, 원시값 `0.510730`), 매크로 F1 `0.539` (`0.491–0.583`, 원시값 `0.539031`)를 기록했고, 시드 `1741`(`run_ras4` 및 동일 설정 반복 실행 `run_m72s`, 모두 `selected_epoch = 6`, `val_loss = 0.4854`)은 2회 실행 모두 동일하게 매크로 AUROC `0.725` (`0.691–0.760`, 원시값 `0.725339`), 매크로 AP `0.522` (`0.472–0.596`, 원시값 `0.521519`), 매크로 F1 `0.537` (`0.487–0.580`, 원시값 `0.537406`)을 기록했다. 선형 기준모델(`run_yy4a`)과 동일 시드 중복 실행을 제외하고 3개 고유 attention 시드(`1729`, `1733`, `1741`)에 대해 집계한 테스트 매크로 AUROC의 평균±표준편차는 **`0.7250 ± 0.0003`** (3자리 반올림 기준 `0.725`, `SD < 0.001`, 원시값 범위 `0.7247–0.7253`), 매크로 AP는 **`0.517 ± 0.005`** (원시값 `0.5167 ± 0.0055`, 범위 `0.511–0.522`), 매크로 F1은 **`0.528 ± 0.018`** (원시값 `0.5279 ± 0.0180`, 범위 `0.507–0.539`)로 관찰되었다. 모든 정상 실행 캡슐의 `runs/<run_id>/launch.json`, `source_index.json`, `source.tar`는 동결된 실행 소스 커밋(`ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51`)을 기록하고 있으며, 각 실행의 유효 설정 해시(`effective_config_sha256`)는 `runs/<run_id>/inputs.json` 및 `runs/<run_id>/run_manifest.json`에 일관되게 보존되어 있다.

#### 표 2. 정상 기준선 모형 및 다중 시드 정상 설정 실행(총 10회)의 테스트 분할 종합 지표 요약

| 실행 구분 및 공개 `run_id` | 모델 아키텍처 | 시드 (`seed`) | 선택 에포크 (`epoch`) | 실행 소스 커밋 (`source_commit`) | 계획/산출/유보 참여자 (`n_planned`/`n_scored`/`n_abstain`) | 매크로 AUROC (95% CI) | 매크로 AP (95% CI) | 매크로 F1 (95% CI) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| 선형 기준모델 (`run_yy4a`) | `linear` | `1729` | `20` | `ff77e8b4...fb51` | `240` / `223` / `17` | `0.713` (`0.679–0.748`) | `0.508` (`0.454–0.575`) | `0.512` (`0.464–0.555`) |
| 주목 모형 주 기준 실행 (`run_52xe`) | `attention` (2-head) | `1733` | `7` | `ff77e8b4...fb51` | `240` / `223` / `17` | **`0.725`** (`0.691–0.759`) | **`0.518`** (`0.469–0.589`) | **`0.507`** (`0.457–0.550`) |
| 주목 모형 시드 `1733` 반복 (`run_b3f9`) | `attention` (2-head) | `1733` | `7` | `ff77e8b4...fb51` | `240` / `223` / `17` | `0.725` (`0.691–0.759`) | `0.518` (`0.469–0.589`) | `0.507` (`0.457–0.550`) |
| 주목 모형 시드 `1729` 기준 (`run_xapp`) | `attention` (2-head) | `1729` | `7` | `ff77e8b4...fb51` | `240` / `223` / `17` | `0.725` (`0.692–0.759`) | `0.511` (`0.466–0.578`) | `0.539` (`0.491–0.583`) |
| 주목 모형 시드 `1729` 반복 (`run_adnm`, `run_sh3j`, `run_7fba`, `run_3tjm` 등 4회 동일) | `attention` (2-head) | `1729` | `7` | `ff77e8b4...fb51` | `240` / `223` / `17` | `0.725` (`0.692–0.759`) | `0.511` (`0.466–0.578`) | `0.539` (`0.491–0.583`) |
| 주목 모형 시드 `1741` 기준 (`run_ras4`) | `attention` (2-head) | `1741` | `6` | `ff77e8b4...fb51` | `240` / `223` / `17` | `0.725` (`0.691–0.760`) | `0.522` (`0.472–0.596`) | `0.537` (`0.487–0.580`) |
| 주목 모형 시드 `1741` 반복 (`run_m72s`) | `attention` (2-head) | `1741` | `6` | `ff77e8b4...fb51` | `240` / `223` / `17` | `0.725` (`0.691–0.760`) | `0.522` (`0.472–0.596`) | `0.537` (`0.487–0.580`) |
| **주목 모형 3개 고유 시드 요약 (`1729`, `1733`, `1741` 평균±SD)** | `attention` (2-head) | 3개 시드 | `6–7` | `ff77e8b4...fb51` | `240` / `223` / `17` | **`0.7250 ± 0.0003`** *(범위 `0.7247–0.7253`)* | **`0.517 ± 0.005`** *(범위 `0.511–0.522`)* | **`0.528 ± 0.018`** *(범위 `0.507–0.539`)* |

> *주*: `source_commit`의 전체 SHA-1 해시는 `ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51`이다. `run_id`를 제외한 모든 설정값과 시드를 동일하게 공유하는 반복 실행들은 동일한 예측 점수와 지표를 산출하므로(단, `effective_config_sha256` 해시는 `run_id`를 포함하여 실행마다 고유함), 3개 시드 평균±표준편차는 고유 시드 3개(`1729`, `1733`, `1741`)당 1개 대표값만 사용하여 계산했다.

---

## 5. 논의 및 한계

### 5.1 모델 내부 양상 수준 주목 가중치 관찰과 생물학적 인과 해석의 분리
본 연구의 소형 2-head attention 모델(`src/model.py::AttentionFusion`)은 24개의 단백체 모사 특성(`proteoform` 모사 변수 [5]) 전체를 단일 16차원 `protein` 양상 토큰으로 선형 투영하고, 95개의 기저 전사체 모사 특성 전체를 단일 16차원 `rna` 양상 토큰으로 선형 투영한 뒤 시퀀스 길이 2(`protein`, `rna`)에 대해 2-헤드 자기주목 연산을 수행한다. 따라서 본 아키텍처의 주목 층은 개별 단백질이나 개별 전사체 특성 단위의 가중치를 직접 산출하지 않으며, 오직 **헤드별 $2 \times 2$ 양상 토큰 간 주목 가중치(`protein` 대 `rna`)**만을 계산한다.

테스트 분할(`480`개 표본) 중 두 오믹스 양상이 모두 가용한 $n = 382$개 분취 표본을 대상으로 주 기준 실행(`run_52xe`, `seed = 1733`; 동일 시드 반복 실행 `run_b3f9`와 동일)의 양상 간 평균 주목 가중치를 분석한 결과, 두 헤드 모두에서 `protein` 양상 토큰에 상대적으로 높은 키(key) 가중치가 할당되었다. 구체적으로 `head 0`에서는 `protein` 쿼리 기준 `protein→protein = 0.646`, `protein→rna = 0.354`였고 `rna` 쿼리 기준 `rna→protein = 0.528`, `rna→rna = 0.472`였으며, `head 1`에서는 `protein→protein = 0.692`, `protein→rna = 0.308`, `rna→protein = 0.612`, `rna→rna = 0.388`이었다(한 양상만 가용한 63개 표본에서는 `key_padding_mask`에 의해 가용한 단일 양상 토큰에 가중치 `1.000`이 부여된다).

그러나 거의 동일한 테스트 매크로 AUROC(`0.725`)를 달성한 다른 두 무작위 초기화 시드와 비교하면 우세 양상 토큰의 방향 자체가 시드에 따라 역전되었다. 시드 `1729`(`run_xapp` 등)에서는 `head 0`(`protein→rna = 0.548`, `rna→rna = 0.564`)과 `head 1`(`protein→rna = 0.560`, `rna→rna = 0.531`) 모두 오히려 `rna` 양상 토큰에 더 높은 가중치를 부여한 반면, 시드 `1741`(`run_ras4`, `run_m72s`)에서는 `head 0`이 `protein` 토큰을 선호(`protein→protein = 0.617`, `rna→protein = 0.594`)하고 `head 1`은 두 양상에 거의 균등한 가중치(`protein→protein = 0.558`, `rna→protein = 0.502`)를 부여했다. 이처럼 동일한 예측 판별력(`AUROC 0.725`) 하에서도 시드 초기화에 따라 양상 간 주목 가중치의 우열이 뒤바뀌는 현상은, Jain과 Wallace(2019)가 지적한 바와 같이 주목 가중치 분포가 유일하거나 불변적인 예측 설명이 아님을 직접적으로 뒷받침한다 [10]. 또한 Wiegreffe와 Pinter(2019)의 논의 역시 모델 내부의 표현 진단에 관한 것일 뿐 관찰 데이터 외부의 생물학적 기전을 입증하는 절차가 아니다 [11]. 더욱이 본 연구는 컴퓨터로 생성된 합성 변수를 대상으로 수행되었고 생물학적 개입 실험(intervention study)이나 기능적 검증을 전혀 포함하지 않으므로, 모델 내부의 양상 토큰 주목 가중치나 투영 계수를 실제 질병의 발병 인과 기전(causal mechanism)이나 임상 약물 개발을 위한 검증된 치료 표적(therapeutic target)으로 해석해서는 안 된다 [10, 11].

### 5.2 연구의 한계 (Limitations)
본 연구는 방법론적 재현성과 감사 가능성을 평가하기 위한 합성 기준선 연구로서 다음과 같은 명확한 한계를 가진다:
1. **합성 자료에 따른 습식 분석 미실시**: 본 연구의 단백체(24개) 및 전사체(96개) 특성은 난수 생성기로 모사된 수치 행렬이며, 실제 한 방울 혈액(예: 10 $\mu\text{L}$)에서 단백질과 RNA를 동시에 추출·정량하는 습식 분석(wet-lab assay)을 수행하거나 검증한 바 없다 [1].
2. **6개 합성 사건으로 제한된 과업 범위 및 임상 적용 불가**: 예측 대상은 `SYN_T01`부터 `SYN_T06`까지의 6개 추상 합성 사건에 국한된다. 따라서 본 모형이 인간의 모든 질병을 예측할 수 있다거나 일차 진료·응급 임상 현장에서 즉시 진단 목적으로 사용될 수 있다는 어떠한 결론도 지지하지 않는다.
3. **단일 합성 분포 내 내부 평가의 한계**: 3개 가상 기관(`SITE_A`–`SITE_C`)은 합성 생성기 내부의 잠재 변수로 정의되었으며, 본 테스트 분할 성능은 동일 생성 규칙 내 보류된 참여자(`held-out subjects`)에 대한 내부 평가 결과다. 실제 독립된 외부 의료기관 코호트에서의 외부 검증(external validation)은 수행되지 않았다 [3, 4].
4. **결측 유보(`abstain`) 및 우측 중도절단(`null`)에 따른 조건부 평가 한계**: 테스트 분할 계획 참여자(`n_planned = 240`명) 중 두 오믹스 양상이 모두 결측된 17명(`n_abstain = 17`명)에 대해서는 예측 점수를 산출하지 않고 유보하여 223명(`n_scored = 223`명, 커버리지 `92.9%`)만 평가에 포함되었으며, 과업별로 180일 이전에 추적 관찰이 중단된 무사건 사례 31~35명은 미관찰(`observed = false`)로 마스킹하여 과업별 유효 평가 분모(`188`–`192`명)에서 제외했다. 따라서 보고된 AUROC, AP, F1 지표는 점수가 산출되고 라벨이 관찰된 부분집합(`scored` $\cap$ `observed`)에서의 조건부 성능이며, 계획된 전체 코호트(`n_planned = 240`)의 커버리지 한계와 함께 해석되어야 한다.
5. **고정된 에포크 예산(`max_epochs = 20`)에 따른 선형 기준모델과 주목 모형 비교의 한계**: 소형 2-head attention 모델은 3개 시드 모두에서 6~7 에포크에 검증 손실 최솟값에 도달한 반면, 선형 기준모델(`run_yy4a`)은 최대 에포크인 20 에포크(`selected_epoch = 20`)에서 최소 검증 손실이 선택되었고 학습 종료 시점까지 검증 손실이 계속 감소하는 추세를 보였다(`runs/run_yy4a/epoch_metrics.csv`). 따라서 고정된 20 에포크 예산과 단일 학습률(`0.001`) 하에서 관찰된 매크로 AUROC 차이(`0.725` 대 `0.713`)는 사전 지정된 학습 예산 내의 경험적 비교일 뿐, 선형 모형 대비 자기주목 결합 아키텍처의 본질적 우월성을 입증하지 않는다.

---

## 윤리 진술 (Ethics Statement)

본 연구는 전적으로 컴퓨터 시뮬레이션으로 생성된 가상 참여자(`SYN-P0001`–`SYN-P1200`)와 합성 수치 데이터만을 사용했다(`data/generation_manifest.json`). 실제 인간 대상자 모집, 인체유래물 채취, 개인식별정보 처리 또는 환자 의무기록 열람을 일체 수행하지 않았으므로 기관생명윤리위원회(IRB) 심의 및 동의서 취득 대상이 아니다(`not_applicable / synthetic-only`). 본 원고에는 어떠한 가상 또는 허위의 IRB 승인 번호도 부여하지 않는다.

## 자료 가용성 진술 (Data Availability Statement)

본 연구에 사용된 모든 합성 원자료(`data/subjects.csv`, `data/specimens.csv`, `data/modality_crosswalk.csv`, `data/protein.csv`, `data/rna.csv`, `data/labels.csv`), 마스크 테이블(`data/observation_mask.csv`, `data/modality_mask.csv`), 데이터 사전(`data/feature_dictionary.json`, `data/label_dictionary.json`, `data/generation_manifest.json`), 참여자 분할 명세(`splits/split_c321a741e9/`) 및 실행 캡슐(`runs/<run_id>/`)은 참가자 배포 저장소 내에 재현 가능한 형태로 전체 공개된다.

## 코드 가용성 진술 (Code Availability Statement)

합성 데이터 생성(`src/generate.py`, `src/labels.py`), 정규 표본 결합(`src/pairing.py`), 참여자 단위 분할(`src/split.py`), 학습 전용 전처리 적합(`src/prepare.py`), 선형 및 소형 2-head attention 모델 학습(`src/model.py`, `src/train.py`), 참여자 수준 평가 및 군집 부트스트랩 신뢰구간 산출(`src/evaluate.py`), 참여자 흐름 및 커버리지 집계(`src/report.py`), 그리고 실험 실행·독립 지표 재계산·계약 검증 도구(`tools/run_case.py`, `tools/recompute_metrics.py`, `tools/verify_contracts.py`)와 잠긴 의존성 명세(`pyproject.toml`, `environment.lock`)는 모두 배포 저장소에 포함된다. 배포 저장소에 보존된 각 실행 캡슐(`runs/<run_id>/`)의 평가지표와 95% 군집 부트스트랩 신뢰구간은 외부 네트워크 연결 없이 단일 CPU 프로세스에서 `python -m tools.recompute_metrics --run <run_id>` (및 계약·해시 검증을 위한 `python -m tools.verify_contracts --run <run_id>` 또는 `python -m tools.verify_contracts --all-runs`) 명령으로 즉시 재검산할 수 있으며, 원천 학습 실행(`python -m tools.run_case --case <case_id>`)은 기존 실행 캡슐을 덮어쓰지 않도록 동결된 실행 소스 커밋(`ff77e8b4b58ad90eede0e5d1eec18342cdc8fb51`, `runs/` 생성 이전 상태)의 클린 체크아웃에서 동일하게 재현할 수 있다.

---

## AMF `edu-1.0` 재현성 체크리스트 (Reproducibility Checklist)

| 점검 항목 (AMF `edu-1.0` 필수 양식) | 응답 상태 | 원고 및 저장소 근거 위치 |
| :--- | :---: | :--- |
| 1. 교육용 허구·합성 연구 여부 및 비임상 한계 명시 | **예 (Yes)** | 표지 공지, 초록, 1절, 5.2절, 윤리 진술, `README.md`, `task_contract.yaml` |
| 2. 데이터 생성 시드, 분할 시드 및 코호트 스키마 공개 | **예 (Yes)** | 3.1절, 3.3절, 3.5절, `src/generate.py` (`SEED = 1729`), `data/generation_manifest.json`, `configs/config.yaml` (`split.seed: 1729`, `bootstrap_seed: 2718`) |
| 3. 학습·검증·테스트 분할 단위 및 중복 0건 검증 공개 | **예 (Yes)** | 3.3절, 4.1절 (`subject_id` 60/20/20 분할), `splits/split_c321a741e9/members.csv`, `summary.csv` |
| 4. 전처리 적합 범위(`train`-only) 및 적합 멤버십 기록 | **예 (Yes)** | 3.3절, `src/prepare.py`, `runs/<run_id>/fit_membership.csv`, `preprocess_state.npz` |
| 5. 검증 분할 기반 체크포인트 및 임계값 선택 이력 공개 | **예 (Yes)** | 3.5절, 4.1절, 4.2절, `runs/<run_id>/checkpoint_index.jsonl`, `epoch_metrics.csv`, `selection.json` |
| 6. 양상 결측 유보(`abstain`) 및 미관찰 라벨(`null`) 분모 공개 | **예 (Yes)** | 3.2절, 3.4절, 4.1절, 표 1, 표 2, `data/observation_mask.csv`, `data/modality_mask.csv`, `runs/<run_id>/flow.csv` |
| 7. 독립 재계산 스크립트 및 잠긴 실행 환경 제공 | **예 (Yes)** | 코드 가용성 진술, `src/evaluate.py`, `tools/recompute_metrics.py`, `environment.lock` |

---

## 참고문헌 (References — AMF 등장순 대괄호 숫자 양식)

1. Shen, X. et al. Multi-omics microsampling for the profiling of lifestyle-associated changes in health. *Nature Biomedical Engineering* **8**, 11–29 (2024; online 19 January 2023). https://doi.org/10.1038/s41551-022-00999-8
2. Vaswani, A. et al. Attention Is All You Need. In *Advances in Neural Information Processing Systems (NeurIPS)* **30**, 5998–6008 (2017). https://papers.nips.cc/paper_files/paper/2017/hash/3f5ee243547dee91fbd053c1c4a845aa-Abstract.html
3. Pajouheshnia, R., Groenwold, R. H. H., Peelen, L. M., Moons, K. G. M. & Reitsma, J. B. How variation in predictor measurement affects the discriminative ability and transportability of a prediction model. *Journal of Clinical Epidemiology* **105**, 136–141 (2019; Epub 14 September 2018). https://doi.org/10.1016/j.jclinepi.2018.09.001
4. Zech, J. R. et al. Variable generalization performance of a deep learning model to detect pneumonia in chest radiographs: A cross-sectional study. *PLOS Medicine* **15**(11), e1002683 (2018). https://doi.org/10.1371/journal.pmed.1002683
5. Smith, L. M., Kelleher, N. L. & The Consortium for Top Down Proteomics. Proteoform: a single term describing protein complexity. *Nature Methods* **10**(3), 186–187 (2013). https://doi.org/10.1038/nmeth.2369
6. Ambroise, C. & McLachlan, G. J. Selection bias in gene extraction on the basis of microarray gene-expression data. *Proceedings of the National Academy of Sciences (PNAS)* **99**(10), 6562–6566 (2002). https://doi.org/10.1073/pnas.102102699
7. scikit-learn developers. Common pitfalls and recommended practices; `sklearn.metrics.roc_auc_score`; Tuning the decision threshold for class prediction. *scikit-learn official documentation* (stable, checked 18 October 2026). https://scikit-learn.org/stable/common_pitfalls.html
8. Saito, T. & Rehmsmeier, M. The Precision-Recall Plot Is More Informative than the ROC Plot When Evaluating Binary Classifiers on Imbalanced Datasets. *PLOS ONE* **10**(3), e0118432 (2015). https://doi.org/10.1371/journal.pone.0118432
9. Hydra developers. Output/Working directory. *Hydra v1.3 official documentation* (checked 18 October 2026). https://hydra.cc/docs/1.3/tutorials/basic/running_your_app/working_directory/
10. Jain, S. & Wallace, B. C. Attention is not Explanation. In *Proceedings of the 2019 Conference of the North American Chapter of the Association for Computational Linguistics: Human Language Technologies (NAACL-HLT)*, 3543–3556 (2019). https://doi.org/10.18653/v1/N19-1357
11. Wiegreffe, S. & Pinter, Y. Attention is not not Explanation. In *Proceedings of the 2019 Conference on Empirical Methods in Natural Language Processing and the 9th International Joint Conference on Natural Language Processing (EMNLP-IJCNLP)*, 11–20 (2019). https://doi.org/10.18653/v1/D19-1002
