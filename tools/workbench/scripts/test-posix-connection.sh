#!/usr/bin/env bash
# Offline tests for the POSIX falsify:// handler. No model calls, no macOS GUI, no real browser.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/falsify-connection.sh"
fail=0
ok=0
check() {
  ok=$((ok + 1))
  if [ "$2" = 1 ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    fail=$((fail + 1))
  fi
}
nonce_a=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
nonce_b=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB
nonce_c=CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
pair="falsify://connect?port=7816&challenge=${nonce_a}&state=${nonce_b}&proof=${nonce_c}"
parsed=$(falsify_parse_uri "$pair")
check 'pairing uri parses' "$([ "$parsed" = "7816 1 $nonce_a $nonce_b $nonce_c" ] && echo 1 || echo 0)"
parsed=$(falsify_parse_uri 'falsify://connect/?port=65535')
check 'root slash port only' "$([ "$parsed" = '65535 0' ] && echo 1 || echo 0)"
if falsify_parse_uri 'falsify://connect?port=7816&cmd=calc' >/dev/null 2>&1; then check 'reject command' 0; else check 'reject command' 1; fi
if falsify_parse_uri "falsify://connect?port=7816&token=abc" >/dev/null 2>&1; then check 'reject token' 0; else check 'reject token' 1; fi
if falsify_parse_uri 'falsify://connect?port=1023' >/dev/null 2>&1; then check 'reject low port' 0; else check 'reject low port' 1; fi
check 'approval ask' "$([ "$(falsify_approval_decision "$(falsify_fixed_origin)" '')" = ask ] && echo 1 || echo 0)"
check 'approval cancel' "$([ "$(falsify_approval_decision "$(falsify_fixed_origin)" no)" = cancel ] && echo 1 || echo 0)"
check 'approval yes' "$([ "$(falsify_approval_decision "$(falsify_fixed_origin)" yes)" = approve ] && echo 1 || echo 0)"
check 'approval other origin' "$([ "$(falsify_approval_decision 'https://evil.example' yes)" = refuse ] && echo 1 || echo 0)"

out=$(FALSIFY_CONNECT_DRY_RUN=1 FALSIFY_CONNECT_APPROVAL=no "$root/open-connection.sh" "$pair" || true)
check 'cancel dry-run' "$(printf '%s' "$out" | grep -q 'DRY-RUN pairing cancelled port=7816' && ! printf '%s' "$out" | grep -q "$nonce_a" && echo 1 || echo 0)"
out=$(FALSIFY_CONNECT_DRY_RUN=1 FALSIFY_CONNECT_APPROVAL=yes "$root/open-connection.sh" "$pair")
check 'approve dry-run hides nonces' "$(printf '%s' "$out" | grep -q 'DRY-RUN start-companion port=7816 pairing=1' && ! printf '%s' "$out" | grep -q "$nonce_a" && echo 1 || echo 0)"
out=$(FALSIFY_CONNECT_DRY_RUN=1 "$root/open-connection.sh" 'falsify://connect?port=7817')
check 'port-only dry-run' "$(printf '%s' "$out" | grep -q 'DRY-RUN start-companion port=7817' && echo 1 || echo 0)"
if FALSIFY_CONNECT_DRY_RUN=1 "$root/open-connection.sh" 'falsify://connect?port=7816&password=x' >/dev/null 2>&1; then
  check 'open rejects password' 0
else
  check 'open rejects password' 1
fi

# Exercise launcher ownership with a deterministic interpreter stub, without binding a port.
launch_tmp=$(mktemp -d)
mkdir -p "$launch_tmp/.venv/bin" "$launch_tmp/app/local" "$launch_tmp/private"
cp "$root/open-connection.sh" "$root/falsify-connection.sh" "$launch_tmp/"
cat > "$launch_tmp/.venv/bin/python" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = -c ]; then exit 0; fi
case "$1:$2" in
  */pairing.py:probe)
    case "$PROBE_MODE" in
      existing) echo "existing $$"; exit 0 ;;
      foreign) echo foreign; exit 2 ;;
      start)
        case " $* " in *' --expected-pid '*) echo 'existing 1'; exit 0 ;; esac
        echo absent; exit 1 ;;
    esac ;;
  */pairing.py:register)
    if [ "$PROBE_MODE" = start ]; then echo refused; exit 1; fi
    echo registered; exit 0 ;;
  */server.py:*) echo $$ > "$CHILD_FILE"; exec sleep 60 ;;
