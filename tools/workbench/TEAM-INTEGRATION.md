# Workbench alpha.70 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.70 소스 스냅샷입니다.

- 소스 커밋: `f5556be071e4ad7c83854c1210c72f2fb9ad1243`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.70
- 소스 파일 1,398개를 동기화합니다.
- 이 폴더에는 `INTEGRATION-SOURCE.json`과 이 문서만 저장소 소유 메타데이터로 남습니다.

이번 릴리스(`0.2.0-alpha.70`)는 **Agent-First 4차 4개 축 1순위** 구현을 담고 있습니다:
1. **BLUE 환자 흐름(CONSORT) 산술 감사 & 의미론적 스핀 단서 분리 (`paper_flow_and_spin_triage.py`, `paper_blue_sensor.py`, `paper_mcp.py`)**: `Screened − Excluded = Randomized`, 군 배정 합계, 추적 탈락·분석 대상, 기저 표 하위집단 분모(`k/n`, 결측 각주 면제)와 범주 합계 감사(`signals`) 및 비무작위·유의성 미달 인과 단정(`D3`)·극성 역전(`S1`) 분리 단서(`triageHints`, `advisoryOnly: true`)
2. **코드 보충자료 정적 AST 감사 & 포터블 `BLUE Evidence v0.3.9` (`paper_code_audit.py`, `app/examples/evidence_blue_v039`)**: 무실행 정적 분석(`.py`/`.R`/`.Rmd`/`.sql` 단측·양측 불일치, 분할 전 전처리 누수, 임계값 불일치, 미고지 행 필터링) + 타이포그래피 인용 폴딩·Zero-Drop 복원·1회 수리 게이트(`v0.3.1`–`v0.3.8` 불변)
3. **RED 다표면(`L3`/`L4`) 연쇄 변조 플래너 & 포터블 `RED Injector v0.2` (`paper_red_planner.py`, `app/examples/adversarial_red_v02`)**: `falsify red plan`, `red apply --out-supplement-dir`, 변조 PDF+보충자료 맹검 번들 및 봉인 `falsify.red-gold-ledger.v1` 산출(`adversarial_red_v01` 불변)
4. **PDF 타이포그래피 인용 폴딩·수리 팩 & 다중 문서 배치 선별 (`blue_report_validate.py`, `paper_mcp_workspace.py`, `falsify_cli.py`)**: 합자·줄바꿈 하이픈·마이너스·스마트 따옴표·`µ`/`μ` 정규화 및 `--emit-repair-pack`(`falsify.quote-repair-pack.v1`), 논문별 보충자료 자동 결합·`triage_workspace`(`falsify blue scan-workspace`), `mcp-config --role red|both --supplement`
5. **무인 다세대 공진화 캠페인 & 18케이스 벤치마크 v2 (`tools/evaluation/arena_campaign.py`, `tools/evaluation/benchmark_suite.py`)**: `falsify arena evolve`(세대 상한 `<= 3`, Holdout 순수 오탐 무증가 가드) 및 11 Gold + 7 Benign-Trap Holdout 총 18케이스 회귀 벤치마크(`falsify.benchmark-report.v2`)

이 브랜치는 Workbench 코드를 수정하며, 상위 저장소의 다른 코드나 실험 자료로 대체하지 않습니다. 라이선스와 설치 안내는 스냅샷에 포함된 upstream 문서를 따릅니다.
