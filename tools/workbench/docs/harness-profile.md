# 연결 프로필 AI 초안 · 수동 샘플 매핑

[wrapper adapter](harness-wrapper.md) 빌더 안에 두 도구가 붙어 있다. 둘 다 **기존 프로그램을 실행하지 않고** 사람이 쓸 wrapper 설정을 돕는다. 등록과 실행은 기존처럼 따로 동의한다.

| 단계 | 하는 일 | 모델 호출 | 프로그램 실행 |
|---|---|---|---|
| 1. AI 초안 요청 | README · 명령 예시 · 샘플 출력으로 연결 프로필 **초안**을 받는다 | 버튼을 누를 때 1회 | 없음 |
| 2. 검토 · 승인 | `proposed` 초안만 빌더 칸에 채운다. 실행 파일 절대 경로는 사람이 확인 · 수정 | 없음 | 없음 |
| 3. 합성 매핑 시험 | 초안의 출력 설정을 **붙여넣은 샘플**에만 적용해 최상위 필드를 보여 준다 | 없음 | 없음 |
| 4. 등록 · 실행 | 기존 harness 등록과 RED/BLUE 실행 동의 | 기존 그대로 | 기존 그대로 |

## AI 초안 (`POST /api/harness/profile/propose`)

- **Claude Code CLI만 지원한다.** 로컬 companion의 기존 `ClaudeBackend`를 `--tools ""`와 빈 strict MCP 설정으로 한 번 호출한다(재시도 없음, 120초). Codex 요청은 `unsupported_provider`로 거절하며 다른 CLI로 바꿔 보내지 않는다. Codex의 read-only sandbox는 명령 실행 자체를 막지 못하고 사후 관찰만 하므로 이 경로에 쓰지 않는다. RED/BLUE 실행의 Codex 지원은 그대로다. capability는 `harnessProfileProposal: {available, schema, providers: ["claude"]}`.
- 붙여넣은 글은 신뢰하지 않는 데이터다. prompt 끝에 JSON으로만 넣고, 그 안의 지시는 따르지 않도록 지시한다. 오류는 고정 코드만 돌려주며 모델 · CLI 원문을 싣지 않는다.
- companion의 결정적 검사(`app/local/harness_profile.py`):
  - **원문 인용**: 근거 항목은 `{field, source, quote}` 정확히 이 키만, `field ∈ command|input|output|mapping`, `source ∈ readme|examples|sample`. quote가 그 칸에 글자 그대로 없으면 초안 전체를 버린다(`invalid_proposal`).
  - **복사만 허용**: AI가 쓴 `stageMaps`와 입력 template은 모든 값이 `$from`/`$each` 아래에 있어야 한다. literal 문자열 · 숫자 · null · 배열(`[]` 포함) · 빈 객체는 지어낸 status · finding이므로 초안 전체를 버린다. 사람이 쓰는 wrapper 매핑의 literal은 그대로 허용된다.
  - **`proposed` 조건**(하나라도 빠지면 `unknown`, 샘플이 JSON이 아닐 때만 `manual_mapping`): 실행 파일 이름과 자리표시자가 아닌 모든 인자가 README · 예시에 토큰 그대로 있음 / command · input 인용은 README · 예시에서, output 인용은 샘플에서, 매핑이 있으면 mapping 인용 / 샘플이 선언 형식(json · json-fence)으로 읽힘 / 제공된 **모든** 단계 매핑과 역할 자신의 단계를 샘플에 적용한 결과가 RED/BLUE 서비스가 실제로 보내는 스키마(`red_service.SCAN`·`RESULT`, `blue_service.SELECTION`·`RESULT`)를 통과 / 입력 template 경로가 실제 invocation에서 풀림(settings는 알 수 없으므로 빈 객체).
  - 모델은 상태를 낮출 수만 있고 올릴 수 없다.
- 브라우저(`app/dist/harness-profile.js`)는 companion 답도 데이터로 다시 검사한다: 정확한 키 · 코드, 복사만 허용, `proposed`이면 downgrade 없음, 인용 위치 · 횟수를 보낸 원문에서 다시 계산(companion은 Python code point, 브라우저는 UTF-16을 code point로 환산), `inputHash`와 `proposalHash`를 정렬 키 JSON(UTF-8) SHA-256으로 다시 계산. 하나라도 어긋나면 버린다. 초안을 받은 뒤 README · 예시 · 샘플 · 역할이 바뀌면 승인과 합성 시험이 막힌다.
- 승인 기록은 harness `settings.profileProposal`에 `proposalHash`, `inputHash`, CLI, `executableEdited`와 함께 남는다. 승인은 빌더 칸만 채운다.

