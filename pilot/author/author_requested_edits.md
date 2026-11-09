# 저자 영문 번역 및 편집 요청 범위 (`author_requested_edits.md`)

> **[교육용 허구 연구 표시]**
> 본 문서는 한국어 원문 기준본(`author/author_draft_ko.md`)을 영문 원고(`paper/manuscript_en.md`)로 변환·편집할 때 허용된 편집 범위와 일반적 충실도 원칙을 명시하는 공개 기준 문서입니다.

## 1. 허용된 편집 작업 (Authorized Operations)

1. **충실한 학술 영문 번역 및 문장 정돈**:
   - 한국어 원문의 문장 구조나 어순을 자연스러운 학술 영어로 재배열하거나 문장을 결합·분할하는 문체적 다듬기(stylistic polishing)는 핵심 조건·수치·부정 표현·한계 범위가 보존되는 한 허용한다.
   - 백분율과 소수 표기 간 수학적 등가 변환(예: `92.9%` $\leftrightarrow$ `0.929`, `60%/20%/20%` $\leftrightarrow$ `0.60/0.20/0.20`) 및 국제단위계(SI) 내 정확히 일치하는 물리량 표기 변환은 정상 변환으로 허용한다.
2. **승인된 검증 문헌의 제한적 보충 (`Authorized Expansion`)**:
   - `evidence/reference_registry.json`에 등록된 검증 문헌(Shen et al., 2024 [1]; Vaswani et al., 2017 [2]; Pajouheshnia et al., 2019 [3]; Zech et al., 2018 [4]; Smith & Kelleher, 2013 [5]; Ambroise & McLachlan, 2002 [6]; scikit-learn documentation [7]; Saito & Rehmsmeier, 2015 [8]; Hydra v1.3 [9]; Jain & Wallace, 2019 [10]; Wiegreffe & Pinter, 2019 [11])의 실제 지지 범위 내에서 관련 연구 배경과 방법론적 맥락을 명확히 설명하는 문장 보충은 허용한다.
   - 단백체학 표준 전문용어 `proteoform` [5]은 원어 그대로 유지한다.
3. **투고처(`AMF edu-1.0`) 서식 맞춤**:
   - 가상 투고처 `Aster Methods Forum (AMF)` (`track: methods`, `stage: initial`, `profile_version: edu-1.0`) 규정에 따라 비구조화 단일 문단 영문 초록(180단어 이하), 등장순 대괄호 숫자 인용(`[1]`), 익명 초심 표기, 한계 절, 윤리·자료·코드 가용성 진술 및 재현성 체크리스트 형식을 적용한다.

## 2. 일반적 편집 충실도 및 보존 원칙 (General Fidelity Principles)

1. **연구 설계 및 실험 범위의 정합성 유지**:
   - 한국어 원문과 저장소 아티팩트(`data/`, `protocol/`, `runs/`)에 정의된 데이터 생성 방식, 코호트 구성, 입력 특성 정의, 예측 과업의 정의 및 내부 평가 범위를 원문 그대로 유지하며, 수행되지 않은 실험 절차나 외부 검증 범위를 추가하지 않는다.
2. **통계적·기계학습적 해석 경계 준수**:
   - 모델 아키텍처의 내부 연산 결과 및 평가지표는 원문에 명시된 통계적·계산적 정의 범위 내에서만 서술하며, 관찰 데이터나 합성 시뮬레이션의 범위를 넘어서는 경험적 확정 표현으로 확장하지 않는다.
3. **부정 표현·완곡 어조·분모 및 한계 보존**:
   - 한국어 원문에 명시된 부정 표현, 가능성·연관성 수준의 완곡 표현(hedging), 계획 분모(`n_planned`)·산출 분모(`n_scored`)·유보 인원(`n_abstain`)·관찰 마스크(`observed`) 등 조건부 평가 분모와 연구 한계 진술을 누락 없이 보존한다.
4. **수치·단위·서지 및 윤리 진술의 정확성 유지**:
   - 실행 캡슐 및 검산 도구에서 확인된 실험 수치, 신뢰구간, 물리적 단위 규모, 윤리 심의 비적용(`synthetic-only`) 진술을 임의로 변경하지 않으며, `evidence/reference_registry.json`에서 검증된 참고문헌 목록과 서지 정보를 일관되게 유지한다.
