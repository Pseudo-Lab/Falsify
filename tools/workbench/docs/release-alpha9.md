# Workbench 0.2.0-alpha.9

## Use it

1. Open RED or BLUE and drop, paste or pick one paper in the large paper target. A PDF shows its actual first page when it can be rendered locally. Empty future stages remain compact.
2. The default tool is already selected. Click it to open the Harness shelf; execution adapter, CLI/model and code settings stay under details. Connect **내 PC**, check explicit execution consent, then press the play button.
3. Read results where they appear. RED and BLUE remain independent; neither is a required predecessor of the other. Existing result download, candidate editing, failure/recovery and manual JSON paths remain available.
4. Open Harness to use a registered tool or prepare its **팀에 저장** action directly. Preparing a library share does not change RED/BLUE execution selection or start a model. Code authoring is under **새 도구 만들기**.
5. Open **팀 기록** to connect and browse the team drawer. **팀에 저장** opens the selected record and explicit team-publication consent; **공개하고 저장** performs the write. Original/edited PDF bytes are not included in these JSON archives. Remote views remain temporary and must be explicitly published to retain new review notes.
6. In Review, check/cross/question controls set the existing human verdicts. Decided finding/attack items still require reasons. No human judgment, score or approval is generated automatically.

## Reuse and architecture

The original charcoal rail, yellow wayfinding signs, typography, role destinations, CLI/model control, immutable run ledger and Confluence-only transport remain. The UI is a thin presentation adapter over existing real controls and validators, not a replacement experiment engine.

- GoogleChromeLabs **file-drop-element 1.0.1**: unchanged Apache-2.0 custom-element runtime and corresponding source, the same component family used by Squoosh. Native file inputs retain their existing listeners and validation. Multiple-file drops are explicitly refused without replacing the current paper.
- **Lucide**: 23 selected SVG symbols pinned to commit05232756c05e9ca7d5ad267e8694e9afa5d572fa. Complete ISC/inherited MIT notice and source/hash manifest are included.
- Native HTML details/buttons/selects supply disclosure and selection behavior. The selected objects and contextual actions borrow the researched Squoosh/ScratchJr patterns; no ScratchJr, Excalidraw, analytics or compression engine is shipped.
- **Playwright1.64.1** is a development-only browser regression dependency. It is not served or installed with the Python companion. Source/licensing manifest: app/vendor-sources/visual-components.json.

## Validation and limits

All22 application Node test files passed, including17Confluence UI cases (exact-hash share preparation without execution-selection changes, connect/read from the team drawer, stale preparation cancellation and existing isolation/security cases). Browser tests at1440px and390px pass file drop/paste, multi-file refusal preserving source, independent inputs, every overall verdict mapping, no horizontal overflow and zero saved human reviews. The browser test is committed and gates Pages CI. An actual synthetic PDF rendered an88x125 first-page thumbnail.

Aside normal-UI testing independently verified file picking, shelves, Harness preparation isolation, per-finding/attack mappings and reason validation. It found an overall-verdict label-default activation bug, which was fixed by retaining the real select in a neutral container; every overall value was then verified through actual visible buttons. No new model/CLI run, real-paper publication or fabricated human gold was used. Aside lacks viewport resizing, so isolated Edge supplied responsive QA. This is functional/visual acceptance, not measured child or uncoached-newcomer usability.

Remote storage semantics are unchanged from [alpha.8](release-alpha8.md): Confluence permanent archive, memory-only remote views, original local ledger preserved. Native PDF editor/reflow behavior is unchanged. PC connection still requires the local companion and user authentication; UI simplicity does not install or authorize software automatically.

## Maintainer regression

Start `python -m http.server 7851 --bind 127.0.0.1 --directory app/dist` from the repository root, then `npm ci --ignore-scripts --prefix app`, `npm exec --prefix app -- playwright install chromium`, and `npm run test:browser --prefix app`. On Windows the browser regression uses installed Edge. The only ledger fixture is synthetic and contains no human reviews. Browser outputs go to ignored `.local/visual-workflow-captures`.
