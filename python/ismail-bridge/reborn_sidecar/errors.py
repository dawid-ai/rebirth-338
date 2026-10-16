"""Error types that map directly onto protocol error codes."""

from __future__ import annotations

ERROR_CODES: tuple[str, ...] = (
    'invalid_params',
    'not_found',
    'unsupported_format',
    'cancelled',
    'backend_error',
    'internal',
)


class SidecarError(Exception):
    """An error that is reported to the client with a specific code."""

    def __init__(self, code: str, message: str) -> None:
        if code not in ERROR_CODES:
            raise ValueError(f'Unknown sidecar error code: {code}')
        super().__init__(message)
        self.code = code
        self.message = message


class Cancelled(SidecarError):
    """Raised inside a job when the client cancelled it."""

    def __init__(self, message: str = 'The job was cancelled.') -> None:
        super().__init__('cancelled', message)
