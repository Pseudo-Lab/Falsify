"""Offline click-pairing tests. Ephemeral loopback ports, temporary key directories, no model calls."""
import io
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import pairing
import server

WEB = pairing.FIXED_ORIGIN
CHALLENGE = 'A' * 43
STATE = 'B' * 43
PROOF = 'C' * 43
OTHER = 'D' * 43


def nonce_ok(value):
    return isinstance(value, str) and len(value) == 43


class ParserTests(unittest.TestCase):
    def test_port_only_and_pairing_form(self):
        self.assertEqual(pairing.parse_connect_uri('falsify://connect?port=7816')['port'], 7816)
        self.assertFalse(pairing.parse_connect_uri('falsify://connect/?port=65535')['pairing'])
        link_proof = pairing.proof_commitment(PROOF)
        parsed = pairing.parse_connect_uri(
            'falsify://connect?port=7816&challenge=%s&state=%s&proof=%s' % (CHALLENGE, STATE, link_proof))
        self.assertEqual(parsed, {'port': 7816, 'challenge': CHALLENGE, 'state': STATE, 'proof': link_proof, 'pairing': True})
        self.assertNotIn(PROOF, 'falsify://connect?port=7816&challenge=%s&state=%s&proof=%s' % (CHALLENGE, STATE, link_proof))
        parsed = pairing.parse_connect_uri(
            'falsify://connect/?port=1024&challenge=%s&state=%s&proof=%s' % (CHALLENGE, STATE, PROOF))
        self.assertTrue(parsed['pairing'])
        self.assertEqual(parsed['port'], 1024)

    def test_rejects_bearer_password_command_and_drift(self):
        bad = [
            '', 'falsify://connect?port=7816&cmd=calc', 'falsify://connect?port=7816&token=abc',
            'falsify://connect?port=7816&password=secret', 'falsify://connect?port=7816&bearer=abc',
            'falsify://connect?origin=https://evil.example&port=7816',
            'falsify://connect?port=7816&model=gpt', 'falsify://connect?port=7816&command=calc',
            'falsify://connect?port=7816&challenge=%s&proof=%s&state=%s' % (CHALLENGE, PROOF, STATE),
            'falsify://connect?port=7816&challenge=%s&state=%s&proof=%s&extra=1' % (CHALLENGE, STATE, PROOF),
            'falsify://connect?port=07816', 'falsify://connect?port=1023', 'falsify://connect?port=65536',
            'falsify://connect?port=7816&challenge=%s&state=%s&proof=%s' % ('A' * 42, STATE, PROOF),
            'falsify://connect?port=7816&challenge=%s=&state=%s&proof=%s' % ('A' * 42, STATE, PROOF),
            'falsify://connect//?port=7816', 'falsify://user:pw@connect?port=7816',
            'falsify://connect?port=7816#frag', 'falsify://connect?port=%37816',
            'FALSIFY://connect?port=7816', 'falsify://connect?port=7816 ',
        ]
        for uri in bad:
            with self.subTest(uri=uri):
                with self.assertRaises(pairing.PairingError):
                    pairing.parse_connect_uri(uri)

    def test_approval_is_visible_and_not_implied(self):
        self.assertEqual(pairing.approval_decision(WEB, None), 'ask')
        self.assertEqual(pairing.approval_decision(WEB, 'no'), 'cancel')
        self.assertEqual(pairing.approval_decision(WEB, 'yes'), 'approve')
        self.assertEqual(pairing.approval_decision('https://evil.example', 'yes'), 'refuse')
        self.assertEqual(pairing.approval_decision(WEB, 'YES'), 'ask')


