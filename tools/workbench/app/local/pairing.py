"""One-time click pairing for the fixed hosted origin.

The custom protocol carries a port, challenge, state, and the SHA-256 commitment of a
proof verifier. It never carries the raw verifier, a bearer token, a password, or a
command. The local launcher approves the fixed web origin, then registers that
commitment. Only a browser request from that origin can redeem it, once, by presenting
the raw verifier. The reconnect credential lasts 12 hours in the same tab and is revoked
explicitly. It does not start a model.

The reconnect credential is not the server process token. The process token stays on
the loopback launcher channel. The signing key lives outside the repository checkout.
"""
import argparse
import base64
import hashlib
import hmac
import json
import os
import re
import stat
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

FIXED_ORIGIN = 'https://shinick-han.github.io'
REGISTER_PATH = '/api/pair/register'
REDEEM_PATH = '/api/pair/redeem'
STATUS_PATH = '/api/pair/status'
REVOKE_PATH = '/api/pair/revoke'
REGISTER_SCHEMA = 'falsify.pair-register.v1'
REDEEM_SCHEMA = 'falsify.pair-redeem.v1'
STATUS_SCHEMA = 'falsify.pair-status.v1'
REVOKE_SCHEMA = 'falsify.pair-revoke.v1'
PENDING_TTL = 120
RECONNECT_TTL = 12 * 60 * 60
NONCE_RE = re.compile(r'[A-Za-z0-9_-]{43}')
PORT_RE = r'([1-9][0-9]{3,4})'
# Fixed query order. No percent-decoding, extra keys, fragments, userinfo or commands.
PAIR_URI_RE = re.compile(
    r'\Afalsify://connect/?\?port=' + PORT_RE +
    r'&challenge=(' + NONCE_RE.pattern + r')&state=(' + NONCE_RE.pattern + r')&proof=(' + NONCE_RE.pattern + r')\Z'
)
PORT_URI_RE = re.compile(r'\Afalsify://connect/?\?port=' + PORT_RE + r'\Z')
URI_MAX = 184
REPO_ROOT = Path(__file__).resolve().parents[2]
KEY_NAME = 'reconnect.key'
REVOKE_NAME = 'revocations.json'


class PairingError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def _b64url(raw):
    return base64.urlsafe_b64encode(raw).decode('ascii').rstrip('=')


def _b64url_decode(text):
    if not isinstance(text, str) or not re.fullmatch(r'[A-Za-z0-9_-]+', text):
        raise PairingError('wrong_proof')
    pad = '=' * ((4 - len(text) % 4) % 4)
    try:
        return base64.urlsafe_b64decode(text + pad)
    except (ValueError, TypeError):
        raise PairingError('wrong_proof') from None


def _no_duplicates(items):
    result = {}
    for key, value in items:
        if key in result:
            raise ValueError('duplicate JSON key')
        result[key] = value
    return result


def _nonce(value):
    return isinstance(value, str) and NONCE_RE.fullmatch(value) is not None


def proof_commitment(verifier):
    """Unpadded base64url SHA-256 of the redeem verifier.

    The link and /api/pair/register carry only this commitment. The raw verifier stays
    in the page and is sent once to /api/pair/redeem. Query names and length stay the
    strict 43-character form so existing parsers keep accepting the link.
    """
    if not _nonce(verifier):
        raise PairingError('invalid_request')
    text = _b64url(hashlib.sha256(verifier.encode('ascii')).digest())
    if not _nonce(text) or text == verifier:
        raise PairingError('invalid_request')
    return text


def _port(value):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if 1024 <= value <= 65535:
        return value
    return None


