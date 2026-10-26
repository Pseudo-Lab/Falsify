# 외부 RED 응답 가져오기

이 모듈은 외부 모델에 **직접** 붙여넣을 프롬프트를 만들고, 사람이 가져온 응답을 현재 원문에 정확히 대응한다. Falsify는 여기서 모델을 호출하지 않고, 네트워크 요청을 보내지 않으며, 응답을 자동으로 적용하지 않는다. 가져온 결과는 검증된 RED 실행·하네스·과학적 성공이 아니다. 저자 출처는 `external-ai-import`이고, 모델 이름은 선택 표시일 뿐이다.

소유 파일은 `app/dist/external-red.js`, `app/dist/external-red-ui.js`, `app/dist/external-red-ui.css`, `app/tests/external-red*.cjs`, 이 문서다. `index.html`과 워크스페이스 컨트롤러는 다른 소유자가 연결한다.

## 브라우저 API

전역 `FalsifyExternalRed` (UMD, 의존성 없음).

- `buildPrompt({segments,fileHash})` → 문자열. 안정 ID, 0부터 세는 `pageIndex`, PDF 표시 라벨, 전체 문단 원문, 권장 응답 `{"changes":[{"segmentId","pageIndex","before","after"}]}`를 담는다. 프롬프트는 사람이 고를 해석·논리 공격을 쉬운 한국어로 요청하고, 겨냥하지 않은 문장은 그대로 두며, Before와 문단 ID를 원문에서 그대로 복사하라고 한다. `rationale`은 생략해도 된다. 한도를 넘기면 일부를 자르지 않고 던진다.
- `parse(text,{segments,fileHash})` → `{proposals,diagnostics}`. 제안은 `segmentId`, `pageIndex`, `before`, `after`, `anchor`, `origin`, `status`, `matches`, `listComplete`를 가진다. `status`는 `matched`, `ambiguous`, `missing`뿐이다. `matches`는 `{segmentId,pageIndex,start,end,occurrence}`다. `occurrence`는 한 글자씩 센 0부터의 출현 번호다.
- `origin`은 항상 `external-ai-import`다. 붙여넣은 값으로 바꾸지 않는다.

`matched`는 지정한 범위에서 Before가 **정확히 한 곳**일 때만이다. 문단 ID가 있으면 그 문단 안에서만 세고, ID 없이 `pageIndex`만 있으면 그 쪽만, 둘 다 없으면 전체 원문에서 한 곳이어야 한다. 겹치는 인용도 센다. `aaa` 안의 `aa`는 0과 1 두 곳이라 `ambiguous`다. 첫 번째 출현이나 비슷한 문장으로 고르지 않는다. 여러 곳이면 `ambiguous`이고 `anchor`는 비운다. 없으면 `missing`이다. 같은 위치에 After가 서로 다르면 둘 다 `ambiguous`다.

확정된 `before`는 정규화한 인용이 아니라 원문 조각 그대로다. `end-start`는 그 조각의 길이와 같다. `anchor.occurrence`는 그 시작 위치의 출현 번호다. 시작과 끝이 있으면 편집 코어는 occurrence를 생략해도 받지만, 이 모듈은 둘을 같이 맞춘다. After가 빈 문자열이면 삭제로 보낸다. 공백만 있는 After는 제안하지 않고, 빈 문자열로 지우라고 알린다. Before나 After가 4000자를 넘으면 제안을 만들기 전에 더 짧은 인용으로 나누라고 알린다.

## pageIndex와 PDF 라벨

`pageIndex`는 0부터다. 문단에 정수 `pageIndex`가 있으면 그 값을 쓴다. 없을 때만 라벨을 바꾼다.

- `PDF p. N` (`N`은 1–9999) → `N-1`. 논문 분석의 `PDF p. N` 규칙과 같다.
- `p. N`, `pN`, `page N`도 같은 방식으로 `N-1`.
- 응답의 `pageIndex` 숫자는 0부터인 인덱스로 그대로 둔다. `1`을 1쪽으로 해석하지 않는다.
- 응답의 `page` / `pageLabel`은 표시 라벨이다. `PDF p. 1`과 숫자 `1`은 `pageIndex` 0이다.
- 라벨을 정수 쪽으로 바꿀 수 없으면 배열에서의 0부터 위치를 쓴다. 로마 숫자·임의 접두 라벨은 쪽 사전이 아니므로 바꾸지 않는다.

ID와 쪽이 서로 모순되면 맞추지 않고 `page-mismatch`로 `missing`이다. 없는 ID는 다른 문단으로 옮기지 않는다.

## 받는 형식

권장 JSON 외에 다음을 읽는다. 코드 블록 밖 글, HTML, 스크립트는 지시로 실행하지 않는다.

