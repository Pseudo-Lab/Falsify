# Confluence-only team archive contract

## Product decision

**2026-10-26 user decision:** Confluence-loaded experiments use a temporary in-memory native review view, not an automatic persistent merge into browser localStorage. Preserve all preexisting local records and backups. Remote view and its draft reviews end on reload, disconnect/explicit close, or at most 12 hours. Explicit publication writes the chosen case and new reviews back to Confluence. Do not claim any privacy-reporting exemption before operator verification.

Ledger exposes `FalsifyLab.openArchive(archive)` (validated temporary view, experiment returns `{kind:'experiment',runId}`, Harness preview only), `reviewSnapshot()` (active review source clone for experiment publication), `closeArchive()` (remote view only). `cloudSnapshot()` stays local-only for Harness/library publication. A compatibility `restoreArchive` must not silently persist fetched records. Native review uses the temporary source while all local persistence, Harness selection, result metrics and JSON backup keep their original local target. Same IDs in the remote view do not overwrite local records. Remote item judgments remain memory-only until explicit team publication. UI calls `openArchive`, navigates to the existing native route, labels the temporary state and expiry, and clears remote view/list when disconnecting. No auto-execution, registration, whole-ledger upload or historical republishing.

Confluence is the ONLY remote record store. Publishing means sharing with all Falsify space members; there is no private/shared selector, Workbench username/password signup, or alternate D1/R2/KV record backend in the new UI. GitHub Pages remains the static frontend. Original browser-local drafts and explicit JSON backup/import stay available and are labelled local. Fetched archives and list metadata stay memory-only for at most 12 hours. Existing data is preserved; no database/resource deletion or automatic republication of historical private records.

The existing Cloudflare Worker becomes a thin OAuth and Confluence API relay. It stores NO paper, run, harness, review or OAuth session in a database/object store. No new paid storage, paid plan or automatic upgrade. Actual plan/account limits must be checked separately; absence of record storage is not a promise that every provider has unlimited free compute.

## Authentication and confinement

Use ONE centrally configured Atlassian OAuth 2.0 (3LO) application, acting as each user. No collection of users' API tokens or per-user developer apps. OAuth client secret and envelope encryption key are server secrets only. Use current official Atlassian scopes/API guidance. Required configuration: `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET`, `CONFLUENCE_SESSION_KEY`, `CONFLUENCE_PARENT_PAGE_ID`, fixed site `https://falsify.atlassian.net`, space key `Falsify`, space ID `65737`, exact allowed frontend origins, configured callback URL.

OAuth state is short-lived, purpose-bound and signed/sealed, binding the caller's random nonce and allowed return origin. Callback messages a sealed opaque session to its opener using exact `targetOrigin`; no token/secret in URL, logs, browser-readable source, archive or model requests. Browser verifies callback origin, popup source and nonce before accepting. Session is an expiring authenticated-encryption envelope (Web Crypto), with rotation/expiry checks and safe reconnect behavior. Its browser cache is separate from local experiment data. Browser disconnect clears the local connection only; do not claim global grant revocation. No silent fallbacks when unconfigured.

All remote operations use the user's Atlassian permission and are confined to this site, space and configured archive parent. Discover the cloud ID only from the exact allowed site in accessible-resources. No arbitrary proxy URL, arbitrary page publishing, cross-site cloud ID or credential forwarding across download redirects. New archive pages inherit the configured team's readable location; do not create public internet links or quietly widen existing restrictions. Report a restricted/misconfigured parent rather than claim team-wide availability. No hardcoded root personal credential or service-account impersonation.

## Portable data contract (data owner)

`falsify.review-bundle.v1`:

```json
{"schema":"falsify.review-bundle.v1","selectedRunId":"...","ledger":{"schema":"falsify.experiment-ledger.v1","harnesses":[],"runs":[],"reviews":[]}}
```

Copy the minimal selected-case dependency closure without mutating raw runs: selected run, snapshot/sourceRunId ancestors, matching RED final output plus parent for independent BLUE, and RED sources referenced by included review comparisons. Include used harness versions and reviews, preserving findingAssessments/reviewContext. Unknown remains unknown. Reject malformed hashes, dangling/cyclic references, conflicting IDs and size/count limits; never truncate. Opening archives uses existing full ledger validation and an isolated memory view, never a persistent merge. Existing local execution records retain provenance; remote records are imported-unverified, never new executions. No model execution, CLI consent or code installation during restore.

`falsify.confluence-archive.v1`:

```json
{"schema":"falsify.confluence-archive.v1","kind":"experiment","id":"selected-run-id","title":"Human readable title","data":{"schema":"falsify.review-bundle.v1","selectedRunId":"...","ledger":{"schema":"falsify.experiment-ledger.v1","harnesses":[],"runs":[],"reviews":[]}}}
```

Standalone Harness archives use `kind: "harness"`, `id` equal to the validated harness content hash, and `data: {"config": {}, "hash": "..."}`. Loading a Harness previews it through the existing explicit registration flow; never execute it. Reviews travel with experiments rather than orphan standalone review records.

Pure ESM `app/dist/review-bundle.mjs` exports:

