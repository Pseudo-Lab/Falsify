# Workbench alpha.72 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.72 소스 스냅샷입니다.

- 소스 커밋: `6f48b92eb6b7e0bc310dd197d4c5231516e20d70`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.72
- 소스 파일 1,438개를 동기화합니다.
- 이 폴더에는 `INTEGRATION-SOURCE.json`과 이 문서만 저장소 소유 메타데이터로 남습니다.

이번 릴리스(`0.2.0-alpha.72`)는 **Agent-First 6차(Wave 11) 4개 축 1순위** 구현을 담고 있습니다:
1. **메타분석(PRISMA·Forest Plot 가중치·합산 효과·$Q$/$I^2$) & 다중 표 간 교차 감사 (`paper_meta_and_table_audit.py`)**: PRISMA 흐름 산술(`prisma_flow_mismatch`), 연구별 가중치 합(`meta_weight_sum_mismatch`), Cochran's $Q$/$I^2$ 정합성(`meta_heterogeneity_mismatch`), 역분산 합산 효과(`meta_pooled_effect_mismatch`), 표 간 표본수(`cross_table_sample_size_mismatch`) 정적 감사
2. **PDF 비가시 텍스트·프롬프트 인젝션 방어 & 서브패널·축 왜곡 포렌식 + `BLUE Evidence v0.4.1` (`paper_pdf_security_forensics.py`, `paper_figure_forensics.py`, `app/examples/evidence_blue_v041`)**: 은닉 텍스트(`hidden_pdf_text_layer`, 스캔 OCR 오버레이 면제)·프롬프트 인젝션(`prompt_injection_directive`) 감지, 복합 이미지 내 서브패널 복제(`composite_subpanel_duplicate`)·축 눈금 왜곡(`axis_scale_distortion`), `v0.3.1`–`v0.4.0` 불변 보존
3. **구조 보존형 `.xlsx`·`.ipynb` RED 변조기 & `L4` 의미론 플래너 + `RED Injector v0.4` (`paper_supplement_mutator.py`, `paper_red_mcp.py`, `paper_red_planner.py`, `app/examples/adversarial_red_v04`)**: `xlsx-cell`·`ipynb-cell` 무흔적 변조, `paper_red_mcp` `redBrief` 연결, `L4`(`D3`/`S1`/`D5`) 의미론 템플릿, `v01`–`v03` 불변 보존
4. **해시 기반 증거 캐시, 워크스페이스 전 센서 Triage & `SARIF 2.1.0`·스키마 카탈로그 (`paper_evidence_cache.py`, `paper_sarif_export.py`, `paper_mcp_workspace.py`)**: 정답·경로 비노출 `EvidenceCache`, `SARIF 2.1.0` 표준 리포트 내보내기 및 `falsify schemas` 계약 조회기
5. **다자간 `N×M` 아레나 토너먼트(Bradley-Terry/Elo), 이종 BLUE 앙상블 합의기, 캠페인 `--resume` & 32케이스 벤치마크 `v4` (`arena_tournament.py`, `blue_ensemble.py`, `arena_campaign.py`, `benchmark_suite.py`)**: 라운드로빈 Pareto 리더보드, 분열 판정 `확인필요` 보존 합의기, 체크포인트 재개, 18 Gold + 14 Benign-Trap Holdout 총 32케이스(`corpusVersion: "v4"`)

이 브랜치는 Workbench 코드를 수정하며, 상위 저장소의 다른 코드나 실험 자료로 대체하지 않습니다. 라이선스와 설치 안내는 스냅샷에 포함된 upstream 문서를 따릅니다.
