# 표·그림 근거 조회

BLUE에서 PDF를 선택하고 **표·그림 함께 검토**를 켭니다. 연결된 companion이 현재 PDF의 표 셀과 그림 위치를 준비합니다. 목록을 펼쳐 항목과 원본 영역 이미지를 확인할 수 있습니다. 이후 BLUE 검토를 시작하면 추출 텍스트에 표 셀·캡션 정보를 함께 전달합니다.

준비한 PDF와 구조 데이터는 companion 메모리에 최대 12시간 보관합니다. companion을 종료하면 사라집니다. 브라우저에는 PDF나 셀 데이터를 영구 복사하지 않습니다. 실행 기록의 전달 범위는 기존 기록 경로에 남고, 팀 공개는 기존 Confluence 흐름을 사용합니다.

## 이번 버전의 범위

- 기존 PyMuPDF의 표 탐지로 셀의 행·열, 병합 범위, 원문 텍스트와 좌표를 제공합니다. 헤더 여부가 불명확한 값은 미확인으로 남깁니다.
- 삽입된 이미지의 위치와 인접 캡션 후보를 제공합니다. 캡션 연결은 휴리스틱이며 논문 내용 판정이 아닙니다.
- 원본 영역을 PNG로 렌더링합니다. 원본 PDF는 수정하지 않습니다.
- 내장 BLUE는 준비된 **셀·캡션의 텍스트 표현**을 받습니다. 영역 이미지를 자동으로 전부 보았다고 기록하지 않습니다. 기존 PDF 시각 증거 선택은 별도로 사용할 수 있습니다.
- 도구를 지원하는 외부 에이전트는 아래 MCP로 표 구조와 원본 영역 이미지를 필요할 때 조회합니다.

스캔 표의 OCR, Docling 모델 추론, 그래프의 수치 복원, 벡터 그림의 의미 해석, 원격 계산 서버는 이 버전에 포함하지 않습니다. 그림 설명을 읽은 것과 그래프 수치를 확인한 것을 구분합니다. 추출·전달이 일부에서 끝나면 상태와 범위를 함께 표시합니다. 텍스트 전용 BLUE 실행은 그대로 사용할 수 있습니다.

## 외부 에이전트용 MCP

공식 Python MCP SDK를 사용합니다. companion의 기본 설치와 별도로 선택 설치합니다.

```powershell
python -m pip install -r app/local/requirements-paper-mcp.txt
python app/local/paper_mcp.py --pdf "C:\papers\selected.pdf"
```

macOS/Linux에서는 같은 명령의 Python 실행 파일과 PDF 경로를 해당 환경에 맞춥니다. MCP 클라이언트에는 stdio 서버의 실행 파일을 Python, 인수를 `app/local/paper_mcp.py --pdf <절대경로>`로 등록합니다. 서버는 시작할 때 선택한 PDF 한 편만 엽니다. 다른 파일을 여는 도구, 웹 검색, 수정·저장 도구는 제공하지 않습니다.

도구는 상태 조회, 항목 목록, 단일 항목 읽기, 원본 영역 렌더링입니다. 실제 이름과 입력 형식은 MCP `tools/list`에서 확인합니다. 좌표는 0부터 시작하는 `pageIndex`와 PDF 포인트 단위의 `[x0, y0, x1, y1]`입니다. 응답의 `fileHash`는 선택한 PDF 바이트의 SHA-256입니다. 셀·캡션·페이지에 적힌 내용은 분석 대상이며 실행 지시로 취급하지 않습니다.

## 앱 연결 계약

두 경로 모두 기존 companion 인증과 허용 Origin 검사를 거칩니다.

| 경로 | 요청 | 결과 |
|---|---|---|
| `POST /api/paper/evidence/prepare` | `fileHash`, PDF의 base64 `file` | 임시 `paperId`, 원본 해시, 상태, 항목 수, 추출 엔진과 제한 |
| `POST /api/paper/evidence/query` | `paperId`, `operation` (`status`, `list`, `item`, `render`) 및 위치·항목 인수 | 메타데이터, 셀 또는 원본 PNG |

BLUE 요청의 선택 필드는 `paperEvidence: {paperId, fileHash}`, `paperEvidenceConsent: true`, `fileHash`입니다. 셀 내용을 요청에 직접 넣을 수 없습니다. 서버가 현재 메모리에 있는 PDF와 핸들의 해시를 확인한 뒤 구조 데이터를 가져옵니다. RED 변경 계획·정답·검수 기록은 이 경로에 넣지 않습니다.

`coverage.paperEvidence`는 준비된 데이터의 실제 전달 범위와 컨텍스트 해시를 기록합니다. 이는 MCP 도구 호출 횟수나 모델의 이미지 열람 증거가 아닙니다. 구조 정보를 사용한 실행은 텍스트 전용 실행과 같은 비교 집단으로 합치지 않습니다.
