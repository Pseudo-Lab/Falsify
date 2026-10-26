# Confluence 게이트웨이

이 문서는 `cloud/api`의 상태 없는 Confluence OAuth/아카이브 릴레이를 설명한다. 공유 계약은 `docs/confluence-storage-contract.md`다. 이 후보 브랜치는 배포되지 않았다. `cloud/api/test/confluence-gateway.test.mjs`는 네트워크 없이 주입한 `fetch`로만 동작하므로, 테스트 성공은 실제 Atlassian 인가나 Confluence 저장의 증거가 아니다. 공간 멤버의 편집 가능 표시나 부모 페이지의 상속 권한도 라이브 OAuth 증거가 아니다. 앱 스코프, 시크릿, 콜백 호스트, 배포 확인은 운영자가 맡는다.

## 맡은 경로

접두사는 `/v1/confluence`다.

| 메서드와 경로 | 동작 |
| --- | --- |
| `GET /capabilities` | `{provider:'confluence',configured,siteUrl,spaceKey,spaceId,maxArchiveBytes}` |
| `POST /auth/start` | 본문 `{nonce,returnOrigin}` → `{authorizeUrl}` |
| `GET /auth/callback` | opener에게만 `postMessage` |
| `POST /auth/refresh` | 봉인된 세션을 회전 |
| `GET /archives?cursor=` | 준비된 자식 페이지만 `{items,nextCursor}`. `nextCursor`는 서버 커서를 AES-GCM으로 봉인한 base64url이며 `=`를 포함하지 않는다 |
| `GET /archives/{pageId}` | 검증된 `{pageId,webUrl,archive,archiveSha256}` |
| `POST /archives` | 본문 `{archive,teamShare:true}` |

아카이브 검증은 데이터 소유 모듈 `app/dist/review-bundle.mjs`의 `validateArchive`와 `archiveHash`를 쓴다. 게이트웨이는 `{harness, red, blue, review}` 검증기를 직접 넘긴다. 모듈이 없으면 `503 archive_validator_unavailable`이며, 저장된 아카이브가 있는 것처럼 응답하지 않는다. 통합 전에는 테스트 주입만 허용된다.

`GET /capabilities`의 `maxArchiveBytes`는 `6291456`(UTF-8 6 MiB)이다. 응답에 시크릿, 세션, 부모 페이지 ID는 없다.

## 세션

중앙 Atlassian OAuth 2.0 (3LO) 앱 하나다. 사용자 API 토큰이나 사용자별 개발자 앱은 받지 않는다. 비밀번호 세션 `fss_`와 초대 코드 `fsi_`는 Confluence 요청을 인가하지 못한다.

`CONFLUENCE_SESSION_KEY`는 32바이트 키의 base64다. 생성 예:

```sh
openssl rand -base64 32
```

상태는 `falsify.confluence.oauth-state.v1`, 세션은 `falsify.confluence.session.v1` 목적의 AES-256-GCM 봉투다. 목적은 AAD로 묶여 상태 토큰을 세션으로 쓸 수 없다. 상태 TTL은 10분이고 호출자의 `nonce`와 허용된 `returnOrigin`을 담는다. 세션 봉투의 절대 만료는 12시간이며 갱신해도 늘어나지 않는다. 액세스 토큰은 만료 60초 전후부터 갱신하고, 회전은 16회에서 멈춘다. 그 이후와 봉투 만료는 `401 session_expired`다.

갱신이 일어나면 응답 헤더 `X-Falsify-Confluence-Session`에 새 봉투가 실리고 `Access-Control-Expose-Headers`에 그 이름만 공개된다. 오류 응답에도 같은 헤더가 붙을 수 있다. 브라우저는 이 값을 로컬 연결 상태로만 보관한다. 연결 해제는 그 로컬 값을 지울 뿐 Atlassian 쪽 전역 동의 철회가 아니다.

콜백은 `Cache-Control: no-store`, `Referrer-Policy: no-referrer` HTML이다. `window.opener`가 있을 때만 봉인된 세션을 `{type:'falsify.confluence.session.v1',nonce,session,expiresAt}`로 보내고 `targetOrigin`은 상태에 묶인 출처와 같다. 설정이 없거나 상태가 틀리거나 사이트가 허용 사이트가 아니면 세션 없이 다시 연결하라는 문구만 보여 준다. 인가 코드, 액세스 토큰, 클라이언트 시크릿은 URL, HTML, 로그에 넣지 않는다.

워커 로그는 경로 템플릿, 메서드, 상태 코드, 소요 시간만 남긴다. CORS는 허용된 출처만 `Access-Control-Allow-Origin`에 그대로 넣으며 `*`를 쓰지 않는다. 콜백은 Atlassian의 최상위 이동이라 프론트 출처 검사가 면제되고, 그 경우에도 반사된 허용 출처 헤더는 없다.

