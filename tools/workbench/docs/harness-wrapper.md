# Wrapper adapter — 기존 프로그램을 고치지 않고 연결하기

`wrapper` adapter는 이미 있는 프로그램(Falsify 출력 스키마를 모르는 프로그램)을 그대로 두고, **입력 전달 방식**과 **출력 → 단계별 스키마 변환**만 선언해 RED/BLUE harness로 쓰게 한다. 변환은 결정적 매핑뿐이며 앱이 프로그램 내용을 추론하거나 코드를 생성하지 않는다. 등록 계약 전반은 [harness-contract.md](harness-contract.md)를 따른다. README로 설정 초안을 받거나 JSON이 아닌 샘플을 손으로 매핑하는 보조 도구는 [harness-profile.md](harness-profile.md)에 있다.

## 빠른 시작 (데모 프로그램)

1. [app/examples/wrapper-profile.json](../app/examples/wrapper-profile.json)을 복사한다. 연결 대상은 합성 legacy 프로그램 [app/examples/wrapper_legacy_demo.py](../app/examples/wrapper_legacy_demo.py)(LegacyLint 2.3)다. 규칙 기반 키워드 처리만 하며 모델이 아니다.
2. `C:/ABSOLUTE/PATH/TO/...` 두 곳을 **내 PC의 실제 절대 경로**로 바꾼다(`python.exe`, 데모 `.py`). 이 경로는 자리표시자이며 다른 PC로 그대로 옮겨지지 않는다. 경로가 없으면 등록 검증에서 거절된다.
3. `settings.programCommit`에 내 프로그램의 commit hash를 적는다. harness 해시는 매핑·설정만 덮고 **실행 파일 내용은 덮지 않는다**.
4. RED로 쓰려면 `role`을 `red`, `id`를 다르게 바꾼다. 같은 `stageMaps`가 두 역할을 모두 처리한다.
5. Harness 화면에 등록 → RED/BLUE에서 선택 → 시작 시 사용자 코드 실행 동의. 등록만으로는 실행되지 않는다.

명령줄에서 먼저 확인해 볼 수 있다(앱이 붙이는 prompt 끝의 JSON을 흉내 낸 예):

```powershell
'policy {"segments":[{"id":"s0","label":"p1","text":"The method always works."}]}' | python app/examples/wrapper_legacy_demo.py --in prompt
```

출력은 Falsify 스키마가 아니라 legacy 형식이다:

```json
{"legacy": "LegacyLint/2.3", "outcome": "ok", "digest": "1 passage(s), 1 marker sentence(s)",
 "highlights": [{"para": "s0", "text": "The method always works.", "why": "legacy marker sentence"}],
 "items": [{"ref": "LL-1", "para": "s0", "tier": 0, "excerpt": "The method always works.", "rewrite": "",
            "note": "Absolute claim \"always\" is not qualified in the supplied text.",
            "support": [{"para": "s0", "text": "The method always works.", "why": "the flagged sentence itself"}],
            "caveat": "Keyword rule; no domain judgment."}],
 "picks": [{"para": "s0", "anchor": "The method always works.", "why": "reread around legacy marker"}]}
```

## 데모 대응표 (stageMaps)

앱은 호출마다 받은 `outputSchema`의 필드로 단계를 정한다: `summary`→`scan`, `targets`→`selection`, `candidates`→`red`, `findings`→`blue`.

| 단계 | 대상 스키마 | legacy 원천 |
|---|---|---|
| scan (다중 청크 읽기, RED/BLUE 공통) | status / summary / evidence[segmentId, quote, relation] | outcome / digest / highlights[para, text, why] |
| selection (BLUE 재독 대상) | status / targets[segmentId, anchor, reason] | outcome / picks[para, anchor, why] |
| red (최종 후보) | candidates[id, segmentId, level, before, after, rationale, evidence, uncertainty] | items[ref, para, tier, excerpt, rewrite, note, support, caveat] |
| blue (최종 지적) | findings[id, segmentId, quote, rationale, evidence, uncertainty] | items[ref, para, excerpt, note, support, caveat] |

인용(`quote`/`before`/`anchor`)은 `$from`으로 **문자 그대로 복사**된다. 매핑은 따옴표·대시·한글·공백을 바꾸지 않으며, 원문 일치 검증은 앱이 다시 한다.

## 입력 방식 예시

모두 `target`은 기존 stdio 형태(`executable` 절대 경로 + 문자열 `args`), shell 없음.

| input.mode | 프로그램이 받는 것 | 데모 args |
|---|---|---|
| `invocation` | stdin = 기존 invocation JSON(`prompt`, `outputSchema`, `settings`, `role`, `call` …) | `["…/wrapper_legacy_demo.py", "--in", "invocation"]` |
| `prompt` | stdin = prompt 원문 텍스트만 | `["…", "--in", "prompt"]` |
| `template` | stdin = invocation에 `template`을 적용한 JSON | `["…", "--in", "job"]` |
| `files` | stdin 비어 있음. 비공개 임시 폴더의 `invocation.json`, `prompt.txt`, `schema.json` | 아래 참고 |

```json
"input": {"mode": "template", "template": {"job": {"text": {"$from": "/prompt"}, "role": {"$from": "/role"}}}}
```

```json
"target": {"type": "stdio", "executable": "C:/…/python.exe",
  "args": ["C:/…/wrapper_legacy_demo.py", "--in", "files", "--invocation", "{input}", "--prompt-file", "{prompt}",
           "--schema", "{schema}", "--out", "file", "--out-file", "{output}"]},
"input": {"mode": "files"},
"output": {"source": "file", "format": "json", "stageMaps": {"…": "…"}}
```

