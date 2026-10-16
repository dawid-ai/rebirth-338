"""Builtin numpy analysis backend. Always available.

The file is processed in 1-second chunks. Each chunk is split into 100 ms
segments, and every metric is accumulated per segment, so file-level and
section-level results come from the same pass. Sections snap to the 100 ms
segment grid.
"""

from __future__ import annotations

import functools
import math
import os
from dataclasses import dataclass
from typing import Any, Callable

import numpy as np

from .. import __version__
from ..dsp import StreamingFir, TruePeakMeter, k_weighting_fir
from ..errors import SidecarError
from ..jobs import JobContext
from ..model import AnalyzeRequest, CompareRequest, GenerateRequest, SeparateRequest
from ..wavio import WavInfo, WavReader, probe

BANDS: tuple[tuple[str, float, float], ...] = (
    ('sub', 20.0, 60.0),
    ('bass', 60.0, 250.0),
    ('lowMid', 250.0, 500.0),
    ('mid', 500.0, 2000.0),
    ('harsh', 2000.0, 6000.0),
    ('air', 6000.0, 20000.0),
)
BAND_LABELS: dict[str, str] = {
    'sub': 'sub-bass',
    'bass': 'bass',
    'lowMid': 'low-mid',
    'mid': 'midrange',
    'harsh': 'upper-mid (2-6 kHz)',
    'air': 'air (6-20 kHz)',
}
SEGMENT_SECONDS = 0.1
SEGMENTS_PER_CHUNK = 10
BLOCK_SEGMENTS = 4  # 400 ms gating blocks with 75% overlap.
ABSOLUTE_GATE_LUFS = -70.0
RELATIVE_GATE_LU = -10.0

# Thresholds for plain-language comparison findings.
LOUDNESS_FINDING_LU = 1.0
BAND_FINDING_DB = 1.5
BAND_FINDING_MIN_SHARE = 0.01  # Ignore bands holding under 1% of the energy in both files.
CREST_FINDING_DB = 2.0
CORRELATION_FINDING = 0.2
TRUE_PEAK_CEILING_DBTP = -1.0
DC_FINDING = 0.001
BAND_FLOOR = 1e-12  # -120 dBFS; keeps differences finite for empty bands.


def _round(value: float | None, digits: int = 3) -> float | None:
    if value is None or not math.isfinite(value):
        return None
    return round(float(value), digits)


def _db20(value: float) -> float | None:
    return 20.0 * math.log10(value) if value > 0 else None


def _db10(value: float) -> float | None:
    return 10.0 * math.log10(value) if value > 0 else None


def segment_frames(sample_rate: int) -> int:
    return max(1, int(round(sample_rate * SEGMENT_SECONDS)))


