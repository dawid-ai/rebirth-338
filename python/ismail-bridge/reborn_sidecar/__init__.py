"""RE:BORN analysis sidecar.

The sidecar reads rendered audio files and returns structured measurements
over a JSON-lines protocol on stdin and stdout. It never edits RE:BORN
projects. See ``PROTOCOL.md`` for the wire format.
"""

__version__ = '0.2.0'
PROTOCOL_VERSION = 2

__all__ = ['__version__', 'PROTOCOL_VERSION']
