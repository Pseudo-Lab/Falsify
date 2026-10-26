# Reload recovery for RED and BLUE jobs

A RED or BLUE run writes one browser record before `POST /api/{role}/jobs`. After a reload the page only calls `GET /api/{role}/jobs/{requestId}`. It does not POST again and it does not start another model call.

## What is stored

The record lives in this browser under `falsify.pending-job.red.v1` or `falsify.pending-job.blue.v1`. It keeps the extracted text segments, the original `requestId`, the harness hash from `FalsifyHarness.hash` (the same digest `harness.resolve` returns), the source and file SHA-256, the document revision, the public companion instance descriptor `ci1.` plus 64 hex characters, the local canonical checksum, and `requestBytesDigest`.

It does not keep the original PDF or any other file bytes, and it does not keep the pairing secret, the session secret, or a bearer token. BLUE records accept only the BLUE document fields. RED gold, a RED filename, and a RED plan are not stored on a BLUE record. Cloud sharing is unchanged. Objects nested deeper than 64 levels are rejected, and a secret-shaped key at any scanned depth is rejected. A deep key is not skipped.

## Identity required on GET

A completed, running, failed, or cancelled body is accepted only when every one of these is present and exact:

- `id` equals the stored `requestId`
- `role` equals the stored role
- `sourceHash` and `revision` equal the stored document
- `harnessHash` equals the stored harness hash
- `requestBytesDigest` equals the SHA-256 of the exact JSON bytes posted for that trial
- `companionInstance` equals the descriptor stored at start and the descriptor of the companion that is connected now

A missing field is a mismatch. It is not treated as optional. The result still has to pass `FalsifyDocumentRed.validateResponse` or `FalsifyDocumentBlue.validateResponse`. The same `requestId` is kept. `requestBytesDigest` is the hash of `JSON.stringify` of the stored request, captured before POST, and the companion hashes the raw HTTP body before it parses JSON. A later trial with the same id, source, and harness but a different `maxCalls` or RED `level` has a different byte digest, so GET does not apply that other result.

The browser also keeps `requestFingerprint`, the SHA-256 of its own canonical JSON. That checksum is local. It is not compared with Python. The companion's idempotency key remains the parsed, key-sorted fingerprint and is not returned by GET. Python and JavaScript canonical JSON differ on float spelling and key order; the wire digest is what both sides share. `harnessCanonical` remains the harness digest only.

The companion publishes `companionInstance` on `GET /api/capabilities`. It is a hash of the process instance id, not the launcher restart secret. A different descriptor means this process is not the one that accepted the job (a restart, or another companion). The page does not GET that job and does not start a new one.

## Retention

`RESULT_RETENTION` on the companion is 3600 seconds. The sweep deletes a job only after it has a `finished` timestamp older than that window. A job that is still running has no `finished` timestamp, so it stays in memory while the process stays up, including when the run itself is longer than 3600 seconds.

The browser record for an open or running job has no expiry. Reload still issues GET. A long run is not marked expired just because it started more than 3600 seconds ago.

After the page observes a finished state (completed, failed, or cancelled), it keeps the record for 3600 seconds from that observation and still GETs. The companion clock is monotonic from the server's finish time; the page clock is wall time from when the page saw the terminal GET. Those two clocks can disagree by a little. If the server still returns the job, the page uses that body. If the server returns 404 after the local window, the page shows expired or not-found and leaves the record in place.

A 404, a refused authentication, a corrupt record, a hash mismatch, or an unknown POST receipt is shown. None of those become a successful empty result, and none of them start another run.

## Replacing a record

`hold` will not overwrite an unresolved, failed, cancelled, expired, unknown, or corrupt record for the same role. The other role has its own key. The user has to choose "버리기", which is the only delete. A completed record may be replaced by the next explicit start, because the validated result is already on the page. `note` may update the receipt of the same `requestId` only. It does not replace a different request, and it does not repair a corrupt value.

RED export after recovery stays blocked until the user selects the original file again and its SHA-256 matches the hash stored with the job. The recovered page has the extracted text only.

## Without the helper

`index.html` loads `pending-job.js` before the role pages. On that shipped page a missing or unusable helper does not POST. The start control reports that the request was not sent.

`UNSHIPPED_TEST_ISOLATION` is the only direct POST. It runs when `document-red.js` or `document-blue.js` is loaded by a standalone page VM that has neither `FalsifyPendingJobs` nor a `pending-job.js` script tag. Those existing tests describe the module without the helper. They are not the shipped page.

## Admission

The latch covers one page and one JavaScript realm. It is not atomic across browser tabs. Web Locks are not used, and this document does not promise that two tabs will admit only one job. Within that one page, each role latches its start synchronously, before `makeRequest` or `hold` awaits. A second click in that window does not start another hold or POST. `hold` also takes an in-memory latch and reads storage again after the harness and byte hashes, immediately before it writes. That re-check is still the same thread. An unresolved, failed, or corrupt record is not replaced. If `hold` fails, the results already on the page stay.
