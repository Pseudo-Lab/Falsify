# Password change and revoke-all

Contract `falsify.cloud.v1`. Fake examples only. No new migration, dependency, session cookie, or account-deletion endpoint.

Both routes require an active team member. Authentication is the existing `Authorization: Bearer fss_…` session. A missing, malformed, revoked, or expired session is `401 unauthorized`. A session whose author is revoked or was never admitted is `403 membership_required`, and neither route revokes that session (`POST /v1/logout` still can).

Fixed error bodies stay `{ "error": { "code", "message" } }` with the messages already defined in the Worker. No password, token, SQL, or request text is echoed. Responses keep `Cache-Control: no-store`. Origin checks, `Content-Type`, and body limits are the existing ones. Password change reads at most 4 KiB (`MAX_AUTH_BODY_BYTES`), the same cap as login and registration.

Rate limits use the existing `rateLimit` helper and the existing login caps (`LOGINS_PER_IP_HOUR`, `LOGINS_PER_HOUR`, `LOGIN_FAILURES_PER_USERNAME_HOUR`). Buckets are separate (`password:ip:`, `password:all`, `password:author:`) so a password guess does not consume a login counter. Buckets store truncated hashes. A failed current-password check keeps its author slot; success releases that slot. There is no new environment variable.

Login inserts its session only while `authors.password_hash` is still the hash it just verified. A password change that commits first cannot leave a session for the old password. Registration does not pass that predicate, because that request created the author row.

## POST /v1/auth/password

```http
POST /v1/auth/password
Authorization: Bearer fss_example_token_not_a_real_secret_value_0001
Content-Type: application/json

{"currentPassword":"correct horse battery","newPassword":"replacement horse battery"}
```

`200`

```json
{"changed": true}
```

- `currentPassword` is checked with `verifyPassword` (one scrypt, dummy salt if the stored hash is unusable).
- `newPassword` uses `passwordText` and `hashPassword` (12 to 128 code points after NFC, no composition rules). A bad new password is `400 invalid_password` and does not write.
- Extra or missing fields, or non-strings, are `400 invalid_request`.
- Wrong current password is `401 invalid_credentials`. The stored hash and sessions stay as they were.
- A missing, revoked, or expired bearer is `401 unauthorized`, including when revoke-all lands after authentication and before the batch. That request does not change the hash.
- The update is one D1 batch. `UPDATE authors` matches the hash just verified and requires the bearer session (`token_hash = author.keyHash`, `revoked_at IS NULL`, `expires_at > now`) plus active membership. `UPDATE sessions` then revokes unrevoked sessions only if that new hash is already stored. A revoked current session or a stale hash changes zero author rows and zero session rows.
- Every still-valid session of this author is revoked, including the caller. No new session is created. The new password is not in the body.
- The client logs in again with `POST /v1/auth/login`. The old password then fails. Other authors, their sessions, records, and this author's `team_members` row are untouched.
- A lost race is `401 invalid_credentials` (the password that was verified is no longer current).

`413 payload_too_large` and `415 unsupported_media_type` match login. `429 rate_limited` carries `Retry-After`. `OPTIONS` uses the same allow-lists as the other routes.

## POST /v1/auth/sessions/revoke

No body. Same active-member bearer rule.

```http
POST /v1/auth/sessions/revoke
Authorization: Bearer fss_example_token_not_a_real_secret_value_0001
```

`200`

```json
{"revoked": true}
```

Sets `revoked_at` on every unrevoked session of that author only. Password, records, and membership stay. The bearer used for this call is revoked too. Another author's sessions keep working. `GET` is `405 method_not_allowed`.

`POST /v1/logout` is unchanged: it revokes only the presented session and still allows a non-member to log out.

## Workbench panel

`app/dist/cloud-records.js` adds the controls to the existing account panel. Nothing in `index.html` changes.

- Password change has current, new, and confirmation fields. The confirmation is checked in the browser and is not sent.
- Fields are cleared before the request. Passwords are not written to `localStorage`.
- Success drops the session token and does not log in again.
- A wrong current password is a 401 that leaves the browser token in place, because the server session is still valid.
- Revoke-all shows a confirmation button first. The request has no body and uses only the signed-in bearer.

The panel behavior is described for operators in `docs/account-operations.md`.

## Not settled

Account deletion, record anonymization, password recovery, and moving the session token to an HttpOnly cookie are not implemented. `docs/account-operations.md` records the product boundary.
