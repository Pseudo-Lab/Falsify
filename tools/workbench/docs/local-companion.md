# Connect your own CLI

The website is https://shinick-han.github.io/falsify-workbench/. It does not run a CLI on GitHub or use the author's account. Each participant starts their own companion, using their own CLI login and model subscription.

## Windows

1. Install Python 3.10+ and at least one built-in CLI yourself: Codex CLI or Claude Code. Sign in with your own subscription (`codex login`, or run `claude` and use `/login`). The platform never installs a CLI, signs you in or asks for an API key.
2. Download this repository's source ZIP, extract it to a folder you will keep, and open PowerShell in that folder. Read the scripts before executing them.
3. Start the companion, either manually each time or with the optional click-to-launch link below. Either way it runs in a visible PowerShell window. On the first launch it creates `.venv` in this project and installs the pinned Python dependencies from PyPI, printing each setup step; later launches skip pip until the requirements change. Before the broker starts it lists which of `codex` / `claude` were found on PATH (nothing is run) and how to sign in.
4. The window prints a pairing token. Copy it into the hosted website's CLI connection panel yourself and connect. The token is never placed in a link or URL. If the browser asks for local-network access, allow it only for this trusted site. Tokens live only for this broker process; keep them private.
5. In RED or BLUE, supply a paper and choose CLI, model and effort for that role. These are per-role choices, not a global setting of the companion or the link. Pairing does not execute a model. Each execution still requires its own consent.

### Manual start

Run `powershell -NoProfile -ExecutionPolicy Bypass -File .\start-companion.ps1`. This applies the execution policy only to this process; it does not modify your global policy.

### Optional: click-to-launch `falsify://connect`

Install once, yourself, from the folder you will keep:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-connection.ps1 -WhatIf   # preview, changes nothing
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-connection.ps1
```

This registers a per-user URL protocol under `HKCU\Software\Classes\falsify` (see Microsoft's [application registration](https://learn.microsoft.com/en-us/windows/win32/shell/app-registration) and [URI scheme registration](https://learn.microsoft.com/en-us/previous-versions/windows/internet-explorer/ie-developer/platform-apis/aa767914(v=vs.85)) documentation). It needs no administrator rights and creates no startup entry, scheduled task, service or background process. The registered command is fixed: the PowerShell executable you installed with runs `open-connection.ps1` from this checkout with `-NoExit`, and the clicked link is passed as one quoted argument. The installer refuses if `falsify:` is already registered by another application, per-user or machine-wide, and never overwrites it. **Do not move or rename the folder afterwards**; if you do, run `uninstall-connection.ps1` and install again from the new location.

Then open `falsify://connect?port=7816` from the website's connect link, or paste it into the browser address bar. The browser asks whether to open Windows PowerShell; this prompt is the browser's own approval and is not suppressed. A visible PowerShell window starts the companion for that port; errors stay on screen because the window does not close by itself.

`open-connection.ps1` accepts exactly `falsify://connect?port=<1024-65535>`. Windows normalizes that link to `falsify://connect/?port=<1024-65535>` (one empty root slash) before passing it to PowerShell, so that single equivalent form is accepted too. Nothing else is: no other path, double slash, user info, fragment, extra or repeated query keys, percent-encoding, whitespace, case changes, leading zeros or other text. Anything else is rejected before any network, Python, model or child process. The link carries only the port: never a token, command, script, CLI, model or website origin. The companion always pairs with the fixed origin `https://shinick-han.github.io`.

Remove it with `powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-connection.ps1` (`-WhatIf` previews). It removes only this launcher's own exact registration, key by key, and refuses to touch anything else. The project folder and `.venv` remain.

Browser limits of custom protocols: the web page cannot tell whether the protocol is installed (if not, clicking does nothing or shows a browser message), cannot see the terminal or read its output, and receives no token from it. Browsers may require a user click and show a confirmation each time unless you choose to remember it for this site. Entering the link in Win+R also works but has no browser prompt.

Clicking Connect again does not require manually finding and killing the old server. The launcher checks the Windows listener and its exact Python script path before contacting it. An idle companion from this same checkout is gracefully restarted after startup prerequisites pass. Use the new terminal's pairing token afterwards: restart invalidates the previous token, but does not clear browser-local papers, harnesses or records.

If RED/BLUE or PDF export is running, or the companion still retains recent job results, it is reused rather than stopped. Older same-checkout companions without the restart protocol are also reused; they need a manual stop once to adopt the new restart behavior. The launcher never force-kills a process. A foreign, ambiguous or differently configured listener is left untouched with an explanatory message. In that case use a genuinely free port, e.g. `-Port 7817` or `falsify://connect?port=7817`, and set the website's port field to the same number. Simultaneous clicks are serialized during startup; a second terminal does not start a competing broker.

`-NoInstall` skips pip entirely; deleting `.venv` forces a fresh setup. `-NoPdf` skips installation of the optional PDF editor in a new environment; it does not uninstall an existing one. PDF import remains browser-local, but PDF modified-file export requires PyMuPDF. TXT export does not require it.

