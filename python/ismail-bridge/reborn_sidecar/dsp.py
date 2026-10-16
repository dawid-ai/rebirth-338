"""Streaming filters used by the builtin backend.

numpy has no recursive filter, so the BS.1770 K-weighting biquads are turned
into a long FIR (their truncated impulse response) and applied with FFT
overlap-save. True peak uses a 48-tap, 4-phase polyphase interpolator as
suggested in BS.1770 Annex 2.
"""

from __future__ import annotations

import functools
import math

import numpy as np

Biquad = tuple[tuple[float, float, float], tuple[float, float]]

TRUE_PEAK_OVERSAMPLE = 4
TRUE_PEAK_TAPS = 48


def k_weighting_biquads(sample_rate: float) -> tuple[Biquad, Biquad]:
    """Return the BS.1770 pre-filter (high shelf) and RLB high-pass for any rate.

    The coefficients follow the analog prototypes used by libebur128, which
    reproduce the published 48 kHz values.
    """
    f0 = 1681.974450955533
    gain_db = 3.999843853973347
    q = 0.7071752369554196
    k = math.tan(math.pi * f0 / sample_rate)
    vh = 10.0 ** (gain_db / 20.0)
    vb = vh ** 0.4996667741545416
    a0 = 1.0 + k / q + k * k
    shelf: Biquad = (
        ((vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0),
        (2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0),
    )
    f0 = 38.13547087602444
    q = 0.5003270373238773
    k = math.tan(math.pi * f0 / sample_rate)
    a0 = 1.0 + k / q + k * k
    highpass: Biquad = (
        (1.0, -2.0, 1.0),
        (2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0),
    )
    return shelf, highpass


def _biquad(signal: list[float], section: Biquad) -> list[float]:
    (b0, b1, b2), (a1, a2) = section
    out: list[float] = []
    x1 = x2 = y1 = y2 = 0.0
    for x0 in signal:
        y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
        out.append(y0)
        x2, x1 = x1, x0
        y2, y1 = y1, y0
    return out


@functools.lru_cache(maxsize=8)
def k_weighting_fir(sample_rate: int) -> np.ndarray:
    """Truncated impulse response of the K-weighting cascade (250 ms long)."""
    length = max(1024, int(sample_rate * 0.25))
    impulse = [0.0] * length
    impulse[0] = 1.0
    shelf, highpass = k_weighting_biquads(sample_rate)
    response = np.asarray(_biquad(_biquad(impulse, shelf), highpass))
    response.setflags(write=False)
    return response


def _next_pow2(value: int) -> int:
    return 1 << max(0, (value - 1).bit_length())


class StreamingFir:
    """FFT overlap-save FIR filter that keeps state across chunks."""

    def __init__(self, taps: np.ndarray, channels: int) -> None:
        self._taps = taps
        self._history = np.zeros((len(taps) - 1, channels))
        self._spectra: dict[int, np.ndarray] = {}

    def process(self, block: np.ndarray) -> np.ndarray:
        count = block.shape[0]
        if count == 0:
            return block.copy()
        buffer = np.concatenate([self._history, block], axis=0)
        size = _next_pow2(buffer.shape[0])
        spectrum = self._spectra.get(size)
        if spectrum is None:
            spectrum = np.fft.rfft(self._taps, size)
            self._spectra[size] = spectrum
        filtered = np.fft.irfft(np.fft.rfft(buffer, size, axis=0) * spectrum[:, None], size, axis=0)
        offset = len(self._taps) - 1
        if offset:
            self._history = buffer[-offset:]
        return filtered[offset:offset + count]


@functools.lru_cache(maxsize=1)
def true_peak_phases() -> np.ndarray:
    """Polyphase interpolation filter, shape (oversample, taps per phase)."""
    index = np.arange(TRUE_PEAK_TAPS)
    t = (index - (TRUE_PEAK_TAPS - 1) / 2.0) / TRUE_PEAK_OVERSAMPLE
    prototype = np.sinc(t) * np.kaiser(TRUE_PEAK_TAPS, 6.0)
    phases = np.stack([prototype[p::TRUE_PEAK_OVERSAMPLE] for p in range(TRUE_PEAK_OVERSAMPLE)])
    phases /= phases.sum(axis=1, keepdims=True)
    phases.setflags(write=False)
    return phases


class TruePeakMeter:
    """Returns, per input frame, the largest absolute interpolated value."""

    def __init__(self, channels: int) -> None:
        self._phases = true_peak_phases()
        self._history = np.zeros((self._phases.shape[1] - 1, channels))

    def process(self, block: np.ndarray) -> np.ndarray:
        if block.shape[0] == 0:
            return np.zeros_like(block)
        buffer = np.concatenate([self._history, block], axis=0)
        self._history = buffer[-self._history.shape[0]:]
        peaks = np.zeros_like(block)
        for channel in range(block.shape[1]):
            column = buffer[:, channel]
            for phase in self._phases:
                np.maximum(peaks[:, channel], np.abs(np.convolve(column, phase, mode='valid')), out=peaks[:, channel])
        return peaks