## 수동 샘플 매핑 (`falsify.sample-conversion.v1`)

Markdown 등 JSON이 아닌 샘플을 사람이 **원문 구간 단위로** 단계 스키마 칸에 연결하는 도구다. 변환기(`falsify.manual-span-mapping` v1)는 추론하지 않는다.

- 값은 모두 원문 구간 그대로다. `level`은 구간이 정확히 `1`·`2`·`3`일 때만 숫자, `status`는 사람이 고른 `ok|abstain|refusal` 표시이며 근거 구간과 함께 `manual-label`로 기록된다. 빈 필수 칸은 채우지 않고 누락으로 보고한다.
- 내보내기에는 원문, UTF-8 바이트 수, SHA-256, 변경 이력(map · replace · label · unmap, 각 구간 해시와 origin, label 값), 한계 문구, 결과가 들어간다. 다시 시작하면(원문이나 단계가 바뀌어도) 이전 기록의 해시 · 단계 · 항목 수를 잇는다.
- 검증은 이력을 원문 위에서 처음부터 다시 실행해 항목 · 이력 · 결과가 완전히 같은지 본다. 이력 삭제 · 위조, 음수 · 빈 구간, 중복 경로, 여분 키, 한계 문구 · 단위 변경은 모두 실패한다.
- **이 기록은 붙여넣은 샘플에만 적용된다.** 실행 중 프로그램의 Markdown 출력을 변환하는 live 변환기가 아니다. 실제 연결에는 여전히 JSON 출력(또는 JSON을 내는 작은 wrapper)이 필요하다.

## 한계

- 샘플은 출력 하나다. 단계마다 다른 출력을 내는 프로그램이면 그 샘플로 풀리지 않는 단계 매핑은 `unknown`이 된다. 샘플의 segmentId · 인용이 실제 문서와 맞는지는 실행 때 서비스의 근거 검사가 판정한다.
- 제공하지 않은 scan/selection 등 다른 단계의 매핑은 이번 제안에서 검사하지 않으며 그 단계의 호환성은 미확인이다. `proposed`는 해당 역할의 샘플과 제공된 매핑을 검사한 결과이며, 전체 청크 실행의 호환성 인증이 아니다.
- 실행 파일 존재, 실제 출력, 프로그램 내부 동작은 확인하지 않는다. 초안의 `executed`는 항상 `false`다.
- 해시는 위변조 탐지용 자기 일관성 검사이며 서명이나 신원 증명이 아니다.

## 이후 설계 (아직 구현하지 않음)

현재 경로와 섞이지 않도록 별도 과제로 둔다.

- **바이너리 입출력**: 지금은 추출 텍스트만 전달하고 출력은 JSON 텍스트만 받는다. 원본 PDF 등 바이너리를 넘기려면 files 모드에 읽기 전용 원본 사본(`{source}` 자리표시자, 크기 · 형식 상한, 해시 기록)을 추가하고, 바이너리 출력은 별도 산출물 디렉터리와 형식별 검증기를 거친 뒤에만 단계 스키마로 들어가야 한다. 청크 분할(긴 텍스트를 여러 scan 호출로 나누는 것)과는 독립이며, 바이너리는 청크로 쪼개 보내지 않는다.
- **완전 자율 오케스트레이션**: 프로그램이 스스로 여러 단계를 돌리게 하려면 앱이 지금 정하는 호출 순서 · 예산(scan → selection → final)을 프로그램에 위임하는 별도 계약이 필요하다. 이때도 BLUE 격리(RED 계획 · 정답 · 파일명을 BLUE에 넘기지 않음)는 앱이 보내는 입력 단계에서 유지되어야 하며, 프로그램 내부의 격리는 앱이 보증할 수 없음을 결과에 표시해야 한다. 최종 출력은 지금처럼 서비스의 shape · 근거 인용 검사를 통과해야 한다.
- AI 초안이 이 두 기능을 제안하는 것은 위 계약이 생긴 뒤의 일이다.