def parse_connect_uri(uri):
    """Return {port, challenge, state, proof, pairing}. Rejects bearer, password and command forms."""
    if not isinstance(uri, str) or len(uri) > URI_MAX or any(c.isspace() for c in uri):
        raise PairingError('rejected_uri')
    matched = PAIR_URI_RE.fullmatch(uri)
    if matched:
        port = int(matched.group(1))
        if not 1024 <= port <= 65535:
            raise PairingError('rejected_uri')
        return {'port': port, 'challenge': matched.group(2), 'state': matched.group(3), 'proof': matched.group(4), 'pairing': True}
    matched = PORT_URI_RE.fullmatch(uri)
    if not matched:
        raise PairingError('rejected_uri')
    port = int(matched.group(1))
    if not 1024 <= port <= 65535:
        raise PairingError('rejected_uri')
    return {'port': port, 'challenge': None, 'state': None, 'proof': None, 'pairing': False}


def default_pairing_dir():
    """Private per-user directory. Never inside the repository or dist tree."""
    override = os.environ.get('FALSIFY_PAIRING_DIR')
    if override:
        return Path(override)
    if os.name == 'nt':
        root = os.environ.get('LOCALAPPDATA') or str(Path.home() / 'AppData' / 'Local')
        return Path(root) / 'falsify-workbench' / 'pairing'
    if sys.platform == 'darwin':
        return Path.home() / 'Library' / 'Application Support' / 'falsify-workbench' / 'pairing'
    xdg = os.environ.get('XDG_DATA_HOME')
    base = Path(xdg) if xdg else Path.home() / '.local' / 'share'
    return base / 'falsify-workbench' / 'pairing'


def assert_private_dir(path):
    resolved = Path(path).resolve()
    repo = REPO_ROOT.resolve()
    dist = (repo / 'app' / 'dist').resolve()
    if resolved == repo or repo in resolved.parents or resolved == dist or dist in resolved.parents:
        raise PairingError('pairing_store_outside_checkout')
    return resolved


def _mode(path):
    return stat.S_IMODE(path.stat().st_mode)


# SDDL aliases icacls may emit. Unknown principals fail closed rather than being trusted.
_SDDL_ALIASES = {
    'AN': 'S-1-5-7', 'AO': 'S-1-5-32-548', 'AU': 'S-1-5-11', 'BA': 'S-1-5-32-544',
    'BG': 'S-1-5-32-546', 'BU': 'S-1-5-32-545', 'CG': 'S-1-3-1', 'CO': 'S-1-3-0',
    'IU': 'S-1-5-4', 'LS': 'S-1-5-19', 'NS': 'S-1-5-20', 'NU': 'S-1-5-2',
    'OW': 'S-1-3-4', 'RC': 'S-1-5-12', 'SU': 'S-1-5-6', 'SY': 'S-1-5-18', 'WD': 'S-1-1-0',
}
_ACE_RE = re.compile(r'\(([A-Z]+);([^;]*);([^;]*);([^;]*);([^;]*);([^)]+)\)')


def windows_dacl_is_current_user(sddl, user_sid, directory):
    """True only for one protected allow ACE granting the current user full control."""
    if not isinstance(sddl, str) or not isinstance(user_sid, str) or not user_sid.startswith('S-1-'):
        return False
    if not sddl.startswith('D:'):
        return False
    rest = sddl[2:]
    flags = []
    while rest and rest[0] != '(':
        flags.append(rest[0])
        rest = rest[1:]
    if 'P' not in flags:
        return False
    aces = list(_ACE_RE.finditer(rest))
    if len(aces) != 1 or aces[0].end() != len(rest):
        return False
    ace_type, ace_flags, rights, _obj, _inherit, sid = aces[0].groups()
    if ace_type != 'A' or 'ID' in ace_flags:
        return False
    if sid != user_sid:
        return False
    if rights not in ('FA', '0x1f01ff', '0X1F01FF'):
        return False
    if directory and ('OI' not in ace_flags or 'CI' not in ace_flags):
        return False
    if not directory and ('OI' in ace_flags or 'CI' in ace_flags):
        return False
    return True


def _sddl_aces(sddl):
    if not isinstance(sddl, str) or not sddl.startswith('D:'):
        return []
    rest = sddl[2:]
    while rest and rest[0] != '(':
        rest = rest[1:]
    found = []
    for ace in _ACE_RE.finditer(rest):
        sid = ace.group(6)
        found.append(_SDDL_ALIASES.get(sid, sid))
    return found