esac
exit 1
STUB
chmod +x "$launch_tmp/.venv/bin/python"
link="falsify://connect?port=40123&challenge=${nonce_a}&state=${nonce_b}&proof=${nonce_c}"
if PROBE_MODE=existing CHILD_FILE="$launch_tmp/child" FALSIFY_CONNECT_APPROVAL=yes FALSIFY_PAIRING_DIR="$launch_tmp/private" "$launch_tmp/open-connection.sh" "$link" >/dev/null && [ ! -e "$launch_tmp/child" ]; then
  check 'reuses matching companion without starting child' 1
else
  check 'reuses matching companion without starting child' 0
fi
if PROBE_MODE=foreign CHILD_FILE="$launch_tmp/child" FALSIFY_CONNECT_APPROVAL=yes FALSIFY_PAIRING_DIR="$launch_tmp/private" "$launch_tmp/open-connection.sh" "$link" >"$launch_tmp/out" 2>&1; then
  check 'foreign port refused without starting child' 0
else
  check 'foreign port refused without starting child' "$(grep -q 'Port 40123 is occupied' "$launch_tmp/out" && [ ! -e "$launch_tmp/child" ] && echo 1 || echo 0)"
fi
if PROBE_MODE=start CHILD_FILE="$launch_tmp/child" FALSIFY_CONNECT_APPROVAL=yes FALSIFY_PAIRING_DIR="$launch_tmp/private" "$launch_tmp/open-connection.sh" "$link" >/dev/null 2>&1; then
  check 'failed registration cleans started child' 0
else
  child=$(cat "$launch_tmp/child")
  if kill -0 "$child" 2>/dev/null; then check 'failed registration cleans started child' 0; else check 'failed registration cleans started child' 1; fi
fi

test_home_dir=$(mktemp -d)
FALSIFY_CONNECT_OS=Linux FALSIFY_CONNECT_HOME="$test_home_dir" FALSIFY_CONNECT_DRY_RUN=1 "$root/install-connection.sh" | grep -q 'DRY-RUN install linux'
FALSIFY_CONNECT_OS=Linux FALSIFY_CONNECT_HOME="$test_home_dir" "$root/install-connection.sh" >/dev/null
mode=$(falsify_mode "$test_home_dir/.local/share/applications")
check 'linux applications dir is private' "$([ "$mode" = 700 ] && echo 1 || echo 0)"
grep -q "Exec=$root/open-connection.sh %u" "$test_home_dir/.local/share/applications/falsify-connect.desktop"
# A foreign handler is not removed.
foreign=$test_home_dir/.local/share/applications/falsify-connect.desktop
printf 'Exec=/other/open-connection.sh %%u\n' > "$foreign"
if FALSIFY_CONNECT_OS=Linux FALSIFY_CONNECT_HOME="$test_home_dir" "$root/uninstall-connection.sh" >/dev/null 2>&1; then
  check 'linux uninstall refuses foreign handler' 0
else
  check 'linux uninstall refuses foreign handler' 1
fi
FALSIFY_CONNECT_OS=Linux FALSIFY_CONNECT_HOME="$test_home_dir" "$root/install-connection.sh" >/dev/null
FALSIFY_CONNECT_OS=Linux FALSIFY_CONNECT_HOME="$test_home_dir" "$root/uninstall-connection.sh" >/dev/null
if [ -f "$test_home_dir/.local/share/applications/falsify-connect.desktop" ]; then
  check 'linux uninstall removes own handler' 0
