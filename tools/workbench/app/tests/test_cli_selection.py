"""CLI agent selection (Codex / Claude Code) with mocked transports only; no model calls."""
import hashlib
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'local'))
import harness
import red_service
import blue_service
import cli_backend
import server
from experiments.selfplay_codex import CodexBackend

TEXT = 'Synthetic paper. Only an association was observed.'
SCHEMA = {'type': 'object', 'properties': {'status': {'type': 'string', 'enum': ['ok', 'abstain', 'refusal']},
          'findings': {'type': 'array', 'maxItems': 0}}, 'required': ['status', 'findings'], 'additionalProperties': False}
SUBSCRIPTION = json.dumps({'loggedIn': True, 'authMethod': 'claude.ai', 'apiProvider': 'firstParty', 'email': 'secret@example.com'})

def request(role, adapter=None):
    h = harness.default(role)
    if adapter is not None: h['adapter'] = adapter
    d = {'schema': 'falsify.document-' + role + '.v1', 'revision': 'r1', 'requestId': 'cli1', 'sourceHash': hashlib.sha256(TEXT.encode()).hexdigest(),
         'segments': [{'id': 's0', 'label': 'p1', 'text': TEXT}], 'maxCalls': 8, 'consent': True, 'harness': h}
    if role == 'red': d['level'] = 1
    return d

def factory(log, name):
    class Fake:
        def __init__(self, **kwargs): log.append((name, kwargs, self))
        def infer(self, prompt, schema):
            key = 'candidates' if 'candidates' in schema['properties'] else 'findings'
            return {'status': 'ok', 'response': {'status': 'abstain', key: []}}
    return Fake

def run(role, adapter=None):
    log = []
    service = red_service if role == 'red' else blue_service
    result = service.run_review(request(role, adapter), lambda _: None, threading.Event(), factory(log, 'codex'), factory(log, 'claude'))
    return result, log

LIMITS = {'max_calls': 1, 'timeout_seconds': 180, 'max_prompt_chars': 100000}

class SelectionTests(unittest.TestCase):
    def test_legacy_default_untouched(self):
        for role in ['red', 'blue']:
            for adapter in [None, {'type': 'codex'}]:
                result, log = run(role, adapter)
                self.assertEqual([(n, k) for n, k, _ in log], [('codex', LIMITS)])
                self.assertEqual(result['model'], 'gpt-6.1-sol'); self.assertNotIn('cliSelection', result)

    def test_model_effort_forwarded_both_roles(self):
        for role in ['red', 'blue']:
            for adapter, name, model, effort in [({'type': 'codex', 'model': 'gpt-6-astra', 'effort': 'high'}, 'codex', 'gpt-6-astra', 'high'),
                                                 ({'type': 'codex', 'effort': 'low'}, 'codex', 'gpt-6.1-sol', 'low'),
                                                 ({'type': 'claude'}, 'claude', 'claude-opus-5-5', 'medium'),
                                                 ({'type': 'claude', 'model': 'sonnet', 'effort': 'high'}, 'claude', 'sonnet', 'high')]:
                result, log = run(role, adapter)  # built-in CLIs need no executionConsent
                self.assertEqual([(n, k) for n, k, _ in log], [(name, {**LIMITS, 'model': model, 'effort': effort})])
                self.assertEqual(result['model'], model)
                self.assertEqual(result['cliSelection'], {'provider': name, 'model': model, 'effort': effort})
                self.assertEqual(result['harness']['adapter'], adapter)

    def test_role_separation_fresh_backends(self):
        _, red_log = run('red', {'type': 'claude'}); _, blue_log = run('blue', {'type': 'claude'})
        self.assertIsNot(red_log[0][2], blue_log[0][2])
        with self.assertRaises(ValueError): blue_service.validate_request({**request('blue', {'type': 'claude'}), 'gold': 'x'})
        with self.assertRaises(ValueError): harness.validate(request('red', {'type': 'claude'})['harness'], 'blue')

    def test_invalid_model_effort_fields_rejected(self):
        bad = [{'type': 'claude', 'model': m} for m in ['', '-rf', '--tools=Bash', 'a b', 'x;rm', 'a&b', '$(id)', 'é', 'a' * 121, 'gpt\n', 123, None]]
        bad += [{'type': t, 'effort': e} for t in ['codex', 'claude'] for e in ['xhigh', 'max', 'ultracode', 'LOW', '', None, 1]]
        bad += [{'type': 'claude', 'tools': 'Bash'}, {'type': 'codex', 'executable': 'C:/x.exe'}, {'type': 'claude', 'settings': {}}]
        for adapter in bad:
            with self.subTest(adapter=adapter):
                with self.assertRaises(ValueError): harness.validate({**harness.default('red'), 'adapter': adapter}, 'red')
        self.assertTrue(harness.validate({**harness.default('red'), 'adapter': {'type': 'claude', 'model': 'a' * 120}}, 'red'))
        for cls in [CodexBackend, cli_backend.ClaudeBackend]:
            for kwargs in [{'model': '-x'}, {'model': 'a b'}, {'effort': 'max'}]:
                with self.assertRaises(ValueError): cls(skill_folders=[], **kwargs) if cls is CodexBackend else cls(**kwargs)

    def test_selection_record_immutable(self):
        selected = harness.selection({'adapter': {'type': 'claude', 'effort': 'low'}})
        with self.assertRaises(TypeError): selected['model'] = 'x'
        self.assertIsNone(harness.selection({'adapter': {'type': 'codex'}}))
        self.assertIsNone(harness.selection({}))

