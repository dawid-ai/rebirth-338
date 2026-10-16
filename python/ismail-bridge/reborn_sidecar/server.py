"""JSON-lines protocol server. See PROTOCOL.md."""

from __future__ import annotations

import json
import logging
import math
import os
import platform
import threading
import traceback
from typing import Any, BinaryIO, Callable, Iterable

import numpy as np

from . import PROTOCOL_VERSION, __version__
from .backends import Backend
from .errors import Cancelled, SidecarError
from .jobs import JobContext
from .model import parse_analyze, parse_compare, parse_generate, parse_separate

log = logging.getLogger('reborn_sidecar.server')

JOB_METHODS = ('analyze', 'compare', 'generate', 'separate', 'presets')
SHUTDOWN_GRACE_SECONDS = 5.0


def json_safe(value: Any) -> Any:
    """Convert numpy values and non-finite floats into strict JSON values."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, np.bool_):
        return bool(value)
    if isinstance(value, np.integer):
        return int(value)
    if isinstance(value, np.floating):
        number = float(value)
        return number if math.isfinite(number) else None
    if isinstance(value, np.ndarray):
        return json_safe(value.tolist())
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    raise TypeError(f'Value of type {type(value).__name__} is not JSON-serializable.')


class Server:
    def __init__(
        self,
        backend: Backend,
        output: BinaryIO,
        *,
        throttle_seconds: float = 0.0,
        max_concurrent_jobs: int = 2,
        fallback_reason: str | None = None,
    ) -> None:
        self._backend = backend
        self._output = output
        self._throttle = throttle_seconds
        self._fallback_reason = fallback_reason
        self._write_lock = threading.Lock()
        self._jobs_lock = threading.Lock()
        self._jobs: dict[str, threading.Event] = {}
        self._threads: list[threading.Thread] = []
        self._slots = threading.Semaphore(max(1, max_concurrent_jobs))
        self._output_broken = False

    # Output

    def send(self, message: dict[str, Any]) -> None:
        line = json.dumps(json_safe(message), ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n'
        with self._write_lock:
            if self._output_broken:
                return
            try:
                self._output.write(line.encode('utf-8'))
                self._output.flush()
            except (OSError, ValueError) as error:
                self._output_broken = True
                log.error('Cannot write to stdout: %s', error)

    def send_error(self, request_id: str | None, code: str, message: str) -> None:
        self.send({'id': request_id, 'error': {'code': code, 'message': message}})

    # Input

    def serve(self, lines: Iterable[bytes]) -> None:
        try:
            for raw in lines:
                if not raw.strip():
                    continue
                if not self.handle_line(raw):
                    break
        finally:
            self.close()

    def handle_line(self, raw: bytes) -> bool:
        """Handle one request line. Returns False after ``shutdown``."""
        try:
            message = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            self.send_error(None, 'invalid_params', f'Malformed request line: {error}')
            return True
        if not isinstance(message, dict):
            self.send_error(None, 'invalid_params', 'A request must be a JSON object.')
            return True
        request_id = message.get('id')
        if not isinstance(request_id, str) or not request_id:
            self.send_error(None, 'invalid_params', 'A request needs a non-empty string "id".')
            return True
        method = message.get('method')
        params = message.get('params')
        if params is None:
            params = {}
        try:
            if not isinstance(method, str):
                raise SidecarError('invalid_params', 'A request needs a string "method".')
            if not isinstance(params, dict):
                raise SidecarError('invalid_params', '"params" must be an object.')
            if method == 'hello':
                self.send({'id': request_id, 'result': self.hello()})
            elif method == 'cancel':
                self.send({'id': request_id, 'result': self.cancel(params)})
            elif method == 'shutdown':
                self.send({'id': request_id, 'result': {'ok': True}})
                return False
            elif method in JOB_METHODS:
                self.submit(request_id, method, params)
            else:
                raise SidecarError('invalid_params', f'Unknown method: {method}')
        except SidecarError as error:
            self.send_error(request_id, error.code, error.message)
        except Exception as error:  # Never let one request take the process down.
            log.error('Internal error handling %s: %s', method, traceback.format_exc())
            self.send_error(request_id, 'internal', f'{type(error).__name__}: {error}')
        return True

    # Methods

    def hello(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            'protocol': PROTOCOL_VERSION,
            'backend': self._backend.name,
            'version': __version__,
            'backendVersion': self._backend.version,
            'capabilities': list(self._backend.capabilities),
            'pid': os.getpid(),
            'python': platform.python_version(),
            'numpy': np.__version__,
        }
        if self._fallback_reason:
            result['fallbackReason'] = self._fallback_reason
        return result

    def cancel(self, params: dict[str, Any]) -> dict[str, Any]:
        target = params.get('target')
        if not isinstance(target, str) or not target:
            raise SidecarError('invalid_params', '"target" must be the id of a running request.')
        with self._jobs_lock:
            event = self._jobs.get(target)
        if event is not None:
            event.set()
        return {'target': target, 'cancelled': event is not None}

    def submit(self, request_id: str, method: str, params: dict[str, Any]) -> None:
        work: Callable[[JobContext], dict[str, Any]]
        if method == 'analyze':
            analyze = parse_analyze(params)
            work = lambda ctx: self._backend.analyze(analyze, ctx)  # noqa: E731
        elif method == 'compare':
            compare = parse_compare(params)
            work = lambda ctx: self._backend.compare(compare, ctx)  # noqa: E731
        elif method == 'generate':
            generate = parse_generate(params)
            work = lambda ctx: self._backend.generate(generate, ctx)  # noqa: E731
        elif method == 'separate':
            separate = parse_separate(params)
            work = lambda ctx: self._backend.separate(separate, ctx)  # noqa: E731
        else:
            work = lambda ctx: self._backend.presets()  # noqa: E731
        with self._jobs_lock:
            if request_id in self._jobs:
                raise SidecarError('invalid_params', f'A request with id {request_id!r} is already running.')
            event = threading.Event()
            self._jobs[request_id] = event
        thread = threading.Thread(target=self._run, args=(request_id, method, work, event), name=f'job-{request_id}', daemon=True)
        self._threads = [item for item in self._threads if item.is_alive()]
        self._threads.append(thread)
        thread.start()

    def _run(self, request_id: str, method: str, work: Callable[[JobContext], dict[str, Any]], event: threading.Event) -> None:
        def report(completed: int, total: int, message: str) -> None:
            self.send({'id': request_id, 'progress': {'completed': completed, 'total': total, 'message': message}})

        ctx = JobContext(event, report, throttle_seconds=self._throttle)
        acquired = False
        try:
            while not acquired:
                if event.is_set():
                    raise Cancelled()
                acquired = self._slots.acquire(timeout=0.05)
            ctx.check()
            result = work(ctx)
            try:
                payload = {'id': request_id, 'result': json_safe(result)}
                json.dumps(payload, allow_nan=False)
            except (TypeError, ValueError) as error:
                raise SidecarError('backend_error', f'The {self._backend.name} backend returned a result that is not JSON: {error}') from error
            self.send(payload)
        except SidecarError as error:
            self.send_error(request_id, error.code, error.message)
        except Exception as error:  # A backend crash must not kill the sidecar.
            log.error('Backend %s failed in %s: %s', self._backend.name, method, traceback.format_exc())
            self.send_error(request_id, 'backend_error', f'{type(error).__name__}: {error}')
        except BaseException as error:  # noqa: B036 - SystemExit/KeyboardInterrupt raised inside a backend.
            log.error('Backend %s aborted in %s: %r', self._backend.name, method, error)
            self.send_error(request_id, 'backend_error', f'The backend aborted with {type(error).__name__}.')
        finally:
            if acquired:
                self._slots.release()
            with self._jobs_lock:
                self._jobs.pop(request_id, None)

    def close(self) -> None:
        """Cancel running jobs and give them a short grace period to stop."""
        with self._jobs_lock:
            for event in self._jobs.values():
                event.set()
        deadline = SHUTDOWN_GRACE_SECONDS
        for thread in self._threads:
            if thread.is_alive():
                thread.join(timeout=deadline)