def _run_icacls(args):
    import subprocess
    completed = subprocess.run(['icacls', *args], check=False, capture_output=True, text=True,
                               **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
    if completed.returncode != 0:
        raise PairingError('pairing_store_permissions')
    return completed.stdout or ''


def _windows_user_sid():
    import csv
    import subprocess
    completed = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], check=False, capture_output=True, text=True,
                               **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
    if completed.returncode != 0 or not completed.stdout.strip():
        raise PairingError('pairing_store_permissions')
    try:
        row = next(csv.reader([completed.stdout.strip().splitlines()[-1]]))
    except (StopIteration, csv.Error):
        raise PairingError('pairing_store_permissions') from None
    sid = row[-1].strip() if row else ''
    if not sid.startswith('S-1-') or sid in _SDDL_ALIASES.values():
        raise PairingError('pairing_store_permissions')
    return sid


def _windows_saved_dacl(path):
    tmp = Path(str(path) + '.acl')
    try:
        _run_icacls([str(path), '/save', str(tmp), '/Q'])
        raw = tmp.read_bytes()
        for encoding in ('utf-16', 'utf-8-sig', 'utf-8'):
            try:
                text = raw.decode(encoding)
            except UnicodeError:
                continue
            for line in text.splitlines():
                line = line.strip()
                if line.startswith('D:'):
                    return line
        raise PairingError('pairing_store_permissions')
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass


def _windows_restrict(path, directory, sid):
    """Replace the DACL with the current user only, then require that result."""
    _run_icacls([str(path), '/inheritance:r', '/Q'])
    rights = ':(OI)(CI)F' if directory else ':F'
    _run_icacls([str(path), '/grant:r', '*' + sid + rights, '/Q'])
    for other in _sddl_aces(_windows_saved_dacl(path)):
        if other != sid:
            _run_icacls([str(path), '/remove', '*' + other, '/Q'])
    if not windows_dacl_is_current_user(_windows_saved_dacl(path), sid, directory):
        raise PairingError('pairing_store_permissions')


def _assert_private(path, directory):
    if os.name == 'nt':
        if not windows_dacl_is_current_user(_windows_saved_dacl(path), _windows_user_sid(), directory):
            raise PairingError('pairing_store_permissions')
        return
    if _mode(path) & 0o077:
        raise PairingError('pairing_store_permissions')


def _restrict_new(path, directory):
    if os.name == 'nt':
        _windows_restrict(path, directory, _windows_user_sid())
        return
    os.chmod(path, 0o700 if directory else 0o600)
    _assert_private(path, directory)


