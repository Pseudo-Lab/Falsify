# Harness + 독립 사람 검수

`논문 실험 → RED / BLUE`는 각각 독립적으로 입력 → 실행 → 결과를 제공한다. RED의 후보 선택·After 편집·사본 다운로드는 유지한다. 사람이 모델 행동을 평가하는 곳은 별도 `검수`다. 유효한 결과는 입력 추출문·응답·Harness의 고정 사본과 함께 이 브라우저에 자동 기록된다. 기록 실패는 표시하며 결과를 화면에 남겨 수동 재시도할 수 있다. 기록 자체는 JSON 다운로드를 발생시키지 않으며 전체 백업은 명시적으로 요청한다. 초기화해도 저장한 실행·검수는 사라지지 않는다. 독립 역할 사용을 강제 순서로 묶는 공통 5단계 경로는 없다.

## 최소 등록 계약

```json
{
  "schema": "falsify.harness.v1",
  "id": "my-blue",
  "name": "내 BLUE",
  "version": "1",
  "role": "blue",
  "instructions": "내부 근거와 결론의 논리적 연결을 검토한다.",
  "maxCalls": 8,
  "adapter": {"type": "codex"},
  "settings": {"strategy": "claim-evidence", "temperature": 0.2}
}
```

필수: 위 schema/id/name/version/role/instructions/maxCalls. adapter와 settings는 선택이다. adapter 생략은 Codex. ID/버전은 영문·숫자·`._-` 1–80자, 이름 120자, 지침 8,000자, 호출 상한 1–32. settings는 임의 JSON 객체(32,000자); 비밀키·로그인 정보는 넣지 않는다. 정렬 JSON의 SHA-256으로 정확한 내용 버전을 식별한다. 같은 ID/버전명을 다시 써도 내용이 달라지면 별도 해시로 공존한다. 등록은 실행이 아니다. RED/BLUE 선택 메뉴에서 쓸 버전을 선택한다. 선택 변경은 현재 응답을 무효화하지만 저장된 실행은 그대로다.

실제 호출 상한은 UI 예산과 harness 상한 중 작은 값이다. 전체 추출문을 전달할 예산이 부족하면 시작하지 않는다. 앱의 분할/인용/응답 검증 계약은 유지한다. custom harness는 내부 모델, 도구, 탐색, 하위 agent, 자체 반복 로직을 자유롭게 구현할 수 있다. 앱이 제공하는 기본 CLI는 도구 제한을 적용하며, 사용자 코드/서버의 도구·내부 모델 호출량·도메인 타당성·격리는 검증하지 못한다.

### 기본 CLI 선택과 사용자 연결 방식

- `codex`: 로그인된 Codex CLI에 instructions와 호출 상한을 적용. `adapter: {"type":"codex","model":"gpt-6.1-sol","effort":"medium"}`로 모델과 추론 강도를 선택한다. model 생략은 기존 gpt-6.1-sol이다. 새 선택 설정에서 effort 생략은 medium; adapter 생략 또는 기존 `{"type":"codex"}`만 있는 계약은 기존 CLI 기본 effort를 유지한다. ChatGPT 로그인만 허용하며 API 키로 자동 전환하지 않는다.
- `claude`: 로그인된 Claude Code 구독을 사용한다. `adapter: {"type":"claude","model":"claude-opus-5-5","effort":"medium"}`. model 생략은 claude-opus-5-5, effort 생략은 medium. API 인증·외부 provider는 허용하지 않고 오류로 끝낸다. 별도 일회성 실행에서 도구·customization을 제한한다. OAuth를 차단하는 `--bare`는 쓰지 않는다.
- `stdio`: `adapter: {"type":"stdio","executable":"C:/.../python.exe","args":["C:/.../my_harness.py"]}`. 존재하는 executable 절대 경로, 문자열 args 최대32개. 임의 shell 문자열/eval은 사용하지 않는다. 시작 시 사용자 코드 실행 동의를 별도로 받는다. Python뿐 아니라 Node·실행 파일 등 JSON stdin/stdout을 지원하면 가능하다.
- `http`: `adapter: {"type":"http","url":"https://your-server.example/falsify"}`. 공인 HTTPS 주소만, URL userinfo/query/fragment 금지, redirect/자동 재시도/환경 proxy 금지. DNS 결과를 검사하고 검사한 공인 IP에 연결하며 TLS는 원래 hostname을 검증한다. 서버가 인증을 요구하면 로컬 stdio wrapper가 자기 비밀 저장소를 이용해 호출하도록 구현한다. 앱 등록 JSON에 인증키를 저장하는 기능은 없다.

