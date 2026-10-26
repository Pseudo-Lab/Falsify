# Falsify Confluence 팀 보관

원격 보관은 Falsify Confluence 팀 공간 하나다. 불러온 팀 기록은 이 브라우저의 localStorage에 자동으로 합치거나 남기지 않는다. 작업대 사용자 이름·비밀번호 가입, 비공개/공유 전환, 다른 기록 서버는 새 화면에 없다. 로컬 실행·검수·Harness와 JSON 백업/병합은 결과 화면의 기록판에 그대로 있다. 연결하거나 팀 보관을 임시로 열어도 그 기록을 지우거나 합치지 않는다.

이 문서는 화면 동작이다. 운영자의 OAuth 앱 등록, 비밀 값, 배포는 포함하지 않는다. 목 시험이 통과해도 실제 Atlassian 로그인이나 팀 공간 저장이 증명된 것은 아니다.

## 연결

검수, 결과, Harness 화면에 **Confluence에 연결**, **Confluence에 팀 공유**, **팀 기록 불러오기**가 있다.

연결을 누르면 사용자 클릭 안에서 `about:blank` 팝업을 먼저 연다. 그 다음 게이트웨이 응답의 로그인 주소가 Atlassian Falsify 연결로 확인된 뒤에만 그 창을 이동한다. 주소가 다르거나, 창이 닫혔거나, `opener`가 이 페이지가 아니면 창을 닫고 세션을 만들지 않는다. 응답이 오기 전에 연결을 끊으면 그 창을 닫고 늦은 콜백은 받지 않는다.

브라우저는 콜백 메시지의 출처가 게이트웨이 origin인지, `popup.source`가 그 창인지, nonce가 이번 연결의 값인지 확인한 뒤에만 세션을 받는다. 세션은 `falsify.confluence-session.v1`에 AES-GCM으로 감싼 불투명 값으로만 둔다. 실험 원장 키와 섞지 않고, API 키나 클라이언트 비밀을 입력받지 않는다. 저장 공간이나 암호 연산이 실패하면 연결되었다고 표시하지 않고, 다시 연결하라는 안내만 보여 준다. 로컬 기록은 그대로다.

**이 브라우저 연결 끊기**는 임시 열람이 열려 있지 않아도 `closeArchive`를 부른다. 그와 함께 화면에 보이는 팀 목록과 봉인된 세션 `falsify.confluence-session.v1`만 지운다. 로컬 원장, Harness 목록, 결과 기록판, JSON 백업은 남긴다. `closeArchive`가 실패하거나 그 함수가 아직 없어도 세션과 목록은 지운 상태를 유지하고, 로컬 기록은 지우지 않는다. Atlassian에 부여한 권한 전체가 취소되었다고 표시하지 않는다. Atlassian 정책이 면제를 준다고 말하지 않는다.

게이트웨이가 Confluence로 설정되지 않았거나 사이트·공간이 `https://falsify.atlassian.net` / `Falsify` / `65737`이 아니면 연 팝업을 닫고 로그인 주소로 이동하지 않는다. 운영자 설정이 필요하다.

## 팀 공유

동의 체크 뒤에만 지금 고른 실행과 사람 검수, 또는 선택한 등록 Harness 하나를 올린다. 로그인만으로 원장 전체가 올라가지 않고 모델을 실행하지 않는다. 요청은 `{archive, teamShare:true}` 한 번이다. 첫 흐름은 JSON이다. 추출문과 원응답이 들어 있을 수 있지만, 그것만으로 원본 PDF를 저장한 것은 아니다.

실험은 `reviewSnapshot`으로 지금 검수 화면의 기록만 읽고, Harness는 `cloudSnapshot`으로 고른 정의만 읽는다. 쓰기 전에 세션을 한 번 갱신한다. 갱신이 끝나기 전에는 보관을 보내지 않는다. 인증은 15초, 목록과 본문 읽기는 30초, 게시는 90초를 넘기면 그 요청만 끊는다. 게시가 끊기면 올라갔는지 알 수 없는 상태다. 같은 POST를 자동으로 다시 보내지 않고 **팀 기록 불러오기**로 확인한다. 충돌이면 덮어쓰지 않는다.

크기 한도는 보관 JSON 450만 자와 UTF-8 6MiB다. 게이트웨이가 더 작은 `maxArchiveBytes`를 알리면 그 바이트 한도를 쓴다. 넘는 보관은 잘라서 보내지 않는다.

갱신된 봉인 세션이 응답 헤더 `x-falsify-confluence-session`에 있으면 캐시를 바꾼다. 만료 시각은 `x-falsify-confluence-session-expires`다. 헤더 값은 화면에 보이지 않는다.

## 불러오기

목록은 제목과 페이지 식별자만 보여 준다. **이 보관 열기**는 `openArchive`로 임시 열람만 만든다. 로컬 원장, Harness 목록, JSON 백업에는 합치지 않는다. 성공하면 실험은 `#review`, Harness는 `#harness`로 이동한다. `#harness`가 Harness 화면의 실제 경로이고 `#agents`는 아니다. 등록 버튼을 누르기 전에는 등록되거나 실행되지 않는다.

화면에 **임시 열람. Confluence만 영구 보관. 새로고침·연결 해제·12시간 후 임시 기록 소멸. 보내지 않은 사람 검수는 Confluence에 팀 공유를 누르기 전에는 저장되지 않습니다.** 를 둔다. 실험 게시는 `reviewSnapshot`으로 고른 실행만 읽고, Harness 게시는 `cloudSnapshot`으로 고른 정의만 읽는다. 팀 공유 동의는 지금 고른 보관과 실행에 묶인다. **임시 열람 닫기**는 `closeArchive`만 부른다. 연결 끊기는 그 호출과 함께 원격 목록과 봉인 세션만 지운다. 성공한 실험 열람은 `#review`, Harness 열람은 `#harness`로 이동한다. 새로고침하면 메모리의 임시 열람은 없어진다. 열람이 거절되면 경로를 바꾸지 않는다. 다음 목록 커서가 짧은 토큰이 아니면 그 주소로 요청하지 않는다.

## 로컬 시험

합성 데이터만 쓴다. 운영 게이트웨이, 실제 논문, 모델, OAuth 앱 등록은 호출하지 않는다.

```text
node app/tests/confluence-store.spec.cjs
```

`review-bundle.mjs`가 아직 없어도 이 시험은 가짜 codec으로 동작한다. 통합 전에는 화면이 그 모듈의 `buildExperimentArchive`, `buildHarnessArchive`, `validateArchive`, `archiveHash`를 호출한다.
