# Source releases and local updates

Download a tagged source release from [GitHub Releases](https://github.com/Shinick-Han/falsify-workbench/releases).
Each ZIP is produced from one exact committed tree; `release-manifest.json` identifies its commit/version and
`SHA256SUMS.txt` identifies its SHA-256. Preview versions are explicitly marked prerelease.
The current source version is 0.2.0-alpha.8; see [release notes](release-alpha8.md), [the changelog](../CHANGELOG.md) and the
[shared-records contract and quick use](harness-contract.md#선택형-공동-기록). A source version is not proof of live API deployment.

The archive includes the Workbench and companion source with license notices. It does not include private papers,
harnesses, records, environments, model artifacts, account credentials, `.pdf-editor.local.json` or the locally patched
editor WASM. The separate editor and its configured runtime are not silently replaced by a Workbench update.

Keep your source/configuration backed up before updating. For a Git checkout, pull the selected release commit; for a ZIP,
extract into a new named folder and register that folder's launcher after reviewing it. Do not overwrite paper/record backups
or copy untrusted local configuration. See [local companion setup](local-companion.md) and [PDF editor setup](pdf-editor.md).
The optional manual raster-image writer has separate [dependency/setup instructions](pdf-image-editing.md); a source update
does not silently install its native wheels. Existing image dependencies/configuration are retained in the local checkout.

The Windows launcher checks exact listener identity and startup prerequisites before gracefully restarting an idle
same-checkout companion. Busy companions and recent job results are preserved; foreign listeners are not terminated.
After restart use the new pairing token. Browser-local papers, harnesses and records are not removed. The hosted page's
connection panel reports the authenticated installed companion version; it never fetches a token cross-origin or runs a model
merely because you connect. Old companions can still use supported manual/RED/BLUE paths but cannot provide newer preflight.

Maintainers run `node scripts/package-release.mjs --out-dir ABSOLUTE_DIRECTORY` only after tests and a clean committed tree.
The helper verifies app/companion/release version agreement and refuses unexpected private paths. It does not push, publish,
install, restart a listener or upload anything. Release publication and actual hosted/local verification are separate steps.
