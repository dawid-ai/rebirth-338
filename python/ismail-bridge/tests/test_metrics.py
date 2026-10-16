from __future__ import annotations

import os
import tempfile
import threading
import unittest
from typing import Any

import numpy as np

from _support import db, sine, write_float, write_pcm

from reborn_sidecar.backends.builtin import BuiltinBackend
from reborn_sidecar.errors import SidecarError
from reborn_sidecar.jobs import JobContext
from reborn_sidecar.model import AnalyzeRequest, Section


class MetricsTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name
        self.backend = BuiltinBackend()

    def tearDown(self) -> None:
        self._dir.cleanup()

    def analyze(self, name: str, signal: np.ndarray, *, rate: int = 48000, bits: int = 24, sections: tuple[Section, ...] = ()) -> dict[str, Any]:
        path = os.path.join(self.dir, name)
        if bits == 0:
            write_float(path, signal, rate)
        else:
            write_pcm(path, signal, rate, bits)
        return self.backend.analyze(AnalyzeRequest(path, sections), JobContext())

    def test_peak_and_rms_of_known_sines(self) -> None:
        for amplitude in (1.0, 0.5, 0.1):
            with self.subTest(amplitude=amplitude):
                metrics = self.analyze(f'sine-{amplitude}.wav', sine(1000, 2.0, amplitude), bits=0)['metrics']
                self.assertAlmostEqual(metrics['peakDbfs'], db(amplitude), delta=0.1)
                self.assertAlmostEqual(metrics['rmsDbfs'], db(amplitude / np.sqrt(2)), delta=0.1)
                self.assertAlmostEqual(metrics['crestDb'], 3.01, delta=0.1)

    def test_minus_20_dbfs_sine_reads_minus_23_lufs(self) -> None:
        # Mono counts as one channel, so a -20 dBFS (peak) 1 kHz sine reads
        # -23 LUFS; the same signal on both stereo channels reads -20 LUFS.
        mono = sine(1000, 5.0, 0.1)
        self.assertAlmostEqual(self.analyze('mono.wav', mono)['metrics']['integratedLufs'], -23.0, delta=0.5)
        stereo = np.stack([mono, mono], axis=1)
        self.assertAlmostEqual(self.analyze('stereo.wav', stereo)['metrics']['integratedLufs'], -20.0, delta=0.5)

    def test_lufs_at_44100(self) -> None:
        metrics = self.analyze('mono441.wav', sine(1000, 5.0, 0.1, rate=44100), rate=44100)['metrics']
        self.assertAlmostEqual(metrics['integratedLufs'], -23.0, delta=0.5)

    def test_relative_gate_ignores_quiet_passages(self) -> None:
        loud = sine(1000, 5.0, 0.1)
        quiet = sine(1000, 5.0, 0.001)
        metrics = self.analyze('gated.wav', np.concatenate([loud, quiet]))['metrics']
        self.assertAlmostEqual(metrics['integratedLufs'], -23.0, delta=0.5)

    def test_short_and_silent_files_return_null_loudness(self) -> None:
        self.assertIsNone(self.analyze('short.wav', sine(1000, 0.2, 0.5))['metrics']['integratedLufs'])
        silent = self.analyze('silent.wav', np.zeros(48000))['metrics']
        self.assertIsNone(silent['integratedLufs'])
        self.assertIsNone(silent['peakDbfs'])
        self.assertIsNone(silent['rmsDbfs'])

    def test_true_peak_exceeds_sample_peak_between_samples(self) -> None:
        # A quarter-rate sine at 45 degrees never hits its peak on a sample.
        metrics = self.analyze('intersample.wav', sine(12000, 1.0, 0.5, phase=np.pi / 4), bits=0)['metrics']
        self.assertAlmostEqual(metrics['peakDbfs'], db(0.5 * np.sin(np.pi / 4)), delta=0.1)
        self.assertAlmostEqual(metrics['truePeakDbtp'], db(0.5), delta=0.5)

    def test_band_energy_lands_in_the_right_band(self) -> None:
        cases = {'sub': 40, 'bass': 120, 'lowMid': 350, 'mid': 1000, 'harsh': 4000, 'air': 10000}
        for band, frequency in cases.items():
            with self.subTest(band=band):
                metrics = self.analyze(f'band-{band}.wav', sine(frequency, 2.0, 0.5), bits=0)['metrics']
                shares = {name: value['share'] for name, value in metrics['bands'].items()}
                self.assertEqual(max(shares, key=lambda name: shares[name]), band)
                self.assertGreater(shares[band], 0.9)
                self.assertAlmostEqual(metrics['bands'][band]['db'], metrics['rmsDbfs'], delta=0.5)

    def test_spectral_centroid_follows_frequency(self) -> None:
        metrics = self.analyze('centroid.wav', sine(1000, 2.0, 0.5), bits=0)['metrics']
        self.assertAlmostEqual(metrics['spectralCentroidHz'], 1000.0, delta=20.0)

    def test_stereo_correlation_and_dc_offset(self) -> None:
        tone = sine(220, 1.0, 0.4)
        same = self.analyze('same.wav', np.stack([tone, tone], axis=1), bits=0)['metrics']
        inverted = self.analyze('inverted.wav', np.stack([tone, -tone], axis=1), bits=0)['metrics']
        mono = self.analyze('mono-corr.wav', tone, bits=0)['metrics']
        self.assertAlmostEqual(same['stereoCorrelation'], 1.0, places=3)
        self.assertAlmostEqual(inverted['stereoCorrelation'], -1.0, places=3)
        self.assertIsNone(mono['stereoCorrelation'])
        offset = self.analyze('dc.wav', tone + 0.05, bits=0)['metrics']
        self.assertAlmostEqual(offset['dcOffset'], 0.05, places=3)

    def test_sections_measure_their_own_range(self) -> None:
        signal = np.concatenate([sine(1000, 2.0, 0.1), sine(1000, 2.0, 0.5)])
        result = self.analyze('sections.wav', signal, sections=(Section('verse', 0.0, 2.0), Section('drop', 2.0, 4.0), Section('late', 10.0, 12.0)))
        verse, drop, late = result['sections']
        self.assertEqual(verse['id'], 'verse')
        self.assertAlmostEqual(verse['metrics']['peakDbfs'], db(0.1), delta=0.1)
        self.assertAlmostEqual(drop['metrics']['peakDbfs'], db(0.5), delta=0.1)
        self.assertAlmostEqual(drop['metrics']['integratedLufs'], -9.0, delta=0.5)
        self.assertEqual(drop['analyzedStart'], 2.0)
        self.assertIsNone(late['metrics']['peakDbfs'])
        self.assertAlmostEqual(result['metrics']['peakDbfs'], db(0.5), delta=0.1)

    def test_bands_can_be_skipped(self) -> None:
        path = write_pcm(os.path.join(self.dir, 'nobands.wav'), sine(1000, 1.0, 0.5))
        result = self.backend.analyze(AnalyzeRequest(path, bands=False), JobContext())
        self.assertNotIn('bands', result['metrics'])

    def test_reports_progress_and_honors_cancellation(self) -> None:
        path = write_pcm(os.path.join(self.dir, 'long.wav'), sine(100, 30.0, 0.5))
        updates: list[tuple[int, int]] = []
        event = threading.Event()

        def report(completed: int, total: int, message: str) -> None:
            updates.append((completed, total))
            if completed >= 3:
                event.set()

        with self.assertRaises(SidecarError) as caught:
            self.backend.analyze(AnalyzeRequest(path), JobContext(event, report, min_interval_seconds=0))
        self.assertEqual(caught.exception.code, 'cancelled')
        self.assertEqual(updates[0], (0, 30))
        self.assertLess(updates[-1][0], 30)


if __name__ == '__main__':
    unittest.main()
