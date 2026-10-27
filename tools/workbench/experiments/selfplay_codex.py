"""Bounded prompt-only Codex transport; read-only is not filesystem read isolation.

No retries or provider fallback. Only final JSON and token usage are returned;
raw event streams and authentication diagnostics are never persisted.
"""
import json
import os
from pathlib import Path
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

MODEL = "gpt-6.1-sol"
EFFORTS = ("low", "medium", "high")
MODEL_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}", re.ASCII)
DISABLED_FEATURES = ("shell_tool", "unified_exec", "apps", "plugins", "multi_agent", "browser_use", "browser_use_external",
                     "computer_use", "code_mode", "code_mode_only", "code_mode_prewarm",
                     "code_mode_host", "view_image", "hooks", "image_generation", "sleep_tool",
                     "skill_mcp_dependency_install",
                     "skill_search", "memories", "tool_suggest")
MAX_OUTPUT_BYTES = 262144
TOOL_ITEM_TYPES = frozenset({"command_execution", "file_change", "mcp_tool_call",
                             "web_search", "dynamic_tool_call", "tool_call",
                             "computer_use", "browser_use", "image_generation"})
PASSIVE_ITEM_TYPES = frozenset({"agent_message", "reasoning", "plan"})
CODE_MODE_DISABLED_ADVISORY = (
    "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; "
    "enable `features.code_mode_host` and install `codex-code-mode-host`."
)


def classify_error_item(item):
    """Map diagnostics to fixed labels; no diagnostic text is returned."""
    message = item.get("message", "")
    if type(message) is not str:
        return "unknown"
    text = message[:8192].lower()
    if text.startswith("under-development features enabled:"):
        return "configuration"
    if text.startswith("code mode is unavailable because code-mode host is disabled."):
        return "code_mode_unavailable"
    patterns = (
        ("skills", ("skill", "skill.md")),
        ("schema", ("json schema", "output schema", "output_schema", "invalid schema", "schema validation")),
        ("configuration", ("configuration", "config.toml", "unknown feature", "unrecognized feature", "under-development features", "unsupported feature")),
        ("sandbox", ("sandbox", "permission denied", "access is denied")),
        ("authentication", ("authentication", "unauthorized", "not logged in", "401")),
        ("quota", ("usage limit", "rate limit", "quota", "429")),
        ("model_access", ("model is not supported", "model not found", "does not exist", "model access")),
        ("context_limit", ("context window", "context length", "too many tokens")),
        ("connection", ("connection", "stream disconnected", "network", "retrying", "reconnecting")),
        ("startup", ("failed to initialize", "failed to start", "startup")),
    )
    for category, phrases in patterns:
        if any(phrase in text for phrase in phrases):
            return category
    return "unknown"