## 발행

원격 저장은 Confluence 팀 공간뿐이다. `teamShare`가 `true`가 아니면 `400 team_share_required`다. 비공개 모드, 공개 인터넷 링크, 임의 업스트림 프록시는 없다.

모든 쓰기 전에 다음을 확인한다.

1. `https://api.atlassian.com/oauth/token/accessible-resources`에서 출처가 정확히 `https://falsify.atlassian.net`인 항목이 하나일 것.
2. 그 cloud ID의 공간 `65737` 키가 `Falsify`일 것.
3. 설정된 부모 페이지가 그 공간 안에 있을 것.

사이트, 공간, 부모가 어긋나면 페이지를 만들지 않는다. `CONFLUENCE_SITE_URL`, `CONFLUENCE_SPACE_KEY`, `CONFLUENCE_SPACE_ID`가 위 고정값과 다르면 `configured`는 `false`다. 클라이언트 시크릿, 세션 키, 콜백 URL, 부모 ID 중 하나라도 없으면 연결된 것처럼 응답하지 않는다. 배포 기본 부모 ID는 `8355842`다.

목록의 `nextCursor`는 Confluence가 준 원문 커서가 아니다. 원문은 `=`를 포함할 수 있어 프론트의 base64url 규칙과 맞지 않는다. 게이트웨이는 그 값을 `falsify.confluence.cursor.v1`으로 cloudId와 부모 페이지에 묶어 AES-GCM 봉인하고, 패딩 `=`를 뺀 base64url만 돌려준다. 다른 사이트나 다른 부모의 봉인, `=`가 들어 있는 원문 커서는 `400 invalid_cursor`다.

페이지 본문은 이스케이프된 짧은 요약이다. 코덱은 `app/dist/review-bundle.mjs`를 정적 import로 불러 검증한다. 첫 흐름은 JSON만 저장한다고 본문에 적혀 있으며 PDF를 저장하지 않는다. 원문은 SHA-256 파일명의 첨부 `{archiveSha256}.json`이다. 속성 `falsify-archive`에는 `kind`, `id`, `archiveSha256`, `ready:true`만 넣는다. 라벨 `falsify-archive-ready`는 첨부 검증과 속성 다음에 마지막으로 붙인다. 라벨이 없는 페이지는 목록과 단건 조회에서 성공으로 나오지 않고 단건은 `404`다.

같은 제목의 현재 페이지가 다른 부모에 있거나, 준비 라벨의 해시나 ID가 다르면 `409 archive_conflict`이며 덮어쓰지 않는다. ID, 종류, 해시가 같은 준비된 페이지는 `alreadyExisted:true`로 다시 쓰지 않는다. 기존 첨부와 이전 리비전은 삭제하지 않는다. 아카이브 제목은 코덱과 같이 500자까지다. 제어 문자와 DEL은 거절한다.

부모 페이지와 그 조상 페이지의 읽기 제한을 본다. `GET /wiki/api/v2/pages/{id}/restriction-state`의 `VIEW_RESTRICTED`는 직접 읽기 제한이다. OpenAPI는 이 값이 상속 제한을 포함하지 않는다고 적는다. 그래서 `GET /wiki/api/v2/pages/{id}/ancestors`로 조상 id를 읽고 각 조상에도 같은 restriction-state를 호출한다. `OPEN`과 `EDIT_RESTRICTED`만 통과한다. 조상이 페이지가 아니거나, 응답이 없거나, 다음 링크가 `api.atlassian.com`의 같은 클라우드 ancestors 경로가 아니면 `403 parent_not_allowed`다. 공간 멤버가 편집할 수 있다는 UI 표시는 이 검사를 통과했다는 뜻이 아니다.

