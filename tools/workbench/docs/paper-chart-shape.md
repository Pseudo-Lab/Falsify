# 원본 서식으로 그래프 고치기

RED에 PDF를 넣고 **표·그래프·그림 고치기**에서 그림을 선택합니다. 목록에 없는 벡터 그래프는 **영역 직접 선택**으로 해당 쪽을 열어 그래프를 지정합니다. **그래프 고치기**를 누르면 원본 축·격자·라벨 위에서 곡선을 조작합니다.

- 곡선을 위아래로 당기면 봉우리나 골이 생깁니다.
- 가운데 손잡이는 위치와 높이, 양옆 손잡이는 폭을 바꿉니다.
- 막대는 끝점을 끌어 높이 또는 길이를 바꾸고, 산점은 점을 끌어 위치를 바꿉니다. 막대의 기준선·폭과 산점의 크기는 유지됩니다.
- **되돌리기**, **원본 비교**, **내보내기**를 같은 편집기에서 사용합니다. 내보내기는 현재 편집으로 PDF를 만들어 바로 다운로드합니다.

정밀 좌표는 **정밀 좌표** 또는 **좌표 (px)** 접힌 영역에 있습니다. 좌표의 단위는 선택한 원본 이미지의 픽셀이고, 왼쪽 위가 원점입니다. OCR·축 보정·기존 새 서식 재그리기는 **고급 · 그래프 분석·축 보정**에 있습니다.

원본의 해당 곡선 또는 이미지 사용 위치를 고칩니다. PDF의 글꼴·축·눈금·페이지 배치는 원본을 이어 씁니다. 수정 전후 좌표와 명령은 사람 편집 기록에 남고, BLUE에는 다운로드한 PDF만 전달됩니다. 변경이 없으면 원본 파일 바이트를 받습니다.

## 에이전트 도구

BLUE의 기존 `paper_mcp.py`는 읽기 전용입니다. RED 곡선 편집은 별도 MCP를 실행합니다.

```sh
python app/local/paper_chart_edit_mcp.py --pdf /absolute/path/paper.pdf
```

초기화 응답의 `Selected PDF`에서 `paperId`와 `fileHash`를 읽습니다. 도구는 세 개입니다.

| 도구 | 입력 | 결과 |
|---|---|---|
| `prepare_chart_edit` | paperId, pageIndex, bbox, options | 원본에 연결된 장면과 계열·점·스타일 |
| `preview_chart_edit` | paperId, sceneId, revision, operations | 편집 이미지와 계산된 장면 |
| `export_chart_edit` | 같은 편집 계획 | PDF 사본, SHA-256, 변경 기록, 보존 검사 |

`pageIndex`는 0부터 시작하고 `bbox`는 페이지에서 보이는 좌표(pt)의 `[왼쪽, 위, 오른쪽, 아래]`입니다. 각 계열의 `points`는 해당 장면의 crop 픽셀입니다. 한 장면은 원본을 기준으로 하므로 매번 전체 명령 이력을 보냅니다.

```json
{
  "id": "drag-1",
  "kind": "deform",
  "seriesId": "series-1",
  "center": [120, 80],
  "radius": 35,
  "dx": 0,
  "dy": -20
}
```

`move`는 `range:[시작점,끝점]`과 `dx,dy`, `resize`는 같은 range와 `anchor:[x,y],scaleX,scaleY`, `set-values`는 `points:[{index,x,y}]`를 사용합니다. 원본에 국소 변위를 더하고, 다른 계열과 범위 밖 표본을 유지합니다. 브라우저와 MCP는 같은 해시 고정 JavaScript 코어로 계산합니다.

HTTP는 인증된 companion의 `/api/paper/chart/prepare`, `/preview`, `/export`를 사용합니다. preview/export 요청은 `schema: falsify.chart-edit-plan.v1`과 `paperId,fileHash,sceneId,revision,operations`를 포함합니다. 기존 `/api/paper/visual/export`의 `chart-shape` 작업으로 표 셀 편집과 함께 적용할 수도 있습니다.

출력의 보존 검사는 페이지 수·추출 텍스트·편집 영역 밖 픽셀을 대조합니다. 래스터 곡선 아래에 가려져 있던 배경은 원본 주변 픽셀로 복원합니다. RGB ICC 프로필과 soft mask를 유지하며, 불투명 그림은 바뀐 픽셀만 덧입혀 JPEG 캡션과 비편집 영역의 재저장을 피합니다. 검증 범위와 지원 패턴은 구현 영수증에 기록합니다.

현재 원본 보존 경로는 PDF의 선·cubic 곡선과 색 곡선 이미지, 최상위의 채워진 직사각 막대·원형 산점을 지원합니다. 막대·산점이 Form 안에 있거나 여러 요소가 한 그림으로 합쳐져 있으면 이 조작기로 분리하지 않습니다. 이미지 교체와 고급 재그리기는 기존 도구에서 사용할 수 있습니다.
