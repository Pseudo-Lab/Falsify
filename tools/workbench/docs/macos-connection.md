# macOS connection setup

From the checkout in Terminal, install Python 3 (for example, Homebrew Python) and prepare the project-local environment before installing the URL handler:

```sh
cd /path/to/falsify-workbench
python3 -m venv .venv
.venv/bin/python -m pip install -r app/local/requirements.txt
./install-connection.sh
```

Use the actual checkout path in the `cd` command, quoting it if it contains spaces. The installer records that path; uninstall from the original checkout before moving it, then install again from the new location. The launcher looks for Homebrew in `/opt/homebrew/bin` and `/usr/local/bin` when opened from Finder. The Python packages are installed into `.venv`, not system Python. If dependencies are missing, the handler stops and reports the setup command; it does not install packages automatically.

Click Connect on the hosted page and approve the browser/macOS prompt and the separate local approval dialog. The local dialog defaults to No. To remove the handler, run `./uninstall-connection.sh` from that checkout; the project and pairing key remain. Actual Launch Services delivery, dialog behavior, and AppleScript compilation require validation on a Mac.

For pairing, the launcher reuses a companion on the selected port when its authenticated launcher descriptor reports this checkout and the fixed web origin. An unrelated service or a companion from another checkout is left running and reported as a port conflict; choose another port or stop it yourself. If a newly started companion fails to become ready or pairing fails, the launcher stops that child. The PID and checkout attribution come from the companion descriptor; they are a compatibility check, not operating-system attestation of a hostile local process.
