#!/bin/bash
# Native, synthetic-only smoke test. Run from a clean committed checkout.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
[ "$(uname -s)" = Darwin ] || { echo 'This smoke test requires Darwin.' >&2; exit 1; }
work=$(mktemp -d "${TMPDIR:-/tmp}/falsify-native.XXXXXXXX")
work=$(CDPATH= cd -- "$work" && pwd -P)
trap 'rm -rf "$work"' EXIT
python3 -m venv "$work/venv"
"$work/venv/bin/python" -m pip install -r app/local/requirements.txt
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_document_red.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_blue_visual.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_macos_runtime.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_cli_selection.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_harness_wrapper.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_web_bridge.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_port_binding.py -v
"$work/venv/bin/python" -m unittest discover -s app/tests -p test_pairing.py -v
node --test app/tests/local-bridge.spec.cjs app/tests/auto-pair.spec.cjs
"$work/venv/bin/python" - "$work" <<'PY'
import http.client, json, os, pathlib, socket, subprocess, sys, time
work = pathlib.Path(sys.argv[1]); fakebin = work / 'bin'; fakebin.mkdir()
for name in ('codex', 'claude'):
    path = fakebin / name
    path.write_text('#!/bin/sh\nexit 0\n'); path.chmod(0o755)
env = {'HOME': str(work), 'PATH': str(fakebin) + ':/usr/bin:/bin', 'TMPDIR': str(work)}
with socket.socket() as s:
    s.bind(('127.0.0.1', 0)); port = s.getsockname()[1]
assert port != 7816
p = subprocess.Popen([sys.executable, 'app/local/server.py', '--port', str(port), '--token-display', 'hidden'],
                     env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
def request(path, headers):
    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
    try:
        conn.request('GET', path, headers=headers); response = conn.getresponse()
        return response.status, json.loads(response.read())
    finally: conn.close()
try:
    for _ in range(100):
        if p.poll() is not None: raise RuntimeError('companion exited during startup')
        try:
            status, session = request('/api/session', {'Sec-Fetch-Site': 'same-origin'})
            break
        except (OSError, http.client.HTTPException): time.sleep(0.1)
    else: raise RuntimeError('companion startup timed out')
    assert status == 200
    status, capabilities = request('/api/capabilities', {'Authorization': 'Bearer ' + session['token'], 'Sec-Fetch-Site': 'same-origin'})
    assert status == 200 and capabilities['red'] and capabilities['blue'] and capabilities['pdf']
    assert capabilities['cliSelection'] and capabilities['harnessWrapper']
    assert {item['id'] for item in capabilities['cliAgents'] if item['installed']} >= {'codex', 'claude'}
    assert p.poll() is None
    print('Synthetic companion started on an ephemeral loopback port; capabilities verified.')
finally:
    if p.poll() is None: p.terminate()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill(); p.wait()
PY
node --test scripts/packaging.spec.mjs
node scripts/package-release.mjs --out-dir "$work/release"
"$work/venv/bin/python" - "$work/release" <<'PY'
import hashlib, json, pathlib, stat, subprocess, sys, zipfile
release = pathlib.Path(sys.argv[1])
receipt = json.loads((release / 'release-manifest.json').read_text())
archive = release / receipt['archive']
assert hashlib.sha256(archive.read_bytes()).hexdigest() == receipt['sha256']
assert receipt['commit'] == subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
entries = subprocess.check_output(['git', 'ls-tree', '-r', '-z', 'HEAD']).split(b'\0')
tracked = {}
for entry in filter(None, entries):
    meta, name = entry.split(b'\t', 1)
    mode, kind, _ = meta.split()
    assert kind == b'blob'
    tracked[name.decode()] = int(mode, 8)
prefix = 'falsify-workbench-v' + receipt['version'] + '/'
with zipfile.ZipFile(archive) as z:
    files = {i.filename[len(prefix):]: i for i in z.infolist() if not i.is_dir() and i.filename.startswith(prefix)}
    assert set(files) == set(tracked), (set(tracked) - set(files), set(files) - set(tracked))
    for name, mode in tracked.items():
        # Git ZIP omits Unix attributes for ordinary non-executable files.
        zipped_mode = stat.S_IMODE(files[name].external_attr >> 16) or 0o644
        assert zipped_mode == stat.S_IMODE(mode), name
    for name in ('install-connection.sh', 'open-connection.sh', 'uninstall-connection.sh'):
        assert files[name].external_attr >> 16 & 0o111, name
print('Archive tracked paths and Unix modes verified; SHA-256 and commit match.')
PY
mkdir "$work/extracted"
unzip -q "$work"/release/*.zip -d "$work/extracted"
"$work/venv/bin/python" - "$work/extracted" <<'PY'
import pathlib, stat, sys
root = next(pathlib.Path(sys.argv[1]).iterdir())
for name in ('install-connection.sh', 'open-connection.sh', 'uninstall-connection.sh'):
    assert stat.S_IMODE((root / name).stat().st_mode) == 0o755, name
assert stat.S_IMODE((root / 'falsify-connection.sh').stat().st_mode) == 0o644
print('System unzip preserved launcher executable modes and regular file mode.')
PY
