"""Adapter for an installed ``ismail`` Python module.

Every attribute is optional. The adapter uses what exists and falls back to
the builtin backend for the rest:

``__version__: str``
    Reported as ``hello.backendVersion``.

``CAPABILITIES: list[str]``
    Extra capability names, reported as ``ismail:<name>`` in ``hello``.

``analyze(path: str, **options) -> dict``
    Deeper analysis of one WAV file.

``compare(path: str, reference: str, **options) -> dict``
    Deeper comparison of a mix against a reference.

The adapter passes only the keyword options a function declares (or all of
them when it takes ``**kwargs``):

- ``sections``: list of ``{"id", "start", "end"}`` dicts in seconds (analyze only).
- ``bands``: bool (analyze only).
- ``progress``: ``Callable[[int, int, str], None]`` taking completed, total, and message.
- ``should_cancel``: ``Callable[[], bool]``; poll it between chunks of work and
  return early (or raise) when it returns True.

The builtin metrics always run first, so results keep the documented schema.
The Ismail return value is attached unchanged under the ``ismail`` key and
must be JSON-serializable. An exception raised by Ismail becomes a
``backend_error`` response; the sidecar process keeps running.
"""

from __future__ import annotations

import inspect
from types import ModuleType
from typing import Any, Callable

from ..errors import Cancelled
from ..jobs import JobContext
from ..model import AnalyzeRequest, CompareRequest
from .builtin import BuiltinBackend


class IsmailContractError(Exception):
    """The Ismail module returned something outside the documented interface."""


def _accepted_options(function: Callable[..., Any], options: dict[str, Any]) -> dict[str, Any]:
    try:
        parameters = inspect.signature(function).parameters.values()
    except (TypeError, ValueError):
        return {}
    if any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in parameters):
        return options
    names = {
        parameter.name
        for parameter in parameters
        if parameter.kind in (inspect.Parameter.POSITIONAL_OR_KEYWORD, inspect.Parameter.KEYWORD_ONLY)
    }
    return {key: value for key, value in options.items() if key in names}


class IsmailBackend:
    name = 'ismail'

    def __init__(self, module: ModuleType, fallback: BuiltinBackend) -> None:
        self._module = module
        self._fallback = fallback
        self.version = str(getattr(module, '__version__', 'unknown'))
        extra = getattr(module, 'CAPABILITIES', [])
        names = [str(item) for item in extra] if isinstance(extra, (list, tuple)) else []
        self.capabilities: list[str] = [*fallback.capabilities, 'ismail', *(f'ismail:{name}' for name in names)]

    def _function(self, name: str) -> Callable[..., Any] | None:
        candidate = getattr(self._module, name, None)
        return candidate if callable(candidate) else None

    def _invoke(self, function: Callable[..., Any], args: tuple[Any, ...], options: dict[str, Any], ctx: JobContext) -> dict[str, Any]:
        def progress(completed: int, total: int, message: str = '') -> None:
            ctx.progress(int(completed), int(total), f'Ismail: {message}' if message else 'Ismail')

        options = {**options, 'progress': progress, 'should_cancel': lambda: ctx.cancelled}
        ctx.progress(0, 1, 'Ismail: starting')
        result = function(*args, **_accepted_options(function, options))
        if ctx.cancelled:
            raise Cancelled()
        if not isinstance(result, dict):
            raise IsmailContractError(f'ismail.{function.__name__} returned {type(result).__name__}, expected dict.')
        return result

    def analyze(self, request: AnalyzeRequest, ctx: JobContext) -> dict[str, Any]:
        result = self._fallback.analyze(request, ctx)
        function = self._function('analyze')
        if function is None:
            return result
        sections = [{'id': s.id, 'start': s.start, 'end': s.end} for s in request.sections]
        extra = self._invoke(function, (request.path,), {'sections': sections, 'bands': request.bands}, ctx)
        return {**result, 'backend': 'ismail', 'ismail': extra}

    def compare(self, request: CompareRequest, ctx: JobContext) -> dict[str, Any]:
        result = self._fallback.compare(request, ctx)
        function = self._function('compare')
        if function is None:
            return result
        extra = self._invoke(function, (request.path, request.reference), {}, ctx)
        return {**result, 'backend': 'ismail', 'ismail': extra}
