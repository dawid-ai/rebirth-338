"""Chunked WAV reading with the standard library and numpy.

Supported encodings: integer PCM at 8, 16, 24, and 32 bits and IEEE float at
32 and 64 bits, including WAVE_FORMAT_EXTENSIBLE headers. Plain PCM is read
through the ``wave`` module. Float and extensible files use a small RIFF
parser because ``wave`` rejects them on Python 3.11.
"""

from __future__ import annotations

import os
import struct
import wave
from dataclasses import dataclass
from types import TracebackType
from typing import BinaryIO, Iterator

import numpy as np

from .errors import SidecarError

FORMAT_PCM = 0x0001
FORMAT_FLOAT = 0x0003
FORMAT_EXTENSIBLE = 0xFFFE

_PCM_BITS = (8, 16, 24, 32)
_FLOAT_BITS = (32, 64)


@dataclass(frozen=True)
class WavInfo:
    path: str
    sample_rate: int
    channels: int
    frames: int
    bits: int
    encoding: str  # 'pcm' or 'float'
    extensible: bool
    data_offset: int
    block_align: int

    @property
    def sample_format(self) -> str:
        return f'{self.encoding}{self.bits}'

    @property
    def duration(self) -> float:
        return self.frames / self.sample_rate if self.sample_rate else 0.0


def _unsupported(message: str) -> SidecarError:
    return SidecarError('unsupported_format', message)