`{input}` `{prompt}` `{schema}` `{output}`는 **인자 전체가 정확히 그 토큰일 때만** 생성 파일의 절대 경로로 바뀐다(`--x={input}`은 바뀌지 않음). 파일은 추출된 텍스트/JSON이며 원본 PDF 바이너리가 아니다. 출력 파일은 고정 이름 `output.json`뿐이다.

## 출력 계약

```json
"output": {"source": "stdout|file", "format": "json|json-fence", "path": "/envelope/report",
           "map": {"…": "…"}, "stageMaps": {"scan": {}, "selection": {}, "red": {}, "blue": {}}}
```

- `source: file`은 stdio target에서만. `json`은 JSON 값 하나(여러 줄 들여쓰기 허용). `json-fence`는 출력 전체가 ```` ```json ```` 블록 **하나**여야 한다.
- 거절: 앞뒤 설명문이 섞인 JSON, JSON Lines(값 두 개), `json` 모드의 fence, fence 밖 설명문, fence 두 개. 앱은 설명문 속 JSON을 찾아 주지 않는다.
- `path`(RFC 6901 pointer)를 먼저 적용하고 그다음 매핑한다. 해당 단계 `stageMaps`가 없으면 `map`, 그것도 없으면 그대로(identity) 쓴다.
- 매핑 지시어: `{"$from": "/pointer"}` 값 복사(`""`는 전체), `{"$each": "/array", "template": …}` 배열 원소마다 원소 기준으로 template 적용. 그 밖의 객체·배열·값은 literal/재귀 template. 없는 경로, 배열이 아닌 `$each`, 잘못된 지시어는 **실패**하며 기본값이나 성공으로 채우지 않는다.
- 제한: 설정 직렬화 32,000자, 매핑 깊이 20 / 항목 1,000. 알 수 없는 필드·단계 이름은 거절. eval·문자열 보간·스크립트 식 없음.
- 매핑 뒤에도 기존 출력 shape 검증과 근거 인용 검증이 최종 판정이다.

## abstain / refusal은 만들어지지 않는다

`status`는 프로그램 값을 복사할 뿐이다. 데모는 원문에 `LEGACY-NOTHING`이 있으면 `abstain`, `LEGACY-DECLINE`이면 `refusal`을 빈 목록으로 낸다. 반대로 abstain인데 항목을 내거나 원문에 없는 문장을 인용하는 프로그램은 매핑이 고쳐 주지 않고 앱 검증에서 실패한다.

## 현재 한계

- **값 변환 없음**: 매핑은 이름·구조만 바꾼다. 프로그램이 `PASS`/`FAIL`처럼 다른 status 값을 쓰면 `ok|abstain|refusal`로 바꾸는 작은 stdio wrapper를 직접 둔다.
- **내부 구현은 자유, 앱은 바깥 순서만**: 청크 읽기 → 선택 → 최종의 호출 순서·예산은 앱이 정한다. 프로그램 안의 모델·도구·하위 호출은 앱이 보지도 제한하지도 않는다.
- **stdio는 신뢰한 코드 실행**: OS sandbox가 아니다. 최소 환경·임시 cwd일 뿐 PC 파일·네트워크에 접근할 수 있다.
- **시간·크기·비용**: 호출당 180초, 출력 150,000바이트, 자동 재시도 없음. 프로그램 내부 토큰·비용·지출은 통제·집계하지 않는다. 과학적 성능 인증이 아니다.
- **원본 PDF 미전달**: 추출 텍스트만 전달한다. 원본 파일 전달과 전체 실행 오케스트레이션은 이후 과제다.
- **AI는 초안까지만**: 빌더 안의 「AI 초안 요청」은 README · 예시 · 샘플을 읽어 Claude Code CLI로 연결 프로필 **초안**을 받는다(Codex 미지원). 복사만 하는 매핑과 근거 인용이 검증된 `proposed` 초안만 사람이 승인해 빌더 칸을 채우며, 실행 · 등록은 하지 않는다. 수동 빌더 자체는 모델을 호출하지 않는다. 자세한 경계는 [harness-profile.md](harness-profile.md).
- **브라우저 미리보기는 인증이 아니다**: 공개 웹 화면은 형태·pointer 문법만 확인하며 실행 파일 존재나 실제 출력 호환을 검사하지 못한다. 실제 호환성은 로컬 broker 실행과 아래 테스트로 확인한다.
- HTTP target은 기존 공인 HTTPS 제한(DNS 고정, 인증 헤더·비밀 없음)을 그대로 따른다.

## 확인 범위

[app/tests/test_wrapper_compatibility.py](../app/tests/test_wrapper_compatibility.py)는 데모와 `app/tests/fixtures/wrapper_compat_*.py`를 실제 하위 프로세스로 실행해 다음을 확인한다: 같은 표본이 invocation/prompt/template/files × stdout/file × json/json-fence 모든 조합에서 같은 결과로 매핑됨, 인용 원문 보존, RED/BLUE 단일·다중 청크(BLUE 재독 포함) 종단 실행, abstain/refusal 비조작, 부정직 출력 거절, 설명문/JSON Lines/fence 오류, `path`, files 모드 계약, 매핑·adapter 검증 실패. `app/local/harness_wrapper.py`가 통합되기 전에는 모든 테스트가 **오류**로 끝나며 통과나 skip으로 보고하지 않는다.

```powershell
cd app; python -m unittest tests.test_wrapper_compatibility -v
```
