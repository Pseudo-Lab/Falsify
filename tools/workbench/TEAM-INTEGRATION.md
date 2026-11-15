# Workbench alpha.69 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.69 소스 스냅샷입니다.

- 소스 커밋: `f5cc5fd4a2d8e81e6e8335d472b067e3cf8f58ed`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.69
- 소스 파일 1,379개를 동기화합니다.
- 이 폴더에는 `INTEGRATION-SOURCE.json`과 이 문서만 저장소 소유 메타데이터로 남습니다.

이번 릴리스(`0.2.0-alpha.69`)는 **Agent-First 3차 4개 축 1순위** 구현을 담고 있습니다:
1. **BLUE 원자료 행 단위 재계산 & MCP 그림 포렌식 (`paper_raw_dataset_audit.py`, `paper_mcp.py`, `paper_mcp_bundle.py`)**: 첨부 `.csv/.tsv/.json` 원자료의 `N`·결측 제외 `n`·집단별 `mean ± SD`·`median [IQR]`·`k/n (%)`·이표본 `t`·2×2 Fisher/카이제곱 `p` 재계산(다변량 `aOR`/`aRR`/`aHR` 및 `FDR`/`Bonferroni` `p_adj` 면제), 읽기 전용 MCP `recompute_raw_supplement`·`audit_figures`, `falsify blue scan --recompute-raw --figure-forensics`
2. **포터블 `BLUE Evidence v0.3.8` (`app/examples/evidence_blue_v038`)**: 동결된 `v0.3.1`–`v0.3.7` 보존, 원자료 재계산 Triage 다이제스트 주입 + 모델 후 Zero-Drop 복원·인용구 검증(최대 1회 수리 후 미검증 인용 `확인필요` 강등)
3. **RED 난이도 사전 게이트 & 포터블 `RED Injector v0.1` (`falsify_cli.py`, `app/examples/adversarial_red_v01`)**: `falsify red simulate|trace`, `red apply --min-difficulty L1|L2|L3|L4`(기준 미달 시 파일 미생성·종료 코드 `3`), 자율형 맹검 번들 + 봉인 `falsify.red-gold-ledger.v1` 산출
4. **보충자료 포함 인용 게이트 & 역할별 MCP 구성 (`blue_report_validate.py`, `falsify_cli.py`)**: `falsify blue validate --supplement PATH ...` 다중 보충자료 인용 실존 대조·`nearestCandidates`(금지 RED 키 종료 코드 `3`), `falsify mcp-config --workspace DIR --role blue|red|both`
5. **무인 RED-vs-BLUE 대결·패치 승격 가드 & 10케이스 회귀 벤치마크 (`tools/evaluation/arena_duel.py`, `tools/evaluation/benchmark_suite.py`)**: `falsify arena duel`, 세대 상한(`<= 3`)·Holdout 순수 오탐 증가 롤백 가드(`falsify arena apply-patch`, 종료 코드 `3`), 6 Gold + 4 Benign-Trap Holdout 회귀 벤치마크(`falsify arena benchmark`, 회귀 시 종료 코드 `3`)

이 브랜치는 Workbench 코드를 수정하며, 상위 저장소의 다른 코드나 실험 자료로 대체하지 않습니다. 라이선스와 설치 안내는 스냅샷에 포함된 upstream 문서를 따릅니다.