def probe(path: str) -> WavInfo:
    """Parse the RIFF header and return the stream layout."""
    try:
        handle = open(path, 'rb')
    except FileNotFoundError as error:
        raise SidecarError('not_found', f'File not found: {path}') from error
    except OSError as error:
        raise SidecarError('not_found', f'Cannot open {path}: {error.strerror or error}') from error
    with handle:
        file_size = os.fstat(handle.fileno()).st_size
        header = handle.read(12)
        if len(header) < 12:
            raise _unsupported('The file is too short to be a WAV file.')
        if header[0:4] in (b'RF64', b'BW64'):
            raise _unsupported('RF64/BW64 WAV files are not supported.')
        if header[0:4] != b'RIFF' or header[8:12] != b'WAVE':
            raise _unsupported('The file is not a RIFF/WAVE file.')
        fmt: bytes | None = None
        data: tuple[int, int] | None = None
        position = 12
        while position + 8 <= file_size:
            handle.seek(position)
            chunk_header = handle.read(8)
            if len(chunk_header) < 8:
                break
            chunk_id = chunk_header[0:4]
            (size,) = struct.unpack('<I', chunk_header[4:8])
            body_start = position + 8
            if chunk_id == b'fmt ':
                fmt = handle.read(min(size, 64))
            elif chunk_id == b'data':
                # Interrupted or streamed renders can declare more data than the
                # file holds, so clamp to what is on disk.
                data = (body_start, max(0, min(size, file_size - body_start)))
            if fmt is not None and data is not None:
                break
            position = body_start + size + (size & 1)
        if fmt is None or len(fmt) < 16:
            raise _unsupported('The WAV file has no valid "fmt " chunk.')
        if data is None:
            raise _unsupported('The WAV file has no "data" chunk.')

    format_tag, channels, sample_rate, _byte_rate, block_align, bits = struct.unpack('<HHIIHH', fmt[:16])
    extensible = False
    if format_tag == FORMAT_EXTENSIBLE:
        if len(fmt) < 40:
            raise _unsupported('The WAVE_FORMAT_EXTENSIBLE header is truncated.')
        (format_tag,) = struct.unpack('<H', fmt[24:26])
        extensible = True
    if format_tag == FORMAT_PCM and bits in _PCM_BITS:
        encoding = 'pcm'
    elif format_tag == FORMAT_FLOAT and bits in _FLOAT_BITS:
        encoding = 'float'
    else:
        raise _unsupported(f'Unsupported WAV encoding (format tag 0x{format_tag:04x}, {bits} bits). Use PCM 8/16/24/32-bit or float 32/64-bit.')
    if channels < 1 or sample_rate < 1:
        raise _unsupported('The WAV header declares no channels or no sample rate.')
    if block_align != channels * (bits // 8):
        raise _unsupported('The WAV header has an inconsistent block alignment.')
    data_offset, data_size = data
    return WavInfo(
        path=path,
        sample_rate=sample_rate,
        channels=channels,
        frames=data_size // block_align,
        bits=bits,
        encoding=encoding,
        extensible=extensible,
        data_offset=data_offset,
        block_align=block_align,
    )


def decode(raw: bytes, encoding: str, bits: int, channels: int) -> np.ndarray:
    """Decode interleaved little-endian samples to float64 of shape (frames, channels)."""
    frame_bytes = channels * (bits // 8)
    usable = len(raw) - len(raw) % frame_bytes
    buffer = raw[:usable]
    if encoding == 'float':
        samples = np.frombuffer(buffer, dtype='<f4' if bits == 32 else '<f8').astype(np.float64)
    elif bits == 8:
        samples = (np.frombuffer(buffer, dtype=np.uint8).astype(np.float64) - 128.0) / 128.0
    elif bits == 16:
        samples = np.frombuffer(buffer, dtype='<i2').astype(np.float64) / 32768.0
    elif bits == 24:
        triplets = np.frombuffer(buffer, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        values = triplets[:, 0] | (triplets[:, 1] << 8) | (triplets[:, 2] << 16)
        values = np.where(values & 0x800000, values - 0x1000000, values)
        samples = values.astype(np.float64) / 8388608.0
    elif bits == 32:
        samples = np.frombuffer(buffer, dtype='<i4').astype(np.float64) / 2147483648.0
    else:
        raise _unsupported(f'Unsupported PCM bit depth: {bits}.')
    return samples.reshape(-1, channels)


class WavReader:
    """Reads a WAV file in chunks of frames."""

    def __init__(self, path: str) -> None:
        self.info = probe(path)
        self._wave: wave.Wave_read | None = None
        self._file: BinaryIO | None = None
        self._remaining = self.info.frames
        if self.info.encoding == 'pcm' and not self.info.extensible:
            try:
                reader = wave.open(path, 'rb')
                if reader.getnchannels() == self.info.channels and reader.getsampwidth() * 8 == self.info.bits:
                    self._wave = reader
                else:
                    reader.close()
            except (wave.Error, EOFError, OSError):
                self._wave = None
        if self._wave is None:
            self._file = open(path, 'rb')
            self._file.seek(self.info.data_offset)

    def read(self, frames: int) -> np.ndarray:
        count = min(frames, self._remaining)
        if count <= 0:
            return np.zeros((0, self.info.channels))
        if self._wave is not None:
            raw = self._wave.readframes(count)
        else:
            assert self._file is not None
            raw = self._file.read(count * self.info.block_align)
        samples = decode(raw, self.info.encoding, self.info.bits, self.info.channels)
        self._remaining = 0 if samples.shape[0] < count else self._remaining - count
        return samples

    def chunks(self, frames: int) -> Iterator[np.ndarray]:
        while True:
            block = self.read(frames)
            if block.shape[0] == 0:
                return
            yield block

    def close(self) -> None:
        if self._wave is not None:
            self._wave.close()
            self._wave = None
        if self._file is not None:
            self._file.close()
            self._file = None

    def __enter__(self) -> WavReader:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.close()


def read_wav(path: str) -> tuple[np.ndarray, WavInfo]:
    """Read a whole file. Use ``WavReader`` for long files."""
    with WavReader(path) as reader:
        blocks = list(reader.chunks(1 << 18))
        info = reader.info
    if not blocks:
        return np.zeros((0, info.channels)), info
    return np.concatenate(blocks, axis=0), info
