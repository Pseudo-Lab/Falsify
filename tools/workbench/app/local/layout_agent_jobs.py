"""In-memory, idempotent ledger of asynchronous layout-agent steps for one companion instance.

A step is identified by (runId, stepId) and the SHA-256 of its canonical inner request. The inner
request is the existing falsify.paper-layout-agent-step.v1 payload and is validated with
layout_agent_service.validate_request before admission. A new step runs the injected decide callback
(normally layout_agent_service.decide) on a worker thread; the receipt is returned immediately.

Admission is delegated to the caller: admit() acquires the companion ACTIVE slot for a new step only,
and release() is invoked exactly once after the callback has actually returned (or the worker could
not be started). Cancellation is recorded, never claimed as termination of the running subprocess.
Nothing is ever resubmitted automatically. Receipts hold no credentials or raw CLI output.
"""
import hashlib
import json
import re
import threading
import time

from layout_agent_service import LayoutAgentError, RESPONSE_SCHEMA, validate_request

RECEIPT_SCHEMA = 'falsify.layout-step-receipt.v1'
IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9._-]{0,127}\Z')
HEX = re.compile(r'[0-9a-f]{64}\Z')
MAX_REQUEST_BYTES = 6 * 1024 * 1024
ENVELOPE_KEYS = frozenset({'runId', 'stepId', 'request', 'fingerprint'})
STATES = ('running', 'completed', 'failed', 'cancelled')