def chunk_count(info: WavInfo) -> int:
    chunk = segment_frames(info.sample_rate) * SEGMENTS_PER_CHUNK
    return max(1, -(-info.frames // chunk))


def channel_weights(channels: int) -> np.ndarray:
    """BS.1770 channel weights. Mono counts as one channel, with no dual-mono gain."""
    if channels == 6:  # L R C LFE Ls Rs
        return np.array([1.0, 1.0, 1.0, 0.0, 1.41, 1.41])
    if channels == 5:  # L R C Ls Rs
        return np.array([1.0, 1.0, 1.0, 1.41, 1.41])
    return np.ones(channels)


@functools.lru_cache(maxsize=16)
def _spectral_plan(length: int, sample_rate: int) -> tuple[np.ndarray, float, np.ndarray, np.ndarray, np.ndarray]:
    window = np.hanning(length)
    energy = float(np.sum(window ** 2))
    scale = 2.0 / (length * energy) if energy > 0 else 0.0
    freqs = np.fft.rfftfreq(length, 1.0 / sample_rate)
    masks = np.stack([(freqs >= lo) & (freqs < hi) for _, lo, hi in BANDS]).astype(np.float64)
    centroid_mask = (freqs >= 20.0) & (freqs <= min(20000.0, sample_rate / 2.0))
    return window, scale, masks, centroid_mask, freqs


@dataclass
class Scan:
    info: WavInfo
    segment_frames: int
    n: np.ndarray  # (S,) frames per segment
    sumsq: np.ndarray  # (S, C)
    ksq: np.ndarray  # (S, C) K-weighted sum of squares
    peak: np.ndarray  # (S, C)
    true_peak: np.ndarray  # (S, C)
    sums: np.ndarray  # (S, C)
    cross: np.ndarray  # (S,) sum of L*R
    band_ms: np.ndarray  # (S, B) mean square per band, averaged over channels
    spec_p: np.ndarray  # (S,)
    spec_fp: np.ndarray  # (S,)

    @property
    def segments(self) -> int:
        return int(self.n.shape[0])


_FIELDS = ('n', 'sumsq', 'ksq', 'peak', 'true_peak', 'sums', 'cross', 'band_ms', 'spec_p', 'spec_fp')


def _segment_stats(x: np.ndarray, xk: np.ndarray, tp: np.ndarray, sample_rate: int) -> dict[str, np.ndarray]:
    segments, length, channels = x.shape
    peak = np.abs(x).max(axis=1)
    stats: dict[str, np.ndarray] = {
        'n': np.full(segments, length, dtype=np.int64),
        'sumsq': np.sum(x * x, axis=1),
        'ksq': np.sum(xk * xk, axis=1),
        'peak': peak,
        'true_peak': np.maximum(tp.max(axis=1), peak),
        'sums': x.sum(axis=1),
        'cross': np.sum(x[:, :, 0] * x[:, :, 1], axis=1) if channels >= 2 else np.zeros(segments),
    }
    window, scale, masks, centroid_mask, freqs = _spectral_plan(length, sample_rate)
    if length >= 16 and scale > 0:
        spectrum = np.fft.rfft(x * window[None, :, None], axis=1)
        power = np.mean(spectrum.real ** 2 + spectrum.imag ** 2, axis=2) * scale  # (S, K)
        stats['band_ms'] = power @ masks.T
        stats['spec_p'] = power[:, centroid_mask].sum(axis=1)
        stats['spec_fp'] = (power[:, centroid_mask] * freqs[centroid_mask]).sum(axis=1)
    else:
        stats['band_ms'] = np.zeros((segments, len(BANDS)))
        stats['spec_p'] = np.zeros(segments)
        stats['spec_fp'] = np.zeros(segments)
    return stats


def scan_file(path: str, ctx: JobContext, on_chunk: Callable[[], None] | None = None) -> Scan:
    """Read the file once and accumulate per-segment statistics."""
    with WavReader(path) as reader:
        info = reader.info
        channels = info.channels
        rate = info.sample_rate
        seg = segment_frames(rate)
        k_filter = StreamingFir(k_weighting_fir(rate), channels)
        true_peak = TruePeakMeter(channels)
        parts: list[dict[str, np.ndarray]] = []
        for block in reader.chunks(seg * SEGMENTS_PER_CHUNK):
            ctx.check()
            weighted = k_filter.process(block)
            peaks = true_peak.process(block)
            full = block.shape[0] // seg * seg
            if full:
                shape = (-1, seg, channels)
                parts.append(_segment_stats(block[:full].reshape(shape), weighted[:full].reshape(shape), peaks[:full].reshape(shape), rate))
            if full < block.shape[0]:
                parts.append(_segment_stats(block[full:][None], weighted[full:][None], peaks[full:][None], rate))
            if on_chunk is not None:
                on_chunk()
    ctx.check()
    if parts:
        merged = {name: np.concatenate([part[name] for part in parts], axis=0) for name in _FIELDS}
    else:
        merged = {
            'n': np.zeros(0, dtype=np.int64),
            'sumsq': np.zeros((0, channels)),
            'ksq': np.zeros((0, channels)),
            'peak': np.zeros((0, channels)),
            'true_peak': np.zeros((0, channels)),
            'sums': np.zeros((0, channels)),
            'cross': np.zeros(0),
            'band_ms': np.zeros((0, len(BANDS))),
            'spec_p': np.zeros(0),
            'spec_fp': np.zeros(0),
        }
    return Scan(info=info, segment_frames=seg, **merged)


def integrated_loudness(ksq: np.ndarray, n: np.ndarray, full_length: int, weights: np.ndarray) -> float | None:
    """Gated integrated loudness (BS.1770-4) from 100 ms K-weighted segments."""
    if ksq.shape[0] < BLOCK_SEGMENTS:
        return None
    windows = np.lib.stride_tricks.sliding_window_view
    block_ksq = windows(ksq, BLOCK_SEGMENTS, axis=0).sum(axis=-1)  # (J, C)
    block_n = windows(n, BLOCK_SEGMENTS).sum(axis=-1)  # (J,)
    complete = windows(n == full_length, BLOCK_SEGMENTS).all(axis=-1)
    power = (block_ksq / np.maximum(block_n, 1)[:, None]) @ weights
    valid = complete & (power > 0)
    if not valid.any():
        return None
    loudness = np.full(power.shape, -np.inf)
    loudness[valid] = -0.691 + 10.0 * np.log10(power[valid])
    gated = valid & (loudness > ABSOLUTE_GATE_LUFS)
    if not gated.any():
        return None
    relative = -0.691 + 10.0 * math.log10(float(power[gated].mean())) + RELATIVE_GATE_LU
    gated &= loudness > relative
    if not gated.any():
        return None
    return -0.691 + 10.0 * math.log10(float(power[gated].mean()))


def _empty_metrics(channels: int, bands: bool) -> dict[str, Any]:
    metrics: dict[str, Any] = {
        'peakDbfs': None,
        'rmsDbfs': None,
        'crestDb': None,
        'integratedLufs': None,
        'truePeakDbtp': None,
        'spectralCentroidHz': None,
        'stereoCorrelation': None,
        'dcOffset': None,
        'channels': [{'peakDbfs': None, 'rmsDbfs': None, 'truePeakDbtp': None, 'dcOffset': None} for _ in range(channels)],
    }
    if bands:
        metrics['bands'] = {name: {'db': None, 'share': None} for name, _, _ in BANDS}
    return metrics


def segment_metrics(scan: Scan, start: int, end: int, bands: bool = True) -> dict[str, Any]:
    """Metrics for the segment range [start, end)."""
    channels = scan.info.channels
    frames = int(scan.n[start:end].sum())
    if frames == 0:
        return _empty_metrics(channels, bands)
    sumsq = scan.sumsq[start:end].sum(axis=0)
    peak = scan.peak[start:end].max(axis=0)
    true_peak = scan.true_peak[start:end].max(axis=0)
    sums = scan.sums[start:end].sum(axis=0)
    dc = sums / frames
    peak_all = float(peak.max())
    rms_all = math.sqrt(float(sumsq.sum()) / (frames * channels))
    peak_db = _db20(peak_all)
    rms_db = _db20(rms_all)

    correlation: float | None = None
    if channels >= 2:
        cov = float(scan.cross[start:end].sum()) - sums[0] * sums[1] / frames
        var_l = float(sumsq[0]) - sums[0] ** 2 / frames
        var_r = float(sumsq[1]) - sums[1] ** 2 / frames
        if var_l > 1e-12 and var_r > 1e-12:
            correlation = max(-1.0, min(1.0, cov / math.sqrt(var_l * var_r)))

    dc_index = int(np.argmax(np.abs(dc)))
    spec_p = float(scan.spec_p[start:end].sum())
    metrics: dict[str, Any] = {
        'peakDbfs': _round(peak_db),
        'rmsDbfs': _round(rms_db),
        'crestDb': _round(peak_db - rms_db) if peak_db is not None and rms_db is not None else None,
        'integratedLufs': _round(integrated_loudness(scan.ksq[start:end], scan.n[start:end], scan.segment_frames, channel_weights(channels))),
        'truePeakDbtp': _round(_db20(float(true_peak.max()))),
        'spectralCentroidHz': _round(float(scan.spec_fp[start:end].sum()) / spec_p, 1) if spec_p > 0 else None,
        'stereoCorrelation': _round(correlation, 4),
        'dcOffset': _round(float(dc[dc_index]), 6),
        'channels': [
            {
                'peakDbfs': _round(_db20(float(peak[c]))),
                'rmsDbfs': _round(_db20(math.sqrt(float(sumsq[c]) / frames))),
                'truePeakDbtp': _round(_db20(float(true_peak[c]))),
                'dcOffset': _round(float(dc[c]), 6),
            }
            for c in range(channels)
        ],
    }
    if bands:
        weights = scan.n[start:end].astype(np.float64)
        band_ms = (scan.band_ms[start:end] * weights[:, None]).sum(axis=0) / weights.sum()
        total = float(band_ms.sum())
        metrics['bands'] = {
            name: {
                'db': _round(_db10(float(band_ms[i]))),
                'share': _round(float(band_ms[i]) / total, 4) if total > 0 else None,
            }
            for i, (name, _, _) in enumerate(BANDS)
        }
    return metrics


def _format(info: WavInfo) -> dict[str, Any]:
    return {
        'sampleRate': info.sample_rate,
        'channels': info.channels,
        'frames': info.frames,
        'durationSeconds': _round(info.duration, 6),
        'sampleFormat': info.sample_format,
    }


def analysis_result(scan: Scan, request: AnalyzeRequest) -> dict[str, Any]:
    rate = scan.info.sample_rate
    seg = scan.segment_frames
    total = scan.segments
    offsets = np.concatenate([[0], np.cumsum(scan.n)])
    sections: list[dict[str, Any]] = []
    for section in request.sections:
        start = min(total, int(round(section.start * rate / seg)))
        end = min(total, int(round(section.end * rate / seg)))
        if end <= start and start < total:
            end = start + 1
        sections.append({
            'id': section.id,
            'start': section.start,
            'end': section.end,
            'analyzedStart': _round(float(offsets[start]) / rate, 6),
            'analyzedEnd': _round(float(offsets[end]) / rate, 6),
            'metrics': segment_metrics(scan, start, end, request.bands),
        })
    return {
        'path': request.path,
        'backend': 'builtin',
        'format': _format(scan.info),
        'metrics': segment_metrics(scan, 0, total, request.bands),
        'sections': sections,
    }


def _difference(mix: float | None, reference: float | None, digits: int = 3) -> float | None:
    if mix is None or reference is None:
        return None
    return _round(mix - reference, digits)


def compare_findings(mix: dict[str, Any], reference: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Return metric differences and plain-language findings (largest first)."""
    findings: list[dict[str, Any]] = []
    differences: dict[str, Any] = {}
    for key in ('integratedLufs', 'rmsDbfs', 'peakDbfs', 'truePeakDbtp', 'crestDb', 'spectralCentroidHz', 'stereoCorrelation'):
        differences[key] = {'mix': mix[key], 'reference': reference[key], 'difference': _difference(mix[key], reference[key])}

    lufs = differences['integratedLufs']['difference']
    if lufs is not None and abs(lufs) >= LOUDNESS_FINDING_LU:
        findings.append({
            'kind': 'loudness',
            'metric': 'integratedLufs',
            'difference': lufs,
            'message': f'Your mix is {abs(lufs):.1f} LU {"louder" if lufs > 0 else "quieter"} than the reference.',
        })

    def band_power(metrics: dict[str, Any], name: str) -> float:
        level = metrics['bands'][name]['db']
        return max(BAND_FLOOR, 10.0 ** (level / 10.0)) if level is not None else BAND_FLOOR

    mix_total = sum(band_power(mix, name) for name, _, _ in BANDS)
    reference_total = sum(band_power(reference, name) for name, _, _ in BANDS)
    comparable = mix_total > len(BANDS) * BAND_FLOOR and reference_total > len(BANDS) * BAND_FLOOR
    bands: dict[str, Any] = {}
    for name, lo, hi in BANDS:
        mine = mix['bands'][name]
        theirs = reference['bands'][name]
        balance: float | None = None
        if comparable:
            # Loudness-matched: compare each band's share of its file's energy.
            balance = _round(10.0 * math.log10((band_power(mix, name) / mix_total) / (band_power(reference, name) / reference_total)))
        bands[name] = {
            'rangeHz': [lo, hi],
            'mixDb': mine['db'],
            'referenceDb': theirs['db'],
            'difference': _difference(mine['db'], theirs['db']),
            'balanceDifference': balance,
        }
        relevant = max(band_power(mix, name) / mix_total, band_power(reference, name) / reference_total) >= BAND_FINDING_MIN_SHARE
        if balance is not None and relevant and abs(balance) >= BAND_FINDING_DB:
            findings.append({
                'kind': 'band',
                'metric': name,
                'difference': balance,
                'message': f'Your mix has {abs(balance):.1f} dB {"more" if balance > 0 else "less"} {BAND_LABELS[name]} energy than the reference.',
            })
    differences['bands'] = bands

    crest = differences['crestDb']['difference']
    if crest is not None and abs(crest) >= CREST_FINDING_DB:
        findings.append({
            'kind': 'crest',
            'metric': 'crestDb',
            'difference': crest,
            'message': f'Your mix has {abs(crest):.1f} dB {"more" if crest > 0 else "less"} crest factor than the reference, so it is {"more dynamic" if crest > 0 else "more compressed"}.',
        })

    width = differences['stereoCorrelation']['difference']
    if width is not None and abs(width) >= CORRELATION_FINDING:
        findings.append({
            'kind': 'stereo',
            'metric': 'stereoCorrelation',
            'difference': width,
            'message': f'Your mix is {"narrower" if width > 0 else "wider"} than the reference (stereo correlation {mix["stereoCorrelation"]:.2f} vs {reference["stereoCorrelation"]:.2f}).',
        })

    true_peak = mix['truePeakDbtp']
    if true_peak is not None and true_peak > TRUE_PEAK_CEILING_DBTP:
        findings.append({
            'kind': 'truePeak',
            'metric': 'truePeakDbtp',
            'difference': _difference(true_peak, TRUE_PEAK_CEILING_DBTP),
            'message': f'Your mix peaks at {true_peak:+.1f} dBTP; leave at least 1 dB of true-peak headroom to avoid clipping after encoding.',
        })

    dc = mix['dcOffset']
    if dc is not None and abs(dc) >= DC_FINDING:
        findings.append({
            'kind': 'dcOffset',
            'metric': 'dcOffset',
            'difference': dc,
            'message': f'Your mix has a DC offset of {abs(dc) * 100:.2f}% of full scale; a gentle high-pass filter removes it.',
        })

    findings.sort(key=lambda finding: abs(finding['difference']), reverse=True)
    return differences, findings


ISMAIL_NEEDED = 'This needs Ismail. Install it from RE:BORN (Browser > Generate > Install Ismail).'


class BuiltinBackend:
    name = 'builtin'
    version = __version__
    capabilities: list[str] = ['analyze', 'compare', 'cancel', 'progress', 'sections', 'bands', 'lufs', 'truePeak', 'stereo']

    def analyze(self, request: AnalyzeRequest, ctx: JobContext) -> dict[str, Any]:
        total = chunk_count(probe(request.path))
        label = f'Analyzing {os.path.basename(request.path)}'
        done = 0

        def tick() -> None:
            nonlocal done
            done += 1
            ctx.progress(done, total, label)

        ctx.progress(0, total, label)
        return analysis_result(scan_file(request.path, ctx, tick), request)

    def compare(self, request: CompareRequest, ctx: JobContext) -> dict[str, Any]:
        mix_info = probe(request.path)
        reference_info = probe(request.reference)
        total = chunk_count(mix_info) + chunk_count(reference_info)
        done = 0
        label = ''

        def tick() -> None:
            nonlocal done
            done += 1
            ctx.progress(done, total, label)

        label = f'Analyzing {os.path.basename(request.path)}'
        ctx.progress(0, total, label)
        mix_scan = scan_file(request.path, ctx, tick)
        label = f'Analyzing reference {os.path.basename(request.reference)}'
        reference_scan = scan_file(request.reference, ctx, tick)
        mix = segment_metrics(mix_scan, 0, mix_scan.segments, True)
        reference = segment_metrics(reference_scan, 0, reference_scan.segments, True)
        differences, findings = compare_findings(mix, reference)
        return {
            'path': request.path,
            'reference': request.reference,
            'backend': 'builtin',
            'mix': {'format': _format(mix_scan.info), 'metrics': mix},
            'referenceAnalysis': {'format': _format(reference_scan.info), 'metrics': reference},
            'differences': differences,
            'findings': findings,
        }

    def presets(self) -> dict[str, Any]:
        raise SidecarError('unavailable', ISMAIL_NEEDED)

    def generate(self, request: GenerateRequest, ctx: JobContext) -> dict[str, Any]:
        raise SidecarError('unavailable', ISMAIL_NEEDED)

    def separate(self, request: SeparateRequest, ctx: JobContext) -> dict[str, Any]:
        raise SidecarError('unavailable', ISMAIL_NEEDED)
