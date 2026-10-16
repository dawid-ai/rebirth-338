"""Backend interface and selection.

``REBORN_SIDECAR_BACKEND`` picks the backend:

- ``builtin``: always use the numpy backend.
- ``ismail``: use the Ismail adapter. If ``ismail`` cannot be imported, the
  sidecar falls back to builtin and reports why in ``hello.fallbackReason``.
- ``auto`` (default): use Ismail when importable, otherwise builtin.

``REBORN_SIDECAR_ISMAIL_MODULE`` overrides the module name (default
``ismail``), which is mainly useful for tests and local forks.

``REBORN_SIDECAR_WORKSPACE`` is the folder for Ismail's scratch projects
(default: ``reborn-ismail`` in the system temp folder). Ismail's shared
``songs`` and machine folders are pointed into it too, so nothing is written
next to the installed package.
"""

from __future__ import annotations

import importlib
import logging
import os
from typing import Any, Mapping, Protocol

from ..jobs import JobContext
from ..model import AnalyzeRequest, CompareRequest, GenerateRequest, SeparateRequest
from .builtin import BuiltinBackend
from .ismail_adapter import IsmailBackend, default_workspace

log = logging.getLogger('reborn_sidecar.backends')

BACKEND_CHOICES = ('auto', 'builtin', 'ismail')


class Backend(Protocol):
    name: str
    version: str
    capabilities: list[str]

    def analyze(self, request: AnalyzeRequest, ctx: JobContext) -> dict[str, Any]: ...

    def compare(self, request: CompareRequest, ctx: JobContext) -> dict[str, Any]: ...

    def presets(self) -> dict[str, Any]: ...

    def generate(self, request: GenerateRequest, ctx: JobContext) -> dict[str, Any]: ...

    def separate(self, request: SeparateRequest, ctx: JobContext) -> dict[str, Any]: ...


def select_backend(environ: Mapping[str, str] | None = None) -> tuple[Backend, str | None]:
    """Return the backend to use and, when a requested backend was unavailable, why."""
    env = os.environ if environ is None else environ
    choice = env.get('REBORN_SIDECAR_BACKEND', 'auto').strip().lower() or 'auto'
    if choice not in BACKEND_CHOICES:
        log.warning('Unknown REBORN_SIDECAR_BACKEND=%r; using auto.', choice)
        choice = 'auto'
    builtin = BuiltinBackend()
    if choice == 'builtin':
        return builtin, None

    module_name = env.get('REBORN_SIDECAR_ISMAIL_MODULE', 'ismail').strip() or 'ismail'
    workspace = os.path.abspath(env.get('REBORN_SIDECAR_WORKSPACE', '').strip() or default_workspace())
    # Ismail reads these when its modules load, so set them before importing.
    if environ is None:
        os.environ.setdefault('ISMAIL_SONGS', os.path.join(workspace, 'songs'))
        os.environ.setdefault('ISMAIL_MACHINE_DIR', os.path.join(workspace, 'machine'))
    try:
        module = importlib.import_module(module_name)
        importlib.import_module(f'{module_name}.api')
    except Exception as error:  # A broken install must not stop the sidecar.
        reason = f'Ismail module {module_name!r} is not importable ({type(error).__name__}: {error}); using builtin.'
        if choice == 'ismail':
            log.warning(reason)
            return builtin, reason
        log.info(reason)
        return builtin, None

    return IsmailBackend(module, builtin, workspace), None


__all__ = ['Backend', 'BuiltinBackend', 'select_backend', 'BACKEND_CHOICES']
