"""Cooperative cancellation and progress reporting for long-running jobs."""

from __future__ import annotations

import threading
import time
from typing import Callable

from .errors import Cancelled

ProgressCallback = Callable[[int, int, str], None]


class JobContext:
    """Passed to every backend call.

    Backends call ``check()`` between chunks of work and ``progress()`` as
    they advance. ``check()`` raises ``Cancelled`` after the client sends
    ``cancel`` for the job.
    """

    def __init__(
        self,
        cancel_event: threading.Event | None = None,
        report: ProgressCallback | None = None,
        throttle_seconds: float = 0.0,
        min_interval_seconds: float = 0.05,
    ) -> None:
        self._event = cancel_event if cancel_event is not None else threading.Event()
        self._report = report
        self._throttle = max(0.0, throttle_seconds)
        self._min_interval = min_interval_seconds
        self._last_report = 0.0

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()

    def check(self) -> None:
        # The throttle only exists to make cancellation testable on fast
        # machines. Waiting on the event lets a cancel interrupt it.
        if self._throttle > 0:
            self._event.wait(self._throttle)
        if self._event.is_set():
            raise Cancelled()

    def progress(self, completed: int, total: int, message: str = '') -> None:
        if self._report is None:
            return
        now = time.monotonic()
        final = completed >= total
        if not final and completed > 0 and now - self._last_report < self._min_interval:
            return
        self._last_report = now
        self._report(completed, total, message)
