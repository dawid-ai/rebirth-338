from __future__ import annotations

import os
import sys
import tempfile
import unittest

from _support import sine, write_fake_ismail, write_pcm

from reborn_sidecar.backends import select_backend
from reborn_sidecar.errors import SidecarError
from reborn_sidecar.jobs import JobContext
from reborn_sidecar.model import AnalyzeRequest, CompareRequest, GenerateRequest, SeparateRequest, Tempo

MODULE = 'fake_ismail_pkg'


class IsmailAdapterTest(unittest.TestCase):
    def setUp(self) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.dir = self._dir.name
        sys.path.insert(0, write_fake_ismail(self.dir, MODULE))
        self.wav = write_pcm(os.path.join(self.dir, 'tone.wav'), sine(1000, 1.0, 0.5))
        os.environ['FAKE_ISMAIL_WAV'] = self.wav
        self.workspace = os.path.join(self.dir, 'workspace')
        self.env = {'REBORN_SIDECAR_ISMAIL_MODULE': MODULE, 'REBORN_SIDECAR_WORKSPACE': self.workspace}

    def tearDown(self) -> None:
        sys.path.remove(self.dir)
        for name in list(sys.modules):
            if name == MODULE or name.startswith(f'{MODULE}.'):
                sys.modules.pop(name, None)
        os.environ.pop('FAKE_ISMAIL_WAV', None)
        self._dir.cleanup()

    def backend(self):
        backend, reason = select_backend(self.env)
        self.assertIsNone(reason)
        self.assertEqual(backend.name, 'ismail')
        return backend

    def test_builtin_choice_ignores_ismail(self) -> None:
        backend, reason = select_backend({**self.env, 'REBORN_SIDECAR_BACKEND': 'builtin'})
        self.assertEqual(backend.name, 'builtin')
        self.assertIsNone(reason)

    def test_analyze_attaches_reports_and_keeps_partial_failures(self) -> None:
        backend = self.backend()
        self.assertEqual(backend.version, '9.9.9')
        self.assertIn('generate', backend.capabilities)
        result = backend.analyze(AnalyzeRequest(self.wav, tempo=Tempo(128)), JobContext())
        self.assertEqual(result['backend'], 'ismail')
        self.assertIn('peakDbfs', result['metrics'])
        self.assertEqual(result['ismail']['reports']['overview'], 'overview of tone.wav')
        self.assertIn('bars [1, 1]', result['ismail']['errors']['chords'])
        # Scratch projects are removed after each job.
        self.assertEqual(os.listdir(os.path.join(self.workspace, 'jobs')), [])

    def test_compare_reports_the_reference(self) -> None:
        result = self.backend().compare(CompareRequest(self.wav, self.wav), JobContext())
        self.assertEqual(set(result['ismail']['reports']), {'compare', 'align', 'referenceKey', 'referenceGrid'})
        self.assertIn('lowMid', result['differences']['bands'])

    def test_generate_copies_the_sound_out(self) -> None:
        out = os.path.join(self.dir, 'out')
        result = self.backend().generate(GenerateRequest(name='Soft pluck!', instrument='pluck', out_dir=out, notes='0 C3 1', bpm=90), JobContext())
        self.assertTrue(os.path.isfile(result['path']))
        self.assertTrue(os.path.dirname(result['path']) == out)
        self.assertEqual(result['summary'], "sound 'Soft pluck': 0.50s")
        self.assertIn('90', result['description'])

    def test_generate_explains_bad_instruments(self) -> None:
        with self.assertRaises(SidecarError) as caught:
            self.backend().generate(GenerateRequest(name='x', instrument='missing', out_dir=self.dir), JobContext())
        self.assertEqual(caught.exception.code, 'invalid_params')
        self.assertIn('unknown preset', caught.exception.message)

    def test_presets_list_presets_and_voices(self) -> None:
        listed = self.backend().presets()
        self.assertEqual(listed['presets'][0], {'name': 'pluck', 'type': 'synth'})
        self.assertEqual(listed['voices'][0]['name'], 'growl')

    def test_separate_needs_the_add_on(self) -> None:
        backend = self.backend()
        self.assertNotIn('separate', backend.capabilities)
        with self.assertRaises(SidecarError) as caught:
            backend.separate(SeparateRequest(self.wav, self.dir), JobContext())
        self.assertEqual(caught.exception.code, 'unavailable')

    def test_separate_returns_stems(self) -> None:
        backend = self.backend()
        backend.separation = True
        result = backend.separate(SeparateRequest(self.wav, self.dir), JobContext())
        self.assertEqual([stem['name'] for stem in result['stems']], ['drums', 'bass'])
        self.assertTrue(all(os.path.isfile(stem['path']) for stem in result['stems']))

    def test_cancel_during_separation_discards_stems(self) -> None:
        backend = self.backend()
        backend.separation = True
        ctx = JobContext()
        ctx.cancel()
        with self.assertRaises(SidecarError) as caught:
            backend.separate(SeparateRequest(self.wav, os.path.join(self.dir, 'cancelled')), ctx)
        self.assertEqual(caught.exception.code, 'cancelled')
        self.assertEqual(os.listdir(os.path.join(self.dir, 'cancelled')), [])

    def test_unimportable_module_falls_back_with_a_reason(self) -> None:
        backend, reason = select_backend({'REBORN_SIDECAR_BACKEND': 'ismail', 'REBORN_SIDECAR_ISMAIL_MODULE': 'definitely_not_ismail'})
        self.assertEqual(backend.name, 'builtin')
        self.assertIn('definitely_not_ismail', reason or '')
        backend, reason = select_backend({'REBORN_SIDECAR_ISMAIL_MODULE': 'definitely_not_ismail'})
        self.assertEqual(backend.name, 'builtin')
        self.assertIsNone(reason)


if __name__ == '__main__':
    unittest.main()
