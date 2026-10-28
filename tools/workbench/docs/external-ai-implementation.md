# 외부 AI 작업 흐름 구현 기록

2026-10-28 · WorkBite T-0152 · 0.2.0-alpha.28

## 구현한 동작

RED와 BLUE에서 논문을 입력하고 외부 AI의 답변을 붙여넣거나 JSON·TXT·Markdown 파일로 가져온다. 앱에서 요청을 만들거나 PC를 연결할 필요 없이 사용할 수 있다. 원문·Harness를 포함한 프롬프트 만들기는 선택 기능이다.

답변을 계속 추가하고 항목별 체크로 반영한다. 원응답과 출처를 보존하며, 위치가 불명확한 항목은 나중에 원문에 연결한다. 겹치는 RED 수정안은 하나만 선택되고, 사용자가 새 결합안을 작성할 수 있다. 숫자·인용·제목·본문 변경과 삭제를 받는다.

체크와 편집은 자동 미리보기로 이어진다. 생성 키·취소·캐시로 오래된 출력의 역전을 막고 입력창의 포커스를 유지한다. 다운로드와 BLUE 인계는 클릭 시점의 편집을 반영한 파일을 사용한다. BLUE에는 생성 PDF의 추출문만 전달하며 모델을 자동 실행하지 않는다.

명시적으로 기록한 외부 응답은 결과 기록에서 열어 별도 검수 화면에서 평가한다. 원응답은 접힌 상세에 있다. 팀 공개는 Confluence 저장을 직접 실행할 때 수행한다. 원격 기록은 임시 열람하며 기존 로컬 기록과 백업을 유지한다.

로컬 RED도 공격 유형을 복수 선택한다. 유형 집합을 기록·백업·보관·비교 조건에 보존하고 이전 L1~L3 기록을 읽는다.

## 검증

- 전체 `app/npm test` 통과. 신규 교환 파서·제안·자동 생성·작업대·보관·통합 검사를 기존 실행 경로 검사와 함께 실행했다.
- RED Python 서비스 검사 22개 통과.
- Cloudflare API 검사 52개 및 Wrangler dry run 통과.
- Aside 실제 브라우저에서 합성 PDF의 `120 → 121`, `120 → 122` 대안을 가져와 선택을 전환했다. 바로 다운로드한 1,394바이트 PDF에 `122`가 반영됐고 BLUE 입력 파일 해시가 다운로드 해시와 일치했다. 변경하지 않은 두 번째 페이지 문구도 보존됐다.
- 독립 BLUE에 위치 없는 두 지적을 가져와 하나를 선택·기록했다. 결과 기록에서 검수 화면을 열어 두 지적과 출처를 확인하고 검수 의견을 저장했다. 원응답 상세는 닫힌 상태였다. 합성 기록을 팀에 공개하지 않았다.
- 실제 36쪽 논문에서 7쪽 한 문구를 변경했다. 출력 36쪽 유지, 별도 PyMuPDF 렌더링에서 나머지 35쪽 동일, 변경 문구 추출 확인. 원문과 검증 산출물은 로컬에만 보관했다.
- 작업자 별도 브라우저 검사에서 제안 입력값과 포커스가 실제 자동 PDF 생성 후 유지되는 것을 확인했다.

전체 앱 검사 중 과거 단일 공격 단계·기존 가져오기 버튼명에 결합된 테스트를 현재 UI 계약에 맞췄다. 저장 형식과 PDF 결과 검사는 유지했다.

## 검증 범위와 후속 항목

외부 AI/유료 모델을 호출하지 않은 기능 검사다. 실제 모델의 탐지 성능은 별도 실험으로 평가한다. 입력 반응 100ms 목표의 기기별 계측, 실제 운영 Confluence의 외부 응답 저장·재열람, macOS 실제 사용자 환경의 이번 전체 흐름은 추가 확인 대상이다.

그림 교체와 표 구조 변경의 외부 응답 계약, 전체 논문 재조판 확대는 후속 범위다. 기존 PDF 편집·그림·표 기능은 유지한다. 시도 기록의 과거 형식에는 복합 공격 유형이 없으므로 그 기록을 복합 조건의 시도 합계로 간주하지 않는다.

스펙 기준은 [North Star](NORTH_STAR_EXTERNAL_AI.md), 기술 계약은 [external-ai-contract.md](external-ai-contract.md)다. North Star 적용 대상은 Falsify orchestrator이며 작업자에게는 개별 작업 지시를 전달한다.

## 배포 결과

- 공개 앱: https://shinick-han.github.io/falsify-workbench/?v=0.2.0-alpha.28
- 공개 소스: `65770a9f8cd314cc8945464529ce117cca9677eb` ([PR 34](https://github.com/Shinick-Han/falsify-workbench/pull/34)).
- [GitHub 검사·배포](https://github.com/Shinick-Han/falsify-workbench/actions/runs/40636080719): Linux, Windows launcher, macOS ARM/Intel 및 Pages 모두 성공.
- [소스 릴리스](https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.28): 고정 런타임·라이선스·파일 해시 검증 후 패키징.
- Cloudflare `falsify-cloud-api`: 버전 `6f580c48-9bfa-4be0-8e70-5f7860ccd5fe`. 배포 후 Confluence capabilities의 configured=true 확인.
- 로컬 설치: 변경 53개 파일을 이전 릴리스 바이트와 대조·백업 후 교체. 유휴 companion 재시작, 인증된 capabilities에서 alpha.28 및 RED/BLUE 활성 확인.
- 팀 저장소: 기존 `feat/workbench-html-guide-20261012` 브랜치의 `9023f71`. 미리보기 저장소 `ee0ea35`, Pages 배포 성공. 팀 main은 수정하지 않았다.
- 공개 웹을 Aside로 열어 자산 버전 alpha.28, 외부 RED/BLUE UI, 공격 유형 체크박스 3개 확인.

합성 문서 한 번의 브라우저 계측에서 선택 변경 핸들러는 1.2ms였다. 별도 표본의 다음 프레임 대기는 728.2ms로, 입력 처리와 그리기 대기를 구분한 추가 측정이 필요하다. 이 수치는 전체 UI가 100ms 이내라는 보장이 아니다.
