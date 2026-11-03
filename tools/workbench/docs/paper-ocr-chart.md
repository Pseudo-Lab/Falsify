# 논문 OCR·그래프 읽기

BLUE의 **자동 실행·도구 설정 → 스캔·그래프 읽기**에서 사용합니다. PC companion 연결이 필요합니다.

1. PDF를 넣습니다. 텍스트가 없는 스캔 PDF도 열 수 있습니다.
2. 쪽을 골라 **글자 읽기 (OCR)**를 누릅니다. 영어·한국어를 선택할 수 있습니다. 판독문과 표의 행·열·병합 셀을 준비합니다.
3. 그래프는 미리보기에서 축과 범례를 포함해 한 영역을 드래그하고 **그래프를 표로 읽기**를 누릅니다.
4. 눈금을 읽지 못했으면 **축·곡선 지정**을 펼칩니다. X1·X2·Y1·Y2를 원본에서 찍고 값을 입력한 뒤, 곡선 색을 고르고 **보정해서 다시 읽기**를 누릅니다.
5. 원본과 결과를 대조합니다. JSON·CSV로 받거나 그대로 BLUE 검토를 진행합니다.

OCR은 현재 쪽 전체를 읽습니다. 그래프는 선택한 영역을 읽습니다. 원본 PDF·편집본은 바꾸지 않습니다. 생성 데이터는 원본 파일 해시·쪽·영역·입력 이미지 해시·엔진/모델에 연결되며 companion 메모리에 임시 보관됩니다. 전체 문서 OCR을 자동 시작하지 않습니다.

## 설치

개발 소스에서 한 번 실행합니다. 일반 companion 의존성과 모델 실행 환경은 분리됩니다.

```sh
python app/local/setup-paper-analysis.py
```

별도 가상환경에 RapidOCR 3.10.0, img2table 2.0.0, OpenCV contrib, Kiwi와 MiniRacer를 설치합니다. PlotTracer 2.6.0과 WebPlotDigitizer의 고정된 JavaScript 계산 모듈을 실행합니다. 첫 OCR 실행 시 선택 언어의 공개 모델을 받습니다. API 키는 필요하지 않습니다. 기존 DePlot 어댑터를 별도로 쓰는 경우만 `--with-deplot`을 추가합니다.

분석은 요청할 때 자식 프로세스에서 실행하며, 완료·취소 시 종료합니다. Windows 명령 창을 띄우지 않습니다. 그래프 좌표 계산은 로컬에서 수행합니다.

## 에이전트 MCP

기존 네 도구를 유지합니다. 모델 도구는 `--analysis`로 추가합니다.

```sh
python app/local/paper_mcp.py --pdf /absolute/path/paper.pdf --analysis
```

`initialize.instructions`에서 바인딩된 `paperId`와 파일 해시를 읽습니다. 추가 도구는 `list_analyses`, `read_analysis`, `ocr_page`, `extract_chart`, `digitize_points`입니다. 도구로 다른 파일이나 URL을 열 수 없습니다. OCR·그래프 결과는 native PDF 셀과 별도로 저장됩니다.

`ocr_page`는 쪽·영역·언어를 지정합니다. 여러 쪽은 에이전트가 필요한 쪽을 순서대로 호출합니다. `extract_chart`는 기존 OCR로 눈금을 찾고, PDF에 남아 있는 곡선 경로나 이미지의 선을 좌표로 읽습니다. 벡터 곡선은 PyMuPDF로 읽고, 이미지 곡선은 PlotTracer와 WebPlotDigitizer의 고정된 계산 모듈을 사용합니다. 선형·로그 축을 따로 보정하고, 이중 축은 눈금과 곡선의 색으로 연결합니다. 축을 하나로 정할 수 없으면 양쪽 값 후보를 남깁니다. 눈금이 부족하면 빈 부분 결과를 반환하고 보정을 기다립니다. `numericCells.origin`은 픽셀 측정이면 `pixel-calibrated`, PDF 경로이면 `pdf-vector-calibrated`, 보간한 점이면 `curve-interpolated`입니다. 곡선 샘플은 평균이나 신뢰구간으로 자동 분류된 값이 아닙니다.

