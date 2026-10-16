"""Shared helpers: import path setup and WAV generators for tests."""

from __future__ import annotations

import os
import struct
import sys
import wave

import numpy as np

PACKAGE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if PACKAGE_DIR not in sys.path:
    sys.path.insert(0, PACKAGE_DIR)


def sine(frequency: float, seconds: float, amplitude: float, rate: int = 48000, phase: float = 0.0) -> np.ndarray:
    t = np.arange(int(round(seconds * rate))) / rate
    return amplitude * np.sin(2.0 * np.pi * frequency * t + phase)


def as_frames(signal: np.ndarray) -> np.ndarray:
    return signal[:, None] if signal.ndim == 1 else signal


def write_pcm(path: str, signal: np.ndarray, rate: int = 48000, bits: int = 16) -> str:
    """Write integer PCM with the ``wave`` module."""
    frames = np.clip(as_frames(signal), -1.0, 1.0)
    scale = float(2 ** (bits - 1) - 1)
    ints = np.round(frames * scale).astype(np.int64)
    if bits == 8:
        raw = (ints + 128).astype(np.uint8).tobytes()
    elif bits == 16:
        raw = ints.astype('<i2').tobytes()
    elif bits == 24:
        raw = ints.astype('<i4').view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
    elif bits == 32:
        raw = ints.astype('<i4').tobytes()
    else:
        raise ValueError(bits)
    with wave.open(path, 'wb') as handle:
        handle.setnchannels(frames.shape[1])
        handle.setsampwidth(bits // 8)
        handle.setframerate(rate)
        handle.writeframes(raw)
    return path


def write_riff(path: str, format_tag: int, channels: int, rate: int, bits: int, payload: bytes, extensible: bool = False) -> str:
    """Write a RIFF/WAVE file by hand (float, extensible, or exotic tags)."""
    block_align = channels * (bits // 8)
    if extensible:
        guid_tail = b'\x00\x00\x00\x00\x10\x00\x80\x00\x00\xaa\x00\x38\x9b\x71'
        fmt = struct.pack('<HHIIHHHHI', 0xFFFE, channels, rate, rate * block_align, block_align, bits, 22, bits, 0)
        fmt += struct.pack('<H', format_tag) + guid_tail
    else:
        fmt = struct.pack('<HHIIHH', format_tag, channels, rate, rate * block_align, block_align, bits)
    body = b'WAVE' + b'fmt ' + struct.pack('<I', len(fmt)) + fmt
    body += b'data' + struct.pack('<I', len(payload)) + payload
    if len(payload) % 2:
        body += b'\x00'
    with open(path, 'wb') as handle:
        handle.write(b'RIFF' + struct.pack('<I', len(body)) + body)
    return path


def write_float(path: str, signal: np.ndarray, rate: int = 48000, bits: int = 32, extensible: bool = False) -> str:
    frames = as_frames(signal)
    payload = frames.astype('<f4' if bits == 32 else '<f8').tobytes()
    return write_riff(path, 3, frames.shape[1], rate, bits, payload, extensible)


def db(value: float) -> float:
    return 20.0 * float(np.log10(value))