def macos_runtime_path():
    """Retain absolute PATH entries and add standard GUI-launch locations on macOS."""
    entries = os.environ.get("PATH", "").split(os.pathsep)
    entries += [str(Path.home() / ".local" / "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    return os.pathsep.join(dict.fromkeys(entry for entry in entries if entry and Path(entry).is_absolute()))


def discover_codex():
    """Prefer the npm package's native binary over Windows shell launchers."""
    path_arg = {"path": macos_runtime_path()} if sys.platform == "darwin" else {}
    launcher = shutil.which("codex", **path_arg) or shutil.which("codex.cmd", **path_arg)
    if not launcher:
        raise FileNotFoundError("codex_unavailable")
    path = Path(launcher)
    if path.suffix.lower() in (".exe", ""):
        return [str(path)]
    package = path.parent / "node_modules" / "@openai" / "codex"
    binaries = list(package.glob("node_modules/@openai/codex-*/vendor/*/bin/codex.exe"))
    if binaries:
        return [str(binaries[0])]
    node = shutil.which("node", **path_arg)
    script = package / "bin" / "codex.js"
    if node and script.is_file():
        return [node, str(script)]
    raise FileNotFoundError("native_codex_unavailable")


def clean_environment():
    env = {key: value for key, value in os.environ.items()
            if not ("API_KEY" in key.upper() or key.upper() in
                    {"OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID",
                     "CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_PERMISSION_PROFILE",
                     "CODEX_CI"})}
    if sys.platform == "darwin": env["PATH"] = macos_runtime_path()
    return env


def host_skill_folders():
    """Discover folder metadata only; never read skill instructions or auth files."""
    home = Path.home()
    codex_home = Path(os.environ.get("CODEX_HOME", str(home / ".codex")))
    roots = {codex_home / "skills", home / ".agents" / "skills"}
    folders = set()
    for root in roots:
        for pattern in ("*/SKILL.md", ".system/*/SKILL.md"):
            for path in root.glob(pattern):
                if len(folders) >= 256:
                    raise ValueError("skill_folder_limit")
                folders.add(str(path.parent.absolute()))
    return sorted(folders)


def disabled_skills_override(folders):
    # JSON string quoting is also valid TOML basic-string quoting; this is an
    # argument array element, never interpolated into a shell command.
    value = "skills.config=[" + ",".join(
        # CLI 0.160.0 empirically matches the SKILL.md file path, despite the
        # config-reference folder wording. App-server skills/config/write also
        # documents file paths. No skill contents are read here.
        "{path=" + json.dumps(str(Path(folder) / "SKILL.md")) + ",enabled=false}"
        for folder in folders) + "]"
    if len(value) > 24000:
        raise ValueError("skill_folder_limit")
    return value


def strict_json_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate_json_key")
        value[key] = item
    return value


def _kill_tree(process):
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                       timeout=10, check=False, creationflags=subprocess.CREATE_NO_WINDOW)
    else:
        import signal
        os.killpg(process.pid, signal.SIGKILL)
    process.kill()
    process.wait(timeout=10)


def bounded_transport(command, *, cwd, env, stdin, timeout_seconds, max_output_bytes):
    """Drain both pipes with bounded queue/chunks and kill the process tree on limit."""
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               shell=False,
                               **({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                                  else {"start_new_session": True}))
    chunks = queue.Queue(maxsize=8)
    stop = threading.Event()

    def read(pipe, name):
        try:
            while not stop.is_set():
                block = pipe.read(4096)
                if not block:
                    break
                while not stop.is_set():
                    try:
                        chunks.put((name, block), timeout=.05)
                        break
                    except queue.Full:
                        pass
        finally:
            while not stop.is_set():
                try:
                    chunks.put((name, None), timeout=.05)
                    break
                except queue.Full:
                    pass

    def write():
        try:
            process.stdin.write(stdin.encode("utf-8"))
            process.stdin.close()
        except (BrokenPipeError, OSError):
            pass

    threads = [threading.Thread(target=read, args=(process.stdout, "stdout"), daemon=True),
               threading.Thread(target=read, args=(process.stderr, "stderr"), daemon=True),
               threading.Thread(target=write, daemon=True)]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + timeout_seconds
    output = bytearray()
    total, closed = 0, 0
    try:
        while closed < 2:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("timeout")
            try:
                name, block = chunks.get(timeout=min(.1, remaining))
            except queue.Empty:
                continue
            if block is None:
                closed += 1
                continue
            total += len(block)
            if total > max_output_bytes:
                raise ValueError("output_limit")
            if name == "stdout" or command[-2:] == ["login", "status"]:
                output.extend(block)
        process.wait(timeout=max(.001, deadline-time.monotonic()))
        return {"returncode": process.returncode, "stdout": output.decode("utf-8", errors="strict")}
    finally:
        stop.set()
        _kill_tree(process)
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe and not pipe.closed:
                pipe.close()
        for thread in threads:
            thread.join(timeout=.2)


class CodexBackend:
    def __init__(self, max_calls=3, timeout_seconds=90, max_prompt_chars=30000,
                 *, transport=None, executable=None, skill_folders=None, model=None, effort=None):
        if type(max_calls) is not int or not 1 <= max_calls <= 100:
            raise ValueError("invalid_call_budget")
        if not 0 < timeout_seconds <= 600 or not 1 <= max_prompt_chars <= 100000:
            raise ValueError("invalid_limits")
        # Omitted model/effort keep the legacy argv exactly (no effort override).
        model = MODEL if model is None else model
        if type(model) is not str or not MODEL_PATTERN.fullmatch(model):
            raise ValueError("invalid_model")
        if effort is not None and effort not in EFFORTS:
            raise ValueError("invalid_effort")
        self.model, self.effort = model, effort
        self.max_calls, self.timeout_seconds = max_calls, timeout_seconds
        self.max_prompt_chars = max_prompt_chars
        self.calls = 0
        self._lock = threading.Lock()
        self.transport = transport or bounded_transport
        self.executable = executable
        self.skill_folders = host_skill_folders() if skill_folders is None else list(skill_folders)
        self.skills_override = disabled_skills_override(self.skill_folders)
        self.capability_config = {"provider": "codex", "model": self.model,
                                  "effort": self.effort or "cli_default", "sandbox": "read-only",
                                  "approval_policy": "never", "ignore_user_config": True,
                                  "host_skill_discovery_requested": "discovered_folders_disabled",
                                  "host_skill_folders_disabled": len(self.skill_folders),
                                  "skill_override_path_semantics": "SKILL.md file; verified CLI 0.160.0",
                                  "inherited_codex_session_environment": False,
                                  "host_context_exclusion_verified": False,
                                  "disabled_features": list(DISABLED_FEATURES),
                                  "project_doc_max_bytes": 0, "retries": 0,
                                  "max_output_bytes": MAX_OUTPUT_BYTES,
                                  "boundary": "prompt-only; not OS read isolation",
                                  "mcp_boundary": "user configuration ignored; observed tool events rejected"}

    def infer(self, prompt, schema):
        start = time.monotonic()
        result = {"status": "error", "response": None, "usage": {},
                  "elapsed_seconds": 0., "model": self.model, "effort": self.effort or "cli_default",
                  "error_code": None,
                  "observed_tool_calls": 0, "observed_item_types": [],
                  "observed_error_categories": [], "observed_advisories": []}
        try:
            if type(prompt) is not str or not 1 <= len(prompt) <= self.max_prompt_chars:
                raise ValueError("prompt_limit")
            encoded = json.dumps(schema, allow_nan=False)
            if type(schema) is not dict or len(encoded.encode()) > 32768:
                raise ValueError("schema_limit")
            # Validate schemas and output locally, not only through the CLI contract.
            from jsonschema import Draft202012Validator
            Draft202012Validator.check_schema(schema)
            with self._lock:
                if self.calls >= self.max_calls:
                    result.update(status="budget_exhausted", error_code="call_budget")
                    return result
                self.calls += 1
            executable = self.executable or discover_codex()
            env = clean_environment()
            with tempfile.TemporaryDirectory(prefix="falsify-codex-") as directory:
                login = self.transport(executable + ["login", "status"], cwd=directory,
                                       env=env, stdin="", timeout_seconds=min(10, self.timeout_seconds),
                                       max_output_bytes=8192)
                # Native login status writes to stderr; transport combines it only
                # for this command. The diagnostic is never returned or persisted.
                if login["returncode"] or "chatgpt" not in login.get("stdout", "").lower():
                    raise ValueError("chatgpt_login_required")
                schema_path = Path(directory) / "schema.json"
                schema_path.write_text(encoded, encoding="utf-8")
                command = executable + ["exec", "--ignore-user-config", "--ephemeral", "--json",
                            "--skip-git-repo-check", "--sandbox", "read-only", "--model", self.model,
                            "--output-schema", str(schema_path), "-c", "project_doc_max_bytes=0",
                            "-c", "approval_policy=\"never\"",
                            "-c", self.skills_override,
                            "-c", "model_provider=\"openai\"", "-c", "web_search=\"disabled\""]
                if self.effort is not None:
                    command += ["-c", f"model_reasoning_effort=\"{self.effort}\""]
                for feature in DISABLED_FEATURES:
                    command += ["-c", f"features.{feature}=false"]
                command += ["-"]
                run = self.transport(command, cwd=directory, env=env,
                                     stdin="Return only the requested JSON. Do not use tools.\n" + prompt,
                                     timeout_seconds=max(.001, self.timeout_seconds-(time.monotonic()-start)),
                                     max_output_bytes=MAX_OUTPUT_BYTES)
                if len(run.get("stdout", "").encode()) > MAX_OUTPUT_BYTES:
                    raise ValueError("output_limit")
                final, completed, failed, protocol_violation = None, False, False, False
                error_categories = set()
                fatal_error_categories = set()
                observed_types = set()
                def record_error(value, allow_advisory=False):
                    category = classify_error_item(value)
                    error_categories.add(category)
                    if allow_advisory and value.get("message") == CODE_MODE_DISABLED_ADVISORY:
                        result["observed_advisories"] = ["code_mode_disabled"]
                    else:
                        fatal_error_categories.add(category)
                    result["observed_error_categories"] = sorted(error_categories)
                for line in run.get("stdout", "").splitlines():
                    event = json.loads(line)
                    if event.get("type") == "error":
                        record_error(event)
                    item = event.get("item", {})
                    kind = item.get("type", "")
                    if kind:
                        # Only identifier-shaped bounded metadata is retained. Never
                        # retain arbitrary item contents or attacker-controlled text.
                        if type(kind) is str and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", kind):
                            if len(observed_types) < 32:
                                observed_types.add(kind)
                        else:
                            protocol_violation = True
                        result["observed_item_types"] = sorted(observed_types)
                    if kind in TOOL_ITEM_TYPES:
                        result["observed_tool_calls"] += 1
                    elif kind == "error":
                        record_error(item, allow_advisory=True)
                    elif kind and kind not in PASSIVE_ITEM_TYPES:
                        protocol_violation = True
                    if event.get("type") == "item.completed" and kind == "agent_message":
                        final = item.get("text")
                    if event.get("type") == "turn.completed":
                        completed = True
                        result["usage"] = {k: v for k, v in event.get("usage", {}).items()
                                           if "token" in k and type(v) is int and v >= 0}
                    if event.get("type") == "turn.failed":
                        failed = True
                if result["observed_tool_calls"]:
                    result.update(status="tool_violation", error_code="tool_event")
                elif fatal_error_categories:
                    result.update(status="error", error_code="cli_error_item")
                elif protocol_violation:
                    result.update(status="error", error_code="protocol_violation")
                elif failed:
                    raise ValueError("turn_failed")
                elif run["returncode"] or not completed or final is None:
                    raise ValueError("incomplete_response")
                else:
                    try:
                        response = json.loads(final, object_pairs_hook=strict_json_object,
                            parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite_response")))
                    except json.JSONDecodeError:
                        result.update(status="error", error_code="non_json_response")
                    else:
                        Draft202012Validator(schema).validate(response)
                        if type(response) is not dict:
                            raise ValueError("response_not_object")
                        result.update(status="ok", response=response)
        except (TimeoutError, subprocess.TimeoutExpired):
            result.update(status="timeout", error_code="timeout")
        except Exception as error:
            # Never copy exception text, CLI logs, credentials or prompt content.
            code = str(error) if isinstance(error, ValueError) and str(error) in {
                "prompt_limit", "schema_limit", "output_limit", "chatgpt_login_required",
                "turn_failed", "incomplete_response", "response_not_object", "duplicate_json_key",
                "nonfinite_response"} else type(error).__name__
            result.update(status="error", error_code=code)
        finally:
            result["elapsed_seconds"] = round(time.monotonic() - start, 4)
        return result
