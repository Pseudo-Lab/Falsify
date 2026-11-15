# Workbench alpha.68 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.68 소스 스냅샷입니다.

- 소스 커밋: `f3ac9ec3b45d6807510c98399d5003f553a17964`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.68
- 소스 파일 1,363개를 동기화합니다.
- 이 폴더에는 `INTEGRATION-SOURCE.json`과 이 문서만 저장소 소유 메타데이터로 남습니다.

이번 릴리스(`0.2.0-alpha.68`)는 **Agent-First 2차 4개 축 1순위** 구현을 담고 있습니다:
1. **BLUE 보충 표 재계산 & 그림 포렌식 (`paper_supplement_audit.py`, `paper_figure_forensics.py`)**: 보충 표 행·열 합계와 백분율 대 `N` 재계산, dHash/aHash 기반 패널 복제·좌우반전·회전·크롭 감지, 차트 인쇄값 대 본문 수치 불일치 후보(양쪽 bbox)
2. **RED 탐지 난이도 시뮬레이터 & 클레임 전파 (`paper_red_detectability.py`)**: 원본 대비 편집본 Layer 0 신호 차집합으로 `L1`–`L4` 교차 추론 거리·노출 위험 판정, 본문·표·그림·인용·보충자료 값 전파 추적
3. **전 오퍼레이션 자가 교정 오류 (`paper_red_errors.py`)**: 모든 변조 실패를 `{error, actualValue, nearestCandidates, bbox, recoveryHint}`로 통일하고 경로·`cwd` 비노출
4. **BLUE 리포트 검증 게이트 & 다중 문서 MCP (`blue_report_validate.py`, `paper_mcp_workspace.py`)**: `falsify blue validate`(인용 실존·Zero-Drop 복원·12열 CSV), `falsify mcp-config`, `paper_mcp.py --workspace DIR`(32편 상한, 정답 파일명 마스킹, `list_papers`/`select_paper`)
5. **무인 아레나 라운드 & 정답 비노출 증류 (`tools/evaluation/arena_round.py`)**: 맹검 누출 게이트 후 클린룸에서 임의 stdio 에이전트 실행·다중 라운드 채점, `falsify.harness-patch.v1` 규칙·차기 RED 브리프 증류(누출 시 `distill_scrub_failed`)

이 브랜치는 Workbench 코드를 수정하며, 상위 저장소의 다른 코드나 실험 자료로 대체하지 않습니다. 라이선스와 설치 안내는 스냅샷에 포함된 upstream 문서를 따릅니다.
