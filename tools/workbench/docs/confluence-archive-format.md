# Confluence 아카이브 형식과 임시 보기

원격 영구 저장은 Confluence 팀 아카이브뿐이다. 이 문서는 그 아카이브의 데이터 형식과, 브라우저가 가져온 아카이브를 메모리에서만 여는 동작이다. 가져온 기록을 localStorage에 자동으로 병합하지 않는다. 개인 계정 저장, D1 기록 백엔드, `falsify.private-review-bundle.v1`은 이 인터페이스가 아니다. 로컬 JSON 백업·병합과 로컬 Harness 라이브러리·결과 표는 그대로다. 이 문서가 Atlassian 정책의 면제를 뜻하지는 않는다.

구현은 `app/dist/review-bundle.mjs`다. DOM, 저장소, 네트워크, 자격 증명을 쓰지 않는다. harness·RED·BLUE·검수 검증기는 `{harness, red, blue, review}`로 넘긴다. 브라우저에서는 기존 전역 객체를 쓸 수 있지만, 모듈이 UMD 스크립트를 ESM으로 import하지는 않는다.

## 실험 아카이브

```json
{"schema":"falsify.confluence-archive.v1","kind":"experiment","id":"선택한 실행 ID","title":"사람이 읽는 제목","data":{"schema":"falsify.review-bundle.v1","selectedRunId":"선택한 실행 ID","ledger":{"schema":"falsify.experiment-ledger.v1","harnesses":[],"runs":[],"reviews":[]}}}
```

`buildExperimentArchive(snapshot, selectedRunId, validators)`는 검증된 `cloudSnapshot`에서 선택 사례의 의존 폐쇄만 복사한다. 원본 스냅샷과 응답 객체는 바꾸지 않는다. 출처도 아카이브 안에서는 그대로다.

폐쇄에 들어가는 것:

- 선택한 실행
- `snapshotOf`와 `sourceRunId` 조상
- 포함된 검수 `comparison.sourceRunId`의 RED와 그 조상
- 선택한 BLUE에 `sourceRunId`가 없으면, 출력 파일 해시가 같은 RED 최종 기록 중 원장 순서의 마지막 기록과 그 부모
- 포함된 실행이 쓰는 harness와, 그 실행의 검수 전체 (`findingAssessments`, `reviewContext`, 대조, 메모)

일치하는 RED가 없는 독립 BLUE는 BLUE만으로 닫을 수 있다. 순환, 없는 참조, 중복 ID, 폐쇄 밖의 실행·harness·검수, 해시 불일치는 거부한다. 자르지 않는다.

제목은 표시용이다. 역할, 응답/최종 스냅샷, 입력 이름 또는 해시 앞 12자, `createdAt`, 실행 ID를 잇는다. 500자를 넘으면 만들지 않는다.

## Harness 아카이브

`kind`는 `harness`다. `id`와 `data.hash`는 검증된 내용 해시와 같다. `data`는 `{config, hash}`뿐이다. 실행 기록이나 검수를 붙이지 않는다.

## 해시와 한도

`archiveHash`는 키를 정렬한 canonical JSON의 SHA-256이다. 배열 순서는 유지한다. 같은 내용이면 키 순서가 달라도 해시가 같다.

아카이브 JSON의 UTF-8 길이와 canonical JSON의 UTF-8 길이 모두 6 MiB 이하다. 실행 100건, harness 100개, 검수 1000건이다. 자르지 않는다. 로컬 원장의 기존 4.5M자 한도는 JSON 백업·병합에만 적용한다. 코덱은 한 원장 안에서 `imported-unverified` 스냅샷이 파일·Harness·모델·리비전·예산·요청 ID·원응답이 같은 기존 루트를 가리키는 것을 허용한다. 그 루트의 출처는 바꾸지 않는다. `imported-unverified`가 아닌 스냅샷은 부모와 출처가 같아야 한다. 부모 식별이 다르면 거부한다.

## 브라우저에서 열기