class PairingStore:
    def __init__(self, directory, clock=None, pending_ttl=PENDING_TTL, reconnect_ttl=RECONNECT_TTL):
        self.directory = assert_private_dir(directory)
        self.key_path = self.directory / KEY_NAME
        self.revoke_path = self.directory / REVOKE_NAME
        self.clock = clock or time.time
        self.pending_ttl = pending_ttl
        self.reconnect_ttl = reconnect_ttl
        self._lock = threading.Lock()
        self._key = None
        self._pending = {}
        self._used = {}
        self._revoked = {}

    def ensure_key(self):
        existed = self.directory.exists()
        self.directory.mkdir(parents=True, exist_ok=True)
        if existed:
            _assert_private(self.directory, True)
        else:
            _restrict_new(self.directory, True)
        if self.key_path.exists():
            _assert_private(self.key_path, False)
        else:
            fd = os.open(self.key_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, 'O_BINARY', 0), 0o600)
            try:
                os.write(fd, os.urandom(32))
            finally:
                os.close(fd)
            _restrict_new(self.key_path, False)
        key = self.key_path.read_bytes()
        if len(key) != 32:
            raise PairingError('pairing_store_permissions')
        _assert_private(self.key_path, False)
        _assert_private(self.directory, True)
        self._key = key
        self._load_revocations()
        return self

    def _load_revocations(self):
        if not self.revoke_path.exists():
            self._revoked = {}
            return
        _assert_private(self.revoke_path, False)
        try:
            data = json.loads(self.revoke_path.read_text(encoding='utf-8'), object_pairs_hook=_no_duplicates)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError):
            raise PairingError('pairing_store_permissions') from None
        ids = data.get('ids') if isinstance(data, dict) else None
        if not isinstance(ids, dict):
            raise PairingError('pairing_store_permissions')
        now = self.clock()
        self._revoked = {key: value for key, value in ids.items()
                         if isinstance(key, str) and re.fullmatch(r'[0-9a-f]{32}', key) and isinstance(value, int) and value >= now}

    def _save_revocations(self):
        payload = json.dumps({'ids': self._revoked}, separators=(',', ':'), sort_keys=True).encode('utf-8')
        tmp = self.revoke_path.with_suffix('.json.tmp')
        fd = os.open(tmp, os.O_CREAT | os.O_TRUNC | os.O_WRONLY, 0o600)
        try:
            os.write(fd, payload)
        finally:
            os.close(fd)
        os.replace(tmp, self.revoke_path)
        _restrict_new(self.revoke_path, False)

    def _prune(self, now):
        # Pending records stay until redeem classifies them as expired. Used and revoked ids age out.
        self._used = {key: value for key, value in self._used.items() if value >= now}
        self._revoked = {key: value for key, value in self._revoked.items() if value >= now}

    def register(self, challenge, state, proof, origin, port, now=None):
        if self._key is None:
            raise PairingError('pairing_disabled')
        if origin != FIXED_ORIGIN or not _nonce(challenge) or not _nonce(state) or not _nonce(proof) or _port(port) is None:
            raise PairingError('invalid_request')
        now = self.clock() if now is None else now
        with self._lock:
            self._prune(now)
            if challenge in self._used:
                raise PairingError('replay')
            current = self._pending.get(challenge)
            if current and current['exp'] < now:
                self._pending.pop(challenge, None)
                current = None
            if current:
                if not hmac.compare_digest(current['state'], state) or not hmac.compare_digest(current['proof'], proof):
                    raise PairingError('replay')
                return {'registered': True, 'expiresIn': max(0, int(current['exp'] - now))}
            exp = now + self.pending_ttl
            self._pending[challenge] = {'state': state, 'proof': proof, 'origin': origin, 'port': port, 'exp': exp}
            return {'registered': True, 'expiresIn': self.pending_ttl}

    def redeem(self, challenge, state, proof, origin, port, now=None):
        if self._key is None:
            raise PairingError('pairing_disabled')
        if origin != FIXED_ORIGIN:
            raise PairingError('wrong_origin')
        if not _nonce(challenge) or not _nonce(state) or not _nonce(proof) or _port(port) is None:
            raise PairingError('invalid_request')
        now = self.clock() if now is None else now
        with self._lock:
            self._prune(now)
            if challenge in self._used:
                raise PairingError('replay')
            current = self._pending.get(challenge)
            if current and current['exp'] < now:
                self._pending.pop(challenge, None)
                raise PairingError('expired')
            if not current:
                raise PairingError('unknown_challenge')
            if current['origin'] != origin:
                raise PairingError('wrong_origin')
            if current['port'] != port:
                raise PairingError('port_mismatch')
            if not hmac.compare_digest(current['proof'], proof_commitment(proof)):
                raise PairingError('wrong_proof')
            if not hmac.compare_digest(current['state'], state):
                raise PairingError('wrong_state')
            self._pending.pop(challenge, None)
            self._used[challenge] = now + self.pending_ttl
            credential, public = self._issue(origin, port, proof, now)
            return {'schema': REDEEM_SCHEMA, 'credential': credential, **public}

    def _issue(self, origin, port, proof, now):
        credential_id = os.urandom(16).hex()
        expires = int(now) + self.reconnect_ttl
        payload = {'v': 1, 'id': credential_id, 'origin': origin, 'exp': expires, 'port': port,
                   'proof': hashlib.sha256(proof.encode('ascii')).hexdigest()}
        body = _b64url(json.dumps(payload, separators=(',', ':'), sort_keys=True).encode('utf-8'))
        mac = _b64url(hmac.new(self._key, b'falsify.reconnect.v1\n' + body.encode('ascii'), hashlib.sha256).digest())
        public = {'expiresAt': expires, 'credentialId': credential_id, 'origin': origin, 'port': port}
        return 'rc1.' + body + '.' + mac, public

    def _open_credential(self, credential, origin, port, now):
        if not isinstance(credential, str) or credential.count('.') != 2 or len(credential) > 512:
            raise PairingError('wrong_proof')
        version, body, mac = credential.split('.')
        if version != 'rc1':
            raise PairingError('wrong_proof')
        expected = _b64url(hmac.new(self._key, b'falsify.reconnect.v1\n' + body.encode('ascii'), hashlib.sha256).digest())
        if not hmac.compare_digest(mac, expected):
            raise PairingError('wrong_proof')
        try:
            payload = json.loads(_b64url_decode(body).decode('utf-8'), object_pairs_hook=_no_duplicates)
        except (UnicodeError, json.JSONDecodeError, ValueError, PairingError):
            raise PairingError('wrong_proof') from None
        if not isinstance(payload, dict) or set(payload) != {'v', 'id', 'origin', 'exp', 'port', 'proof'}:
            raise PairingError('wrong_proof')
        if payload['v'] != 1 or not isinstance(payload['id'], str) or not re.fullmatch(r'[0-9a-f]{32}', payload['id']):
            raise PairingError('wrong_proof')
        if payload['origin'] != origin or payload['origin'] != FIXED_ORIGIN:
            raise PairingError('wrong_origin')
        if payload['port'] != port:
            raise PairingError('port_mismatch')
        if not isinstance(payload['exp'], int) or now >= payload['exp']:
            raise PairingError('expired')
        if payload['id'] in self._revoked:
            raise PairingError('revoked')
        return {'via': 'reconnect', 'expiresAt': payload['exp'], 'credentialId': payload['id'], 'origin': origin, 'port': port}

    def status(self, credential, origin, port, now=None):
        if self._key is None:
            raise PairingError('pairing_disabled')
        if origin != FIXED_ORIGIN or _port(port) is None:
            raise PairingError('wrong_origin')
        now = self.clock() if now is None else now
        with self._lock:
            self._prune(now)
            public = self._open_credential(credential, origin, port, now)
        return {'schema': STATUS_SCHEMA, 'paired': True, **public}

    def allows(self, credential, origin, port, now=None):
        try:
            self.status(credential, origin, port, now)
        except PairingError:
            return False
        return True

    def revoke(self, credential, origin, port, now=None):
        if self._key is None:
            raise PairingError('pairing_disabled')
        now = self.clock() if now is None else now
        with self._lock:
            self._prune(now)
            public = self._open_credential(credential, origin, port, now)
            self._revoked[public['credentialId']] = public['expiresAt']
            self._save_revocations()
        return {'schema': REVOKE_SCHEMA, 'revoked': True, 'credentialId': public['credentialId']}