else
  check 'linux uninstall removes own handler' 1
fi
work=$(mktemp -d)
if FALSIFY_PYTHON= falsify_project_python "$work" >"$work/out" 2>"$work/err"; then
  check 'missing python fails closed' 0
else
  msg=$(cat "$work/err")
  check 'missing python fails closed' "$(printf '%s' "$msg" | grep -q 'Python 3' && ! printf '%s' "$msg" | grep -q 'Approved' && echo 1 || echo 0)"
fi
bindir=$work/bin
mkdir -p "$bindir"
cat > "$bindir/python3" << 'EOF'
#!/bin/sh
if [ "$1" = -m ] && [ "$2" = venv ]; then
  mkdir -p "$3/bin"
  printf '%s\n' '#!/bin/sh' 'exit 1' > "$3/bin/python"
  chmod +x "$3/bin/python"
  exit 0
fi
exit 1
EOF
chmod +x "$bindir/python3"
if FALSIFY_PYTHON="$bindir/python3" falsify_project_python "$work" >"$work/out2" 2>"$work/err2"; then
  check 'missing jsonschema fails closed' 0
else
  err=$(cat "$work/err2")
  check 'missing jsonschema fails closed' "$(printf '%s' "$err" | grep -q jsonschema && ! printf '%s' "$err" | grep -q Approved && [ -x "$work/.venv/bin/python" ] && echo 1 || echo 0)"
fi
printf '%s\n' '#!/bin/sh' 'exit 0' > "$work/.venv/bin/python"
chmod +x "$work/.venv/bin/python"
got=$(FALSIFY_PYTHON="$bindir/python3" falsify_project_python "$work")
check 'first install uses project venv' "$([ "$got" = "$work/.venv/bin/python" ] && echo 1 || echo 0)"
if grep -E 'kill -9|pkill|killall' "$root/open-connection.sh" "$root/install-connection.sh" "$root/falsify-connection.sh" >/dev/null; then
  check 'no arbitrary force kill' 0
else
  check 'no arbitrary force kill' 1
fi
private_file=$work/private-mode
printf 'x\n' > "$private_file"
chmod 600 "$private_file"
check 'gnu stat mode' "$([ "$(falsify_mode "$private_file")" = 600 ] && echo 1 || echo 0)"
real_stat=$(command -v stat)
stat_dir=$work/stat-bsd
mkdir -p "$stat_dir"
cat > "$stat_dir/stat" << EOF
#!/bin/sh
if [ "\$1" = -c ]; then
  echo 'gnu stat refused' >&2
  exit 1
fi
if [ "\$1" = -f ] && [ "\$2" = %OLp ]; then
  if mode=\$($(printf '%q' "$real_stat") -c '%a' "\$3" 2>/dev/null); then
    printf '%s\\n' "\$mode"
  else
    exec $(printf '%q' "$real_stat") -f '%OLp' "\$3"
  fi
fi
echo "unexpected stat \$*" >&2
exit 1
EOF
chmod +x "$stat_dir/stat"
bsd_mode=$(PATH="$stat_dir:$PATH" falsify_mode "$private_file")
check 'bsd stat mode fallback' "$([ "$bsd_mode" = 600 ] && echo 1 || echo 0)"
rm -rf "$work"
rm -rf "$test_home_dir"

python3 - << PY
import pathlib, sys
sys.path.insert(0, str(pathlib.Path("$root") / "app" / "local"))
import pairing
uri = "$pair"
parsed = pairing.parse_connect_uri(uri)
assert parsed["port"] == 7816 and parsed["pairing"] and parsed["challenge"] == "$nonce_a"
try:
    pairing.parse_connect_uri("falsify://connect?port=7816&cmd=calc")
    raise SystemExit(1)
except pairing.PairingError:
    pass
print("python parser agrees")
PY
check 'python parser agrees' 1

echo "$ok checks, $fail failed"
[ "$fail" -eq 0 ]