실제 custom 실행은 인증된 **사용자 PC의 로컬 broker**에서만 가능하다. 공개 웹에서도 [로컬 실행기 설치와 토큰 연결](local-companion.md)을 명시적으로 진행하면 같은 실행기를 호출할 수 있다. 연결하지 않으면 입력/등록/수동 JSON 교환/검수/기록만 가능하다. 사용자 코드에는 최소 환경만 넘기고 임시 작업 폴더에서 실행하지만 **OS sandbox가 아니다**. 신뢰하는 코드만 실행한다. 코드는 PC 파일·네트워크에 접근할 수 있다. 외부 endpoint는 입력 논문을 받을 수 있다. 회당180초, 응답150KB, 앱 adapter 호출 최대32회; custom 내부 하위 호출/토큰/지출은 이 상한으로 제한되지 않는다. 취소는 결과를 폐기하며 현재 호출은 timeout까지 이어질 수 있다. escaped processes나 외부 서버 내부 작업의 중단은 보장하지 않는다.

기본 CLI의 모델 ID는 영문·숫자로 시작하는 ASCII `[A-Za-z0-9_.:-]` 최대120자, effort는 `low` / `medium` / `high`다. 모델 추천 목록은 계정별 접근 가능 목록이 아니다. 직접 ID를 입력할 수 있지만 모델/effort가 계정·CLI에서 지원되지 않으면 실패하고 다른 모델로 자동 대체하지 않는다. 기본 CLI의 `settings.temperature`나 도구 관련 자유 설정은 적용하지 않는다. mandatory role/output/evidence/safety constraints override conflicting instructions. 도구 제한은 OS 파일 읽기 격리가 아니며 관리 정책의 개입까지 없다고 보장하지 않는다.

RED와 BLUE의 CLI·모델·effort는 독립적이다. UI에서 바꾼 실행 설정은 선택 harness의 새 내용 해시로 고정해 요청과 결과 기록에 남긴다. 과거 실행의 설정은 바뀌지 않는다. `stdio`/`http`는 등록한 harness 자체의 실행기를 사용하므로 UI의 기본 CLI 선택으로 덮어쓰지 않는다. 모델 표기는 요청한 ID이며 alias가 실제로 어느 버전으로 해석되는지는 별도로 확인해야 한다. 모델 비교에는 고정 ID 사용을 권한다.

### Invocation 입출력

stdin JSON 하나(UTF-8, newline 후 EOF) 또는 HTTPS POST JSON:

```json
{
  "schema": "falsify.harness-invocation.v1",
  "role": "blue",
  "prompt": "역할 계약과 해당 논문 추출문/청크 인용 요약",
  "outputSchema": {"type":"object","properties":{}},
  "settings": {},
  "call": 1,
  "maxCalls": 1
}
```

`outputSchema`는 실제 호출 때 완전한 JSON Schema가 전달된다(위 빈 properties는 구조 예시). **stdout/HTTP body는 그 스키마 객체 자체**다. 상태는 ok/abstain/refusal. 로그는 stdout에 섞지 않는다. 최종 RED는 status/candidates, BLUE는 status/findings, 다중 청크의 중간 읽기는 status/summary/evidence다. 정확한 근거 인용과 변경 전 문구의 원문 일치 검증은 앱이 다시 수행한다. wrapper response의 schema/revision/sourceHash/harnessHash는 broker가 붙인다. BLUE invocation에는 RED 계획·정답·사람 평가를 앱이 넣지 않는다. 사용자가 지침/settings/코드에 직접 정답을 넣거나 custom 서버가 이전 RED 상태를 공유하면 블라인드 실험이 아니므로 운영자가 경계를 유지해야 한다. 여러 청크 호출은 개별 프로세스/요청일 수 있으므로 필요한 상태 관리는 사용자 구현이 맡는다.

시작용 코드: [app/examples/stdio_harness.py](../app/examples/stdio_harness.py). 기본은 정직한 abstain을 반환한다. 자기 모델/도구 pipeline으로 교체한다. 합성 연결 fixture는 app/tests/fixtures에 별도 위치하며 실제 모델이 아니다.

