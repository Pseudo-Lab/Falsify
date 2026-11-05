# Falsify Paper Workbench 0.2.0-alpha.51

이 폴더는 Workbench의 공개 소스와 한국어 사용 설명서입니다.

- [웹앱 열기](https://shinick-han.github.io/falsify-workbench/?v=0.2.0-alpha.51&release=c490db0#red)
- [사용 설명서](https://shinick-han.github.io/falsify-workbench/guide.html)
- [alpha.51 릴리스와 다운로드](https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.51)
- [고정된 원본 소스](https://github.com/Shinick-Han/falsify-workbench/tree/c490db0c1c09eed9ad2be936ccd087b78a187c1d)

RED와 BLUE에서 논문을 넣고 외부 AI의 응답을 가져오거나, 각자의 PC companion과 CLI 로그인을 연결해 실행합니다. PDF 글자를 클릭하거나 드래그해 고치고 생성본을 받거나 BLUE에 전달할 수 있습니다. 팀에 공개한 하네스와 기록은 Confluence에 보관합니다.

표 셀·그림 영역·그래프 값을 편집하고 변경 PDF를 만들 수 있습니다. 그래프 읽기는 PDF 원본 경로와 고정 WebPlotDigitizer·PlotTracer 계산 모듈을 사용합니다. **스캔·그래프 읽기**를 펼치고 축·곡선을 포함해 영역을 드래그한 뒤 **그래프를 표로 읽기**를 누릅니다. 필요하면 **축·곡선 지정**으로 보정하고, 읽은 값을 고친 뒤 **PDF에 적용**합니다. [alpha.51 변경 내용과 검사 범위](https://github.com/Shinick-Han/falsify-workbench/releases/tag/v0.2.0-alpha.51)를 참조하세요.

## 내려받기와 실행

```sh
git clone --branch feat/workbench-html-guide-20261012 https://github.com/Pseudo-Lab/Falsify.git
cd Falsify/tools/workbench
```

Windows는 `start-companion.ps1`, macOS/Linux는 [로컬 companion 안내](docs/local-companion.md)를 따릅니다. 브라우저 PDF 편집과 외부 응답 가져오기는 PC 연결 없이 사용할 수 있습니다. OCR·그래프 도구 설치는 [별도 안내](docs/paper-ocr-chart.md)를 확인하세요.

앱 검사는 `app`에서 `npm ci --ignore-scripts` 후 `npm test`로 실행합니다. Python 검사는 이 폴더에서 `python -m unittest discover -s app/tests -p 'test_*.py'`로 실행합니다.

## 출처와 포함 범위

애플리케이션 파일과 실행 권한은 공개 커밋 `c490db0c1c09eed9ad2be936ccd087b78a187c1d`과 동일합니다. 이 안내와 `INTEGRATION-SOURCE.json`은 팀 브랜치의 추가 파일입니다. 기존 branch-preview 배포는 별도이며 위 웹앱 링크가 공개 배포를 가리킵니다.

AGPL-3.0-only와 vendor별 LICENSE/NOTICE를 유지합니다. 브라우저 편집기·Typst·BusyTeX WASM과 공개 글꼴을 해당 고지와 함께 포함합니다. 논문·정답지·실험 응답·자격 증명·로컬 환경은 포함하지 않습니다. 중첩된 `.github/workflows`는 원본 앱의 CI 템플릿이며, 팀 저장소 루트와 `main`은 이번 소스 동기화에서 변경하지 않습니다.