`extract_chart`에 `chartOptions`를 주면 지정한 축·색으로 다시 추출합니다. `render_region`을 같은 `bbox`, 반환된 `inputImage.dpi`로 호출한 이미지에 좌표를 찍습니다. 형식은 `{imageSha256, calibration:{x:...,y:...}, series:[{id:"curve-1",color:"#1f77b4",name:"대조군"}], plotBbox?:[x0,y0,x1,y1]}`입니다. `calibration`은 아래 `digitize_points`와 같으며 `imageSha256`이 다르면 적용하지 않습니다. 원본 픽셀·PDF 좌표·보정 출처·엔진 커밋을 결과에 보존합니다.

자동 눈금 읽기를 직접 보정하려면 `render_region`으로 원본을 보고 `digitize_points`로 보정할 수 있습니다. 이 도구는 각 축의 눈금 두 개와 점을 이미지 픽셀로 받아 계산합니다.

```json
{
  "paperId": "initialize에서 받은 값",
  "pageIndex": 0,
  "imageSha256": "render_region의 sha256",
  "bbox": [0, 0, 300, 300],
  "dpi": 120,
  "calibration": {
    "x": {"scale": "linear", "points": [{"pixel": 100, "value": 1}, {"pixel": 400, "value": 4}]},
    "y": {"scale": "log", "points": [{"pixel": 400, "value": 10}, {"pixel": 100, "value": 1000}]}
  },
  "points": [[250, 250]]
}
```

이 예의 계산 결과는 `(2.5, 100)`입니다. 이미지의 왼쪽 위가 `(0,0)`이고 y는 아래로 증가합니다. `bbox`·`dpi`는 먼저 받은 원본 이미지와 같아야 합니다. 픽셀 반 칸에 따른 값 구간과 PDF 좌표도 남깁니다. 눈금·점·축 종류 선택의 정확성을 이 계산이 대신 검증하지는 않습니다.

## 확인한 범위

아래 OCR·곡선 오차 수치는 기존 어댑터의 회귀 기록입니다. PlotTracer 통합 검사는 alpha.45 릴리스 기록에서 구분합니다. 수동 보정의 기본 추출 범위는 선택한 축 눈금 사이이며, MCP의 `plotBbox`로 이미지 픽셀 범위를 지정할 수 있습니다.

- 실제 영문 스캔 표: 10개 문자열·3×3 셀 복원. 저대비 이미지도 같은 결과.
- 90·180·270도 회전한 표에서도 같은 문자열·셀 순서를 복원하고 좌표는 원본 이미지로 되돌림.
- 한국어 판독문은 원문 문자열 `text`와 띄어쓰기를 보완한 `displayText`를 함께 제공합니다. 문자·숫자는 바꾸지 않습니다. Kiwi의 문장 띄어쓰기와 OCR 문자 상자의 실제 간격을 사용하며, 원 판독문은 화면에서 펼쳐 볼 수 있습니다. Windows 격리 프로세스의 한국어 응답도 UTF-8로 전달합니다.
- 실제 막대 그래프: 24·48·36 복원. 선형 꺾은선: 10·20·40·80 복원.
- 선형·로그·이중 선형·이중 로그 축의 색상 곡선을 실제 OCR과 픽셀 계산으로 확인했습니다. 로그·이중 로그 테스트의 상대 오차는 약 0~3%였습니다. 이는 해당 합성 이미지의 측정 결과입니다. 흑백 곡선 보정, 잘못 읽은 눈금 제외, 축 연결이 모호한 경우도 회귀 검사합니다. 원 눈금·제외한 눈금·입력 픽셀·PDF 위치와 픽셀 폭에 따른 값 구간을 보존합니다.