### BLUE 다중 청크 근거 재독

단일 청크(추출문이 36,000자 이하 한 묶음)는 기존대로 전체 원문을 한 번의 호출에 그대로 보내며 `coverage.reread.status`는 `not-needed`다. 여러 청크면 BLUE는 `N`회 청크 읽기 → 1회 재독 대상 선택 → 1회 최종 판단, 총 `N+2`회를 사용한다. 요청 예산과 harness `maxCalls` 중 작은 값이 `N+2`보다 작으면 backend 생성과 모델 호출 전에 시작하지 않는다. 모든 호출의 prompt(harness 지침 포함, JSON escape 후)는 100,000자 이하이며, 모델과 무관한 청크/단일 prompt는 backend 생성 전에 검사한다. 입력은 사용자가 공급한 변경 문서 텍스트뿐이며 원본 논문·정답·RED 기록·파일·도구·외부 자료는 쓰지 않는다.

선택 호출의 `outputSchema`(custom stdio/http adapter도 매 호출 받는다):

```json
{"status": "ok|abstain|refusal",
 "targets": [{"segmentId": "입력 문단 ID", "anchor": "그 문단에 정확히 한 번 나오는 인용(<=300자)", "reason": "<=600자"}]}
```

targets는 최대 8개, strict(추가 필드 금지). 선택 prompt에는 청크 메모(`allChunkNotes`)와 문단 색인(`segmentIndex`: 문단 ID·label·offset·길이·미리보기, 긴 문단은 6,000자마다 항목; 상한 초과 시 미리보기를 줄이고 그래도 넘으면 뒤 항목을 생략하며 `indexTruncated`로 알림)이 들어간다. anchor는 실제로 전달된 색인 미리보기나 검증된 청크 메모 인용에서 복사해야 한다. 없는 ID, 원문에 없거나 중복되는 anchor, 선택 단계에 보이지 않은 anchor는 오류로 끝내고 최종 호출을 하지 않는다. 선택이 abstain/refusal이면 그 상태로, ok인데 대상이 0개이면 요약만으로 판단하지 않고 `abstain`으로 끝낸다(지적 없음, `reread.status = incomplete`).

최종 호출은 기존 status/findings 스키마 그대로이며, 청크 메모와 `rereadWindows`(선택 문단의 RAW 원문 창, `[start,end)` 원문 offset 포함)를 받는다. 창은 anchor 중심으로 결정적으로 자르며 대상당 최대 6,000자, 합계 48,000자 이하다. prompt 상한을 맞추려 줄이거나 anchor조차 담지 못해 생략한 창은 `truncated: true`, `status: incomplete`로 보고한다. 최종 지적의 quote와 evidence 인용은 원문 일치·유일성에 더해, 최종 단계에 실제로 전달된 창이나 검증된 청크 메모 인용 안에 있어야 한다.

```json
"coverage": {"complete": true, "calls": 4, "chunks": 2, "completedChunks": 2, "meaning": "...",
  "reread": {"status": "completed|not-needed|incomplete", "selectedSegments": ["s1"], "deliveredChars": 6000,
             "truncated": false, "meaning": "상태별 고정 문구"},
  "rereadWindows": [{"segmentId": "s1", "start": 15000, "end": 21000}]}
```

`coverage.complete`는 추출 텍스트 전달 여부만 뜻한다. 재독은 모델이 고른 일부 창이며 전체 원문 재독이나 결함 전수 탐지의 보증이 아니다. 부분/중단/유보/거절 결과는 과학적 성공이 아니고 지적을 포함하지 않는다. 진행 상황 `phase`는 고정 ASCII token `reviewing`(청크 읽기·단일 호출) / `selecting` / `reread`(창 구성, 호출 없음) / `finalizing`이며 `requiredCalls`는 `N+2`(단일 1)다. 취소는 다음 호출 전·호출 직후에 확인해 결과를 폐기한다.

## 검수와 비교

