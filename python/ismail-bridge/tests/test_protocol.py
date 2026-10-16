"""Round-trip tests that spawn ``python -m reborn_sidecar`` as a subprocess."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from typing import Any, Callable

from _support import PACKAGE_DIR, sine, write_fake_ismail, write_pcm

Message = dict[str, Any]


class SidecarProcess:
    def __init__(self, extra_env: dict[str, str] | None = None) -> None:
        env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'REBORN_SIDECAR_BACKEND': 'builtin', **(extra_env or {})}
        self.process = subprocess.Popen(
            [sys.executable, '-m', 'reborn_sidecar'],
            cwd=PACKAGE_DIR,
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self.messages: queue.Queue[Message] = queue.Queue()
        self.stderr: list[str] = []
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.messages.put(json.loads(line.decode('utf-8')))

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr.append(line.decode('utf-8', 'replace'))

    def send_raw(self, data: bytes) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(data)
        self.process.stdin.flush()

    def send(self, request_id: str, method: str, params: dict[str, Any] | None = None) -> None:
        self.send_raw((json.dumps({'id': request_id, 'method': method, 'params': params or {}}) + '\n').encode('utf-8'))

    def receive(self, predicate: Callable[[Message], bool], timeout: float = 10.0) -> Message:
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise AssertionError(f'Timed out waiting for a message. stderr: {"".join(self.stderr)}')
            message = self.messages.get(timeout=remaining)
            if predicate(message):
                return message

    def reply(self, request_id: str, timeout: float = 10.0) -> Message:
        return self.receive(lambda m: m.get('id') == request_id and ('result' in m or 'error' in m), timeout)

    def close(self) -> None:
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait(timeout=10)
        for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
            if stream is not None:
                stream.close()


class ProtocolTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._dir = tempfile.TemporaryDirectory()
        cls.dir = cls._dir.name
        cls.tone = write_pcm(os.path.join(cls.dir, 'tone.wav'), sine(1000, 2.0, 0.5))
        # Two minutes of audio, analyzed with a per-chunk throttle so the
        # cancel arrives while the job is still running.
        cls.long = write_pcm(os.path.join(cls.dir, 'long.wav'), sine(80, 120.0, 0.5))

    @classmethod
    def tearDownClass(cls) -> None:
        cls._dir.cleanup()

    def start(self, env: dict[str, str] | None = None) -> SidecarProcess:
        sidecar = SidecarProcess(env)
        self.addCleanup(sidecar.close)
        return sidecar

    def test_hello_analyze_and_shutdown(self) -> None:
        sidecar = self.start()
        sidecar.send('h1', 'hello')
        hello = sidecar.reply('h1')['result']
        self.assertEqual(hello['protocol'], 2)
        self.assertEqual(hello['backend'], 'builtin')
        self.assertIn('analyze', hello['capabilities'])
        self.assertIsInstance(hello['version'], str)

        sidecar.send('a1', 'analyze', {'path': self.tone, 'sections': [{'id': 's', 'start': 0, 'end': 1}]})
        reply = sidecar.reply('a1')
        metrics = reply['result']['metrics']
        self.assertAlmostEqual(metrics['peakDbfs'], -6.02, delta=0.1)
        self.assertEqual(reply['result']['sections'][0]['id'], 's')

        sidecar.send('bye', 'shutdown')
        self.assertEqual(sidecar.reply('bye')['result'], {'ok': True})
        self.assertEqual(sidecar.process.wait(timeout=10), 0)

    def test_progress_is_reported(self) -> None:
        sidecar = self.start()
        sidecar.send('p1', 'analyze', {'path': self.tone})
        progress = sidecar.receive(lambda m: m.get('id') == 'p1' and 'progress' in m)
        self.assertEqual(set(progress['progress']), {'completed', 'total', 'message'})
        self.assertIn('result', sidecar.reply('p1'))

    def test_bad_input_yields_errors_without_crashing(self) -> None:
        sidecar = self.start()
        sidecar.send_raw(b'{not json\n')
        malformed = sidecar.receive(lambda m: True)
        self.assertIsNone(malformed['id'])
        self.assertEqual(malformed['error']['code'], 'invalid_params')
        sidecar.send_raw(b'\xff\xfe garbage\n')
        self.assertIsNone(sidecar.receive(lambda m: 'error' in m)['id'])
        sidecar.send_raw(b'[1, 2, 3]\n')
        self.assertIsNone(sidecar.receive(lambda m: 'error' in m)['id'])

        cases = [
            ('u1', 'transmogrify', {}, 'invalid_params'),
            ('m1', 'analyze', {}, 'invalid_params'),
            ('n1', 'analyze', {'path': os.path.join(self.dir, 'missing.wav')}, 'not_found'),
            ('s1', 'analyze', {'path': self.tone, 'sections': [{'id': 'x', 'start': 2, 'end': 1}]}, 'invalid_params'),
        ]
        text = os.path.join(self.dir, 'notes.wav')
        with open(text, 'w', encoding='utf-8') as handle:
            handle.write('not audio')
        cases.append(('f1', 'analyze', {'path': text}, 'unsupported_format'))
        for request_id, method, params, code in cases:
            with self.subTest(request_id=request_id):
                sidecar.send(request_id, method, params)
                self.assertEqual(sidecar.reply(request_id)['error']['code'], code)

        sidecar.send('alive', 'hello')
        self.assertIn('result', sidecar.reply('alive'))

    def test_cancel_stops_a_long_job_and_hello_stays_responsive(self) -> None:
        sidecar = self.start({'REBORN_SIDECAR_THROTTLE_MS': '20'})
        sidecar.send('long', 'analyze', {'path': self.long})
        first = sidecar.receive(lambda m: m.get('id') == 'long' and 'progress' in m)
        self.assertEqual(first['progress']['total'], 120)

        started = time.monotonic()
        sidecar.send('ping', 'hello')
        sidecar.reply('ping', timeout=2.0)
        self.assertLess(time.monotonic() - started, 1.0)

        sidecar.send('c1', 'cancel', {'target': 'long'})
        self.assertEqual(sidecar.reply('c1')['result'], {'target': 'long', 'cancelled': True})
        error = sidecar.reply('long', timeout=5.0)['error']
        self.assertEqual(error['code'], 'cancelled')

        sidecar.send('c2', 'cancel', {'target': 'long'})
        self.assertEqual(sidecar.reply('c2')['result']['cancelled'], False)

    def test_backend_crash_returns_backend_error(self) -> None:
        module_dir = write_fake_ismail(os.path.join(self.dir, 'crashy'), 'crashy_ismail')
        sidecar = self.start({
            'REBORN_SIDECAR_BACKEND': 'ismail',
            'REBORN_SIDECAR_ISMAIL_MODULE': 'crashy_ismail',
            'REBORN_SIDECAR_WORKSPACE': os.path.join(self.dir, 'workspace'),
            'FAKE_ISMAIL_WAV': self.tone,
            'PYTHONPATH': module_dir,
        })
        sidecar.send('h', 'hello')
        self.assertEqual(sidecar.reply('h')['result']['backend'], 'ismail')

        sidecar.send('a', 'analyze', {'path': self.tone, 'tempo': {'bpm': 128}})
        result = sidecar.reply('a')['result']
        self.assertEqual(result['ismail']['reports']['key'], 'key: A minor')
        self.assertIn('chords failed', result['ismail']['errors']['chords'])

        # A backend that exits the interpreter fails only its own request.
        sidecar.send('g', 'generate', {'name': 'pluck', 'instrument': 'pluck', 'bpm': 99, 'outDir': os.path.join(self.dir, 'out')})
        self.assertEqual(sidecar.reply('g')['error']['code'], 'backend_error')
        sidecar.send('h2', 'hello')
        self.assertIn('result', sidecar.reply('h2'))

        sidecar.send('h2', 'hello')
        self.assertIn('result', sidecar.reply('h2'))
        self.assertIsNone(sidecar.process.poll())

    def test_compare_round_trip(self) -> None:
        sidecar = self.start()
        sidecar.send('cmp', 'compare', {'path': self.tone, 'reference': self.tone})
        result = sidecar.reply('cmp')['result']
        self.assertEqual(result['findings'], [])
        self.assertIn('lowMid', result['differences']['bands'])

    def test_ismail_methods_are_unavailable_on_builtin(self) -> None:
        sidecar = self.start()
        sidecar.send('pre', 'presets')
        self.assertEqual(sidecar.reply('pre')['error']['code'], 'unavailable')
        sidecar.send('gen', 'generate', {'name': 'pluck', 'instrument': 'pluck', 'outDir': os.path.abspath(self.dir)})
        self.assertEqual(sidecar.reply('gen')['error']['code'], 'unavailable')
        sidecar.send('sep', 'separate', {'path': self.tone, 'outDir': 'relative'})
        self.assertEqual(sidecar.reply('sep')['error']['code'], 'invalid_params')

    def test_end_of_input_exits_cleanly(self) -> None:
        sidecar = self.start()
        assert sidecar.process.stdin is not None
        sidecar.process.stdin.close()
        self.assertEqual(sidecar.process.wait(timeout=10), 0)


if __name__ == '__main__':
    unittest.main()
