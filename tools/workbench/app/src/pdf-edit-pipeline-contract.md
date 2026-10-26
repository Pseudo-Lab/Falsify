# Table-first mixed edit composition

`prepare(request,{selectionPdf,paragraphPdf})` composes existing injected
`prepare` APIs. No engine, UI, build/package change or network access is added.
Mixed means enabled `segmentId` starts `table:` plus other enabled body edits.
Single-kind requests/results are delegated unchanged.

For mixed requests, the original PDF bytes and supplied fileHash are verified.
Only copied table anchors lose their alias-local occurrence. Stage A edits
tables on those exact original bytes. Before stage B, A's actual readable File
and SHA are verified twice and its pageMap must be identity, with equal source/
output page counts in verification. Stage B receives actual stage-A bytes/hash
and copied original-index body edits (snapshot embedded fileHash is rebound).
Each engine rederives its own Before/source match. Same-page cross-kind boxes
must be present and non-overlapping; unknown overlap is refused, not guessed.

The actual final PDF is returned as a real immutable File materialized from
owned verified bytes, including readable failed-A early results. File-like
arrayBuffer returns (including shared backing views) are copied immediately;
subsequent engine-owned reads cannot change the returned artifact. The final
hash and final engine pageMap are returned. Top-level
`originalSourceSha256` binds the original source; composite verification schema
`falsify.pdf-edit-pipeline.v1` records each stage's actual input/output hashes,
unaltered nested engine verification/status/checks/warnings. Its sourceSha256
describes the **composite** original input. The paragraph stage's own source
hash remains stage A's hash in the nested record. Independent/layoutVerified
are always false. This is a hash/engine-check chain, not new fidelity proof.

Failed or unverifiable readable stage A returns that actual file, composite
failed, bodyPending and pendingEditIds; stage B does not run. A readable failed
or draft stage B remains a failed/draft candidate. Exceptions propagate without
inventing a file; caller retains its last output. Abort is checked around file/
hash/engine awaits; operations are never automatically retried. Identity-map
failure throws before stage B. Original edit objects/source bytes are not
modified. Mixed request control fields and the original AbortSignal are
captured before the first await; caller replacements cannot cancel a different
operation or bypass the original abort. Per-edit successful states are only
applied/noop; unknown or contradictory edit/check/report/self-check states
prevent A-to-B. Readable explicit drafts remain marked as drafts and do not
upgrade to applied. Single-kind delegation still preserves its original API.
Original source fonts/table bounds and final visual fidelity remain
the underlying engines' and final review's responsibility.

Tests default to this checkout. Real synthetic integration uses this checkout's
existing `app/dist` engines and node_modules, or `FALSIFY_TEST_WORKBENCH` pointing
to an installed Workbench checkout. Runtime file reads are local-only in tests.