The launcher tests in `scripts/test-connection.ps1` are dry-run only: they never write the registry, start the companion, open a window or call a model.

`scripts/test-companion-lifecycle.ps1` additionally checks lifecycle identity, HTTP behavior, startup failure protection, restart/reuse and mutex recovery using synthetic companions on temporary loopback ports. Run it under both Windows PowerShell and PowerShell 7. It does not call an AI model or touch an existing companion.

### Longer PDF edits (opt-in reflow engine)

The unconfigured companion retains legacy single-line PDF editing. For longer After text,
configure the separate verified `falsify-pdf-editor` module and its patched candidate
manifest as described in [PDF editor setup](pdf-editor.md). The Windows launcher reads
the ignored `.pdf-editor.local.json` or explicit `-PdfEditorRoot`/`-PdfEditorManifest`.
Once configured, the same connect button and selected-only download action use that
engine; no manual Node command is needed for each export. Missing Node 24+, source or
verified runtime is reported without silently returning to the old editor. The public
source release does not bundle a prebuilt patched WASM.

## macOS / Linux or manual Windows setup

From the extracted repository root:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r app/local/requirements.txt
.venv/bin/python app/local/server.py --web-origin https://shinick-han.github.io
```

Windows equivalent after creating a venv: `.venv\Scripts\python.exe ...`. Add `--port 7817` if needed. To use the entirely local website instead, omit `--web-origin` and open the printed `http://127.0.0.1:<port>/` address. Local-only mode has no remote origin permission.

## Optional PDF preflight (0.2.0-alpha.1+)

After connecting, RED's **PDF 사전분석** button sends the currently supplied PDF and only selected Before/After candidates to
your own local companion. Upload alone does not send this request. It calls no model, runs the bounded probes in an isolated
child, and displays only inspected-page/object counts and advisory text-layout statuses. This is not a visual/scientific verdict
or editing permission and does not affect the existing export quality gate. Detailed geometry, RED plans and gold are not sent
to BLUE. Docling ML conversion is not configured or downloaded. Object writing remains a separate experiment.

Old companions show an update hint; manual exchange and supported RED/BLUE/export flows remain usable. The connection panel
reports the authenticated companion version. Analysis has a fixed deadline and is serialized with other local operations.
See [adapter evidence](pdf-adapter-experiments.md) and [source release updates](releases.md).

## Other CLIs and custom harnesses

Codex CLI and Claude Code are both built-in adapters using your own subscription login; choose either per role in RED or BLUE. Any other CLI can be connected through a trusted wrapper that follows the JSON stdin/stdout protocol in [the harness contract](harness-contract.md). Import that wrapper's `stdio` harness JSON in Harness, then select it in RED or BLUE. It is **not** sufficient to put a chat CLI path in the executable field: the wrapper must translate input, invoke the CLI using your own subscription login, validate and return only the requested JSON object, without mixing logs into stdout.

No account keys belong in the website, harness JSON, GitHub or the execution ledger. A wrapper may use its CLI's local authentication stores. The minimal stdio environment does not automatically pass all home/config variables; wrappers must resolve their own CLI configuration explicitly. Trusted custom code can access your files/network and incur costs; it is not OS-isolated or guaranteed to enforce internal call budgets. The included `app/examples/stdio_harness.py` intentionally abstains and is a protocol example, not a model implementation.

## Trust and privacy boundaries

- Only `127.0.0.1` is bound, never LAN addresses. Hosted pairing requires an explicit HTTPS origin and a process-local bearer token. Cross-origin token bootstrap, wildcard CORS, arbitrary shell endpoints and browser-stored tokens are not offered.
- Browser trust is **origin-wide**: `https://shinick-han.github.io`, not only the `/falsify-workbench/` path. Only opt in if you trust the origin. Stop the broker to revoke its token; do not post token screenshots or use an untrusted copied website.
- Paper extraction and records stay in your browser until you explicitly execute or export. Execution sends extracted text through your selected harness to its model provider. PDF export sends original bytes to your local companion. The public repo does not receive paper files, answer keys or experiment records.
- Local records remain origin-local localStorage. Local and hosted sites have separate local records. Full-ledger transfer uses explicit JSON backup/import; backups contain paper text and should stay private. The optional [invite-only team API](team-access.md) stores only selected uploads, not an automatic replacement or full sync of the local ledger.
- RED and BLUE are independent. BLUE receives its paper, not RED's answer key; custom harnesses may violate blindness if they share state. This app does not guarantee OS-level input-only isolation.
- The site is publicly accessible. Human review is not domain approval or scientific ground truth.

## Connection problems

Check that the companion is running with the exact hosted origin, port matches, the current token is used, and local-network permission is allowed. Reloading the web page intentionally forgets the token; reconnect manually. Browser policy may reject secure-web to HTTP-loopback connections. If direct pairing is unavailable, use the local workbench or manual JSON exchange; do not disable browser security or bind the broker to the LAN.

Built-in CLI model access, another participant's OS/browser, and scientific performance require validation in that participant's environment. The existing private site and research records are not migrated automatically.
