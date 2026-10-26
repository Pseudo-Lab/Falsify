# Paper edits (`FalsifyPaperEdits`)

In-memory edit session for the paper workspace. The browser file is `app/dist/paper-edits.js` (classic UMD). Tests load it with CommonJS: `require('../dist/paper-edits.js')`. This module does not replace the RED, BLUE, review or harness routes and does not export a PDF.

Original Workbench code under AGPL-3.0-only. It vendors no third-party source and reads no network, DOM, `localStorage`, or model API.

## Session

```js
const session = FalsifyPaperEdits.create({fileHash, name, segments, now, id, resume});
```

| Field | Required | Meaning |
| --- | --- | --- |
| `fileHash` | yes | Lowercase SHA-256 hex of the source file. |
| `name` | yes | Display name, 1–160 characters, no control characters. |
| `segments` | yes | `{id, label, text, pageIndex?}`. `pageIndex` is 0-based. Ids are unique. |
| `now` | no | Finite timestamp checked at creation. Omitted, or a number, leaves later timestamps on `Date.now()`. A function is called for each timestamp and must return a finite integer (tests). |
| `id` | no | Optional session label exposed as `session.id`. It is not part of the snapshot. |
| `resume` | no | Snapshot previously returned by `snapshot()` or `restoreDraft`. File hash and name must match. Ranges are checked against the supplied segments. Undo and redo start empty. |

`segments` are copied. Later edits of the caller's array or objects do not change the session.

Methods: `snapshot()`, `add(edit)`, `update(id, changes)`, `remove(id)`, `setEnabled(id, enabled)`, `undo()`, `redo()`, `subscribe(fn, onError?)`. `add` returns the new edit id (`e1`, `e2`, …). An id is allocated only after range and overlap checks succeed, and it is not reused. The counter stops at `Number.MAX_SAFE_INTEGER`. A rejected add does not consume an id, and removing then adding again does not exhaust the session. `subscribe` returns an unsubscribe function and is called only after a committed change, with its own snapshot. A listener exception does not leave the mutation. Later listeners still run, `onError(error)` is called when supplied, and a throwing `onError` is ignored. `add`, `update`, `remove`, `setEnabled`, `undo` and `redo` still return normally. `setEnabled` with the current value does not move the revision.

## Snapshot

`schema: 'falsify.paper-edits.v1'`, `fileHash`, `name`, `revision`, `edits`, `canUndo`, `canRedo`.

`revision` is a non-negative integer. It starts at 0. Each committed add, update, remove or enable change assigns the next integer and clears redo. Undo and redo return to the revision of that checkpoint, so the same checkpoint keeps the same revision. A change after undo does not reuse the discarded redo revision.

Every `snapshot()` and subscriber callback is a deep JSON clone. Mutating it does not affect the session or any other clone.

## Stored edit

`id`, `enabled`, `before`, `after`, `anchor`, `origin`, `pageIndex`, `segmentId`, `createdAt`, `updatedAt`, `history`.

`before` is the immutable original source quote. Updates may change `after` and the anchor's `bbox` or `style`, not the quote, the range, the occurrence, the origin, the page or the segment. `history` is capped at 12 entries. Entry 0 is the first version and is kept; older middle entries are dropped. Each entry is `{revision, at, after, enabled, anchor}`. The last entry matches the current After, enabled flag and anchor.

`add` accepts `{pageIndex, segmentId?, before, after, anchor?, origin}`. `origin` is `human`, `external-ai-import` or `ai-proposal`. The module stores that value as given. It does not invent a model name, harness id or execution record.

`anchor` input may include `bbox: [x0,y0,x1,y1]`, `occurrence`, `start`, `end`, and one style hint `{font, size, color}` (`color` is an integer RGB, `size` is a finite point size). The stored anchor always has `start`, `end`, `occurrence`, `bbox` and `style` (`bbox` and `style` are `null` when absent). `start`/`end` is a half-open exact range into the segment text.

## Anchors

