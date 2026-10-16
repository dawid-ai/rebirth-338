"""Entry point: ``python -m reborn_sidecar``.

Reads JSON-lines requests from stdin and writes responses to stdout. Logs go
to stderr only. Anything a backend prints is redirected to stderr so it
cannot corrupt the protocol stream.
"""

from __future__ import annotations

import logging
import os
import sys

from .backends import select_backend
from .server import Server


def _throttle_seconds() -> float:
    raw = os.environ.get('REBORN_SIDECAR_THROTTLE_MS', '')
    try:
        return max(0.0, float(raw) / 1000.0) if raw else 0.0
    except ValueError:
        return 0.0


def main() -> int:
    level = logging.getLevelName(os.environ.get('REBORN_SIDECAR_LOG_LEVEL', 'INFO').upper())
    logging.basicConfig(
        stream=sys.stderr,
        level=level if isinstance(level, int) else logging.INFO,
        format='%(levelname)s %(name)s: %(message)s',
    )
    output = sys.stdout.buffer
    sys.stdout = sys.stderr
    backend, fallback_reason = select_backend()
    logging.getLogger('reborn_sidecar').info('Sidecar ready with the %s backend (pid %d).', backend.name, os.getpid())
    server = Server(backend, output, throttle_seconds=_throttle_seconds(), fallback_reason=fallback_reason)
    server.serve(sys.stdin.buffer)
    return 0


if __name__ == '__main__':
    sys.exit(main())