def read_exact_json(handler, limit, keys):
    try:
        if handler.headers.get_all('Content-Type') != ['application/json']:
            raise ValueError('type')
        lengths = handler.headers.get_all('Content-Length') or []
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdigit():
            raise ValueError('length')
        size = int(lengths[0])
        if not 1 <= size <= limit:
            raise ValueError('length')
        raw = handler.rfile.read(size)
        if len(raw) != size:
            raise ValueError('length')
        data = json.loads(raw.decode('utf-8'), object_pairs_hook=_no_duplicates,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError('nonfinite')))
        if not isinstance(data, dict) or set(data) != set(keys):
            raise ValueError('keys')
        return data
    except (ValueError, UnicodeError, json.JSONDecodeError):
        raise PairingError('invalid_request') from None


def _bearer(handler):
    values = handler.headers.get_all('Authorization') or []
    if len(values) != 1 or not values[0].startswith('Bearer ') or values[0].count(' ') != 1:
        return ''
    return values[0][len('Bearer '):]


def _store(handler):
    store = getattr(handler.server, 'pairing', None)
    if store is None:
        raise PairingError('pairing_disabled')
    return store


def handle_register(handler):
    if not handler.launcher_authorized():
        handler.reply(403, {'error': 'unauthorized'})
        return
    if handler.web_origin != FIXED_ORIGIN:
        handler.reply(403, {'error': 'origin_not_approved'})
        return
    try:
        store = _store(handler)
        data = read_exact_json(handler, 1024, ('schema', 'challenge', 'state', 'proof'))
        if data['schema'] != REGISTER_SCHEMA:
            raise PairingError('invalid_request')
        result = store.register(data['challenge'], data['state'], data['proof'], FIXED_ORIGIN, handler.server.server_port)
    except PairingError as error:
        status = 409 if error.code == 'replay' else 400 if error.code == 'invalid_request' else 403
        handler.reply(status, {'error': error.code})
        return
    handler.reply(200, {'schema': REGISTER_SCHEMA, 'registered': True, 'expiresIn': result['expiresIn']})