def canonical_request_bytes(request):
    """UTF-8 of the request as key-sorted, compact JSON (separators ',' and ':', non-ASCII kept, no NaN)."""
    try:
        text = json.dumps(request, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        return text.encode('utf-8')
    except (TypeError, ValueError, UnicodeEncodeError, RecursionError):
        raise LayoutAgentError('invalid_request', 400) from None


def request_fingerprint(request):
    """SHA-256 hex of canonical_request_bytes(request)."""
    return hashlib.sha256(canonical_request_bytes(request)).hexdigest()


def _identifier(value):
    if type(value) is not str or not IDENTIFIER.fullmatch(value): raise LayoutAgentError('invalid_request', 400)
    return value


def _valid_result(result, request):
    """Only the current service action response for exactly this project and step is retained."""
    data = request['data']
    return (type(result) is dict and result.get('schema') == RESPONSE_SCHEMA
            and result.get('projectId') == data['projectId'] and result.get('step') == data['step']
            and type(result.get('action')) is dict)


class _Entry:
    __slots__ = ('run_id', 'step_id', 'fingerprint', 'project_id', 'step', 'state', 'result', 'error',
                 'cancel_requested', 'finished', 'request', 'admitted', 'released', 'settled')

    def __init__(self, run_id, step_id, fingerprint, request):
        self.run_id, self.step_id, self.fingerprint = run_id, step_id, fingerprint
        self.project_id, self.step = request['data']['projectId'], request['data']['step']
        self.state, self.result, self.error = 'running', None, None
        self.cancel_requested, self.finished = False, None
        self.request = request          # dropped once the worker has finished
        self.admitted = False           # admission decided (ok or refused)
        self.released = False
        self.settled = threading.Event()  # set once admission is decided

    def receipt(self):
        out = {'schema': RECEIPT_SCHEMA, 'runId': self.run_id, 'stepId': self.step_id,
               'fingerprint': self.fingerprint, 'projectId': self.project_id, 'step': self.step,
               'state': self.state, 'cancelRequested': self.cancel_requested}
        if self.result is not None: out['result'] = json.loads(json.dumps(self.result))
        if self.error is not None: out['error'] = dict(self.error)
        return out


class LayoutStepLedger:
    """Thread-safe in-memory step ledger. See module docstring for the contract."""

    def __init__(self, decide, retention_seconds=3600, now=time.time, executor=None):
        if not callable(decide) or not callable(now): raise TypeError('decide and now must be callable')
        if type(retention_seconds) not in (int, float) or not retention_seconds >= 0: raise ValueError('retention_seconds')
        self._decide, self._retention, self._now, self._executor = decide, retention_seconds, now, executor
        self._lock = threading.Lock()
        self._entries = {}

    # -- internal -----------------------------------------------------------------------------
    def _prune_locked(self):
        limit = self._now() - self._retention
        for key in [k for k, e in self._entries.items() if e.finished is not None and e.finished < limit]:
            del self._entries[key]

    def _lookup_locked(self, step_id, run_id):
        self._prune_locked()
        if type(step_id) is not str or not IDENTIFIER.fullmatch(step_id): return None
        entry = self._entries.get(step_id)
        if entry is None or (run_id is not None and entry.run_id != run_id): return None
        return entry

    def _release_once(self, entry, release):
        with self._lock:
            if entry.released: return
            entry.released = True
        if release is not None: release()

    def _run(self, entry, release):
        try:
            try:
                result = self._decide(entry.request)
                if not _valid_result(result, entry.request): raise LayoutAgentError('invalid_action', 422)
                outcome = ('completed', result, None)
            except LayoutAgentError as error:
                outcome = ('failed', None, error.payload())
            except Exception:
                outcome = ('failed', None, LayoutAgentError('model_failed').payload())
            with self._lock:
                state, result, error = outcome
                if entry.cancel_requested: state, result = 'cancelled', None
                entry.state, entry.result, entry.error = state, result, error
                entry.finished, entry.request = self._now(), None
        finally:
            # Only after the callback has returned: the companion slot stays held for the whole decision.
            self._release_once(entry, release)

    # -- public API -----------------------------------------------------------------------------
    def submit(self, data, *, admit=None, release=None):
        """Validate {runId, stepId, request, fingerprint?} and return a receipt dict.

        Raises LayoutAgentError: invalid_request/request_limit (400), fingerprint_mismatch (400),
        layout_step_conflict (409), companion_busy (409). Validation happens before admit().
        """
        if type(data) is not dict or not {'runId', 'stepId', 'request'} <= set(data) or set(data) - ENVELOPE_KEYS:
            raise LayoutAgentError('invalid_request', 400)
        run_id, step_id = _identifier(data['runId']), _identifier(data['stepId'])
        if len(canonical_request_bytes(data['request'])) > MAX_REQUEST_BYTES: raise LayoutAgentError('request_limit', 400)
        fingerprint = request_fingerprint(data['request'])
        if 'fingerprint' in data:
            if type(data['fingerprint']) is not str or not HEX.fullmatch(data['fingerprint']): raise LayoutAgentError('invalid_request', 400)
            if data['fingerprint'] != fingerprint: raise LayoutAgentError('fingerprint_mismatch', 400)
        try: request = validate_request(data['request'])
        except LayoutAgentError: raise
        except ValueError: raise LayoutAgentError('invalid_request', 400) from None

        while True:
            with self._lock:
                self._prune_locked()
                entry = self._entries.get(step_id)
                if entry is None:
                    entry = _Entry(run_id, step_id, fingerprint, request)
                    self._entries[step_id] = entry
                    owner = True
                else:
                    if entry.run_id != run_id or entry.fingerprint != fingerprint:
                        raise LayoutAgentError('layout_step_conflict', 409)
                    owner = False
                    if entry.admitted: return entry.receipt()
            if owner: break
            # An identical concurrent submit is still being admitted; wait for its decision, then re-evaluate.
            entry.settled.wait()

        # Admission outside the ledger lock: admit() takes the server lock, which may itself consult this ledger.
        try: admitted = True if admit is None else bool(admit())
        except BaseException:
            admitted = False
            with self._lock: self._entries.pop(step_id, None)
            entry.settled.set()
            raise
        if not admitted:
            with self._lock: self._entries.pop(step_id, None)
            entry.settled.set()
            raise LayoutAgentError('companion_busy', 409)

        with self._lock: entry.admitted = True
        try:
            if self._executor is not None: self._executor.submit(self._run, entry, release)
            else: threading.Thread(target=self._run, args=(entry, release), name='layout-step', daemon=True).start()
        except BaseException:
            with self._lock:
                entry.state, entry.error = 'failed', LayoutAgentError('job_start_failed').payload()
                entry.finished, entry.request = self._now(), None
            self._release_once(entry, release)
        finally:
            entry.settled.set()
        with self._lock: return entry.receipt()

    def get(self, step_id, *, run_id=None):
        """Return the receipt, or raise LayoutAgentError('layout_step_not_found', 404)."""
        with self._lock:
            entry = self._lookup_locked(step_id, run_id)
            if entry is None or not entry.admitted: raise LayoutAgentError('layout_step_not_found', 404)
            return entry.receipt()

    def cancel(self, step_id, *, run_id=None):
        """Record cancellation. A running step keeps state 'running' (cancelRequested true) and its admission
        until the callback returns, then becomes 'cancelled' without a result. A completed step becomes
        'cancelled' and drops its result. Failed/cancelled steps are unchanged."""
        with self._lock:
            entry = self._lookup_locked(step_id, run_id)
            if entry is None or not entry.admitted: raise LayoutAgentError('layout_step_not_found', 404)
            if entry.state in ('running', 'completed'): entry.cancel_requested = True
            if entry.state == 'completed': entry.state, entry.result = 'cancelled', None
            return entry.receipt()

    def running(self):
        """Number of steps whose callback has not yet returned (for diagnostics/busy checks)."""
        with self._lock: return sum(1 for e in self._entries.values() if e.admitted and e.finished is None)