- 펜스 JSON (` ```json `)
- 레거시 `candidates` (`segmentId`, `before`, `after`). 후보 ID·level·rationale은 편집 위치가 아니다.
- `edits` 배열. `changes`, `candidates`와 같은 항목·한도·정확 위치 규칙을 쓴다. 셋 중 목록은 하나만 둔다. 빈 목록, 배열이 아닌 값, 알 수 없는 JSON은 제안을 만들지 않는다.
- `Before:` / `After:` 쌍. 머리글로 `segmentId`, `pageIndex`, `pageLabel`을 둘 수 있다.
- 정확한 문맥이 회복되는 unified diff. 경로가 문단 ID와 같으면 그 문단만 보고, 아니면 문맥으로만 찾는다.
- `rewritten` 또는 `fullText`, 또는 `FULL REWRITE` 본문. 줄 단위로 제한된 차이만 만든다.

CRLF는 찾을 때만 LF로 맞춘다. 제안의 Before와 오프셋은 원문 조각으로 되돌린다. 예를 들어 원문 `first\r\nsecond`와 응답 `first\nsecond`는 Before가 `first\r\nsecond`인 한 곳이다. 같은 변경이 반복되면 한 번만 남긴다. Before와 After가 같으면 제안을 만들지 않는다. 응답의 `fileHash` 또는 `sourceHash`가 현재 원문과 다르면 제안을 만들지 않는다.

## 한도

| 이름 | 값 |
| --- | --- |
| 붙여넣은 응답 | 200000자 |
| 프롬프트 | 500000자 |
| 문단 수 | 2000 |
| 문단 텍스트 | 100000자 |
| Before / After | 각 4000자 |
| 변경 개수 | 40 |
| 한 제안에 나열하는 위치 | 20 |
| 전체 다시 쓰기 | 각 60000자, 400줄, 차이 덩어리 24개 |

한도를 넘으면 일부를 성공으로 남기지 않는다. 전체 다시 쓰기는 검증된 실행이나 과학적 성공이 아니며, 문단 경계를 넘는 덩어리는 후보로 만들지 않는다.

## 화면

`FalsifyExternalRedUI.mount(document)`는 `#paper-workspace`가 있으면 그 안에 작은 구역을 붙인다. 아직 없으면 `falsify:paper-workspace-ready`를 기다린다. `falsify:paper-workspace-source`가 오면 이전 붙여넣기 변경을 지운다. 붙여넣은 글 자체는 남는다.

화면 글은 쉬운 한국어다. 버튼은 `변경 찾기`와 `선택한 변경 가져오기`다. 쪽은 `PDF p.1`처럼 1부터 보여 주고, `pageIndex 0`이나 호스트 이름은 보여 주지 않는다. 위치가 여러 곳이면 각 위치의 앞뒤 문맥을 대괄호로 표시하고, 라디오는 미리 고르지 않는다. 사람이 위치를 확정하고 체크한 뒤에만 가져온다.

복사는 `FalsifyPaperWorkspace.getSource()`로 전체 쪽 원문과 과제 프롬프트를 만든다. 클립보드 권한이 없으면 `falsify-external-red-prompt.txt`로 내려받는다. 진단과 Before/After, 문맥은 `textContent`로만 보인다. 제안이 0건이면 상태는 `no-changes`이고, 문구는 변경 0건이며 적용하지 않는다고 말한다. 그때 가져오기 버튼은 꺼져 있다. 제안이 있을 때만 찾았다고 말한다. 체크한 `matched`만 `acceptProposals(proposals,{origin:'external-ai-import',model?})`로 보낸다. 고른 위치의 `before`는 그 원문 조각이고, `anchor.occurrence`는 그 출현 번호다. 같은 범위를 덮는 제안을 둘 이상 체크하면 보내지 않는다. 편집 화면 API가 없으면 보내지 않는다.

## 출처

파서, unified diff 읽기, 제한된 줄 비교는 이 저장소에서 새로 작성했다. 라이선스는 저장소와 같은 AGPL-3.0-only다. `app/package.json`의 의존성(fflate, parse5, pdfjs-dist)에는 재사용할 diff 라이브러리가 없고, 패키지 소유는 브라우저 PDF 담당이므로 의존성을 추가하지 않았다. 서드파티 diff 코드를 복사하지 않았다.

## 잔여 한계

- 스크립트와 스타일 연결, `#paper-workspace` 호스트, `FalsifyPaperWorkspace` 구현은 UI 담당이다. 이 분기만으로는 화면이 열리지 않는다.
- 기존 정적 점검은 `paper-workspace` 문자열과, `index.html`에 없는 새 스크립트를 레거시로 본다. 계약이 그 호스트와 이벤트를 요구하므로 통합 담당이 점검 예외를 갱신하기 전까지 그 점검은 실패한다.
- 로마 숫자 등 비십진 PDF 페이지 라벨은 0부터의 문단 순서로만 둔다.
- 편집 세션에 위치 선택 API가 없어, 모호한 위치는 이 패널에서 고른 뒤 공개 `acceptProposals`로만 넘긴다. 테스트는 저장소에 있는 `app/dist/paper-edits.js`를 읽고, 원격 git ref로 모듈을 가져오지 않는다.
- 빈 줄 구분으로 이은 전체 다시 쓰기만 다룬다. 레이아웃·글꼴·수치 검증은 하지 않는다.