검수에서 고정 실행을 선택하고 평가자, 사례/실험 조건, supported/unsupported/mixed/uncertain, 선택적인1–5 품질 점수, 필수 근거를 남긴다. 기존 평가를 덮어쓰지 않고 새 이력을 추가한다. RED 원출력과 사용자 최종 선택·편집 After를 구분해 표시한다. 보존 검사 후 출력 해시가 있는 RED 스냅샷과 BLUE 입력 파일의 바이너리 SHA-256이 일치하면 검수에서 변경문 위치를 대조한다. 없으면 기존 변경 계획 JSON을 선택할 수 있다. 계획은 검수에만 존재한다. 인용 겹침은 탐지 성공이 아니며 사람이 변경별 detected/missed/uncertain을 판정한다. 모델 호출·domain gold·팀 승인으로 자동 승격하지 않는다.

결과 표는 기록 출처(로컬 broker 실행 / 수동 응답 / 가져온 기록), harness 확인 상태, harness 내용 해시, 역할, 모델 표기, 입력 텍스트 해시, RED L단계, 요청 호출 예산으로 분리해 서로 다른 출처가 한 분모에 섞이지 않는다. RED 편집·내보내기 스냅샷의 `snapshotOf`는 원 모델 응답을 가리키며 추가 실행/표본으로 세지 않는다. 같은 원 응답의 스냅샷 계열에서 마지막으로 추가된 평가1건을 사용하고 uncertain은 제외한다. 주관적 품질 평균이지 accuracy/탐지율/통계적으로 유의한 순위가 아니다. 저장된 유효 응답만 포함하므로 실패한 요청을 포함하는 전수 실행/실패율 지표가 아니다. 수동 응답은 실제 모델 실행을 인증하지 않는다. 저장된 harness는 "요청 harness"로만 표시하고 로컬 broker 실행 수·앱 adapter 호출 합계·품질 평균에 넣지 않는다. 가져온 기록은 원래 출처와 관계없이 출처 미검증으로 따로 세며, 응답의 harnessHash가 저장된 해시와 다르거나 없는 레거시 로컬 기록은 "실행 미확인 harness"로 표시하고 평균에서 뺀다. 이 구분은 저장 필드에서 파생할 뿐 기존 기록·백업 형식을 다시 쓰지 않는다. RED `coverage.complete=false`는 분할 읽기가 모두 응답했더라도 후보 종합 호출이 실행되지 않았음을 뜻하며, 화면은 완료/유보/거절과 함께 검토 범위·종합 단계·앱 adapter 호출 수를 표시한다. 수동/가져온 기록의 coverage는 검증된 값으로 표시하지 않는다. 외부 harness 모델명은 미검증 placeholder다. A/B/C 대조군·공식gold·동일평가자·반복실행 등 과학적 비교 설계는 별도다.

기록은 origin별 localStorage, **공동 cloud DB가 아니다**. 로컬/비공개웹/다른PC는 JSON 백업·병합으로 옮긴다. Import는 harness/source 해시와 응답 계약을 확인하지만 실행 출처를 인증하지 않으므로 imported-unverified로 표기한다. 파일/JSON을 사용자가 직접 수정할 수 있어 위변조 방지 감사 시스템도 아니다. 100harness /100runs /1000reviews, 저장 JSON4.5M자, import4.5MB 제한. 논문 추출문도 저장하므로 공용 PC에서는 사용하지 않는다. 앱 UI에는 일괄 삭제가 없다; 백업 후 사이트 데이터 제거는 브라우저 설정에서 사용자가 할 수 있다. 저장 공간 부족/손상은 기존 저장본을 덮어쓰지 않고 오류를 표시한다.

## 확인 범위

tests/test_harness.py는 strict 역할/필드, 호출한도, 정규화 해시, 별도 실행 동의, 실제 합성 stdio 프로세스, BLUE 누출 금지, 출력 shape, 사설 HTTPS 거절을 확인한다. tests/harness-ledger.spec.cjs는 두 버전 등록·실제 요청 반영·기록 고정·reload·사람 평가·결과 그룹·별도 동의·실제 로컬 합성프로세스·RED/BLUE 분리·desktop/mobile을 확인한다. tests/ledger-import.spec.cjs는 정상 백업·중복 병합·손상된 저장소 복구와 내용 해시/대조 기록/동일 ID의 수정 차단을 확인한다. tests/harness-core.spec.cjs는 브라우저 계약과 조건별 요약을 확인한다. 실제 외부 서버/유료 모델/AMAS 과학적 성능은 이번 기능 시험에서 호출·평가하지 않는다.
