from __future__ import annotations

import os
import struct
import tempfile
import unittest

import numpy as np

from _support import sine, write_float, write_pcm, write_riff

from reborn_sidecar.errors import SidecarError
from reborn_sidecar.wavio import WavReader, probe, read_wav


class WavReadingTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name
        self.signal = np.stack([sine(440, 0.25, 0.5), sine(660, 0.25, -0.25)], axis=1)

    def tearDown(self) -> None:
        self._dir.cleanup()

    def path(self, name: str) -> str:
        return os.path.join(self.dir, name)

    def test_reads_integer_pcm_depths(self) -> None:
        for bits, tolerance in ((8, 1 / 64), (16, 1e-4), (24, 1e-6), (32, 1e-8)):
            with self.subTest(bits=bits):
                path = write_pcm(self.path(f'pcm{bits}.wav'), self.signal, bits=bits)
                data, info = read_wav(path)
                self.assertEqual(info.sample_format, f'pcm{bits}')
                self.assertEqual(info.channels, 2)
                self.assertEqual(info.frames, self.signal.shape[0])
                np.testing.assert_allclose(data, self.signal, atol=tolerance)

    def test_reads_float32_and_float64(self) -> None:
        for bits in (32, 64):
            with self.subTest(bits=bits):
                path = write_float(self.path(f'float{bits}.wav'), self.signal, bits=bits)
                data, info = read_wav(path)
                self.assertEqual(info.sample_format, f'float{bits}')
                self.assertEqual(info.sample_rate, 48000)
                np.testing.assert_allclose(data, self.signal, atol=1e-6)

    def test_reads_float_values_above_full_scale(self) -> None:
        path = write_float(self.path('hot.wav'), np.array([0.0, 1.5, -2.0]))
        data, _ = read_wav(path)
        np.testing.assert_allclose(data[:, 0], [0.0, 1.5, -2.0])

    def test_reads_extensible_headers(self) -> None:
        float_path = write_float(self.path('ext-float.wav'), self.signal, extensible=True)
        np.testing.assert_allclose(read_wav(float_path)[0], self.signal, atol=1e-6)
        ints = np.round(self.signal * 8388607).astype('<i4').view(np.uint8).reshape(-1, 4)[:, :3].tobytes()
        pcm_path = write_riff(self.path('ext-pcm24.wav'), 1, 2, 48000, 24, ints, extensible=True)
        info = probe(pcm_path)
        self.assertTrue(info.extensible)
        np.testing.assert_allclose(read_wav(pcm_path)[0], self.signal, atol=1e-6)

    def test_reads_in_chunks(self) -> None:
        path = write_pcm(self.path('chunks.wav'), self.signal, bits=16)
        with WavReader(path) as reader:
            sizes = [block.shape[0] for block in reader.chunks(5000)]
        self.assertEqual(sum(sizes), self.signal.shape[0])
        self.assertEqual(sizes[0], 5000)

    def test_clamps_truncated_data_chunk(self) -> None:
        path = write_float(self.path('truncated.wav'), self.signal)
        with open(path, 'rb') as handle:
            content = handle.read()
        with open(path, 'wb') as handle:
            handle.write(content[: len(content) - 4000])
        data, info = read_wav(path)
        self.assertEqual(info.frames, self.signal.shape[0] - 500)
        self.assertEqual(data.shape[0], info.frames)

    def test_rejects_unsupported_encodings(self) -> None:
        adpcm = write_riff(self.path('adpcm.wav'), 2, 1, 48000, 4, b'\x00' * 64)
        text = self.path('notes.wav')
        with open(text, 'w', encoding='utf-8') as handle:
            handle.write('this is not audio at all')
        rf64 = self.path('big.wav')
        with open(rf64, 'wb') as handle:
            handle.write(b'RF64' + struct.pack('<I', 0xFFFFFFFF) + b'WAVE' + b'\x00' * 32)
        for path in (adpcm, text, rf64):
            with self.subTest(path=os.path.basename(path)):
                with self.assertRaises(SidecarError) as caught:
                    probe(path)
                self.assertEqual(caught.exception.code, 'unsupported_format')

    def test_missing_file_is_not_found(self) -> None:
        with self.assertRaises(SidecarError) as caught:
            probe(self.path('missing.wav'))
        self.assertEqual(caught.exception.code, 'not_found')


if __name__ == '__main__':
    unittest.main()
