"""Bounded prompt-only Claude Code transport on the user's Claude subscription.

No retries, no API-key billing fallback and no provider fallback. The CLI runs in
print mode with no tools, no MCP servers, no setting sources, safe mode (not bare
mode: bare mode disables OAuth subscription auth) and no session persistence, in a
disposable directory. Only the validated structured output, token usage and fixed
labels are returned; raw events and authentication diagnostics are never kept.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from experiments.selfplay_codex import bounded_transport, strict_json_object, macos_runtime_path
from harness import CLI_AGENTS, EFFORTS, DEFAULT_EFFORT, MODEL_PATTERN

MAX_OUTPUT_BYTES = 262144
MAX_SCHEMA_BYTES = 16384  # Passed as one argv element; keeps the Windows command line bounded.
STRUCTURED_OUTPUT_TOOL = "StructuredOutput"
TOOL_BLOCK_TYPES = frozenset({"tool_use", "server_tool_use", "mcp_tool_use"})
SUBSCRIPTION_AUTH = "claude.ai"
BLOCKED_ENV_PREFIXES = ("ANTHROPIC_", "CLAUDE_CODE_", "CLAUDECODE", "CLAUDE_AGENT_SDK",
                        "AWS_BEARER_TOKEN_BEDROCK", "OPENAI_", "CODEX_")


def _search_path():
    """PATH entries plus ~/.local/bin; absolute directories only (never the cwd)."""
    entries = []
    path = macos_runtime_path() if sys.platform == "darwin" else os.environ.get("PATH", "")
    for entry in path.split(os.pathsep) + [str(Path.home() / ".local" / "bin")]:
        if entry and Path(entry).is_absolute() and entry not in entries:
            entries.append(entry)
    return entries


def discover_claude():
    """Native executable argv for Claude Code; Windows launchers resolve to native/node argv."""
    entries = _search_path()
    launcher = shutil.which("claude", path=os.pathsep.join(entries))
    if not launcher:
        raise FileNotFoundError("claude_unavailable")
    path = Path(launcher).absolute()
    if not any(path.parent == Path(entry).absolute() for entry in entries):
        raise FileNotFoundError("claude_unavailable")
    if path.suffix.lower() in (".exe", ""):
        return [str(path)]
    package = path.parent / "node_modules" / "@anthropic-ai" / "claude-code"
    for pattern in ("bin/claude.exe", "node_modules/@anthropic-ai/claude-code-*/claude.exe",
                    "node_modules/@anthropic-ai/claude-code-*/bin/claude.exe"):
        binaries = sorted(package.glob(pattern))
        if binaries:
            return [str(binaries[0])]
    node = shutil.which("node", path=os.pathsep.join(entries))
    script = package / "cli.js"
    if node and script.is_file():
        return [node, str(script)]
    raise FileNotFoundError("native_claude_unavailable")


def installed():
    try:
        discover_claude()
        return True
    except (OSError, ValueError):
        return False


def clean_environment():
    """Drop API keys, auth tokens, base URLs and third-party provider switches."""
    env = {key: value for key, value in os.environ.items()
            if "API_KEY" not in key.upper() and "AUTH_TOKEN" not in key.upper()
            and not key.upper().startswith(BLOCKED_ENV_PREFIXES)}
    if sys.platform == "darwin": env["PATH"] = macos_runtime_path()
    return env


def subscription_ok(raw):
    """True only for a first-party claude.ai subscription login; diagnostics are discarded."""
    try:
        status = json.loads(raw, object_pairs_hook=strict_json_object)
    except ValueError:
        return False
    return (isinstance(status, dict) and status.get("loggedIn") is True
            and status.get("authMethod") == SUBSCRIPTION_AUTH
            and status.get("apiProvider") == "firstParty")


def _identifier(value):
    return type(value) is str and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value) is not None


class ClaudeBackend:
    def __init__(self, max_calls=3, timeout_seconds=90, max_prompt_chars=30000,
                 *, transport=None, executable=None, model=None, effort=None):
        if type(max_calls) is not int or not 1 <= max_calls <= 100:
            raise ValueError("invalid_call_budget")
        if not 0 < timeout_seconds <= 600 or not 1 <= max_prompt_chars <= 100000:
            raise ValueError("invalid_limits")
        model = CLI_AGENTS["claude"]["defaultModel"] if model is None else model
        effort = DEFAULT_EFFORT if effort is None else effort
        if type(model) is not str or not MODEL_PATTERN.fullmatch(model):
            raise ValueError("invalid_model")
        if effort not in EFFORTS:
            raise ValueError("invalid_effort")
        self.model, self.effort = model, effort
        self.max_calls, self.timeout_seconds = max_calls, timeout_seconds
        self.max_prompt_chars = max_prompt_chars
        self.calls = 0
        self._lock = threading.Lock()
        self.transport = transport or bounded_transport
        self.executable = executable
        self.capability_config = {"provider": "claude", "model": self.model, "effort": self.effort,
                                  "auth": "claude.ai subscription required; API key/provider environment removed",
                                  "tools": "none", "mcp": "strict empty config", "setting_sources": "none",
                                  "safe_mode": True, "bare_mode": False, "session_persistence": False,
                                  "retries": 0, "max_output_bytes": MAX_OUTPUT_BYTES,
                                  "boundary": "prompt-only; not OS read isolation",
                                  "tool_boundary": "observed tool events rejected"}

    def command(self, executable, encoded_schema):
        return executable + ["-p", "--output-format", "stream-json", "--verbose",
                             "--json-schema", encoded_schema,
                             "--model", self.model, "--effort", self.effort,
                             "--tools", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
                             "--setting-sources", "", "--safe-mode", "--no-session-persistence"]

    def infer(self, prompt, schema):
        start = time.monotonic()
        result = {"status": "error", "response": None, "usage": {}, "elapsed_seconds": 0.,
                  "provider": "claude", "model": self.model, "effort": self.effort, "error_code": None,
                  "observed_tool_calls": 0, "observed_event_types": [], "observed_models": []}
        try:
            if type(prompt) is not str or not 1 <= len(prompt) <= self.max_prompt_chars:
                raise ValueError("prompt_limit")
            encoded = json.dumps(schema, allow_nan=False, separators=(",", ":"))
            if type(schema) is not dict or len(encoded.encode()) > MAX_SCHEMA_BYTES:
                raise ValueError("schema_limit")
            from jsonschema import Draft202012Validator
            Draft202012Validator.check_schema(schema)
            with self._lock:
                if self.calls >= self.max_calls:
                    result.update(status="budget_exhausted", error_code="call_budget")
                    return result
                self.calls += 1
            executable = self.executable or discover_claude()
            env = clean_environment()
            with tempfile.TemporaryDirectory(prefix="falsify-claude-") as directory:
                status = self.transport(executable + ["auth", "status", "--json"], cwd=directory, env=env,
                                        stdin="", timeout_seconds=min(10, self.timeout_seconds),
                                        max_output_bytes=8192)
                if status["returncode"] or not subscription_ok(status.get("stdout", "")):
                    raise ValueError("subscription_login_required")
                run = self.transport(self.command(executable, encoded), cwd=directory, env=env,
                                     stdin="Return only the requested JSON as structured output. Do not use tools.\n" + prompt,
                                     timeout_seconds=max(.001, self.timeout_seconds-(time.monotonic()-start)),
                                     max_output_bytes=MAX_OUTPUT_BYTES)
                if len(run.get("stdout", "").encode()) > MAX_OUTPUT_BYTES:
                    raise ValueError("output_limit")
                self._interpret(run, schema, result, Draft202012Validator)
        except (TimeoutError, subprocess.TimeoutExpired):
            result.update(status="timeout", error_code="timeout")
        except Exception as error:
            # Never copy exception text, CLI logs, credentials or prompt content.
            code = str(error) if isinstance(error, ValueError) and str(error) in {
                "prompt_limit", "schema_limit", "output_limit", "subscription_login_required",
                "api_auth_observed", "mcp_observed", "incomplete_response", "protocol_violation",
                "response_not_object", "duplicate_json_key", "nonfinite_response"} else type(error).__name__
            result.update(status="error", error_code=code)
        finally:
            result["elapsed_seconds"] = round(time.monotonic() - start, 4)
        return result

    def _interpret(self, run, schema, result, validator):
        final, refused, errored = None, False, False
        event_types, models = set(), set()
        for line in run.get("stdout", "").splitlines():
            if not line.strip():
                continue
            event = json.loads(line, object_pairs_hook=strict_json_object,
                               parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite_response")))
            if type(event) is not dict:
                raise ValueError("protocol_violation")
            kind = event.get("type")
            if not _identifier(kind):
                raise ValueError("protocol_violation")
            if len(event_types) < 32:
                event_types.add(kind)
            if kind == "system" and event.get("subtype") == "init":
                if event.get("apiKeySource", "none") != "none":
                    raise ValueError("api_auth_observed")
                if event.get("mcp_servers"):
                    raise ValueError("mcp_observed")
            elif kind == "assistant":
                message = event.get("message")
                if type(message) is not dict:
                    raise ValueError("protocol_violation")
                if event.get("error"):
                    errored = True
                content = message.get("content", [])
                if type(content) is not list:
                    raise ValueError("protocol_violation")
                for block in content:
                    if type(block) is dict and block.get("type") in TOOL_BLOCK_TYPES:
                        # The CLI's own structured-output channel is the only allowed tool block.
                        if not (block.get("type") == "tool_use" and block.get("name") == STRUCTURED_OUTPUT_TOOL):
                            result["observed_tool_calls"] += 1
                if message.get("stop_reason") == "refusal":
                    refused = True
            elif kind == "result":
                if final is not None:
                    raise ValueError("protocol_violation")
                final = event
        result["observed_event_types"] = sorted(event_types)
        if final is not None:
            usage = final.get("usage")
            if type(usage) is dict:
                result["usage"] = {k: v for k, v in usage.items() if "token" in k and type(v) is int and v >= 0}
            model_usage = final.get("modelUsage")
            if type(model_usage) is dict:
                models = {name for name in model_usage if type(name) is str and MODEL_PATTERN.fullmatch(name)}
            result["observed_models"] = sorted(models)[:8]
            if final.get("permission_denials"):
                result["observed_tool_calls"] += len(final["permission_denials"]) if type(final["permission_denials"]) is list else 1
            if final.get("stop_reason") == "refusal":
                refused = True
        if result["observed_tool_calls"]:
            result.update(status="tool_violation", error_code="tool_event")
        elif refused:
            result.update(status="error", error_code="refusal")
        elif errored or final is None or final.get("is_error") is not False or final.get("subtype") != "success":
            result.update(status="error", error_code="cli_error_result")
        elif run["returncode"]:
            raise ValueError("incomplete_response")
        else:
            response = final.get("structured_output")
            if type(response) is not dict:
                raise ValueError("response_not_object")
            validator(schema).validate(response)
            result.update(status="ok", response=response)
