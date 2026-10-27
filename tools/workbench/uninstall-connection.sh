#!/usr/bin/env bash
# Removes only this checkout's per-user falsify:// handler.
# A handler owned by someone else, or pointing at another checkout, is left in place.
# macOS removal unregisters that one applet with lsregister -u and deletes only its bundle.
set -euo pipefail
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$root/falsify-connection.sh"
install_home=$(falsify_install_home)
os=${FALSIFY_CONNECT_OS:-$(uname -s)}
dry=${FALSIFY_CONNECT_DRY_RUN:-}
handler=$root/open-connection.sh
marker=$(falsify_owner_marker)

if [ "$os" = Darwin ]; then
  app=$(falsify_darwin_app "$install_home")
  echo "macOS handler: $app"
  if [ "$dry" = 1 ]; then
    echo "DRY-RUN uninstall darwin app=$app script=$handler"
    exit 0
  fi
  if [ ! -d "$app" ]; then
    echo 'No macOS handler from this installer.'
    exit 0
  fi
  owner_file=$app/Contents/Resources/falsify-owner.txt
  recorded_file=$app/Contents/Resources/falsify-script-path.txt
  if [ ! -f "$owner_file" ] || [ "$(sed -n '1p' "$owner_file")" != "$marker" ]; then
    echo 'Refused: the macOS handler is not this launcher. Nothing was removed.' >&2
    exit 1
  fi
  if [ ! -f "$recorded_file" ]; then
    echo 'Refused: the macOS handler has no recorded checkout. Nothing was removed.' >&2
    exit 1
  fi
  recorded=$(sed -n '1p' "$recorded_file")
  if [ "$recorded" != "$handler" ]; then
    echo 'Refused: the macOS handler points at a different checkout. Nothing was removed.' >&2
    exit 1
  fi
  if registrar=$(falsify_lsregister_path); then
    "$registrar" -u "$app"
  else
    echo 'Refused: lsregister is not available, so the handler was left registered.' >&2
    exit 1
  fi
  rm -rf "$app"
  echo 'Removed this checkout'"'"'s macOS URL handler. The project folder and pairing key were not deleted.'
  exit 0
fi

desktop=$install_home/.local/share/applications/falsify-connect.desktop
mime=$install_home/.local/share/applications/mimeapps.list
if [ ! -f "$desktop" ]; then
  echo 'No per-user falsify:// desktop handler from this installer.'
  exit 0
fi
exec_line=$(grep -E '^Exec=' "$desktop" || true)
case $exec_line in
  "Exec=$handler %u") ;;
  *) echo 'Refused: the desktop handler is not this checkout.' >&2; exit 1 ;;
esac
if [ "$dry" = 1 ]; then
  echo "DRY-RUN uninstall linux desktop=$desktop"
  exit 0
fi
rm -f "$desktop"
if [ -f "$mime" ]; then
  grep -Fvx 'x-scheme-handler/falsify=falsify-connect.desktop' "$mime" > "$mime.tmp" || true
  mv "$mime.tmp" "$mime"
  chmod 644 "$mime"
fi
echo 'Removed the per-user falsify:// handler. The project folder and its pairing key were not deleted.'
