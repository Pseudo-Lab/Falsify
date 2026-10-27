#!/usr/bin/env bash
# Linux mock of the macOS URL handler, plus a real Darwin compile when the tools exist.
# The mock never talks to Launch Services. GUI approval is not clicked on either path.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck disable=SC1091
. "$root/falsify-connection.sh"
fail=0
ok=0
skip=0
check() {
  ok=$((ok + 1))
  if [ "$2" = 1 ]; then
    echo "ok   $1"
  else
    echo "FAIL $1"
    fail=$((fail + 1))
  fi
}
work=$(mktemp -d)
real_app=
real_ls=
cleanup() {
  if [ -n "$real_ls" ] && [ -n "$real_app" ] && [ -d "$real_app" ]; then
    "$real_ls" -u "$real_app" || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# Match native AppleScript semantics: No/Escape must exit nonzero, never approve.
(
  uname() { printf '%s\n' Darwin; }
  osascript() {
    printf '%s\n' "$*" > "$work/approval-command.txt"
    return "$approval_exit"
  }
  approval_exit=1
  if falsify_ask_visible; then
    echo 'FAIL native approval cancellation accepted' >&2
    exit 1
  fi
  approval_exit=0
  falsify_ask_visible
  grep -Fq 'cancel button "No"' "$work/approval-command.txt"
)
check 'native approval No and Escape cancel; Yes approves' 1

check 'xml escape' "$([ "$(falsify_xml_escape 'a&b<c>d')" = 'a&amp;b&lt;c&gt;d' ] && echo 1 || echo 0)"
check 'darwin app path' "$([ "$(falsify_darwin_app /var/test)" = '/var/test/Library/Application Support/falsify-workbench/Falsify Connect.app' ] && echo 1 || echo 0)"

dump=$work/dump.txt
cat > "$dump" << 'EOF'
path: /tmp/Other.app (0x1a2b)
name: Other
claimed schemes: https: falsify:
path: /tmp/Library/Application Support/falsify-workbench/Falsify Connect.app (0x3c)
claimed schemes: https:
path: /tmp/Test.app
claimed schemes: falsify-test:
path: /tmp/Not.app
claimed schemes: notfalsify:
path: /tmp/Indent.app (0x10)
claimed schemes:
  falsify:
path: /tmp/Ours.app (0x99)
claimed schemes: falsify:
EOF
scheme=kept
falsify_scheme_handlers falsify "$dump" >/dev/null
got=$(falsify_scheme_handlers falsify "$dump" | awk -v own=/tmp/Ours.app '$0 != own' | sort)
want=$(printf '%s\n' '/tmp/Indent.app' '/tmp/Other.app' | sort)
check 'dump parser keeps caller binding' "$([ "$scheme" = kept ] && echo 1 || echo 0)"
check 'dump parser exact falsify claims' "$([ "$got" = "$want" ] && echo 1 || echo 0)"
got=$(falsify_scheme_handlers falsify-test "$dump")
check 'dump parser ignores prefix schemes' "$([ "$got" = /tmp/Test.app ] && echo 1 || echo 0)"

stub_compile=$work/osacompile
stub_ls=$work/lsregister
db=$work/ls.db
: > "$db"
cat > "$stub_compile" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
out=
script=
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    -*) echo "stub osacompile refuses $1" >&2; exit 2 ;;
    *) script=$1; shift ;;
  esac
done
if [ -z "${out}" ] || [ -z "${script}" ]; then
  echo 'stub osacompile: missing output or script' >&2
  exit 2
fi
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources/Scripts"
cp "$script" "$out/Contents/Resources/Scripts/main.applescript"
cat > "$out/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>applet</string>
	<key>CFBundleIdentifier</key>
	<string>io.github.shinick-han.falsify-workbench.connect-stub</string>
	<key>CFBundleName</key>
	<string>Falsify Connect</string>
	<key>NSAppleScriptEnabled</key>
	<true/>
