# macOS native compatibility

The branch-scoped `macOS native compatibility` workflow runs on GitHub-hosted macOS 15 ARM64 and Intel machines. It invokes `/bin/bash` explicitly to exercise the system Bash 3.2. The existing POSIX handler contracts and macOS handler test run first; the latter compiles and registers only `falsify-test-isolated`, unregisters its own applet, and does not click an approval dialog.

The native smoke creates a temporary Python venv and installs `app/local/requirements.txt`, runs synthetic RED PDF export, BLUE visual, runtime, wrapper and loopback bridge tests, and launches a companion process on an ephemeral port with fake CLI executables. It runs packaging contracts and builds a source archive from the clean checkout. It checks archive paths, Unix file modes (including Git ZIP's implicit 0644 for regular files), checksum, and commit. No real model or private paper is used. The temporary venv and archive are removed on exit. This does not test GUI approval or production URL registration.

Run from a clean committed checkout on macOS with Python 3, Node, and Git available:

```sh
/bin/bash scripts/test-posix-connection.sh
/bin/bash scripts/test-macos-handler.sh
/bin/bash scripts/test-macos-native.sh
```

The workflow runs on pushes only to `feature/macos-ci-20261027` or `feature/macos-support-20261027`, or by manual dispatch when available. It does not deploy or publish a release.