class CodexArgvTests(unittest.TestCase):
    def capture(self, **kwargs):
        calls = []
        def transport(command, **options):
            calls.append(command)
            if command[-2:] == ['login', 'status']: return {'returncode': 0, 'stdout': 'Logged in using ChatGPT'}
            events = [{'type': 'item.completed', 'item': {'type': 'agent_message', 'text': json.dumps({'status': 'ok', 'findings': []})}},
                      {'type': 'turn.completed', 'usage': {'input_tokens': 1}}]
            return {'returncode': 0, 'stdout': '\n'.join(json.dumps(e) for e in events)}
        backend = CodexBackend(transport=transport, executable=['codex.exe'], skill_folders=[], **kwargs)
        return backend, backend.infer('Synthetic', SCHEMA), calls[1]

    def test_legacy_argv_has_no_effort(self):
        backend, result, command = self.capture()
        self.assertEqual(result['status'], 'ok'); self.assertEqual(result['model'], 'gpt-6.1-sol')
        self.assertEqual(command[command.index('--model') + 1], 'gpt-6.1-sol')
        self.assertFalse(any('model_reasoning_effort' in part for part in command))
        self.assertEqual(backend.capability_config['effort'], 'cli_default')

    def test_selected_model_effort_in_argv(self):
        backend, result, command = self.capture(model='gpt-6-luna', effort='high')
        self.assertEqual(result['model'], 'gpt-6-luna'); self.assertEqual(result['effort'], 'high')
        self.assertEqual(command[command.index('--model') + 1], 'gpt-6-luna')
        self.assertIn('model_reasoning_effort="high"', command)
        for flag in ['--ignore-user-config', '--ephemeral', 'read-only', 'approval_policy="never"', 'web_search="disabled"', 'features.shell_tool=false']:
            self.assertIn(flag, command)
        self.assertEqual(backend.capability_config['model'], 'gpt-6-luna')