</dict>
</plist>
PLIST
printf '%s\n' '#!/bin/sh' 'exit 0' > "$out/Contents/MacOS/applet"
chmod +x "$out/Contents/MacOS/applet"
EOF
cat > "$stub_ls" << 'EOF'
#!/usr/bin/env bash
set -euo pipefail
db=${FALSIFY_LSREGISTER_DB:?}
cmd=
target=
for arg in "$@"; do
  case "$arg" in
    -trusted|-kill|-delete|-gc|-domain)
      echo "stub lsregister refuses $arg" >&2
      exit 2
      ;;
    -f|-u|-dump) cmd=$arg ;;
    -*) echo "stub lsregister refuses $arg" >&2; exit 2 ;;
    *) target=$arg ;;
  esac
done
mkdir -p "$(dirname "$db")"
touch "$db"
case "$cmd" in
  -dump) cat "$db" ;;
  -u)
    [ -n "$target" ]
    tmp=$(mktemp)
    awk -v app="$target" '
      BEGIN { skip = 0 }
      skip == 1 { skip = 0; next }
      /^path:/ {
        path = $0
        sub(/^path:[[:space:]]*/, "", path)
        if (path == app) { skip = 1; next }
      }
      { print }
    ' "$db" > "$tmp"
    mv "$tmp" "$db"
    ;;
  -f)
    [ -n "$target" ]
    scheme=$(awk '
      /<key>CFBundleURLSchemes<\/key>/ { grab = 1; next }
      grab && /<string>/ {
        line = $0
        sub(/.*<string>/, "", line)
        sub(/<\/string>.*/, "", line)
        print line
        exit
      }
    ' "$target/Contents/Info.plist")
    [ -n "$scheme" ]
    printf 'path: %s\nclaimed schemes: %s:\n' "$target" "$scheme" >> "$db"
    ;;
  *)
    echo 'stub lsregister: expected -f, -u, or -dump' >&2
    exit 2
    ;;
esac
EOF
chmod +x "$stub_compile" "$stub_ls"

darwin_install() {
  local home_dir=$1
  shift
  FALSIFY_CONNECT_OS=Darwin \
    FALSIFY_OSACOMPILE="$stub_compile" \
    FALSIFY_LSREGISTER="$stub_ls" \
    FALSIFY_LSREGISTER_DB="$db" \
    FALSIFY_CONNECT_HOME="$home_dir" \
    "$@"
}

echo 'Linux mock Darwin installer (stand-in osacompile and lsregister; GUI approval is not exercised)'

test_home_dir=$work/home-happy
mkdir -p "$test_home_dir"
pair_dir="$test_home_dir/Library/Application Support/falsify-workbench/pairing"
mkdir -p "$pair_dir"
printf 'secret-key-material\n' > "$pair_dir/key"
app=$(falsify_darwin_app "$test_home_dir")
if out=$(darwin_install "$test_home_dir" "$root/install-connection.sh" 2>&1); then
  check 'linux mock install' 1
else
  printf '%s\n' "$out" >&2
  check 'linux mock install' 0
fi
check 'linux mock says gui was not clicked' "$(printf '%s' "$out" | grep -q 'does not click them' && printf '%s' "$out" | grep -q 'GUI approval was not tested' && ! printf '%s' "$out" | grep -q -- '-trusted' && echo 1 || echo 0)"
check 'linux mock keeps checkout script path' "$([ "$(sed -n '1p' "$app/Contents/Resources/falsify-script-path.txt")" = "$root/open-connection.sh" ] && echo 1 || echo 0)"
recorded_root=$(CDPATH= cd -- "$(dirname -- "$(sed -n '1p' "$app/Contents/Resources/falsify-script-path.txt")")" && pwd)
check 'recorded script directory is the checkout' "$([ "$recorded_root" = "$root" ] && echo 1 || echo 0)"
if find "$test_home_dir/Library/Application Support/falsify-workbench" -name 'open-connection.sh' -print | grep -q .; then
  check 'shell handler is not copied' 0
else
  check 'shell handler is not copied' 1
