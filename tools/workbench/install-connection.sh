#!/usr/bin/env bash
# Installs a per-user falsify:// handler.
# Linux: a desktop entry that runs this checkout's open-connection.sh.
# macOS: an AppleScript applet registered with Launch Services. The applet calls this
# checkout's open-connection.sh by the absolute path recorded at install time.
# No administrator rights, login item, LaunchAgent, or approval-dialog suppression.
# FALSIFY_CONNECT_DRY_RUN=1 prints the plan. FALSIFY_CONNECT_HOME selects the install directory.
# FALSIFY_CONNECT_ISOLATED=1 with FALSIFY_CONNECT_SCHEME registers a test scheme, never falsify.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$root/falsify-connection.sh"
install_home=$(falsify_install_home)
os=${FALSIFY_CONNECT_OS:-$(uname -s)}
dry=${FALSIFY_CONNECT_DRY_RUN:-}
handler=$root/open-connection.sh
applescript=$root/FalsifyConnect.applescript
marker=$(falsify_owner_marker)
scheme=falsify
if [ "${FALSIFY_CONNECT_ISOLATED:-}" = 1 ]; then
  scheme=${FALSIFY_CONNECT_SCHEME:-falsify-test-isolated}
  if [ "$scheme" = falsify ] || ! printf '%s' "$scheme" | grep -Eq '^[A-Za-z][A-Za-z0-9-]{0,40}$'; then
    echo 'Refused: an isolated handler must use its own scheme, not falsify.' >&2
    exit 1
  fi
fi

falsify_plist_add_claim() {
  plist=$1
  if [ ! -f "$plist" ]; then
    echo 'Refused: the applet has no Info.plist.' >&2
    return 1
  fi
  if command -v plutil >/dev/null 2>&1; then
    plutil -convert xml1 "$plist"
  fi
  if ! grep -q '<plist' "$plist"; then
    echo 'Refused: Info.plist is not XML. plutil is required to edit a binary plist.' >&2
    return 1
  fi
  if grep -q '<key>CFBundleURLTypes</key>' "$plist"; then
    echo 'Refused: the applet already declares URL types.' >&2
    return 1
  fi
  block=$(mktemp)
  # Placeholders stay literal. awk gsub would treat & and \ in an XML-escaped path specially.
  cat > "$block" << 'EOF'
	<key>CFBundleURLTypes</key>
	<array>
		<dict>
			<key>CFBundleTypeRole</key>
			<string>Viewer</string>
			<key>CFBundleURLName</key>
			<string>io.github.shinick-han.falsify-workbench.connect</string>
			<key>CFBundleURLSchemes</key>
			<array>
				<string>@@SCHEME@@</string>
			</array>
		</dict>
	</array>
	<key>FalsifyOwner</key>
	<string>@@MARKER@@</string>
	<key>FalsifyScriptPath</key>
	<string>@@HANDLER@@</string>
	<key>LSMinimumSystemVersionByArchitecture</key>
	<dict>
		<key>x86_64</key>
		<string>10.6</string>
		<key>arm64</key>
		<string>11.0</string>
	</dict>
EOF
  filled=$(mktemp)
  awk -v scheme="$(falsify_awk_repl "$(falsify_xml_escape "$scheme")")" \
      -v marker="$(falsify_awk_repl "$(falsify_xml_escape "$marker")")" \
      -v handler="$(falsify_awk_repl "$(falsify_xml_escape "$handler")")" '
    {
      gsub(/@@SCHEME@@/, scheme)
      gsub(/@@MARKER@@/, marker)
      gsub(/@@HANDLER@@/, handler)
      print
    }
  ' "$block" > "$filled"
  mv "$filled" "$block"
  tmp=$(mktemp)
  awk -v blockfile="$block" '
    BEGIN { n = 0 }
    { lines[++n] = $0 }
    END {
      last = 0
      for (i = 1; i <= n; i++) if (lines[i] ~ /<\/dict>/) last = i
      if (last == 0) exit 2
      for (i = 1; i < last; i++) print lines[i]
      while ((getline line < blockfile) > 0) print line
      close(blockfile)
      for (i = last; i <= n; i++) print lines[i]
    }
  ' "$plist" > "$tmp"
  rm -f "$block"
  mv "$tmp" "$plist"
}

# Escape \ and & so awk gsub inserts the XML text unchanged.
falsify_awk_repl() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/&/\\&/g'
}

