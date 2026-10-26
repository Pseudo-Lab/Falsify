# BLUE failure recovery

A failed or cancelled BLUE job stays on this page until the user discards it. Reload, a dropped connection, and a later status poll do not clear it and do not start another model call.

## What the page shows

The page distinguishes five observations:

- **running** — the same job is still in progress. The page only repeats GET.
- **completed** — the result passed `FalsifyDocumentBlue.validateResponse`. The page shows that result and does not POST again.
- **failed** — the companion reported failure for this job. The bounded server phrase is shown only after the pending record matches the response.
- **cancelled** — the job ended cancelled. A failure phrase from another body is not copied onto this state.
- **unknown** — the POST receipt or the job state could not be confirmed. The page does not treat that as success.

The phrase `BLUE 재독 기준 인용이 해당 문단에 없거나 중복됩니다.` is the companion's ValueError for a BLUE reread anchor. It is shown as text on a failed job. It is not a generic pending notice, and a later generic recover sentence does not replace it.

## When the server phrase is shown

The phrase is stored and shown only when every identity check already required for recovery matches:

- `id` is the stored `requestId`
- `role` is `blue`
- `sourceHash`, `revision`, `harnessHash`, and `requestBytesDigest` match
- `companionInstance` is the `ci1.` descriptor stored at start and the one reported by the companion that is connected now

A missing or different field is a mismatch. The page keeps the previous matched phrase, if it has one, and does not copy the other body's error. The original request in the pending record is left as it was.

The stored phrase is at most 300 characters. Control characters are removed. A `Bearer` token or a labeled secret assignment is replaced with `[redacted]` before it is stored or shown. The page assigns that string with `textContent`. It does not use `innerHTML` for server data.

## What is kept

The pending record remains `falsify.pending-job.v1`. Older records that have no `serverFailure` field stay valid. After a matched failure, `note` may add `serverFailure`. That field is optional. It is not the request body, the original file, or a pairing secret.

The original request stays on the record. Discard is the only delete. The failure panel can save two files, and saving them does not POST:

- `falsify-blue-failure-diagnostic.json` — role, request id, disposition, receipt, hashes, the public companion instance descriptor, and `serverFailure`
- `falsify-document-blue-request.json` — the stored request, refused if a secret-shaped key is present

## Again, only on purpose

The failure panel tells the user to press "이 대기 작업 버리기" and then "BLUE 독립 검토 시작". Discard removes the record and does not submit a job. The next run happens only when the user starts it. A click on start while the failed, cancelled, or unknown record is still there does not POST.

A matched completed GET can still restore a job whose receipt was unknown, because that receipt never became a confirmed failure. A record already marked failed or cancelled is not replaced by a later running or completed body.