def claude_events(output=None, *, tool=None, init=None, result=None, assistant_extra=None):
    blocks = [{'type': 'text', 'text': 'ok'}]
    if tool: blocks.append({'type': 'tool_use', 'id': 't1', 'name': tool, 'input': {}})
    final = {'type': 'result', 'subtype': 'success', 'is_error': False, 'result': '', 'num_turns': 1,
             'structured_output': {'status': 'ok', 'findings': []} if output is None else output,
             'usage': {'input_tokens': 3, 'output_tokens': 2, 'service_tier': 'standard'},
             'modelUsage': {'claude-opus-5-5': {}}, 'permission_denials': [], **(result or {})}
    return [{'type': 'system', 'subtype': 'init', 'apiKeySource': 'none', 'mcp_servers': [], 'tools': ['StructuredOutput'], **(init or {})},
            {'type': 'assistant', 'message': {'content': blocks, **(assistant_extra or {})}},
            {'type': 'user', 'message': {'content': []}}, final]

class ClaudeBackendTests(unittest.TestCase):
    def backend(self, events=None, auth=SUBSCRIPTION, auth_code=0, returncode=0, raw=None, **kwargs):
        self.calls = []
        def transport(command, **options):
            self.calls.append((command, options))
            if command[-3:] == ['auth', 'status', '--json']: return {'returncode': auth_code, 'stdout': auth}
            stdout = raw if raw is not None else '\n'.join(json.dumps(e) for e in (events or claude_events()))
            return {'returncode': returncode, 'stdout': stdout}
        return cli_backend.ClaudeBackend(transport=transport, executable=['claude.exe'], **kwargs)

    def test_argv_and_success(self):
        env = {'ANTHROPIC_API_KEY': 'k', 'ANTHROPIC_AUTH_TOKEN': 't', 'ANTHROPIC_BASE_URL': 'u', 'CLAUDE_CODE_USE_BEDROCK': '1',
               'CLAUDE_CODE_OAUTH_TOKEN': 'o', 'CLAUDECODE': '1', 'OPENAI_API_KEY': 'k', 'KEEP_ME': '1'}
        with patch.dict(os.environ, env):
            backend = self.backend(model='opus', effort='low')
            result = backend.infer('Synthetic', SCHEMA)
        self.assertEqual(result['status'], 'ok'); self.assertEqual(result['response'], {'status': 'ok', 'findings': []})
        self.assertEqual((result['model'], result['effort'], result['provider']), ('opus', 'low', 'claude'))
        self.assertEqual(result['usage'], {'input_tokens': 3, 'output_tokens': 2})
        self.assertEqual(len(self.calls), 2)  # one auth check, one run, no retries
        (auth_cmd, auth_opts), (command, opts) = self.calls
        self.assertEqual(auth_cmd, ['claude.exe', 'auth', 'status', '--json'])
        self.assertNotIn('secret@example.com', json.dumps(result))
        for name in env:
            if name != 'KEEP_ME': self.assertNotIn(name, opts['env']); self.assertNotIn(name, auth_opts['env'])
        self.assertIn('KEEP_ME', opts['env'])
        self.assertEqual(command[:4], ['claude.exe', '-p', '--output-format', 'stream-json'])
        pairs = {command[i]: command[i + 1] for i in range(1, len(command) - 1)}
        self.assertEqual(pairs['--model'], 'opus'); self.assertEqual(pairs['--effort'], 'low')
        self.assertEqual(pairs['--tools'], ''); self.assertEqual(pairs['--setting-sources'], '')
        self.assertEqual(json.loads(pairs['--mcp-config']), {'mcpServers': {}}); self.assertEqual(json.loads(pairs['--json-schema']), SCHEMA)
        for flag in ['--strict-mcp-config', '--safe-mode', '--no-session-persistence', '--verbose']: self.assertIn(flag, command)
        for flag in ['--bare', '--dangerously-skip-permissions', '--allowedTools', '--add-dir', '--fallback-model', '--resume', '--continue']:
            self.assertNotIn(flag, command)
        self.assertNotIn('Synthetic', ' '.join(command)); self.assertTrue(opts['stdin'].endswith('Synthetic'))
        self.assertTrue(Path(opts['cwd']).name.startswith('falsify-claude-')); self.assertFalse(Path(opts['cwd']).exists())

    def test_defaults(self):
        backend = self.backend()
        self.assertEqual((backend.model, backend.effort), ('claude-opus-5-5', 'medium'))

    def test_subscription_required_no_api_fallback(self):
        for auth, code in [(json.dumps({'loggedIn': True, 'authMethod': 'api_key', 'apiProvider': 'firstParty'}), 0),
                           (json.dumps({'loggedIn': True, 'authMethod': 'api_key_helper', 'apiProvider': 'firstParty'}), 0),
                           (json.dumps({'loggedIn': True, 'authMethod': 'third_party', 'apiProvider': 'bedrock'}), 0),
                           (json.dumps({'loggedIn': True, 'authMethod': 'oauth_token', 'apiProvider': 'firstParty'}), 0),
                           (json.dumps({'loggedIn': False, 'authMethod': 'none'}), 1), ('not json', 0), (SUBSCRIPTION, 1)]:
            with self.subTest(auth=auth):
                result = self.backend(auth=auth, auth_code=code).infer('Synthetic', SCHEMA)
                self.assertEqual(result['error_code'], 'subscription_login_required'); self.assertEqual(len(self.calls), 1)
                self.assertNotIn('api_key', json.dumps(result))

    def test_failures_fail_closed(self):
        cases = [(dict(events=claude_events(init={'apiKeySource': 'ANTHROPIC_API_KEY'})), 'api_auth_observed'),
                 (dict(events=claude_events(init={'mcp_servers': [{'name': 'x', 'status': 'connected'}]})), 'mcp_observed'),
                 (dict(events=claude_events(tool='Bash')), 'tool_event'),
                 (dict(events=claude_events(tool='mcp__x__y')), 'tool_event'),
                 (dict(events=claude_events(result={'permission_denials': [{'tool_name': 'Read'}]})), 'tool_event'),
                 (dict(events=claude_events(output={'status': 'ok'})), 'ValidationError'),
                 (dict(events=claude_events(output={'status': 'ok', 'findings': [], 'extra': 1})), 'ValidationError'),
                 (dict(events=claude_events(result={'structured_output': None})), 'response_not_object'),
                 (dict(events=claude_events(result={'stop_reason': 'refusal'})), 'refusal'),
                 (dict(events=claude_events(assistant_extra={'stop_reason': 'refusal'})), 'refusal'),
                 (dict(events=claude_events(result={'subtype': 'error_max_structured_output_retries', 'is_error': True})), 'cli_error_result'),
                 (dict(events=claude_events(result={'is_error': True})), 'cli_error_result'),
                 (dict(events=claude_events()[:-1]), 'cli_error_result'),
                 (dict(events=claude_events() + [claude_events()[-1]]), 'protocol_violation'),
                 (dict(raw='not json'), 'JSONDecodeError'),
                 (dict(raw='[1]'), 'protocol_violation'),
                 (dict(raw='{"type":"result","type":"result"}'), 'duplicate_json_key'),
                 (dict(returncode=1), 'incomplete_response')]
        for kwargs, code in cases:
            with self.subTest(code=code, kwargs=str(kwargs)[:80]):
                result = self.backend(**kwargs).infer('Synthetic', SCHEMA)
                self.assertNotEqual(result['status'], 'ok'); self.assertEqual(result['error_code'], code)
                self.assertIsNone(result['response']); self.assertEqual(len(self.calls), 2)

    def test_limits_before_any_process(self):
        backend = self.backend(max_calls=1, max_prompt_chars=10)
        self.assertEqual(backend.infer('x' * 11, SCHEMA)['error_code'], 'prompt_limit')
        self.assertEqual(backend.infer('x', {'type': 'object', 'description': 'x' * 20000})['error_code'], 'schema_limit')
        self.assertEqual(self.calls, [])
        backend.infer('x', SCHEMA); self.assertEqual(backend.infer('x', SCHEMA)['error_code'], 'call_budget')