- `buildExperimentArchive(snapshot, selectedRunId, validators)` -> Promise of archive.
- `buildHarnessArchive(harnessRecord, validators)` -> Promise of archive.
- `validateArchive(archive, validators)` -> Promise of normalized deep copy.
- `archiveHash(archive)` -> Promise of SHA-256 over deterministic canonical JSON.

`validators` accepts `{harness, red, blue, review}` using existing validators; browser defaults may use existing globals. No DOM, storage, fetch, new framework or API credentials in this module. Reuse established validators and limits. Gateway supplies validators explicitly. Preserve exact raw response objects; no fabricated findings, approvals, coverage or scores.

The compatibility alias `FalsifyLab.restoreArchive(archive)` uses the same temporary view as `openArchive`, never persistent restoration. Experiment opening selects the remote run in native review; caller owns navigation. Harness opening previews without registration or execution. Strip archive/bundle/Confluence auth material from model bind requests.

## Gateway contract (backend owner)

Prefix `/v1/confluence`. Existing compatibility date/dependencies stay unless a concrete change is justified.

- `GET /capabilities` -> `{provider:'confluence',configured,siteUrl,spaceKey,spaceId,maxArchiveBytes}`; no secrets.
- `POST /auth/start` body `{nonce,returnOrigin}` -> `{authorizeUrl}`. Enforce request Origin and return-origin allowlist.
- `GET /auth/callback` -> minimal no-store HTML posting `{type:'falsify.confluence.session.v1',nonce,session,expiresAt}` only to the bound opener origin. Close/reconnect gracefully if no valid opener.
- `POST /auth/refresh` with sealed bearer -> updated sealed session. Bound rotation and expiry; never log plaintext tokens. Handle auth refresh before any write, not retrying an uncertain write.
- `GET /archives?cursor=...` -> `{items:[{pageId,title,updatedAt,webUrl}],nextCursor}`. Discover completed labelled archive pages under the configured parent only; no arbitrary pagination URLs.
- `GET /archives/{pageId}` -> `{pageId,webUrl,archive,archiveSha256}` after confinement, bounded download, hash and archive validation.
- `POST /archives` body `{archive,teamShare:true}` -> `{pageId,webUrl,archiveSha256,stored:true,alreadyExisted}`. Explicit consent required. No automatic repeated POST after unknown outcome.

Every authenticated request uses an opaque sealed bearer from OAuth. Frontend calls serialize auth refresh; session changes invalidate late callbacks. If a gateway operation refreshes a token, define/document an exposed response header for the replacement sealed session. Reject credentialed wildcard CORS. OAuth callback and API logs must exclude query values, tokens, headers, paper text and bodies. Bounded fixed-code errors with actionable copy.

Page body holds a short escaped human summary; lossless JSON archive is an immutable content-hash-named attachment. Content properties/labels may hold small nonsensitive IDs/hashes, not raw records or credentials. Publish a ready marker/manifest last; incomplete page/attachment combinations are not shown as successful archives. Handle same archive retries by ID+hash and preserve previous versions; do not overwrite unrelated pages/files. Explicitly report partial/unknown outcomes and allow readback instead of blind retries. Honour upstream rate limits. Maximum archive JSON 6 MiB UTF-8 (also preserve existing local-ledger 4.5M-character bound); use bounded reads/streaming and no unrelated provider quota increases. Optional original/edited PDFs require explicit actual file bytes and matching hashes; never claim the PDF was saved when only extracted text exists. First archive flow may store JSON only and must say so.

`CONFLUENCE_ONLY=true` retires legacy record/account writes with a fixed 410 storage-moved response; new UI never offers them. Preserve old data/read-export for migration when a legacy binding exists. No destructive D1 deletion or new private-store implementation. Gateway Confluence routes must work without any D1/R2/KV binding. Retired account passwords/sessions never authorize a Confluence request.

## Native interface (frontend owner)

Replace old shared-record login/upload UI with Confluence-only controls, preserving airport design and independent RED/BLUE/review/Harness workflows. Place `Confluence에 연결`, `Confluence에 팀 공유`, `팀 기록 불러오기` near saved run review and Harness management. All uploads explicitly mean Falsify team access. No pretend personal private mode and no requirement to repeat models after browser changes. Show connection/missing-config/permission/empty/archive-too-large/unknown-write/conflict states. Open archives in a separate temporary native review view; retain existing local records and backup/import, never clear them on disconnect. Standalone Harness import remains preview -> explicit registration. Never auto-publish every local record or operate a CLI on login/restore.

## Acceptance boundary

Cloud workers use code and synthetic fixtures only: no real papers, account secrets, model calls, deployment, app registration, permissions change or production writes. Separate branches/file ownership. Report immutable candidates and focused checks, then stop. Coordinator reviews/integrates before operator OAuth setup and staging/live verification. Require same Confluence team in two independent browser stores: publish, list, load, RED/BLUE relation, item review and no duplicate executions. Also test wrong origin/site/space/parent, missing permission/config, altered archive/hash, stale session, callback mixup, malformed pagination/redirect, collision/storage failure, unknown/partial write, retired D1 writes and existing local data preservation. Mock tests are not live authorization or storage proof.
