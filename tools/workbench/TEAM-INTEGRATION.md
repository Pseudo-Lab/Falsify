# Workbench alpha.65 소스 동기화

`tools/workbench`는 `Shinick-Han/falsify-workbench`의 0.2.0-alpha.65 소스 스냅샷입니다.

- 소스 커밋: `50bbe19ad4ae93833c4e7ffd915bef2a3c8e00ec`
- 공개 웹: https://shinick-han.github.io/falsify-workbench/
- 설치 ZIP: https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.65
- 소스 파일 1,332개를 동기화합니다.
- 이 저장소의 `INTEGRATION-SOURCE.json`과 이 문서는 팀 통합 메타데이터로 유지합니다.

이번 버전(`0.2.0-alpha.65`)은 경찰과 도둑(BLUE·RED·아레나) 3개 축 1순위 6개 고도화와 로컬 companion HTTP `supplement_audit` 보완을 포함합니다:
1. **BLUE 다중 파일 번들 교차 검증**: 본문 PDF와 보충자료(`Supplementary PDF/DOCX/CSV/JSON/코드·로그`) 동시 투입, 고아 보충 인용(`Table S*`/`Fig. S*`), 파일 간 표본수(`N=`) 및 핵심 수치 모순 정밀 감사
2. **BLUE 심층 통계·임상 포렌식**: `SPRITE` 유계 분포 타당성, 2×2 분할표(`a/N1 vs c/N2`) 정확 Fisher `p`·`χ²`·비보정 `OR/RR`(`aOR/aRR` 예외 처리), Kaplan-Meier `No. at risk` 단조 감소 위반 정적/오프라인 감지
3. **BLUE 외부 오라클(`P2`) 철회 문헌 & 사전등록·기탁번호 검증**: Crossref·Europe PMC 철회(`Retracted`) 및 우려 표명(`EoC`) 논문 인용 감지와 `OSF`·`PROSPERO`(`CRD420...`)·`GEO`(`GSE...`)·`PDB` 구문 및 공개 레코드 검증
4. **RED 원본 사전 결함 스캔(Baseline Guard) & 무손실 PDF `/URI` 링크 변조기**: 주입 전 기존 Layer 0 결함 충돌 경고 및 시각 픽셀 무변화 `/URI` 하이퍼링크 은밀 변조(`W5 D2-1·D2-3`)
5. **아레나 다자 평가자 일치도(`Krippendorff's α`) & `확인필요` 선택적 예측(`Risk-Coverage / AURC`)**: 명목/서열 α와 보류율·선택적 정확도·보류 순이득(`Abstention Gain`)·`AURC` 정식 산출

이 브랜치의 Workbench 경로만 갱신하며 공식 프로젝트의 다른 코드와 연구 자료는 유지합니다. 라이선스와 설치·실행 절차는 포함된 upstream 문서를 따릅니다.
