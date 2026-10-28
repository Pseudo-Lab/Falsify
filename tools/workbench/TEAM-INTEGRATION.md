# Falsify Paper Workbench 0.2.0-alpha.24

이 폴더는 웹앱의 공개 소스와 한국어 사용 설명서입니다. 팀의 논문·연구 계획·평가 기준은 변경하지 않습니다.

- 웹앱: https://shinick-han.github.io/falsify-branch-preview/
- 사용 설명서: https://shinick-han.github.io/falsify-branch-preview/guide.html
- 공개 앱: https://shinick-han.github.io/falsify-workbench/
- 소스: https://github.com/Shinick-Han/falsify-workbench/tree/1438c7570b9f08a7ef6a248e618c45ad5624bfb5

RED에 PDF를 넣고 문단을 클릭하거나 글자를 드래그해 수정할 수 있습니다. 미리보기와 다운로드는 같은 생성 파일을 사용합니다. 전체 논문 재조판은 본문과 그림을 새 흐름으로 배치하므로 원본과 쪽수·배치가 달라질 수 있습니다. 기본 PDF 작업은 브라우저에서 실행하며, CLI 모델 실행과 일부 편집 기능은 각자의 PC companion을 사용합니다.

팀 서랍에서 하네스를 열고 **사용**을 누르면 RED 또는 BLUE에 선택됩니다. BLUE Evidence v0.3.5는 **이 PC에 BLUE 준비 후 사용**으로 실행 소스를 준비합니다. 실험 기록은 사용자가 **팀에 공개**를 누르면 Confluence에 저장됩니다.

## 설치와 검사

이 브랜치를 내려받은 뒤 `tools/workbench`에서 Windows는 `start-companion.ps1`를 실행합니다. macOS/Linux는 `docs/local-companion.md`의 가상환경 설치와 서버 실행 순서를 따릅니다. 상세 설치 조건은 `app/dist/guide.html`, `docs/local-companion.md`를 참고하세요. 두 Pages 앱은 같은 GitHub origin을 사용하므로 같은 브라우저 프로필에서는 저장 공간을 공유합니다.

앱 검사는 `app`에서 `node scripts/test.mjs`, Python 검사는 저장소 루트에서 `python -m unittest discover -s app/tests -p 'test_*.py'`로 실행합니다. 선택 기능의 의존성과 실행 조건은 각 문서에 있습니다.

## 포함 범위

애플리케이션 스냅샷은 `1438c7570b9f08a7ef6a248e618c45ad5624bfb5`이며 사용 설명서도 같은 커밋의 파일입니다. AGPL-3.0-only와 vendor별 LICENSE/NOTICE를 유지합니다. 패치된 브라우저 편집 WASM, Typst WASM과 공개 글꼴은 해당 고지와 함께 포함합니다. 사적인 논문·변경본·정답지·실험 응답·자격 증명·로컬 환경은 포함하지 않습니다. 이 라이선스는 팀 저장소 전체의 라이선스를 바꾸지 않습니다.

중첩된 `.github/workflows`는 원본 앱의 CI 템플릿이며 팀 저장소 루트의 워크플로를 설치하지 않습니다. 미리보기는 별도의 개인 저장소에서 배포합니다. 출처는 `INTEGRATION-SOURCE.json`에 기록합니다.
