from __future__ import annotations

import os
import sys
import tempfile
import textwrap
import unittest

from _support import sine, write_pcm

from reborn_sidecar.backends import select_backend
from reborn_sidecar.jobs import JobContext
from reborn_sidecar.model import AnalyzeRequest, CompareRequest

FAKE_MODULE = textwrap.dedent('''
    __version__ = '9.9.9'
    CAPABILITIES = ['stems']

    def analyze(path, *, sections=None, progress=None, should_cancel=None):
        if progress:
            progress(1, 1, 'done')
        return {'path': path, 'sections': len(sections or []), 'cancelAware': should_cancel is not None}
''')

PARTIAL_MODULE = textwrap.dedent('''
    def compare(path, reference):
        return {'paths': [path, reference]}
''')


class IsmailAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name
        for name, source in (('fake_ismail_full', FAKE_MODULE), ('fake_ismail_partial', PARTIAL_MODULE)):
            with open(os.path.join(self.dir, f'{name}.py'), 'w', encoding='utf-8') as handle:
                handle.write(source)
        sys.path.insert(0, self.dir)
        self.wav = write_pcm(os.path.join(self.dir, 'tone.wav'), sine(1000, 1.0, 0.5))

    def tearDown(self) -> None:
        sys.path.remove(self.dir)
        for name in ('fake_ismail_full', 'fake_ismail_partial'):
            sys.modules.pop(name, None)
        self._dir.cleanup()

    def test_builtin_choice_ignores_ismail(self) -> None:
        backend, reason = select_backend({'REBORN_SIDECAR_BACKEND': 'builtin', 'REBORN_SIDECAR_ISMAIL_MODULE': 'fake_ismail_full'})
        self.assertEqual(backend.name, 'builtin')
        self.assertIsNone(reason)

    def test_auto_uses_ismail_when_importable(self) -> None:
        backend, _ = select_backend({'REBORN_SIDECAR_ISMAIL_MODULE': 'fake_ismail_full'})
        self.assertEqual(backend.name, 'ismail')
        self.assertEqual(backend.version, '9.9.9')
        self.assertIn('ismail:stems', backend.capabilities)
        result = backend.analyze(AnalyzeRequest(self.wav), JobContext())
        self.assertEqual(result['backend'], 'ismail')
        self.assertEqual(result['ismail'], {'path': self.wav, 'sections': 0, 'cancelAware': True})
        self.assertIn('peakDbfs', result['metrics'])

    def test_missing_functions_fall_back_to_builtin(self) -> None:
        backend, _ = select_backend({'REBORN_SIDECAR_BACKEND': 'ismail', 'REBORN_SIDECAR_ISMAIL_MODULE': 'fake_ismail_partial'})
        self.assertEqual(backend.name, 'ismail')
        analyzed = backend.analyze(AnalyzeRequest(self.wav), JobContext())
        self.assertEqual(analyzed['backend'], 'builtin')
        self.assertNotIn('ismail', analyzed)
        compared = backend.compare(CompareRequest(self.wav, self.wav), JobContext())
        self.assertEqual(compared['ismail'], {'paths': [self.wav, self.wav]})

    def test_unimportable_module_falls_back_with_a_reason(self) -> None:
        backend, reason = select_backend({'REBORN_SIDECAR_BACKEND': 'ismail', 'REBORN_SIDECAR_ISMAIL_MODULE': 'definitely_not_ismail'})
        self.assertEqual(backend.name, 'builtin')
        self.assertIn('definitely_not_ismail', reason or '')
        backend, reason = select_backend({'REBORN_SIDECAR_ISMAIL_MODULE': 'definitely_not_ismail'})
        self.assertEqual(backend.name, 'builtin')
        self.assertIsNone(reason)


if __name__ == '__main__':
    unittest.main()
