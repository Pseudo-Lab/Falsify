# Falsify Paper Workbench 0.2.0-alpha.42

이 폴더는 Workbench의 공개 소스와 한국어 사용 설명서입니다.

- [웹앱 열기](https://shinick-han.github.io/falsify-workbench/?v=0.2.0-alpha.42&release=3d76441#red)
- [사용 설명서](https://shinick-han.github.io/falsify-workbench/guide.html)
- [alpha.42 릴리스와 다운로드](https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.42)
- [고정된 원본 소스](https://github.com/Shinick-Han/falsify-workbench/tree/3d76441877138fe8900d6419470284ad89df474a)

RED와 BLUE에서 논문을 넣고 외부 AI의 응답을 가져오거나, 각자의 PC companion과 CLI 로그인을 연결해 실행할 수 있습니다. PDF의 글자를 클릭하거나 드래그해 수정하고, 생성본을 다운로드하거나 BLUE에 전달합니다. 팀에 공개한 하네스와 기록은 Confluence에 보관합니다.

alpha.42는 AI 배치 실행의 저장 순서, 취소, 실패 후 요청 조회와 실행 영수증 보존을 개선합니다. 긴 원문·기하 정보·자산 목록을 나눠 읽고, 잘못된 도구 명령은 단계 예산 안에서 정정할 수 있습니다. 전체 논문 재조판의 배치 품질은 해당 문서의 결과를 확인하세요. [변경 내용과 검사 범위](docs/layout-pattern-repairs-20261101.md)에 상세 기록이 있습니다.

## 내려받기와 실행

```sh
git clone --branch feat/workbench-html-guide-20261012 https://github.com/Pseudo-Lab/Falsify.git
cd Falsify/tools/workbench
```

Windows는 `start-companion.ps1`, macOS/Linux는 [로컬 companion 안내](docs/local-companion.md)를 따릅니다. 브라우저 PDF 편집과 외부 응답 가져오기는 PC 연결 없이 사용할 수 있습니다. 소스 ZIP·Python·선택 도구의 설치 조건은 사용 설명서에서 확인하세요.

앱 검사는 `app`에서 `npm ci --ignore-scripts` 후 `npm test`로 실행합니다. Python 검사는 이 폴더에서 `python -m unittest discover -s app/tests -p 'test_*.py'`로 실행합니다. 선택 기능의 의존성은 각 문서에 있습니다.

## 출처와 포함 범위

애플리케이션 파일과 실행 권한은 공개 커밋 `3d76441877138fe8900d6419470284ad89df474a`와 동일합니다. 팀 통합 안내와 `INTEGRATION-SOURCE.json`은 이 브랜치의 추가 파일입니다. 기존 별도 branch-preview 배포와 이번 소스 동기화는 구분하며, 위 웹앱 링크는 최신 공개 배포를 가리킵니다.

AGPL-3.0-only와 vendor별 LICENSE/NOTICE를 유지합니다. 패치된 브라우저 편집 WASM, Typst·BusyTeX WASM과 공개 글꼴은 해당 고지와 함께 포함합니다. 논문·정답지·실험 응답·자격 증명·로컬 환경은 포함하지 않습니다. 중첩된 `.github/workflows`는 원본 앱의 CI 템플릿입니다. 팀 저장소 루트와 `main`은 이번 동기화의 변경 대상에 포함하지 않습니다.
