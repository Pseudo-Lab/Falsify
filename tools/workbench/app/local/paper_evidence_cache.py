"""Content-addressed disk cache for blind BLUE sensor and triage payloads.

Entries are JSON envelopes under ``<cache_dir>/<key[:2]>/<key>.json``. The cache
refuses RED answer-key fields and host-path fields, and never returns its
directory path.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

SCHEMA = "falsify.evidence-cache.v1"
CACHE_ENGINE_VERSION = "w11-v1"
_FORBIDDEN_RED_KEYS = frozenset({
    "before", "after", "patch", "gold", "goldLedger", "why_hard", "candidateRationales", "plan",
})
_BLOCKED_PATH_KEYS = frozenset({
    "path", "paths", "filepath", "file_path", "cwd", "dir", "directory", "root", "workdir", "source_path",
})
_NAMESPACE = re.compile(r"[a-z0-9_-]{1,64}")
_FILE_HASH = re.compile(r"[0-9a-f]{64}")
_BUCKET = re.compile(r"[0-9a-f]{2}")
_ENTRY = re.compile(r"[0-9a-f]{64}\.json")


def _require_token(value, pattern):
    if isinstance(value, str) and pattern.fullmatch(value):
        return value
    raise ValueError("cache_key_invalid")


def _require_limit(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("cache_limit_invalid")
    return value


def _require_min_bytes(value):
    if type(value) is not int or value < 65536:
        raise ValueError("cache_limit_invalid")
    return value


def _pair(item):
    if not isinstance(item, dict):
        raise ValueError("cache_key_invalid")
    name, digest = item.get("name"), item.get("sha256")
    if not isinstance(name, str) or not isinstance(digest, str):
        raise ValueError("cache_key_invalid")
    return (name, digest)


def _canonical_supplements(supplements):
    if supplements is None:
        return []
    if not isinstance(supplements, list):
        raise ValueError("cache_key_invalid")
    pairs = [_pair(item) for item in supplements]
    pairs.sort()
    return [[name, digest] for name, digest in pairs]


def _options_object(options):
    if options is None:
        return {}
    if not isinstance(options, dict):
        raise ValueError("cache_key_invalid")
    try:
        rendered = json.dumps(options, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    except TypeError:
        raise ValueError("cache_key_invalid") from None
    return json.loads(rendered)


def _cache_material(namespace, file_hash, supplements, options, engine_version):
    body = {
        "engineVersion": engine_version,
        "fileHash": file_hash,
        "namespace": namespace,
        "options": _options_object(options),
        "supplements": _canonical_supplements(supplements),
    }
    return json.dumps(body, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def compute_cache_key(namespace, file_hash, *, supplements=None, options=None, engine_version=CACHE_ENGINE_VERSION):
    """Return a lowercase SHA-256 key for one blind, path-free payload."""
    _require_token(namespace, _NAMESPACE)
    _require_token(file_hash, _FILE_HASH)
    if not isinstance(engine_version, str) or not engine_version:
        raise ValueError("cache_key_invalid")
    material = _cache_material(namespace, file_hash, supplements, options, engine_version)
    return hashlib.sha256(material).hexdigest()


def _reject_key(key):
    if key in _FORBIDDEN_RED_KEYS:
        raise ValueError("forbidden_red_key")
    if key in _BLOCKED_PATH_KEYS:
        raise ValueError("cache_path_leak")


def _walk_dict(value):
    for key, item in value.items():
        _reject_key(key)
        _walk(item)


def _walk(value):
    if isinstance(value, dict):
        _walk_dict(value)
    elif isinstance(value, list):
        for item in value:
            _walk(item)


def _assert_clean_payload(value):
    if not isinstance(value, dict):
        raise ValueError("cache_payload_invalid")
    _walk(value)


def _canonical_bytes(payload):
    text = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return text.encode("utf-8")


def _payload_sha256(payload):
    return hashlib.sha256(_canonical_bytes(payload)).hexdigest()


def _valid_key(key):
    if isinstance(key, str) and _FILE_HASH.fullmatch(key):
        return key
    return None


def _require_cache_dir(cache_dir):
    if isinstance(cache_dir, Path):
        return cache_dir
    if isinstance(cache_dir, str) and cache_dir.strip():
        return Path(cache_dir)
    raise ValueError("cache_dir_invalid")


def _is_link(path):
    try:
        if path.is_symlink():
            return True
        junction = getattr(path, "is_junction", None)
        return bool(callable(junction) and junction())
    except OSError:
        return True


def _prepare_cache_dir(cache_dir):
    path = _require_cache_dir(cache_dir)
    if _is_link(path):
        raise ValueError("cache_dir_invalid")
    try:
        path.mkdir(parents=True, exist_ok=True)
    except OSError:
        raise ValueError("cache_dir_invalid") from None
    if _is_link(path) or not path.is_dir():
        raise ValueError("cache_dir_invalid")
    return path


def _unlink(path):
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        return


def _touch(path):
    try:
        os.utime(path, None)
    except OSError:
        return


def _load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return None


def _digest_ok(payload, digest):
    if not isinstance(digest, str):
        return False
    return digest == _payload_sha256(payload)


def _verified_payload(envelope, key):
    if not isinstance(envelope, dict):
        return None
    if envelope.get("schema") != SCHEMA or envelope.get("key") != key:
        return None
    payload = envelope.get("payload")
    if not isinstance(payload, dict):
        return None
    try:
        _assert_clean_payload(payload)
    except ValueError:
        return None
    if not _digest_ok(payload, envelope.get("payloadSha256")):
        return None
    return payload


def _skipped_file(path):
    if path.is_symlink():
        return True
    return not path.is_file()


def _collect_file(path, found):
    if path.is_symlink() or not path.is_file() or _ENTRY.fullmatch(path.name) is None:
        return
    try:
        stat = path.stat()
    except OSError:
        return
    found.append((stat.st_mtime, path.name, stat.st_size, path))


def _collect_bucket(bucket, found):
    if bucket.is_symlink() or not bucket.is_dir() or _BUCKET.fullmatch(bucket.name) is None:
        return
    try:
        paths = list(bucket.iterdir())
    except OSError:
        return
    for path in paths:
        _collect_file(path, found)


def _cache_files(cache_dir):
    found = []
    try:
        buckets = list(cache_dir.iterdir())
    except OSError:
        return found
    for bucket in buckets:
        _collect_bucket(bucket, found)
    return found


def _file_order(item):
    return (item[0], item[1])


def _total_bytes(files):
    return sum(item[2] for item in files)


def _over_budget(files, max_entries, max_bytes):
    if len(files) > max_entries:
        return True
    return _total_bytes(files) > max_bytes


def _envelope(key, payload):
    return {
        "schema": SCHEMA,
        "key": key,
        "engineVersion": CACHE_ENGINE_VERSION,
        "payloadSha256": _payload_sha256(payload),
        "payload": payload,
    }


def _write_atomic(directory, filename, raw):
    directory.mkdir(parents=True, exist_ok=True)
    tmp = tempfile.NamedTemporaryFile(mode="wb", dir=directory, delete=False, prefix="tmp-", suffix=".part")
    tmp_path = Path(tmp.name)
    try:
        tmp.write(raw)
        tmp.flush()
        tmp.close()
        os.replace(tmp_path, directory / filename)
    except Exception:
        tmp.close()
        _unlink(tmp_path)
        raise


class EvidenceCache:
    """Integrity-checked JSON cache. Stats never include the cache directory."""

    def __init__(self, cache_dir, *, max_entries=256, max_bytes=128 * 1024 * 1024):
        self.max_entries = _require_limit(max_entries, 1, 4096)
        self.max_bytes = _require_min_bytes(max_bytes)
        self.cache_dir = _prepare_cache_dir(cache_dir)
        self.hits = 0
        self.misses = 0
        self.corrupt_evictions = 0

    def _entry_path(self, key):
        return self.cache_dir / key[:2] / f"{key}.json"

    def _evict(self, path):
        self.corrupt_evictions += 1
        _unlink(path)

    def _read_entry(self, path, key):
        if _skipped_file(path):
            return None
        payload = _verified_payload(_load_json(path), key)
        if payload is None:
            self._evict(path)
        return payload

    def _write_envelope(self, key, envelope):
        raw = (json.dumps(envelope, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        _write_atomic(self._entry_path(key).parent, f"{key}.json", raw)

    def _prune(self):
        files = _cache_files(self.cache_dir)
        files.sort(key=_file_order)
        while _over_budget(files, self.max_entries, self.max_bytes):
            _unlink(files.pop(0)[3])

    def get(self, key):
        """Return a verified payload, or None after evicting a corrupt entry."""
        if _valid_key(key) is None:
            self.misses += 1
            return None
        path = self._entry_path(key)
        payload = self._read_entry(path, key)
        if payload is None:
            self.misses += 1
            return None
        self.hits += 1
        _touch(path)
        return payload

    def put(self, key, payload):
        """Store a clean payload atomically, then prune the oldest entries."""
        if _valid_key(key) is None:
            raise ValueError("cache_key_invalid")
        _assert_clean_payload(payload)
        self._write_envelope(key, _envelope(key, payload))
        self._prune()
        return payload

    def get_or_compute(self, key, builder):
        """Return ``(payload, True)`` on hit, otherwise store ``builder()``."""
        found = self.get(key)
        if found is not None:
            return found, True
        if not callable(builder):
            raise ValueError("cache_key_invalid")
        return self.put(key, builder()), False

    def stats(self):
        """Return counters and size. The cache directory path is omitted."""
        files = _cache_files(self.cache_dir)
        return {
            "schema": SCHEMA,
            "hits": self.hits,
            "misses": self.misses,
            "corruptEvictions": self.corrupt_evictions,
            "entries": len(files),
            "totalBytes": _total_bytes(files),
        }