fi
check 'no linux desktop from darwin install' "$([ ! -e "$test_home_dir/.local/share/applications/falsify-connect.desktop" ] && echo 1 || echo 0)"
plist=$app/Contents/Info.plist
copied=$app/Contents/Resources/Scripts/main.applescript
check 'applescript opens locations with quoted paths' "$(grep -q 'on open location' "$root/FalsifyConnect.applescript" && grep -q 'quoted form of' "$root/FalsifyConnect.applescript" && ! grep -q "$root" "$root/FalsifyConnect.applescript" && ! grep -q "$root" "$copied" && echo 1 || echo 0)"
check 'applescript reads the checkout path as UTF-8' "$(grep -q 'as «class utf8»' "$root/FalsifyConnect.applescript" && echo 1 || echo 0)"
check 'bundle claims falsify for intel and arm' "$(
  grep -q '<key>CFBundleURLTypes</key>' "$plist" &&
  grep -q '<string>Viewer</string>' "$plist" &&
  grep -q '<string>falsify</string>' "$plist" &&
  grep -q '<key>x86_64</key>' "$plist" &&
  grep -q '<string>10.6</string>' "$plist" &&
  grep -q '<key>arm64</key>' "$plist" &&
  grep -q '<string>11.0</string>' "$plist" &&
  grep -q "$(falsify_owner_marker)" "$plist" &&
  grep -q '<string>applet</string>' "$plist" &&
  grep -F "$root/open-connection.sh" "$plist" >/dev/null &&
  ! grep -q '@@' "$plist" &&
  echo 1 || echo 0
)"
check 'owner marker and private modes' "$(
  [ "$(sed -n '1p' "$app/Contents/Resources/falsify-owner.txt")" = "$(falsify_owner_marker)" ] &&
  [ "$(falsify_mode "$app/Contents/Resources/falsify-script-path.txt")" = 600 ] &&
  [ "$(falsify_mode "$app/Contents/Resources/falsify-owner.txt")" = 600 ] &&
  [ "$(falsify_mode "$(dirname "$app")")" = 700 ] &&
  echo 1 || echo 0
)"
check 'stub database claims only this app' "$([ "$(falsify_scheme_handlers falsify "$db")" = "$app" ] && echo 1 || echo 0)"
check 'pairing key survived install' "$([ "$(cat "$pair_dir/key")" = 'secret-key-material' ] && echo 1 || echo 0)"
if darwin_install "$test_home_dir" "$root/install-connection.sh" >/dev/null 2>&1; then
  check 'second install updates own applet' "$([ "$(sed -n '1p' "$app/Contents/Resources/falsify-script-path.txt")" = "$root/open-connection.sh" ] && echo 1 || echo 0)"
else
  check 'second install updates own applet' 0
fi

printf 'path: %s\nclaimed schemes: mailto:\n' "$work/Other.app" >> "$db"
if darwin_install "$test_home_dir" "$root/uninstall-connection.sh" >"$work/uninstall.out" 2>&1; then
  check 'linux mock uninstall' 1
else
  printf '%s\n' "$(cat "$work/uninstall.out")" >&2
  check 'linux mock uninstall' 0
fi
if grep -F "$app" "$db" >/dev/null; then
  check 'unregister removes only this applet' 0
else
  check 'unregister removes only this applet' "$(grep -F "$work/Other.app" "$db" >/dev/null && [ ! -d "$app" ] && [ "$(cat "$pair_dir/key")" = 'secret-key-material' ] && echo 1 || echo 0)"
fi

: > "$db"
printf 'path: %s\nclaimed schemes: falsify:\n' "$work/Other.app" > "$db"
foreign_home=$work/home-foreign
mkdir -p "$foreign_home"
foreign_app=$(falsify_darwin_app "$foreign_home")
if darwin_install "$foreign_home" "$root/install-connection.sh" >"$work/foreign.out" 2>&1; then
  check 'foreign handler refuses install' 0
else
  check 'foreign handler refuses install' "$(grep -q 'was not replaced' "$work/foreign.out" && [ ! -d "$foreign_app" ] && grep -F "$work/Other.app" "$db" >/dev/null && echo 1 || echo 0)"
fi

: > "$db"
marker_home=$work/home-marker
marker_app=$(falsify_darwin_app "$marker_home")
mkdir -p "$marker_app/Contents/Resources"
printf 'someone-else\n' > "$marker_app/Contents/Resources/falsify-owner.txt"
if darwin_install "$marker_home" "$root/install-connection.sh" >"$work/marker.out" 2>&1; then
  check 'foreign marker is not overwritten' 0