class StoreTests(unittest.TestCase):
    def test_signing_key_bytes_do_not_undergo_windows_newline_translation(self):
        expected = b'\n' * 32
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(pairing.os, 'urandom', return_value=expected):
                store = pairing.PairingStore(Path(tmp) / 'pair').ensure_key()
            self.assertEqual(store.key_path.read_bytes(), expected)

    def test_key_is_outside_checkout_and_mode_restricted(self):
        repo = Path(__file__).resolve().parents[2]
        with self.assertRaises(pairing.PairingError):
            pairing.PairingStore(repo / 'pairing-secret')
        with self.assertRaises(pairing.PairingError):
            pairing.PairingStore(repo / 'app' / 'dist' / 'pairing')
        with tempfile.TemporaryDirectory() as tmp:
            store = pairing.PairingStore(Path(tmp) / 'pair').ensure_key()
            self.assertEqual(len(store.key_path.read_bytes()), 32)
            if os.name == 'nt':
                sid = pairing._windows_user_sid()
                self.assertTrue(pairing.windows_dacl_is_current_user(pairing._windows_saved_dacl(store.key_path), sid, False))
                self.assertTrue(pairing.windows_dacl_is_current_user(pairing._windows_saved_dacl(store.directory), sid, True))
                import subprocess
                completed = subprocess.run(['icacls', str(store.key_path), '/grant', '*S-1-1-0:R'], check=False, capture_output=True, text=True)
                self.assertEqual(completed.returncode, 0)
                with self.assertRaises(pairing.PairingError):
                    pairing.PairingStore(store.directory).ensure_key()
            else:
                self.assertEqual(stat.S_IMODE(store.key_path.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(store.directory.stat().st_mode), 0o700)
                os.chmod(store.key_path, 0o644)
                with self.assertRaises(pairing.PairingError):
                    pairing.PairingStore(store.directory).ensure_key()

    def test_windows_acl_parser_requires_only_the_current_user(self):
        sid = 'S-1-5-21-1-2-3-1001'
        self.assertTrue(pairing.windows_dacl_is_current_user('D:P(A;;FA;;;%s)' % sid, sid, False))
        self.assertTrue(pairing.windows_dacl_is_current_user('D:P(A;OICI;FA;;;%s)' % sid, sid, True))
        self.assertFalse(pairing.windows_dacl_is_current_user('D:P(A;;FA;;;%s)' % sid, sid, True))
        self.assertFalse(pairing.windows_dacl_is_current_user('D:P(A;;FA;;;%s)(A;;FR;;;WD)' % sid, sid, False))
        self.assertFalse(pairing.windows_dacl_is_current_user('D:AI(A;ID;FA;;;%s)' % sid, sid, False))
        self.assertFalse(pairing.windows_dacl_is_current_user('D:P(A;ID;FA;;;%s)' % sid, sid, False))
        self.assertFalse(pairing.windows_dacl_is_current_user('D:P(A;;FA;;;SY)', sid, False))
        self.assertFalse(pairing.windows_dacl_is_current_user('D:(A;;FA;;;%s)' % sid, sid, False))
        self.assertEqual(pairing.RECONNECT_TTL, 12 * 60 * 60)

    def test_restart_keeps_credential_and_drops_pending(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp) / 'pair'
            clock = {'now': 1_000_000.0}
            store = pairing.PairingStore(directory, clock=lambda: clock['now']).ensure_key()
            link_proof = pairing.proof_commitment(PROOF)
            self.assertNotEqual(link_proof, PROOF)
            store.register(CHALLENGE, STATE, link_proof, WEB, 7816)
            clock['now'] += 10
            issued_at = clock['now']
            issued = store.redeem(CHALLENGE, STATE, PROOF, WEB, 7816)
            self.assertNotIn(PROOF, issued['credential'])
            pending = pairing.PairingStore(directory, clock=lambda: clock['now']).ensure_key()
            pending.register(OTHER, STATE, pairing.proof_commitment(OTHER), WEB, 7816)
            restarted = pairing.PairingStore(directory, clock=lambda: clock['now']).ensure_key()
            status = restarted.status(issued['credential'], WEB, 7816)
            self.assertTrue(status['paired'])
            self.assertEqual(status['via'], 'reconnect')
            with self.assertRaises(pairing.PairingError) as pending_error:
                restarted.redeem(OTHER, STATE, OTHER, WEB, 7816)
            self.assertEqual(pending_error.exception.code, 'unknown_challenge')
            clock['now'] = issued_at + 60 * 60
            self.assertTrue(restarted.status(issued['credential'], WEB, 7816)['paired'])
            clock['now'] = issued_at + pairing.RECONNECT_TTL
            with self.assertRaises(pairing.PairingError) as expired:
                restarted.status(issued['credential'], WEB, 7816)
            self.assertEqual(expired.exception.code, 'expired')


class Client:
    def call(self, path, method='GET', body=None, headers=None, origin=WEB, token=True, host=None, raw=None):
        h = {'Host': host or f'127.0.0.1:{self.port}'}
        if origin is not None:
            h['Origin'] = origin
        if token is True:
            h['Authorization'] = 'Bearer ' + server.TOKEN
        elif token:
            h['Authorization'] = token
        if body is not None or raw is not None:
            h['Content-Type'] = 'application/json'
        h.update(headers or {})
        import http.client
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        payload = raw if raw is not None else (json.dumps(body).encode() if isinstance(body, dict) else body)
        conn.request(method, path, payload, headers=h)
        res = conn.getresponse()
        blob = res.read()
        conn.close()
        data = json.loads(blob) if res.getheader('Content-Type', '').startswith('application/json') else blob
        return res.status, {k.lower(): v for k, v in res.getheaders()}, data


class HttpPairingTests(Client, unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.directory = Path(self.tmp.name) / 'pair'
        self.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        self.http.web_origin = WEB
        self.http.pairing = pairing.PairingStore(self.directory).ensure_key()
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True)
        self.thread.start()
        self.port = self.http.server_port
        self.addCleanup(self.shutdown)

    def shutdown(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=5)
        self.tmp.cleanup()

    def launcher(self, challenge=CHALLENGE, state=STATE, proof=None, token=True):
        if proof is None:
            proof = pairing.proof_commitment(PROOF)
        return self.call(pairing.REGISTER_PATH, 'POST', {
            'schema': pairing.REGISTER_SCHEMA, 'challenge': challenge, 'state': state, 'proof': proof,
        }, headers={'X-Falsify-Launcher': '1'}, origin=None, token=token)

    def redeem(self, challenge=CHALLENGE, state=STATE, proof=PROOF, origin=WEB):
        return self.call(pairing.REDEEM_PATH, 'POST', {'challenge': challenge, 'state': state, 'proof': proof}, origin=origin, token=False)

    def test_cancel_is_unknown_until_approval_registers(self):
        self.assertEqual(pairing.approval_decision(WEB, 'no'), 'cancel')
        status, _, data = self.redeem()
        self.assertEqual((status, data['error']), (403, 'unknown_challenge'))
        self.assertNotIn(server.TOKEN, json.dumps(data))

    def test_redeem_once_then_replay_wrong_proof_and_wrong_origin(self):
        status, headers, data = self.launcher()
        self.assertEqual(status, 200)
        self.assertNotIn('access-control-allow-origin', headers)
        self.assertNotIn(server.TOKEN, json.dumps(data))
        self.assertTrue(data['registered'])
        status, _, data = self.redeem(proof=OTHER)
        self.assertEqual((status, data['error']), (403, 'wrong_proof'))
        status, _, data = self.redeem(proof=pairing.proof_commitment(PROOF))
        self.assertEqual((status, data['error']), (403, 'wrong_proof'))
        status, headers, data = self.redeem(origin='https://attacker.example')
        self.assertEqual((status, data['error']), (403, 'wrong_origin'))
        self.assertNotIn('access-control-allow-origin', headers)
        status, headers, data = self.redeem()
        self.assertEqual(status, 200)
        self.assertEqual(headers.get('access-control-allow-origin'), WEB)
        credential = data['credential']
        self.assertTrue(credential.startswith('rc1.'))
        self.assertNotIn(PROOF, json.dumps(data))
        self.assertNotIn(server.TOKEN, json.dumps(data))
        self.assertNotIn(CHALLENGE, credential)
        status, _, data = self.redeem()
        self.assertEqual((status, data['error']), (409, 'replay'))
        status, _, data = self.call(pairing.STATUS_PATH, token='Bearer ' + credential)
        self.assertEqual(status, 200)
        self.assertEqual(data['schema'], pairing.STATUS_SCHEMA)
        self.assertEqual(data['via'], 'reconnect')
        self.assertNotIn('credential', data)
        self.assertNotIn(server.TOKEN, json.dumps(data))

    def test_expired_revoked_and_port_mismatch(self):
        self.assertEqual(self.launcher()[0], 200)
        credential = self.redeem()[2]['credential']
        other = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        other.web_origin = WEB
        other.pairing = pairing.PairingStore(self.directory).ensure_key()
        thread = threading.Thread(target=other.serve_forever, daemon=True)
        thread.start()
        try:
            saved, self.port = self.port, other.server_port
            status, _, data = self.call(pairing.STATUS_PATH, token='Bearer ' + credential)
            self.assertEqual((status, data['error']), (403, 'port_mismatch'))
            self.port = saved
        finally:
            other.shutdown(); other.server_close(); thread.join(timeout=5)
        status, _, data = self.call('/api/capabilities', token='Bearer ' + credential)
        self.assertEqual(status, 200)
        self.assertTrue(data['red'])
        status, _, data = self.call(pairing.REVOKE_PATH, 'POST', {'schema': pairing.REVOKE_SCHEMA}, token='Bearer ' + credential)
        self.assertEqual(status, 200)
        self.assertTrue(data['revoked'])
        status, _, data = self.call(pairing.STATUS_PATH, token='Bearer ' + credential)
        self.assertEqual((status, data['error']), (403, 'revoked'))
        status, _, _ = self.call('/api/capabilities', token='Bearer ' + credential)
        self.assertEqual(status, 403)
        restarted = pairing.PairingStore(self.directory).ensure_key()
        with self.assertRaises(pairing.PairingError) as error:
            restarted.status(credential, WEB, self.port)
        self.assertEqual(error.exception.code, 'revoked')
        self.http.pairing.clock = lambda: 10_000_000_000
        self.assertEqual(self.launcher(challenge=OTHER, proof=pairing.proof_commitment(OTHER))[0], 200)
        self.http.pairing.clock = lambda: 10_000_000_000 + pairing.PENDING_TTL + 1
        status, _, data = self.redeem(challenge=OTHER)
        self.assertEqual((status, data['error']), (403, 'expired'))

    def test_refresh_status_does_not_run_a_model_or_bypass_routes(self):
        self.assertEqual(self.launcher()[0], 200)
        credential = self.redeem()[2]['credential']
        def boom(*_a, **_k):
            raise AssertionError('model path')
        with patch.object(server, 'run_review', boom), patch.object(server, 'run_blue_review', boom):
            before = dict(server.JOBS)
            status, _, data = self.call(pairing.STATUS_PATH, token='Bearer ' + credential)
            self.assertEqual(status, 200)
            self.assertEqual(server.JOBS, before)
            status, _, data = self.call('/api/red/jobs', 'POST', {}, token='Bearer ' + credential)
            self.assertEqual(status, 400)
            self.assertNotIn(server.TOKEN, json.dumps(data))
        status, headers, data = self.call('/api/session', token='Bearer ' + credential)
        self.assertEqual(status, 403)
        self.assertNotIn('access-control-allow-origin', headers)
        self.assertNotIn(server.TOKEN, json.dumps(data))
        status, _, data = self.call('/api/session', origin=None, token=False, headers={'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status, 200)
        self.assertEqual(data['token'], server.TOKEN)
        status, _, _ = self.call('/api/launcher/instance', token='Bearer ' + credential, headers={'X-Falsify-Launcher': '1'}, origin=None)
        self.assertEqual(status, 403)
        status, _, _ = self.call('/api/shell', 'POST', {'command': 'x'}, token='Bearer ' + credential)
        self.assertIn(status, (403, 404))
        status, _, _ = self.call(pairing.REGISTER_PATH, 'POST', {
            'schema': pairing.REGISTER_SCHEMA, 'challenge': OTHER, 'state': STATE, 'proof': PROOF,
        }, token='Bearer ' + credential)
        self.assertEqual(status, 403)
        status, _, _ = self.launcher(token='Bearer ' + credential)
        self.assertEqual(status, 403)

    def test_register_requires_launcher_and_fixed_origin(self):
        status, _, _ = self.call(pairing.REGISTER_PATH, 'POST', {
            'schema': pairing.REGISTER_SCHEMA, 'challenge': CHALLENGE, 'state': STATE, 'proof': PROOF,
        }, headers={'X-Falsify-Launcher': '1'})
        self.assertEqual(status, 403)
        status, _, _ = self.launcher(token=False)
        self.assertEqual(status, 403)
        self.http.pairing = None
        status, _, data = self.launcher()
        self.assertEqual((status, data['error']), (403, 'pairing_disabled'))
        self.http.web_origin = 'https://pages.example'
        self.http.pairing = pairing.PairingStore(self.directory).ensure_key()
        status, _, data = self.launcher(challenge=OTHER)
        self.assertEqual((status, data['error']), (403, 'origin_not_approved'))

    def test_hidden_token_display_and_checkout_dir_refused(self):
        out = io.StringIO()
        err = io.StringIO()
        class Fake:
            def __init__(self, *a, **k):
                self.web_origin = None
            def serve_forever(self):
                raise KeyboardInterrupt
            def server_close(self):
                pass
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'FALSIFY_PAIRING_DIR': str(Path(tmp) / 'private-pair')}), \
                patch.object(sys, 'argv', ['server.py', '--port', '40123', '--web-origin', WEB, '--token-display', 'hidden']), \
                patch.object(server, 'ThreadingHTTPServer', Fake), redirect_stdout(out), patch.object(sys, 'stderr', err):
            server.main()
        text = out.getvalue() + err.getvalue()
        self.assertNotIn(server.TOKEN, text)
        self.assertIn('not displayed', text)
        code = None
        with patch.object(sys, 'argv', ['server.py', '--port', '40123', '--web-origin', WEB, '--pairing-dir', str(Path(__file__).resolve().parents[2] / 'not-private')]), \
                patch.object(server, 'ThreadingHTTPServer', Fake), redirect_stdout(io.StringIO()), patch.object(sys, 'stderr', io.StringIO()):
            try:
                server.main()
            except SystemExit as error:
                code = error.code
        self.assertEqual(code, 2)

    def test_probe_and_register_check_descriptor(self):
        expected = str(Path(server.__file__).resolve())
        out = io.StringIO()
        with redirect_stdout(out):
            self.assertEqual(pairing.probe_local(self.port, expected), 0)
            self.assertEqual(pairing.probe_local(self.port, expected, os.getpid()), 0)
            self.assertEqual(pairing.probe_local(self.port, expected, os.getpid() + 1), 2)
            self.assertEqual(pairing.probe_local(self.port, expected + '.other'), 2)
            self.assertEqual(pairing.register_local(self.port, CHALLENGE, STATE, PROOF, expected, os.getpid() + 1), 1)
        self.assertNotIn(server.TOKEN, out.getvalue())
        self.assertIn('existing %d' % os.getpid(), out.getvalue())
        self.assertEqual(self.redeem()[2]['error'], 'unknown_challenge')
        self.http.web_origin = 'https://other.example'
        with redirect_stdout(io.StringIO()):
            self.assertEqual(pairing.probe_local(self.port, expected), 2)

    def test_absent_and_unrelated_http_listener(self):
        import http.server
        with patch.object(pairing.socket, 'create_connection', side_effect=ConnectionRefusedError), redirect_stdout(io.StringIO()):
            self.assertEqual(pairing.probe_local(40123, server.__file__), 1)
        class Foreign(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'not a companion')
            def log_message(self, *args):
                pass
        foreign = http.server.HTTPServer(('127.0.0.1', 0), Foreign)
        thread = threading.Thread(target=foreign.serve_forever, daemon=True)
        thread.start()
        try:
            with redirect_stdout(io.StringIO()):
                self.assertEqual(pairing.probe_local(foreign.server_port, server.__file__), 2)
            self.assertTrue(thread.is_alive())
        finally:
            foreign.shutdown()
            foreign.server_close()
            thread.join(timeout=5)

    def test_local_register_cli_does_not_print_the_process_token(self):
        out = io.StringIO()
        with redirect_stdout(out):
            code = pairing.register_local(self.port, CHALLENGE, STATE, PROOF)
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue().strip(), 'registered')
        self.assertNotIn(server.TOKEN, out.getvalue())
        self.assertNotIn(PROOF, out.getvalue())


if __name__ == '__main__':
    unittest.main()
