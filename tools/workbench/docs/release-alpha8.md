# Workbench 0.2.0-alpha.8

## Use it

1. Open Review, Results or Harness and choose **Confluence에 연결**. Authorize the central Falsify app using your own Atlassian account and Falsify access.
2. Select a local experiment or registered Harness, check the team-sharing consent, then press **Confluence에 팀 공유**. Publication means sharing in the configured Falsify Confluence team archive.
3. On another browser, connect and press **팀 기록 불러오기**, then open an archive. Experiments open in native Review with RED edits, BLUE findings, Harness versions and saved item judgments. A Harness opens as a preview; register it explicitly to use it.
4. A fetched experiment is temporary. Publish new review notes explicitly to Confluence before closing, disconnecting or reloading. The memory view and team list expire within 12 hours. Original local records and local JSON backups remain unchanged.

## Storage and compatibility

Confluence pages and immutable SHA-256-named JSON attachments are the only new remote record store. The static GitHub Pages frontend uses a stateless OAuth/API relay; no new database or object store contains records or OAuth sessions. Existing legacy data is preserved for migration; new legacy account/record writes return 410. Workbench username/password and private/shared storage selection are retired from the shipped interface.

JSON contains selected case text, original responses, required RED/BLUE ancestors, Harnesses and reviews. It does **not** contain the original or edited PDF bytes. Opening an archive does not execute or register a Harness, run a model, change original execution provenance, or merge into local backups. Existing local records are never automatically republished. Confluence permissions and actual plan limits apply.

## Validation

Synthetic regression coverage includes archive closure/hash validation, real bundled Worker routes without a database, permission/parent confinement, bounded attachment redirects, immutable publication, partial/unknown writes, OAuth callback binding, stale sessions, native temporary view expiry, same-ID local isolation and competing async opens. Final focused checks: codec 4/4, ledger 16/16, Confluence UI 15/15; full API 50/50. All 22 application Node test files passed. GitHub release CI adds Python and Windows launcher checks.

Real staging acceptance used owner OAuth and clearly labelled synthetic fixtures only: Harness and experiment save/list/read, independent browser-origin storage, RED comparison and five raw BLUE findings, explicit uncertain/no-score storage-test review publication and readback. Original local ledger stayed empty in the second origin. No real paper was published and no model or CLI was executed. This demonstrates two independent browser stores, not a second physical PC or a scientific accuracy evaluation. PDF editor/native engine behavior is unchanged from alpha.7.

See [user guide](confluence-use.md), [gateway setup](confluence-gateway.md), [storage contract](confluence-storage-contract.md) and [privacy](privacy.md).
