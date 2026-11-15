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

## 다중 문서 워크스페이스 모드

한 프로세스에서 여러 PDF를 차례로 읽어야 할 때는 `--pdf` 대신 `--workspace DIR`을 사용합니다. 두 옵션은 함께 쓸 수 없고 하나는 반드시 지정해야 합니다. 둘 다 없거나 둘 다 있으면 `paper_evidence_file_invalid`, 디렉터리가 없으면 `workspace_invalid`로 종료 코드 2를 반환합니다.

```powershell
python app/local/paper_mcp.py --workspace "C:\papers"
```

워크스페이스 모드에서만 두 도구가 추가됩니다. 기존 읽기 도구 9개는 그대로 유지되고, 선택한 문서를 대상으로 동작합니다.

| 도구 | 인수 | 결과 |
|---|---|---|
| `list_papers` | 없음 | `schema`, `paperCount`, `maskedCount`, `truncated`, `papers[{paperId, name, byteLength, masked, reason?}]` |
| `select_paper` | `paperId` | `paperId`, `fileHash`, `name`, `pageCount` |

`select_paper`의 `paperId`는 `list_papers`가 준 워크스페이스 id(`ws-` + 파일 바이트 SHA-256 앞 16자)입니다. 선택이 끝나면 `status`, `list_items`, `read_item`, `read_page_text`, `search_text`, `list_references`, `audit_statistics`, `run_blue_sensor`와 선택적으로 켜는 분석·보충·oracle 도구가 그 문서를 대상으로 동작합니다. 선택 전에 호출하면 `workspace_no_selection`을 반환하고, 선택 후 이전 문서의 id로 호출하면 `paper_evidence_unknown_id`를 반환합니다. 프로세스를 다시 시작할 필요는 없습니다.

스캔은 호출할 때마다 새로 수행하며 `DIR` 아래를 깊이 2까지 훑습니다. 최대 32편까지만 나열하고 그보다 많으면 `truncated: true`로 표시합니다. `DIR` 밖으로 해석되는 경로(링크 포함), 0바이트 파일, 25 MiB 초과 파일은 나열하지 않습니다. 응답에는 파일 이름만 있고 절대 경로는 넣지 않습니다.

파일 이름에 `gold`, `ledger`, `answer`, `answerkey`, `solution`, `red-plan`, `whythard`가 들어가면 정답·검수 자료로 간주해 `masked: true`와 `reason: answer_key_name`으로만 나열합니다. 해당 파일은 열지 않고, 바이트 해시도 노출하지 않으며, `select_paper`는 `workspace_file_masked`를 반환합니다. 같은 규칙을 `--supplement` 경로에도 적용하며, 걸리면 시작 단계에서 `workspace_file_masked`로 종료합니다.

단일 `--pdf` 모드는 도구 목록, 응답 형식, 오류 코드가 이전과 같습니다. 워크스페이스는 추가 모드이며 기존 동작을 바꾸지 않습니다.

## 앱 연결 계약

두 경로 모두 기존 companion 인증과 허용 Origin 검사를 거칩니다.

| 경로 | 요청 | 결과 |
|---|---|---|
| `POST /api/paper/evidence/prepare` | `fileHash`, PDF의 base64 `file` | 임시 `paperId`, 원본 해시, 상태, 항목 수, 추출 엔진과 제한 |
| `POST /api/paper/evidence/query` | `paperId`, `operation` (`status`, `list`, `item`, `render`) 및 위치·항목 인수 | 메타데이터, 셀 또는 원본 PNG |

BLUE 요청의 선택 필드는 `paperEvidence: {paperId, fileHash}`, `paperEvidenceConsent: true`, `fileHash`입니다. 셀 내용을 요청에 직접 넣을 수 없습니다. 서버가 현재 메모리에 있는 PDF와 핸들의 해시를 확인한 뒤 구조 데이터를 가져옵니다. RED 변경 계획·정답·검수 기록은 이 경로에 넣지 않습니다.

`coverage.paperEvidence`는 준비된 데이터의 실제 전달 범위와 컨텍스트 해시를 기록합니다. 이는 MCP 도구 호출 횟수나 모델의 이미지 열람 증거가 아닙니다. 구조 정보를 사용한 실행은 텍스트 전용 실행과 같은 비교 집단으로 합치지 않습니다.
