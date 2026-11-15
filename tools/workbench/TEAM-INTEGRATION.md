# Workbench alpha.71 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.71 소스 스냅샷입니다.

- 소스 커밋: `a52a80ffafb22e9c66e27e2f6e2d369fccea5f81`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.71
- 소스 파일 1,416개를 동기화합니다.
- 이 폴더에는 `INTEGRATION-SOURCE.json`과 이 문서만 저장소 소유 메타데이터로 남습니다.

이번 릴리스(`0.2.0-alpha.71`)는 **Agent-First 5차 4개 축 1순위** 구현을 담고 있습니다:
1. **`.xlsx` 다중 시트 & `.ipynb`/`.Rmd`/`.qmd` 정적 로더·원자료·코드 감사 확장 (`paper_tabular_notebook_loader.py`, `paper_raw_dataset_audit.py`, `paper_code_audit.py`)**: 순수 표준 라이브러리 OpenXML `.xlsx` 수식(`<f>`) 대비 캐시(`<v>`) 불일치(`xlsx_formula_value_mismatch`) 및 `.ipynb` 비순차 실행(`notebook_out_of_order_execution`)·셀 출력 불일치(`notebook_output_prose_mismatch`) 정적 감사(무실행·XXE/ZIP-bomb 차단)
2. **논문 내부 IMRaD 섹션 간 정합성 센서 & 포터블 `BLUE Evidence v0.4.0` (`paper_internal_consistency.py`, `app/examples/evidence_blue_v040`)**: Abstract·Methods·Results·Tables 간 표본수 불일치(`abstract_results_sample_size_mismatch`)·지표 불일치(`abstract_results_effect_or_p_mismatch`)·프로토콜 드리프트(`methods_results_protocol_drift`)와 분리 단서(`triageHints`) 제공(`audit_internal_consistency`, `falsify blue scan --internal-consistency`, `v0.3.1`–`v0.3.9` 불변)
3. **벡터 차트(`chart-shape`) 3표면 RED 플래너·`redBrief` 폐루프 & 포터블 `RED Injector v0.3` (`paper_red_planner.py`, `app/examples/adversarial_red_v03`)**: 막대·산점·곡선 차트 기하 변조 결합 `L3`/`L4` 번들 합성 및 `--red-brief` 취약 결함군 우선 공략(`adversarial_red_v01`–`v02` 불변)
4. **원샷 `falsify blue finalize` 확정 게이트 & 3대 에이전트 스킬 동기화 (`blue_report_validate.py`, `.agents/skills/`)**: `.xlsx`/`.ipynb`/`.Rmd`/`.qmd` 인용 검증, 수리 반영 + Zero-Drop 복원 + 미검증 인용 `확인필요` 자동 강등 + 12열 CSV 산출, 신규 `falsify-arena-operator` 포함 스킬 완비
5. **교대 양방향(`role="both"`) 공진화·규칙 압축 & 24케이스 벤치마크 `v3` (`arena_campaign.py`, `arena_duel.py`, `arena_round.py`, `benchmark_suite.py`)**: `compact_harness_rules`(`--compact-rules`), `falsify arena evolve --role both` Pareto 비열화 승격(`finalBlueHarness` + `finalRedHarness`), 14 Gold + 10 Benign-Trap Holdout 총 24케이스 벤치마크(`corpusVersion: "v3"`)

이 브랜치는 Workbench 코드를 수정하며, 상위 저장소의 다른 코드나 실험 자료로 대체하지 않습니다. 라이선스와 설치 안내는 스냅샷에 포함된 upstream 문서를 따릅니다.