Matching is exact and case-sensitive. Whitespace is not folded and the first hit is not chosen.

- One hit: the range and `occurrence: 0` are filled in. A missing `segmentId` binds the only segment on that `pageIndex`.
- More than one hit: pass `occurrence` (0-based, `indexOf` stepping one character, including overlaps) or `start`/`end`. A bbox or style hint does not disambiguate.
- `occurrence` across several segments is rejected until `segmentId` selects one segment.
- A second edit whose range overlaps the same segment is rejected, including when one edit is disabled. Touching endpoints is allowed.
- No match, a page that disagrees with the segment, or an occurrence that disagrees with `start`/`end` is rejected.

## Numbers and citations

Human, imported and `ai-proposal` edits may change digits, bracket citations and URLs. This session does not call `FalsifyDocumentRed.validateAfter`. The legacy RED route still has that restriction; it is not copied here. `before` stays non-empty text within 4000 characters. `after` may be `""`, which deletes that quote. Any other blank After is rejected. `after === before` is a no-op and is rejected on add, update, stored history and draft restore.

## Draft envelope

```js
const envelope = FalsifyPaperEdits.draft({snapshot, now});
const snapshot = FalsifyPaperEdits.restoreDraft(envelope, {fileHash, now});
```

`FalsifyPaperEdits.TTL_MS` is 12 hours. The envelope is exactly `{schema:'falsify.paper-edits-draft.v1', fileHash, savedAt, expiresAt, snapshot}` with `expiresAt === savedAt + TTL_MS`. It is valid for `savedAt <= now < expiresAt`. The module does not write the envelope anywhere. The UI may store it only after an explicit opt-in and may delete it.

`restoreDraft` checks the schema, the 12-hour deadline, and both the envelope hash and the snapshot hash against `fileHash`. A string envelope is parsed as JSON. Wrong hash, expiry and malformed input are different errors (`hash-mismatch`, `expired`, `malformed`). Keys that name a token, password, cookie, secret, session, credential or source PDF bytes are rejected at any depth. Segment text that is not part of an edit is not copied into the envelope. There is no PDF byte field.

`restoreDraft` returns a snapshot, not a live undo stack. Pass it as `create({resume})` to continue from those edits at the same revision. `canUndo` and `canRedo` are then false until a new change.

## Limits

See `FalsifyPaperEdits.LIMITS`. Counts that matter to the UI: 32 edits, 12 history entries, 100 undo checkpoints, 2000 segments, 1,000,000 total segment characters, 4000 characters for Before and for a non-empty After, page index 0–9999, draft JSON text up to 4,000,000 characters. Edit ids stay inside the safe-integer range. Input must be finite JSON: no `NaN`, `Infinity`, sparse arrays, functions, or extra fields.

## Errors

Thrown `Error` values have `paperEdits: true` and `code`:

| `code` | When |
| --- | --- |
| `invalid` | Shape, bounds, missing quote, same Before/After, frozen range |
| `duplicate-anchor` | More than one exact hit and no single occurrence or range |
| `overlap` | Two edits cover the same segment range |
| `unknown-id` | Update, remove or enable of an id that is not current |
| `undo-empty` / `redo-empty` | Nothing to undo or redo |
| `hash-mismatch` | Draft file hash is not the expected source |
| `expired` | `now` is at or past `expiresAt` |
| `malformed` | Draft schema, TTL field, JSON, credentials or snapshot shape |

A failed call does not change the revision and does not notify subscribers.

## Tests

```bash
node app/tests/paper-edits.spec.cjs
```

The shared `app/scripts/test.mjs` list is unchanged; this file is run directly. No model, network, browser or private paper is required.

## Residual limits

- Undo checkpoints live in the session only. A draft restores edit contents and the revision number, not the undo stack.
- Exact segment offsets are not PDF glyph positions. Geometry, when present, is a caller-supplied hint.
- This module does not write, repair or download a PDF. Browser export is a separate owner.
- Passing these tests is implementation evidence, not a release certification.
