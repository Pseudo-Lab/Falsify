# Shared helpers for the macOS and Linux falsify:// handler.
# Source this file. It does not start a companion, write a key, or show a dialog.
# The macOS approval dialog is optional and is not a certification of macOS behavior.

falsify_fixed_origin() {
  printf '%s\n' 'https://shinick-han.github.io'
}

# Prints approve, cancel, ask, or refuse. An empty choice asks; it does not approve.
falsify_approval_decision() {
  origin=$1
  choice=${2-}
  if [ "$origin" != "$(falsify_fixed_origin)" ]; then
    printf '%s\n' refuse
    return 0
  fi
  case "$choice" in
    yes) printf '%s\n' approve ;;
    no) printf '%s\n' cancel ;;
    *) printf '%s\n' ask ;;
  esac
}

falsify_pairing_dir() {
  if [ -n "${FALSIFY_PAIRING_DIR:-}" ]; then
    printf '%s\n' "$FALSIFY_PAIRING_DIR"
    return 0
  fi
  case "$(uname -s)" in
    Darwin) printf '%s\n' "$HOME/Library/Application Support/falsify-workbench/pairing" ;;
    *) printf '%s\n' "${XDG_DATA_HOME:-$HOME/.local/share}/falsify-workbench/pairing" ;;
  esac
}

# Visible one-time approval. Fails closed when no native dialog is available.
# macOS uses osascript only when that binary exists. Linux cloud runs do not have it.
falsify_ask_visible() {
  if [ "$(uname -s)" = Darwin ] && command -v osascript >/dev/null 2>&1; then
    osascript -e "display dialog \"Allow $(falsify_fixed_origin) to receive a short-lived local reconnect credential? This does not run a model or reveal the server process token.\" buttons {\"No\", \"Yes\"} default button \"No\" cancel button \"No\" with title \"Falsify local companion\"" >/dev/null
    return $?
  fi
  echo 'Visible approval is unavailable on this host. Use the manual token fallback. Nothing was approved.' >&2
  return 1
}

# Prints the project .venv interpreter. Creates the venv when it is missing.
# Does not install packages, does not kill processes, and does not claim the companion is ready.
# When FALSIFY_PYTHON is set, including empty, it is the only base interpreter used.
falsify_project_python() {
  local root py base
  root=$1
  py=$root/.venv/bin/python
  if [ ! -x "$py" ]; then
    if [ -n "${FALSIFY_PYTHON+x}" ]; then
      base=$FALSIFY_PYTHON
    else
      base=$(command -v python3 || true)
    fi
    if [ -z "$base" ] || [ ! -x "$base" ]; then
      echo 'Python 3 was not found. Install Python 3, then run: python3 -m venv .venv && .venv/bin/python -m pip install -r app/local/requirements.txt' >&2
      echo 'The companion was not started.' >&2
      return 1
    fi
    echo "Setup: creating project-local virtual environment $root/.venv" >&2
    if ! "$base" -m venv "$root/.venv"; then
      echo 'Could not create .venv. The companion was not started.' >&2
      return 1
    fi
  fi
  if [ ! -x "$py" ]; then
    echo 'The project virtual environment has no interpreter. The companion was not started.' >&2
    return 1
  fi
  if ! "$py" -c 'import jsonschema' >/dev/null 2>&1; then
    echo 'Python dependency jsonschema is missing from .venv. Run: .venv/bin/python -m pip install -r app/local/requirements.txt' >&2
    echo 'The companion was not started and is not ready.' >&2
    return 1
  fi
  printf '%s\n' "$py"
}

# Prints "port pairing" or "port pairing challenge state proof". pairing is 0 or 1.
falsify_parse_uri() {
  uri=$1
  if [ -z "$uri" ] || [ "${#uri}" -gt 184 ]; then
    return 1
  fi
  case $uri in
    *[[:space:]]*|*'#'*|*'%'|*'|'|*'<'*|*'('*) return 1 ;;
  esac
  local nonce='[A-Za-z0-9_-]{43}'
  if [[ $uri =~ ^falsify://connect/?\?port=([1-9][0-9]{3,4})\&challenge=(${nonce})\&state=(${nonce})\&proof=(${nonce})$ ]]; then
    local port=${BASH_REMATCH[1]}
    if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
      return 1
    fi
    printf '%s %s %s %s %s\n' "$port" 1 "${BASH_REMATCH[2]}" "${BASH_REMATCH[3]}" "${BASH_REMATCH[4]}"
    return 0
  fi
  if [[ $uri =~ ^falsify://connect/?\?port=([1-9][0-9]{3,4})$ ]]; then
    local port=${BASH_REMATCH[1]}
    if [ "$port" -lt 1024 ] || [ "$port" -gt 65535 ]; then
      return 1
    fi
    printf '%s %s\n' "$port" 0
    return 0
  fi
  return 1
}

falsify_owner_marker() {
  printf '%s\n' 'falsify-workbench/connect-launcher/v1'
}

# Directory that receives a per-user handler. Reads the real HOME only when no override is set.
falsify_install_home() {
  if [ -n "${FALSIFY_CONNECT_HOME:-}" ]; then
    printf '%s\n' "$FALSIFY_CONNECT_HOME"
  else
    printf '%s\n' "$HOME"
  fi
}

falsify_xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

# GNU stat -c and BSD stat -f both report the permission bits.
falsify_mode() {
  local target mode
  target=$1
  if mode=$(stat -c '%a' "$target" 2>/dev/null); then
    printf '%s\n' "$mode"
    return 0
  fi
  stat -f '%OLp' "$target"
}

falsify_darwin_app() {
  printf '%s\n' "$1/Library/Application Support/falsify-workbench/Falsify Connect.app"
}

falsify_lsregister_path() {
  if [ -n "${FALSIFY_LSREGISTER:-}" ]; then
    printf '%s\n' "$FALSIFY_LSREGISTER"
    return 0
  fi
  for candidate in \
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    /System/Library/Frameworks/CoreServices.framework/Versions/Current/Frameworks/LaunchServices.framework/Versions/Current/Support/lsregister \
    /System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister
  do
    if [ -x "$candidate" ]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

# Print bundle paths whose Launch Services dump claims this exact scheme.
# Accepts the real lsregister -dump shape (path plus claimed schemes) and the test stub.
falsify_scheme_handlers() {
  local scheme dump_file
  scheme=$1
  dump_file=$2
  # path: lines follow lsregister -dump. A scheme matches only as its own token,
  # so falsify-test: and notfalsify: are not claims for falsify.
  awk -v scheme="$scheme" '
    function claims(line, needle, rest, pos, pre) {
      needle = scheme ":"
      rest = line
      while ((pos = index(rest, needle)) > 0) {
        if (pos == 1) return 1
        pre = substr(rest, pos - 1, 1)
        if (pre !~ /[A-Za-z0-9-]/) return 1
        rest = substr(rest, pos + 1)
      }
      return 0
    }
    /^path:/ {
      path = $0
      sub(/^path:[[:space:]]*/, "", path)
      sub(/[[:space:]]*\(0x[0-9A-Fa-f]+\)[[:space:]]*$/, "", path)
      next
    }
    path != "" && claims($0) {
      print path
      path = ""
    }
  ' "$dump_file" | awk '!seen[$0]++'
}
