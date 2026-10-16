from __future__ import annotations

import os
import re
import tempfile
import unittest

import numpy as np

from _support import sine, write_float

from reborn_sidecar.backends.builtin import BuiltinBackend
from reborn_sidecar.jobs import JobContext
from reborn_sidecar.model import CompareRequest


class CompareTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name

    def tearDown(self) -> None:
        self._dir.cleanup()

    def write(self, name: str, signal: np.ndarray) -> str:
        return write_float(os.path.join(self.dir, name), signal)

    def test_reports_band_and_loudness_differences(self) -> None:
        base = sine(100, 4.0, 0.2) + sine(1000, 4.0, 0.2) + sine(8000, 4.0, 0.05)
        reference = self.write('reference.wav', base)
        mix = self.write('mix.wav', base + sine(350, 4.0, 0.3))
        result = BuiltinBackend().compare(CompareRequest(mix, reference), JobContext())

        low_mid = result['differences']['bands']['lowMid']
        self.assertGreater(low_mid['difference'], 20.0)
        self.assertGreater(low_mid['balanceDifference'], 20.0)
        self.assertLess(result['differences']['bands']['mid']['balanceDifference'], 0.0)
        self.assertGreater(result['differences']['integratedLufs']['difference'], 1.0)

        messages = [finding['message'] for finding in result['findings']]
        self.assertTrue(any(re.fullmatch(r'Your mix has \d+\.\d dB more low-mid energy than the reference\.', m) for m in messages), messages)
        self.assertTrue(any(re.fullmatch(r'Your mix is \d+\.\d LU louder than the reference\.', m) for m in messages), messages)
        self.assertEqual(result['findings'][0]['metric'], 'lowMid')

    def test_matching_files_have_no_findings(self) -> None:
        signal = sine(440, 2.0, 0.3)
        a = self.write('a.wav', signal)
        b = self.write('b.wav', signal)
        result = BuiltinBackend().compare(CompareRequest(a, b), JobContext())
        self.assertEqual(result['findings'], [])
        self.assertEqual(result['differences']['integratedLufs']['difference'], 0.0)

    def test_flags_true_peak_and_width(self) -> None:
        tone = sine(440, 2.0, 0.99)
        hot = self.write('hot.wav', np.stack([tone, tone], axis=1))
        wide = self.write('wide.wav', np.stack([tone, sine(440, 2.0, 0.99, phase=np.pi / 2)], axis=1))
        kinds = {finding['kind'] for finding in BuiltinBackend().compare(CompareRequest(hot, wide), JobContext())['findings']}
        self.assertIn('truePeak', kinds)
        self.assertIn('stereo', kinds)


if __name__ == '__main__':
    unittest.main()