WINDOWS = os.name == 'nt'

def launcher(directory, executable=True):
    """Platform-native Claude launcher fixture: claude.exe on Windows (PATHEXT), mode-0755 claude on POSIX (X_OK)."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / ('claude.exe' if WINDOWS else 'claude')
    path.write_bytes(b'')
    if not WINDOWS: path.chmod(0o755 if executable else 0o644)
    return path

class DiscoveryTests(unittest.TestCase):
    @unittest.skipUnless(WINDOWS, 'npm .cmd shims and PATHEXT resolution exist only on Windows; POSIX launchers are covered below')
    def test_windows_cmd_resolves_native_without_shell(self):
        with tempfile.TemporaryDirectory() as root:
            bindir = Path(root) / 'npm'; native = bindir / 'node_modules' / '@anthropic-ai' / 'claude-code' / 'bin' / 'claude.exe'
            native.parent.mkdir(parents=True); native.write_bytes(b''); (bindir / 'claude.cmd').write_text('@echo off')
            with patch.dict(os.environ, {'PATH': str(bindir), 'PATHEXT': '.CMD;.EXE'}), patch.object(Path, 'home', return_value=Path(root) / 'home'):
                self.assertEqual(cli_backend.discover_claude(), [str(native)])

    def test_missing_launcher_unavailable(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.dict(os.environ, {'PATH': str(Path(root) / 'empty')}), patch.object(Path, 'home', return_value=Path(root) / 'home'):
                with self.assertRaises(FileNotFoundError): cli_backend.discover_claude()

    def test_local_bin_and_relative_path_ignored(self):
        with tempfile.TemporaryDirectory() as root:
            native = launcher(Path(root) / '.local' / 'bin')
            with patch.dict(os.environ, {'PATH': '.' + os.pathsep + 'relative', 'PATHEXT': '.EXE'}), patch.object(Path, 'home', return_value=Path(root)):
                found = cli_backend.discover_claude()
                self.assertEqual([os.path.normcase(p) for p in found], [os.path.normcase(str(native.absolute()))])

    @unittest.skipIf(WINDOWS, 'POSIX executable-bit semantics; Windows executability comes from PATHEXT')
    def test_posix_executable_launcher_required(self):
        with tempfile.TemporaryDirectory() as root:
            bindir = Path(root) / 'bin'; home = Path(root) / 'home'
            (bindir / 'node_modules' / '@anthropic-ai' / 'claude-code' / 'bin').mkdir(parents=True)
            (bindir / 'claude.cmd').write_text('@echo off'); (bindir / 'claude.exe').write_bytes(b'')
            with patch.dict(os.environ, {'PATH': str(bindir)}), patch.object(Path, 'home', return_value=home):
                with self.assertRaises(FileNotFoundError): cli_backend.discover_claude()  # Windows-named shims never match on POSIX
                plain = launcher(bindir, executable=False)
                with self.assertRaises(FileNotFoundError): cli_backend.discover_claude()  # non-executable file is not a launcher
                plain.chmod(0o755)
                self.assertEqual(cli_backend.discover_claude(), [str(plain.absolute())])  # suffixless executable runs directly, no shell

class CapabilityTests(unittest.TestCase):
    def test_cli_agents_shape(self):
        with patch.object(server, 'discover_codex', side_effect=FileNotFoundError('x')), patch.object(cli_backend, 'discover_claude', return_value=['C:/secret/claude.exe']):
            agents = server.cli_agents()
        self.assertEqual(agents, [
            {'id': 'codex', 'name': 'Codex CLI', 'installed': False, 'defaultModel': 'gpt-6.1-sol', 'models': ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'], 'efforts': ['low', 'medium', 'high']},
            {'id': 'claude', 'name': 'Claude Code', 'installed': True, 'defaultModel': 'claude-opus-5-5', 'models': ['claude-opus-5-5', 'opus', 'sonnet', 'haiku'], 'efforts': ['low', 'medium', 'high']}])
        self.assertNotIn('secret', json.dumps(agents))
        for agent in agents:
            for model in agent['models']: self.assertTrue(harness.MODEL_PATTERN.fullmatch(model))

if __name__ == '__main__': unittest.main()