같은 색의 곡선도 분리해 각 `series-N`으로 표시합니다. 눈금 사이의 꺾임·봉우리·골짜기를 포함해 선을 따라 표본을 고릅니다. JSON에는 색상, 원본 픽셀·PDF 좌표, 끊긴 구간과 표본 축약 오차를 함께 남깁니다. 교차점에서 어느 선인지 구분하지 못하면 그 부분을 합친 값으로 만들지 않고 `curve-junction-ambiguous`로 표시합니다.

이미지 곡선은 구조에 따라 PlotTracer `findLines`, WebPlotDigitizer Step·XStep을 선택합니다. 단일 곡선의 중심선을 읽되 교차·고리·오차막대는 경로 구조를 유지합니다. 선택한 색과 실제 사용한 색, 추출 경로, 측정점·보간점의 출처를 함께 기록합니다. 추출한 선은 원래 경로 순서를 유지하며 0.75px 기준으로 축약합니다. PDF에 원본 벡터가 있으면 선·3차 곡선의 명령과 색·두께·점선 정보를 함께 남깁니다. 3차 곡선의 표시용 표본은 0.25px 기준으로 나누고, 원래 제어점은 별도로 유지합니다. 원본 경로 위에 교체 이미지가 있으면 화면에 보이는 픽셀 결과를 사용합니다. `sourcePoint`는 기존 페이지 좌표계(`page.rect`)이며, `sourcePagePoint`와 `sourceStroke.commands`는 회전 전 원본 경로 좌표입니다.

벡터·이미지를 합친 전체 표본은 최대 480개이며, 이 안에서 오차 기준이나 끊긴 구간을 유지하지 못하면 `sampling-point-limit`와 `partial`을 기록합니다. BLUE의 텍스트에는 좌표 표와 축·곡선 출처 요약을 전달합니다. 중복된 `numericCells`와 전체 `geometry` 복사를 생략하며, MCP 조회·JSON 다운로드의 전체 분석 기록은 유지합니다.

합성 PDF를 실제 OCR→MCP 경로로 검사했습니다. 같은 색 두 곡선의 기준값 10·7.071은 각각 약 10.31·7.29로 분리됐고, 눈금 사이 세 봉우리의 기준값 80은 약 80.35로 복원됐습니다. 이는 두 재현 사례의 결과이며 일반적인 오차 보장은 아닙니다. 수정 코드와 검사 기록은 [G01·G02 수정 기록](chart-defect-rca-20261103.md)에 있습니다. 공개 웹·설치본 적용 여부는 해당 기록에서 구분합니다.

손글씨·복잡한 수식·중첩 패널·촘촘한 범례·복잡한 교차 곡선은 추가 검토가 필요합니다. 자동 축 보정은 눈금이 읽히는 직교 좌표 그래프를 대상으로 합니다. 픽셀 구간은 OCR·축 선택의 불확실성까지 나타내는 신뢰구간이 아닙니다. `ready`는 데이터 형식이 준비됐다는 뜻이며 정답 판정이 아닙니다. 모델 원문·판독문·원본 위치를 남겨 재검토할 수 있게 합니다.

사용한 구성: [PlotTracer](https://github.com/katalystnord/plottracer), [RapidOCR](https://github.com/RapidAI/RapidOCR), [img2table](https://github.com/xavctn/img2table), [DePlot](https://huggingface.co/google/deplot), [Kiwi](https://github.com/bab2min/kiwipiepy). 축 보정은 [WebPlotDigitizer의 XY 보정 방식](https://www.automeris.io/docs/digitize/)과 같은 선형·로그 보간을 사용합니다. [WebPlotDigitizer 포크](https://github.com/Shinick-Han/WebPlotDigitizer)의 Step·XStep 계산 모듈만 가져와 기존 MCP에 연결했습니다. 원본 모듈의 커밋·해시·라이선스를 빌드에 포함하며 별도 GUI는 실행하지 않습니다.