else
  check 'foreign marker is not overwritten' "$(grep -q 'not this launcher' "$work/marker.out" && [ "$(sed -n '1p' "$marker_app/Contents/Resources/falsify-owner.txt")" = someone-else ] && echo 1 || echo 0)"
fi

: > "$db"
other_home=$work/home-other-checkout
mkdir -p "$other_home"
other_app=$(falsify_darwin_app "$other_home")
darwin_install "$other_home" "$root/install-connection.sh" >/dev/null
printf '/other/open-connection.sh\n' > "$other_app/Contents/Resources/falsify-script-path.txt"
if darwin_install "$other_home" "$root/install-connection.sh" >"$work/other-install.out" 2>&1; then
  check 'install refuses a different checkout' 0
else
  check 'install refuses a different checkout' "$(grep -q 'different checkout' "$work/other-install.out" && [ "$(sed -n '1p' "$other_app/Contents/Resources/falsify-script-path.txt")" = /other/open-connection.sh ] && echo 1 || echo 0)"
fi
before=$(grep -c -F "$other_app" "$db" || true)
if darwin_install "$other_home" "$root/uninstall-connection.sh" >"$work/other-uninstall.out" 2>&1; then
  check 'uninstall refuses a different checkout' 0
else
  after=$(grep -c -F "$other_app" "$db" || true)
  check 'uninstall refuses a different checkout' "$(grep -q 'different checkout' "$work/other-uninstall.out" && [ -d "$other_app" ] && [ "$before" = "$after" ] && echo 1 || echo 0)"
fi

if FALSIFY_CONNECT_ISOLATED=1 FALSIFY_CONNECT_SCHEME=falsify darwin_install "$work/unused" "$root/install-connection.sh" >/dev/null 2>&1; then
  check 'isolated mode refuses the falsify scheme' 0
else
  check 'isolated mode refuses the falsify scheme' 1
fi
: > "$db"
iso_home=$work/home-isolated
mkdir -p "$iso_home"
iso_app=$(falsify_darwin_app "$iso_home")
if FALSIFY_CONNECT_ISOLATED=1 darwin_install "$iso_home" "$root/install-connection.sh" >"$work/iso.out" 2>&1; then
  iso_claims=$(falsify_scheme_handlers falsify "$db" || true)
  iso_test=$(falsify_scheme_handlers falsify-test-isolated "$db" || true)
  check 'isolated mock registers its own scheme' "$(
    grep -q '<string>falsify-test-isolated</string>' "$iso_app/Contents/Info.plist" &&
    ! grep -q '<string>falsify</string>' "$iso_app/Contents/Info.plist" &&
    [ -z "$iso_claims" ] &&
    [ "$iso_test" = "$iso_app" ] &&
    echo 1 || echo 0
  )"
else
  printf '%s\n' "$(cat "$work/iso.out")" >&2
  check 'isolated mock registers its own scheme' 0
fi

bare_home=$work/home-bare
mkdir -p "$bare_home"
bare_app=$(falsify_darwin_app "$bare_home")
if out=$(env -u FALSIFY_OSACOMPILE -u FALSIFY_LSREGISTER FALSIFY_CONNECT_OS=Darwin FALSIFY_CONNECT_DRY_RUN=1 FALSIFY_CONNECT_HOME="$bare_home" "$root/install-connection.sh" 2>&1); then
  check 'dry-run without macOS tools' "$(
    printf '%s' "$out" | grep -q 'DRY-RUN install darwin' &&
    printf '%s' "$out" | grep -q 'GUI approval was not tested' &&
    ! printf '%s' "$out" | grep -q -- '-trusted' &&
    [ ! -e "$bare_app" ] &&
    echo 1 || echo 0
  )"
else
  check 'dry-run without macOS tools' 0
fi
if out=$(env FALSIFY_OSACOMPILE="$work/not-an-osacompile" FALSIFY_CONNECT_OS=Darwin FALSIFY_CONNECT_HOME="$bare_home" "$root/install-connection.sh" 2>&1); then
  check 'real install without tools fails closed' 0
else
  check 'real install without tools fails closed' "$(printf '%s' "$out" | grep -q 'osacompile is not available' && [ ! -e "$bare_app" ] && echo 1 || echo 0)"
fi