첨부 다운로드는 v1 `GET /wiki/rest/api/content/{id}/child/attachment/{attachmentId}/download`만 호출한다. 이 연산은 바이너리를 직접 주지 않고 리다이렉트한다. 게이트웨이는 `redirect: 'manual'`로 최대 3홉만 따라간다. 첫 요청만 `api.atlassian.com`의 그 다운로드 경로이며 Authorization을 붙인다. 호스트가 바뀌면 Authorization과 Cookie를 붙이지 않는다. 다음 호스트는 `api.media.atlassian.com`만 허용한다. 이 호스트는 [Forge runtime egress permissions](https://developer.atlassian.com/platform/forge/runtime-egress-permissions/)가 Atlassian API 리다이렉트의 내부 도메인으로 이름을 적는다. 경로는 `/file/{uuid}/binary`만 허용하고 쿼리는 2048자 이하다. 다른 호스트, 서브도메인, 경로, 루프, 6 MiB 초과 본문은 거절한다. 임의 프록시가 아니다.

쓰기가 시작된 뒤의 단절은 `409 write_unknown` 또는 `409 write_partial`과 `readBack:true`다. 페이지 ID를 알게 된 뒤에는 `pageId`를 함께 준다. 클라이언트는 목록이나 단건을 다시 읽기 전에 같은 발행을 자동 반복하지 않는다. 아직 아카이브 쓰기가 시작되기 전의 `429`는 `rate_limited`이고, `Retry-After`가 1자리에서 6자리 숫자일 때만 그 헤더를 전달한다. 쓰기가 시작된 뒤의 `429`는 `write_partial`이다.

게이트웨이 경로에는 D1, KV, R2 바인딩이 없어도 된다. 이 경로는 `env.DB`를 읽지 않는다.

## 레거시 쓰기

`CONFLUENCE_ONLY=true` 또는 `'true'`일 때만 다음 쓰기가 `410 storage_moved`다.

- `POST /v1/auth/register`
- `POST /v1/auth/login`
- `POST /v1/auth/password`
- `POST /v1/auth/sessions/revoke`
- `POST /v1/logout`
- `POST /v1/records`
- `PATCH /v1/records/:id`
- `DELETE /v1/records/:id`

메시지 본문은 `Remote records moved to the Falsify Confluence archive. This account or record write is no longer accepted.`다. `wrangler.jsonc`의 배포 기본값은 `"true"`다. 레거시 스위트가 계정 쓰기를 유지하려면 그 테스트 env에 `CONFLUENCE_ONLY: "false"`를 명시한다. 읽기와 내보내기(`GET /v1/health`, `GET /v1/me`, `GET /v1/records`, `GET /v1/records/:id`)는 플래그와 관계없이 남아 있다. 예전 D1 바인딩이 없으면 그 읽기는 `503 not_configured`이며 `410`이 아니다. D1 스키마는 지우거나 바꾸지 않는다. 로컬 브라우저 기록과 이미 있는 Confluence 페이지도 이 릴레이가 삭제하지 않는다.

## 공식 스코프

인가 URL의 `scope`는 아래 9개만, 이 순서로, 한 칸으로 이어 보낸다. 2026-10-23 갱신된 [Confluence OAuth 2.0 (3LO) 스코프](https://developer.atlassian.com/cloud/confluence/scopes-for-oauth-2-3LO-and-forge-apps/)는 연산 페이지에 classic 스코프가 있으면 그것을 쓰고, granular 스코프는 classic을 쓸 수 없을 때만 쓰라고 한다. 연산별 값은 [스코프 결정 방법](https://developer.atlassian.com/cloud/oauth/getting-started/determining-scopes/)대로 각 REST 연산과 [Confluence Cloud REST API v2 OpenAPI](https://dac-static.atlassian.com/cloud/confluence/openapi-v2.v3.json)의 `x-atlassian-oauth2-scopes`에서 확인했다. `offline_access`는 [3LO 문서](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)에서 리프레시 토큰을 받기 위한 스코프다. `GET https://api.atlassian.com/oauth/token/accessible-resources`에는 별도의 Confluence 제품 스코프가 없다.

| 호출 | 공식 스코프 | 근거 |
| --- | --- | --- |
| 인가 URL과 `POST https://auth.atlassian.com/oauth/token`의 `refresh_token` | `offline_access` | 3LO 문서의 리프레시 토큰 절 |
| `GET /wiki/api/v2/spaces/65737` | `read:space:confluence` | v2 OpenAPI `GET /spaces/{id}` |
| `GET /wiki/api/v2/pages`, `GET /wiki/api/v2/pages/{id}?include-labels=true&include-properties=true`, `GET /wiki/api/v2/pages/{id}/children`, `GET /wiki/api/v2/pages/{id}/restriction-state` | `read:page:confluence` | v2 OpenAPI. restriction-state의 `VIEW_RESTRICTED`는 직접 읽기 제한만 나타낸다 |
| `GET /wiki/api/v2/pages/{id}/ancestors` | `read:content.metadata:confluence` | v2 OpenAPI `GET /pages/{id}/ancestors`. 상속 읽기 제한을 보기 위해 조상 id만 가져온다 |
| `POST /wiki/api/v2/pages` | `write:page:confluence` | v2 OpenAPI `POST /pages` |
| `POST /wiki/api/v2/pages/{id}/properties` | `read:page:confluence`, `write:page:confluence` | v2 OpenAPI `POST /pages/{page-id}/properties` |
| `GET /wiki/api/v2/pages/{id}/attachments` | `read:attachment:confluence` | v2 OpenAPI `GET /pages/{id}/attachments` |
| `POST /wiki/rest/api/content/{id}/child/attachment` | classic `write:confluence-file` | [Create attachment](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content---attachments/). 헤더 `X-Atlassian-Token: nocheck`가 필요하다 |
| `GET /wiki/rest/api/content/{id}/child/attachment/{attachmentId}/download` | classic `readonly:content.attachment:confluence` | 같은 페이지의 Get URI to download attachment. 응답은 리다이렉트다 |
| `POST /wiki/rest/api/content/{id}/label` | classic `write:confluence-content` | [Add labels to content](https://developer.atlassian.com/cloud/confluence/rest/v1/api-group-content-labels/) |

v2 OpenAPI에는 `POST /pages/{id}/attachments`와 `POST /pages/{id}/labels`가 없다. 그래서 업로드와 라벨은 위 v1 연산을 쓴다. 같은 v1 연산의 granular 대체값은 업로드 `read:content-details:confluence`와 `write:attachment:confluence`, 다운로드 `read:attachment:confluence`, 라벨 `read:label:confluence`와 `write:label:confluence`다. classic이 등록되면 이 대체값은 인가 URL에 넣지 않는다.

자식 목록은 문서에 Deprecated로 표시된 `GET /pages/{id}/children`을 쓰고 스코프는 `read:page:confluence`다. 대체 연산 `GET /pages/{id}/direct-children`의 스코프는 `read:hierarchical-content:confluence`이며 이 게이트웨이는 그 연산을 호출하지 않는다.

## 운영자 체크리스트

클라이언트 시크릿, 세션 키, 콜백의 전체 URL이 없으면 `configured:false`가 정상이다. 이 상태는 연결된 세션을 만들지 않는다.

1. 중앙 3LO 앱은 하나다. 비공개가 아닌 클라이언트 ID `LQL1zmOGHXyk8V4ShnSdPJCc5MzJWYDN`는 `wrangler.jsonc`의 `ATLASSIAN_CLIENT_ID`에 있다.
2. 운영자가 저장한 프로덕션 콜백 경로는 `/v1/confluence/auth/callback`이다. 쿼리, 해시, 사용자 정보는 없다. 워커 호스트를 포함한 전체 URL은 시크릿 `ATLASSIAN_CALLBACK_URL`에 넣는다. `http`는 `localhost` 또는 `127.0.0.1`에서만 받는다.
3. 개발자 콘솔의 동의 스코프는 위 표의 9개와 같게 둔다. `read:content.metadata:confluence`는 조상 id를 읽기 위한 것이며 본문 읽기 권한을 넓히지 않는다. 제한 목록을 읽는 classic `read:confluence-content.all`은 요청하지 않는다.
4. 시크릿은 `ATLASSIAN_CLIENT_SECRET`과 `CONFLUENCE_SESSION_KEY`뿐이다. 세션 키는 32바이트를 base64로 둔다. `openssl rand -base64 32`
5. 아카이브 부모는 저장소 기본값 `CONFLUENCE_PARENT_PAGE_ID=8355842`다. 운영자는 이 페이지를 Falsify 공간 `65737` 안에서 워크스페이스 페이지 `66042` 아래에 만들었다고 보고했다. 게이트웨이는 `8355842`만 부모로 쓰고 `66042`에는 페이지를 만들지 않는다. 콘솔에 공간 멤버가 편집할 수 있다고 표시된 것은 이 후보가 확인한 라이브 권한이 아니다.
6. 고정 공개값은 사이트 `https://falsify.atlassian.net`, 공간 키 `Falsify`, 공간 ID `65737`이다. `REMOTE_PROVIDER`는 `confluence`만 쓴다.
7. 프론트 출처는 `ALLOWED_ORIGINS`에 정확한 origin만 둔다. 예: `https://shinick-han.github.io`.
8. 배포 기본값 `CONFLUENCE_ONLY`는 `true`다. 레거시 계정 쓰기를 유지하는 테스트만 `"false"`를 명시한다. 데이터베이스 삭제나 자동 재업로드는 하지 않는다.
9. 통합 후 운영자가 두 브라우저에서 발행, 목록, 읽기, 잘못된 출처/공간/부모, 갱신, 부분 쓰기를 확인한다. 그 확인 전에는 배포되었다고 하지 않는다.

워커 이름 `falsify-cloud-api`, `compatibility_date` `2026-10-19`, `nodejs_compat`, `cpu_ms` 1000, 기존 D1 데이터베이스 이름은 유지한다. 새 유료 저장소나 패키지는 추가하지 않았다.