def handle_redeem(handler):
    if not handler.host_ok() or not handler.from_web_origin() or handler.web_origin != FIXED_ORIGIN:
        handler.reply(403, {'error': 'wrong_origin'})
        return
    # A bearer, including the process token, does not skip challenge binding.
    try:
        data = read_exact_json(handler, 1024, ('challenge', 'state', 'proof'))
        result = _store(handler).redeem(data['challenge'], data['state'], data['proof'], FIXED_ORIGIN, handler.server.server_port)
    except PairingError as error:
        status = 409 if error.code == 'replay' else 400 if error.code == 'invalid_request' else 403
        handler.reply(status, {'error': error.code})
        return
    handler.reply(200, result)


def handle_status(handler):
    if not handler.host_ok() or not handler.from_web_origin() or handler.web_origin != FIXED_ORIGIN:
        handler.reply(403, {'error': 'wrong_origin'})
        return
    try:
        result = _store(handler).status(_bearer(handler), FIXED_ORIGIN, handler.server.server_port)
    except PairingError as error:
        handler.reply(403, {'error': error.code})
        return
    handler.reply(200, result)


def handle_revoke(handler):
    if not handler.host_ok() or not handler.from_web_origin() or handler.web_origin != FIXED_ORIGIN:
        handler.reply(403, {'error': 'wrong_origin'})
        return
    try:
        data = read_exact_json(handler, 256, ('schema',))
        if data['schema'] != REVOKE_SCHEMA:
            raise PairingError('invalid_request')
        result = _store(handler).revoke(_bearer(handler), FIXED_ORIGIN, handler.server.server_port)
    except PairingError as error:
        status = 400 if error.code == 'invalid_request' else 403
        handler.reply(status, {'error': error.code})
        return
    handler.reply(200, result)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _local_json(port, method, path, headers, body=None):
    request = urllib.request.Request('http://127.0.0.1:%d%s' % (port, path), data=body, headers=headers, method=method)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)
    try:
        with opener.open(request, timeout=1) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


def approval_decision(origin, choice):
    """Pure one-time approval. None means the visible dialog must be shown; it is not a yes."""
    if origin != FIXED_ORIGIN:
        return 'refuse'
    if choice == 'yes':
        return 'approve'
    if choice == 'no':
        return 'cancel'
    return 'ask'