if grep -nE '(^|[[:space:]])sudo[[:space:]]|launchctl|LaunchAgents/|-trusted|LSSetDefaultHandler|osascript' \
  "$root/install-connection.sh" "$root/uninstall-connection.sh" >/dev/null; then
  check 'installer does not elevate or suppress approval' 0
else
  check 'installer does not elevate or suppress approval' 1
fi
if grep -nE '(^|[^A-Za-z0-9_])home=|(^|[^A-Za-z0-9_])HOME=' \
  "$root/install-connection.sh" "$root/uninstall-connection.sh" "$root/open-connection.sh" \
  "$root/falsify-connection.sh" "$root/scripts/test-posix-connection.sh" >/dev/null; then
  check 'scripts do not assign home' 0
else
  check 'scripts do not assign home' 1
fi

echo 'Real Darwin compile/register (separate from the Linux mock)'
real_compile=$(command -v osacompile || true)
for candidate in \
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister \
  /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
do
  if [ -x "$candidate" ]; then
    real_ls=$candidate
    break
  fi
done
if [ "$(uname -s)" = Darwin ] && [ -n "$real_compile" ] && [ -x "$real_compile" ] && [ -n "$real_ls" ]; then
  real_home=$work/home-real
  mkdir -p "$real_home"
  real_app=$(falsify_darwin_app "$real_home")
  if env -u FALSIFY_OSACOMPILE -u FALSIFY_LSREGISTER -u FALSIFY_LSREGISTER_DB \
    FALSIFY_CONNECT_OS=Darwin FALSIFY_CONNECT_ISOLATED=1 \
    FALSIFY_CONNECT_SCHEME=falsify-test-isolated FALSIFY_CONNECT_HOME="$real_home" \
    "$root/install-connection.sh" >"$work/real-install.out" 2>&1; then
    check 'real darwin isolated install' 1
  else
    cat "$work/real-install.out" >&2
    check 'real darwin isolated install' 0
  fi
  if [ -f "$real_app/Contents/Info.plist" ]; then
    check 'real darwin bundle is isolated intel and arm' "$(
      grep -q '<string>falsify-test-isolated</string>' "$real_app/Contents/Info.plist" &&
      ! grep -q '<string>falsify</string>' "$real_app/Contents/Info.plist" &&
      grep -q '<key>x86_64</key>' "$real_app/Contents/Info.plist" &&
      grep -q '<key>arm64</key>' "$real_app/Contents/Info.plist" &&
      [ "$(sed -n '1p' "$real_app/Contents/Resources/falsify-script-path.txt")" = "$root/open-connection.sh" ] &&
      echo 1 || echo 0
    )"
  else
    check 'real darwin bundle is isolated intel and arm' 0
  fi
  real_dump=$work/real-dump.txt
  if "$real_ls" -dump > "$real_dump"; then
    iso_hit=$(falsify_scheme_handlers falsify-test-isolated "$real_dump" | grep -F "$real_app" || true)
    prod_hit=$(falsify_scheme_handlers falsify "$real_dump" | grep -F "$real_app" || true)
    check 'real darwin registers only the isolated scheme' "$([ -n "$iso_hit" ] && [ -z "$prod_hit" ] && echo 1 || echo 0)"
  else
    check 'real darwin registers only the isolated scheme' 0
  fi
  if env -u FALSIFY_OSACOMPILE -u FALSIFY_LSREGISTER -u FALSIFY_LSREGISTER_DB \
    FALSIFY_CONNECT_OS=Darwin FALSIFY_CONNECT_HOME="$real_home" \
    "$root/uninstall-connection.sh" >"$work/real-uninstall.out" 2>&1; then
    check 'real darwin unregister removes only the test applet' "$([ ! -d "$real_app" ] && echo 1 || echo 0)"
  else
    cat "$work/real-uninstall.out" >&2
    check 'real darwin unregister removes only the test applet' 0
  fi
  echo 'Real Darwin compile/register ran. GUI approval was not clicked by this test.'
else
  echo 'SKIP real Darwin compile/register: osacompile and lsregister are not both available. GUI approval was not tested.'
  skip=$((skip + 1))
fi

echo "$ok checks, $fail failed, $skip skipped"
[ "$fail" -eq 0 ]