영구 사본은 Confluence에 있다. `FalsifyLab.openArchive(archive)`가 브라우저에서 여는 입구다. `FalsifyLab.restoreArchive(archive)`는 같은 함수의 호환 이름이며, 가져온 아카이브를 로컬 원장에 병합하지 않는다.

- 실험은 코덱으로 검증한 뒤 별도 메모리 원장에서만 연다. `{kind:'experiment', runId}`를 반환하고 기존 검수 경로로 그 실행을 연다. 화면 이동은 호출자가 한다
- 메모리 안의 실행 출처는 `imported-unverified`다. 로컬 원장, Harness 라이브러리, 결과 표, 실행 횟수는 바꾸지 않는다. 같은 ID가 로컬에 있어도 로컬 기록은 그대로 두고 화면의 원격 기록과 섞지 않는다. 닫거나 만료되면 선택 ID가 같아도 검수 화면을 로컬 기록으로 다시 그린다. 원격 화면의 판정 콜백은 그 화면이 끝난 뒤 로컬 대조를 바꾸지 않는다
- 원격에서 RED를 연 사실은 그 원격 보기에만 남는다. 같은 ID의 로컬 검수가 블라인드인지 RED 공개인지는 로컬에서 연 기록만으로 정한다
- 원격 사례에 대한 사람 검수는 그 메모리 원장에만 쌓인다. 팀 발행 전에는 localStorage에 쓰지 않는다
- `FalsifyLab.reviewSnapshot()`은 원격 보기가 열려 있으면 그 임시 원장의 복사를, 아니면 로컬 원장의 복사를 반환한다. 선택 사례를 명시적으로 발행할 때 쓴다. `cloudSnapshot()`은 항상 로컬 원장만 반환한다
- `FalsifyLab.closeArchive()`는 원격 실험 보기와 저장하지 않은 원격 검수, 그리고 원격 Harness 미리보기만 지운다. 이전에 선택했던 로컬 기록을 다시 고른다. 원격 보기가 아직 없어도 진행 중인 `openArchive` 검증을 세대 번호로 무효로 한다. 열 때마다 세대가 늘고, 닫을 때도 는다. 대기 뒤 원격 상태나 Harness 미리보기를 넣기 전에 그 세대가 아직 유효한지 확인한다. 더 나중에 시작한 열기가 남고, 늦은 열기는 새 보기를 닫거나 바꾸지 않으며 `code`가 `stale`인 거부로 끝난다. 페이지를 다시 불러오면 원격 보기는 없다
- 원격 실험 보기의 최대 유지 시간은 12시간이다. 타이머 전이라도 다시 보거나 검수 동작을 하면 만료된 화면을 지우고 로컬 화면으로 되돌린다. 탭을 닫지 않아도 같다
- Harness 아카이브는 `{kind:'harness', hash}`를 반환하고 편집기 미리보기만 한다. 등록·선택·실행하지 않는다. 이 미리보기도 최대 12시간이며 닫기, 페이지를 떠나기, 다시 불러오기로 끝난다. 편집기가 아직 그 원격 미리보기일 때만 이전 로컬 초안과 미리보기를 되돌린다. 사용자가 고쳤거나 직접 등록한 설정은 덮어쓰지 않는다

모델 `bind`는 요청 최상위에서 아카이브·묶음·Confluence 인증 재료를 제거한다. 키는 `archive`, `bundle`, `reviewBundle`, `restoreBundle`, `confluence`, `confluenceSession`, `oauth`, `accessToken`, `refreshToken`, `authorization`, `bearer`, `clientSecret`, `archiveSha256`, `archiveHash`, `teamShare`, `nonce`, `session`이다. 열기, 해시 계산, 검수 화면은 모델 호출이나 업로드가 아니다.

## 시험

통합 러너에 넣기 전에 이 파일만 실행한다.

```text
node --test app/tests/review-bundle.spec.mjs
node app/tests/cloud-ledger-hooks.spec.cjs
```

합성 기록만 쓴다. 통과해도 Confluence OAuth나 실제 저장이 확인된 것은 아니다.