def _launcher_session(port, expected_server_path, expected_pid=None):
    """Bootstrap and check the server-reported descriptor; this is not OS attestation."""
    status, raw = _local_json(port, 'GET', '/api/session', {'Host': '127.0.0.1:%d' % port, 'Sec-Fetch-Site': 'same-origin'})
    token = json.loads(raw.decode('utf-8')).get('token') if status == 200 else None
    if not isinstance(token, str) or not token:
        raise ValueError('invalid session')
    status, raw = _local_json(port, 'GET', '/api/launcher/instance', {
        'Host': '127.0.0.1:%d' % port, 'Authorization': 'Bearer ' + token,
        'X-Falsify-Launcher': '1',
    })
    descriptor = json.loads(raw.decode('utf-8')) if status == 200 else None
    if not isinstance(descriptor, dict):
        raise ValueError('invalid descriptor')
    pid = descriptor.get('pid')
    path = descriptor.get('serverPath')
    if (descriptor.get('schema') != 'falsify-companion-lifecycle/1'
            or isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0
            or (expected_pid is not None and pid != expected_pid)
            or not isinstance(path, str) or not Path(path).is_absolute()
            or Path(path).resolve() != Path(expected_server_path).resolve()
            or descriptor.get('webOrigin') != FIXED_ORIGIN):
        raise ValueError('descriptor mismatch')
    return token, pid


def probe_local(port, expected_server_path, expected_pid=None):
    """Print existing PID, absent, or foreign; never print the bootstrap token."""
    if _port(port) is None:
        print('foreign')
        return 2
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=0.5):
            pass
    except ConnectionRefusedError:
        print('absent')
        return 1
    except OSError:
        print('foreign')
        return 2
    try:
        _token, pid = _launcher_session(port, expected_server_path, expected_pid)
    except (OSError, ValueError, AttributeError, UnicodeError, urllib.error.URLError):
        print('foreign')
        return 2
    print('existing %d' % pid)
    return 0


def register_local(port, challenge, state, proof, expected_server_path=None, expected_pid=None):
    """Launcher-side register. Prints only registered or refused, never the token."""
    if _port(port) is None or not _nonce(challenge) or not _nonce(state) or not _nonce(proof):
        print('refused', flush=True)
        return 1
    try:
        token, _ = _launcher_session(port, expected_server_path or REPO_ROOT / 'app/local/server.py', expected_pid)
        payload = json.dumps({'schema': REGISTER_SCHEMA, 'challenge': challenge, 'state': state, 'proof': proof},
                             separators=(',', ':')).encode('utf-8')
        status, raw = _local_json(port, 'POST', REGISTER_PATH, {
            'Host': '127.0.0.1:%d' % port,
            'Authorization': 'Bearer ' + token,
            'X-Falsify-Launcher': '1',
            'Content-Type': 'application/json',
        }, payload)
        registered = status == 200 and json.loads(raw.decode('utf-8')).get('registered') is True
    except (OSError, ValueError, AttributeError, UnicodeError, urllib.error.URLError):
        registered = False
    print('registered' if registered else 'refused', flush=True)
    return 0 if registered else 1


def main(argv=None):
    parser = argparse.ArgumentParser(prog='pairing')
    sub = parser.add_subparsers(dest='cmd', required=True)
    reg = sub.add_parser('register')
    reg.add_argument('--port', type=int, required=True)
    reg.add_argument('--challenge', required=True)
    reg.add_argument('--state', required=True)
    reg.add_argument('--proof', required=True)
    reg.add_argument('--expected-server-path', default=str(REPO_ROOT / 'app/local/server.py'))
    reg.add_argument('--expected-pid', type=int)
    probe = sub.add_parser('probe')
    probe.add_argument('--port', type=int, required=True)
    probe.add_argument('--expected-server-path', required=True)
    probe.add_argument('--expected-pid', type=int)
    args = parser.parse_args(argv)
    if args.cmd == 'register':
        return register_local(args.port, args.challenge, args.state, args.proof, args.expected_server_path, args.expected_pid)
    if args.cmd == 'probe':
        return probe_local(args.port, args.expected_server_path, args.expected_pid)
    return 2


if __name__ == '__main__':
    sys.exit(main())
