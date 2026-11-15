# Workbench alpha.67 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.67 소스 스냅샷입니다.

- 소스 커밋: `fe55b4be6ebed023b43fd5a47db39dadecb2af23`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.67
- 소스 파일 1,348개를 동기화합니다.
- 이 저장소의 `INTEGRATION-SOURCE.json`과 이 문서는 팀 통합 메타데이터로 유지합니다.

이번 버전(`0.2.0-alpha.67`)은 **Agent-First 4개 축 1순위 6개 과제**를 전면 통합합니다:
1. **차세대 BLUE MCP 서버 (`paper_mcp.py`, `paper_mcp_bundle.py`)**: 오프라인 `run_blue_sensor`(`digestOnly` 토큰 예산 모드), `--supplement` 다중 보충자료 조회·교차 감사(`list_supplements`, `read_supplement`, `audit_supplements`), `--oracle` 명시 설정 시 `verify_references`·`verify_registries` 제공
2. **자율형 `BLUE Evidence v0.3.7` 어댑터 (`app/examples/evidence_blue_v037`)**: 모델 호출 전 무비용 Layer 0 정적 포렌식(`SPRITE`/2×2/KM, `supp-*` 보충자료 교차 감사) + 확장 `P2` 철회·사전등록(`OSF`/`PROSPERO`/`GEO`/`PDB`) 다이제스트 자동 결합
3. **전양식(Full-Modal) 통합 RED MCP (`paper_text_span_mutator.py`, `paper_red_mcp.py`)**: 네이티브 PDF 본문 `text-span` 무흔적 변조(`list_text_spans`, `nearestCandidates` 자가 치유 힌트), `supplement-edit` 보충자료 변조, `Baseline Guard` 겹침 보고, 봉인된 `goldLedger` 분리 출력
4. **단일 헤드리스 에이전트 JSON CLI & 내장 스킬 (`falsify_cli.py`, `.agents/skills/falsify-blue-auditor`, `.agents/skills/falsify-red-injector`)**: `blue scan`, `red targets`, `red apply`, `blind verify`, `arena score` 정형 JSON stdout 및 종료 코드 계약(`0`/`2`/`3`/`124`)
5. **헤드리스 상보적 진화 아레나 채점기 & 맹검 번들 검증기 (`tools/evaluation/arena_runner.py`)**: PDF DocInfo/XMP/주석/위젯·보충자료 맹검 검증(`verify_blind_bundle`) 및 1:1 이분 매칭·`Baseline Guard` 면제·`W1-W5`/`D1-D7`/`L1-L4` 층화 재현율·`stealthYield`·`Krippendorff's α`·`AURC`·`feedbackDigest` 산출(`evaluate_arena_match`)

이 브랜치의 Workbench 경로만 갱신하며 공식 프로젝트의 다른 코드와 연구 자료는 유지합니다. 라이선스와 설치·실행 절차는 포함된 upstream 문서를 따릅니다.