falsify_other_handlers() {
  registrar=$1
  own_app=$2
  dump=$(mktemp)
  if ! "$registrar" -dump > "$dump"; then
    rm -f "$dump"
    echo 'Refused: Launch Services dump failed, so an existing handler could not be checked.' >&2
    return 1
  fi
  others=$(falsify_scheme_handlers "$scheme" "$dump" | awk -v own="$own_app" '$0 != own')
  rm -f "$dump"
  if [ -n "$others" ]; then
    printf '%s\n' "$others" >&2
    echo 'Refused: another application already claims this URL scheme. It was not replaced.' >&2
    return 1
  fi
}

if [ "$os" = Darwin ]; then
  app=$(falsify_darwin_app "$install_home")
  support=$(dirname "$app")
  echo "macOS handler: $app"
  echo "Checkout script: $handler"
  echo 'Browser and macOS approval dialogs are unchanged. This installer does not click them. GUI approval was not tested here.'
  compiler=${FALSIFY_OSACOMPILE:-$(command -v osacompile || true)}
  if ! registrar=$(falsify_lsregister_path); then
    registrar=''
  fi
  case $handler in
    *$'\n'*) echo 'Refused: the checkout script path contains a newline.' >&2; exit 1 ;;
  esac
  if [ "$dry" = 1 ]; then
    echo "DRY-RUN install darwin app=$app script=$handler scheme=$scheme compiler=${compiler:-osacompile-missing} registrar=${registrar:-lsregister-missing} -f"
    exit 0
  fi
  if [ -z "$compiler" ] || [ ! -x "$compiler" ]; then
    echo 'Refused: osacompile is not available, so no AppleScript URL handler was built.' >&2
    exit 1
  fi
  if [ -z "$registrar" ] || [ ! -x "$registrar" ]; then
    echo 'Refused: lsregister is not available, so no URL handler was registered.' >&2
    exit 1
  fi
  if [ -d "$app" ]; then
    owner_file=$app/Contents/Resources/falsify-owner.txt
    if [ ! -f "$owner_file" ] || [ "$(sed -n '1p' "$owner_file")" != "$marker" ]; then
      echo 'Refused: the macOS handler at the install location is not this launcher.' >&2
      exit 1
    fi
    recorded_file=$app/Contents/Resources/falsify-script-path.txt
    if [ ! -f "$recorded_file" ] || [ "$(sed -n '1p' "$recorded_file")" != "$handler" ]; then
      echo 'Refused: the macOS handler points at a different checkout. Nothing was replaced.' >&2
      exit 1
    fi
  elif [ -e "$app" ] || [ -L "$app" ]; then
    echo 'Refused: the macOS handler location is not an owned applet.' >&2
    exit 1
  fi
  falsify_other_handlers "$registrar" "$app"
  stage=$(mktemp -d)
  trap 'rm -rf "$stage"' EXIT
  staged=$stage/Falsify\ Connect.app
  "$compiler" -o "$staged" "$applescript"
  falsify_plist_add_claim "$staged/Contents/Info.plist"
  printf '%s\n' "$handler" > "$staged/Contents/Resources/falsify-script-path.txt"
  printf '%s\n%s\n' "$marker" "$handler" > "$staged/Contents/Resources/falsify-owner.txt"
  chmod 600 "$staged/Contents/Resources/falsify-script-path.txt" "$staged/Contents/Resources/falsify-owner.txt"
  mkdir -p "$support"
  chmod 700 "$support"
  rm -rf "$app"
  mv "$staged" "$app"
  rm -rf "$stage"
  "$registrar" -f "$app"
  echo "Registered the per-user $scheme handler with Launch Services. It runs $handler. No login item or startup service was created."
  exit 0
fi

desktop_dir=$install_home/.local/share/applications
desktop=$desktop_dir/falsify-connect.desktop
echo "Linux handler: $desktop"
if [ "$dry" = 1 ]; then
  echo "DRY-RUN install linux desktop=$desktop exec=$handler"
  exit 0
fi
mkdir -p "$desktop_dir"
chmod 700 "$desktop_dir"
cat > "$desktop" << EOF
[Desktop Entry]
Type=Application
Name=Falsify Connect
Exec=$handler %u
NoDisplay=true
Terminal=false
MimeType=x-scheme-handler/falsify;
EOF
chmod 644 "$desktop"
mime=$desktop_dir/mimeapps.list
line='x-scheme-handler/falsify=falsify-connect.desktop'
if [ -f "$mime" ] && grep -Fqx "$line" "$mime"; then
  :
else
  touch "$mime"
  chmod 644 "$mime"
  if ! grep -q '^\[Default Applications\]' "$mime"; then
    printf '\n[Default Applications]\n' >> "$mime"
  fi
  printf '%s\n' "$line" >> "$mime"
fi
echo 'Installed the per-user falsify:// handler. The browser cannot detect it and will still ask before opening it. Manual start remains available.'
