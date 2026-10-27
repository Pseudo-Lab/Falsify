#!/usr/bin/env bash
# POSIX target of falsify://connect. One argument: the clicked link.
# Port-only starts the companion in the foreground and may print the process token for manual paste.
# A pairing link requires visible approval, then starts the companion in the background.
# The link never carries a bearer, password, or command. Errors are logged without credentials.
set -euo pipefail
# Finder/Launch Services supplies a reduced PATH; retain Homebrew and user CLI discovery.
if [ "$(uname -s)" = Darwin ]; then
  PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
  export PATH
fi
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# shellcheck disable=SC1091
. "$root/falsify-connection.sh"

if [ "$#" -ne 1 ]; then
  echo 'Rejected: expected exactly one falsify:// link.' >&2
  exit 1
fi
if ! parsed=$(falsify_parse_uri "$1"); then
  echo 'Rejected: falsify connect link.' >&2
  exit 1
fi
# shellcheck disable=SC2086
set -- $parsed
port=$1
pairing=$2
challenge=${3-}
state=${4-}
proof=${5-}

if [ "$pairing" = 0 ]; then
  if [ "${FALSIFY_CONNECT_DRY_RUN:-}" = 1 ]; then
    echo "DRY-RUN start-companion port=$port"
    exit 0
  fi
  if ! py=$(falsify_project_python "$root"); then
    exit 1
  fi
  exec "$py" "$root/app/local/server.py" --port "$port" --web-origin "$(falsify_fixed_origin)"
fi

decision=$(falsify_approval_decision "$(falsify_fixed_origin)" "${FALSIFY_CONNECT_APPROVAL:-}")
if [ "$decision" = ask ]; then
  if falsify_ask_visible; then
    decision=approve
  else
    decision=cancel
  fi
fi
if [ "$decision" != approve ]; then
  if [ "${FALSIFY_CONNECT_DRY_RUN:-}" = 1 ]; then
    echo "DRY-RUN pairing cancelled port=$port"
    exit 2
  fi
  echo 'Cancelled: the fixed website was not approved. No companion was started and no credential was issued.' >&2
  exit 2
fi
if [ "${FALSIFY_CONNECT_DRY_RUN:-}" = 1 ]; then
  echo "DRY-RUN start-companion port=$port pairing=1"
  exit 0
fi
if ! py=$(falsify_project_python "$root"); then
  exit 1
fi

server_path=$root/app/local/server.py
set +e
probe=$("$py" "$root/app/local/pairing.py" probe --port "$port" --expected-server-path "$server_path" 2>/dev/null)
probe_code=$?
set -e
server_pid=
started=0
case "$probe_code:$probe" in
  0:existing\ *) server_pid=${probe#existing } ;;
  1:absent)
    pairdir=$(falsify_pairing_dir)
    umask 077
    mkdir -p "$pairdir"
    chmod 700 "$pairdir"
    err=$pairdir/startup.err
    "$py" "$server_path" --port "$port" --web-origin "$(falsify_fixed_origin)" \
      --token-display hidden --pairing-dir "$pairdir" >/dev/null 2>"$err" &
    server_pid=$!
    started=1
    cleanup() {
      if [ "$started" = 1 ]; then
        kill "$server_pid" 2>/dev/null || true
        wait "$server_pid" 2>/dev/null || true
      fi
    }
    trap cleanup EXIT
    trap 'exit 1' HUP INT TERM
    ready=0
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
      if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
      if "$py" "$root/app/local/pairing.py" probe --port "$port" --expected-server-path "$server_path" --expected-pid "$server_pid" >/dev/null 2>&1 && kill -0 "$server_pid" 2>/dev/null; then
        ready=1
        break
      fi
      sleep 0.2
    done
    if [ "$ready" != 1 ]; then
      logdir=$(dirname "$pairdir")/logs
      mkdir -p "$logdir"
      chmod 700 "$logdir"
      logfile=$logdir/companion-errors.log
      if [ -f "$err" ]; then
        grep -Ev -i 'bearer|pairing token|rc1[.]' "$err" >> "$logfile" || true
      fi
      echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) companion not ready on port $port. No credential was issued." >> "$logfile"
      chmod 600 "$logfile" || true
      rm -f "$err"
      echo "Companion did not become ready on port $port; it may be occupied. The error was recorded without credentials." >&2
      exit 1
    fi
    rm -f "$err"
    ;;
  *)
    echo "Port $port is occupied by an unrelated or incompatible service, or a companion from another checkout. Stop it or select another port; it was not stopped." >&2
    exit 1
    ;;
esac
set +e
registered=$("$py" "$root/app/local/pairing.py" register --port "$port" --challenge "$challenge" --state "$state" --proof "$proof" --expected-server-path "$server_path" --expected-pid "$server_pid" 2>/dev/null)
register_code=$?
set -e
if [ "$register_code" -ne 0 ] || [ "$registered" != registered ] || { [ "$started" = 1 ] && ! kill -0 "$server_pid" 2>/dev/null; }; then
  echo "The companion on port $port refused one-time pairing or stopped. No website credential was issued." >&2
  exit 1
fi
started=0
trap - EXIT HUP INT TERM
echo "Approved $(falsify_fixed_origin) for a short-lived reconnect on port $port. The process token was not shown."
