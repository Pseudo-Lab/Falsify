# Workbench 0.2.0-alpha.4

Source-only prerelease. The separate PDF editor stays 0.1.0-alpha.5.

## Start here

- [Invite-only team accounts and operator commands](team-access.md): choose your own username/password after receiving a single-use invitation. Shared API reads and writes require an active invited-member session. Static GitHub Pages and source remain public.
- [Existing harness connection profiles](harness-wrapper.md): adapt stdio/HTTPS input and structured output without rewriting the program. Registering a profile never executes it. Wrapper runs require a companion reporting `harnessWrapper: true`; old companions keep their supported paths.
- [Shared records and comparison contract](harness-contract.md): private by default, explicit one-record upload and sharing, immutable payloads, revision-checked visibility changes, subjective reviews and condition-matched comparison.

Local papers and the ledger are preserved. The cloud API is separate from local CLI authentication and pairing; it does not collect CLI credentials. Shared run projections exclude private evidence and local IDs. Accounts existing before invitation enforcement require explicit operator admission; migration preserves their records.

## Verification boundary

The invite API was checked with two synthetic accounts on both staging and production: 27 checks per environment, including no-invite/no-session rejection, private ownership, shared projection, revision conflicts, review visibility, persistence and session revocation. Synthetic records were removed afterward. Browser checks exercised invitation signup, private upload/share/delete, logout/local preservation and 1440/390px layouts. No paper benchmark or paid model was called for these checks.

Wrapper subprocess fixtures exercise RED, BLUE, multi-chunk reading and deterministic mapping with exact evidence checks. A sample mapping preview is not proof that an arbitrary installed program is compatible, honest or isolated. The test suite and release workflow validate source separately from deployment.

## Not included

Automatic full-ledger sync/restore; password reset/change/account deletion UI; verified model execution or scientific ranking; AI-generated README connection profiles; arbitrary prose interpretation; original PDF binary handoff or replacing the app's whole orchestration. Wrapper limits bound app calls, not internal model cost or escaped subprocesses; user code is trusted, not sandboxed.

Near the wrapper configuration's 32,000-character boundary, rare JSON number/lone-surrogate encodings can still produce browser/backend size disagreement. The backend rejects an oversized configuration before execution; keep profiles comfortably below the limit. No perfect cross-language parity or arbitrary-harness compatibility is claimed.
