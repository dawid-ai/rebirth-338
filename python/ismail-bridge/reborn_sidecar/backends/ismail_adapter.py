"""Adapter for Ismail (https://github.com/newsbubbles/ismail).

Ismail is a DAW for agents: every operation takes an Ismail project folder
and returns text. The adapter gives each job its own scratch project inside
the sidecar workspace, runs Ismail's ops on the files RE:BORN names, and
deletes the scratch project afterwards. RE:BORN projects are never touched.

What the adapter uses:

``<module>.api.OPS``
    Ismail's op table. ``analyze`` attaches ``analyze_overview``,
    ``analyze_key``, and ``analyze_chords`` reports; ``compare`` attaches
    ``compare``, ``align``, and the reference's ``analyze_grid`` and
    ``analyze_key``. ``generate`` calls ``sound_make``.
``<module>.presets.PRESETS``
    Named instruments, listed by ``presets``.
``<module>.voices.available()``
    Code voices, also listed by ``presets``.
``<module>.separate.separate(path, outdir, model)``
    Demucs stem separation. Needs the optional ``separate`` extra (PyTorch
    and Demucs); without it, ``separate`` answers ``unavailable``.

Builtin metrics always run first for ``analyze`` and ``compare``, so their
results keep the documented schema. One failing Ismail report is recorded
under ``ismail.errors`` and does not fail the job.
"""

from __future__ import annotations

import importlib
import importlib.util
import logging
import os
import re
import shutil
import tempfile
import uuid
from types import ModuleType
from typing import Any, Callable

from ..errors import Cancelled, SidecarError
from ..jobs import JobContext
from ..model import AnalyzeRequest, CompareRequest, GenerateRequest, SeparateRequest, Tempo
from .builtin import BuiltinBackend

log = logging.getLogger('reborn_sidecar.ismail')

# Ismail's analysis tables stop at 32 bars per call.
MAX_CHORD_BARS = 32


def default_workspace() -> str:
    return os.path.join(tempfile.gettempdir(), 'reborn-ismail')


def _safe_name(name: str) -> str:
    cleaned = re.sub(r'[^A-Za-z0-9 _-]+', '', name).strip()
    return cleaned[:60] or 'sound'


class IsmailBackend:
    name = 'ismail'

    def __init__(self, module: ModuleType, fallback: BuiltinBackend, workspace: str | None = None) -> None:
        self._module = module
        self._fallback = fallback
        self._api = importlib.import_module(f'{module.__name__}.api')
        self._ops: dict[str, Callable[..., str]] = self._api.OPS
        self.workspace = os.path.abspath(workspace or default_workspace())
        self.version = self._detect_version(module)
        self.separation = importlib.util.find_spec('demucs') is not None and self._has_submodule('separate')
        self.capabilities: list[str] = [
            *fallback.capabilities,
            'ismail',
            'ismail:overview',
            'ismail:key',
            'ismail:chords',
            'ismail:compare',
            'generate',
            'presets',
            *(['separate'] if self.separation else []),
        ]

    @staticmethod
    def _detect_version(module: ModuleType) -> str:
        version = getattr(module, '__version__', None)
        if isinstance(version, str):
            return version
        try:
            from importlib.metadata import version as dist_version

            return dist_version(module.__name__)
        except Exception:
            return 'unknown'

    def _has_submodule(self, name: str) -> bool:
        try:
            return importlib.util.find_spec(f'{self._module.__name__}.{name}') is not None
        except (ImportError, ValueError):
            return False

    # Scratch projects

    def _project(self, tempo: Tempo | None, seconds: float = 0.0) -> str:
        jobs = os.path.join(self.workspace, 'jobs')
        os.makedirs(jobs, exist_ok=True)
        root = os.path.join(jobs, uuid.uuid4().hex)
        bpm = tempo.bpm if tempo else 120.0
        beats = tempo.beats_per_bar if tempo else 4
        bars = max(1, int(seconds * bpm / 60.0 / beats) + 1)
        self._ops['project_new'](root, bpm=bpm, length_bars=bars, beats_per_bar=beats, offset_sec=tempo.offset_seconds if tempo else 0.0)
        return root

    def _reports(self, project: str, steps: list[tuple[str, str, dict[str, Any]]], ctx: JobContext) -> dict[str, Any]:
        reports: dict[str, str] = {}
        errors: dict[str, str] = {}
        for index, (key, op, kwargs) in enumerate(steps):
            ctx.check()
            ctx.progress(index, len(steps), f'Ismail: {key}')
            try:
                reports[key] = str(self._ops[op](project, **kwargs))
            except Exception as error:  # One report failing must not lose the others.
                log.warning('Ismail %s failed: %s', op, error)
                errors[key] = f'{type(error).__name__}: {error}'
        ctx.progress(len(steps), len(steps), 'Ismail: done')
        return {'version': self.version, 'reports': reports, 'errors': errors}

    # Methods

    def analyze(self, request: AnalyzeRequest, ctx: JobContext) -> dict[str, Any]:
        result = self._fallback.analyze(request, ctx)
        seconds = float(result.get('format', {}).get('durationSeconds') or 0.0)
        project = self._project(request.tempo, seconds)
        try:
            bpm = request.tempo.bpm if request.tempo else 120.0
            beats = request.tempo.beats_per_bar if request.tempo else 4
            bars = max(1, min(MAX_CHORD_BARS, int(seconds * bpm / 60.0 / beats)))
            steps: list[tuple[str, str, dict[str, Any]]] = [
                ('overview', 'analyze_overview', {'source': request.path}),
                ('key', 'analyze_key', {'source': request.path}),
                ('chords', 'analyze_chords', {'source': request.path, 'bars': [1, bars]}),
            ]
            extra = self._reports(project, steps, ctx)
        finally:
            shutil.rmtree(project, ignore_errors=True)
        return {**result, 'backend': 'ismail', 'ismail': extra}

    def compare(self, request: CompareRequest, ctx: JobContext) -> dict[str, Any]:
        result = self._fallback.compare(request, ctx)
        seconds = float(result.get('mix', {}).get('format', {}).get('durationSeconds') or 0.0)
        project = self._project(request.tempo, seconds)
        try:
            steps: list[tuple[str, str, dict[str, Any]]] = [
                ('compare', 'compare', {'a': request.path, 'b': request.reference}),
                ('align', 'align', {'a': request.path, 'b': request.reference}),
                ('referenceKey', 'analyze_key', {'source': request.reference}),
                ('referenceGrid', 'analyze_grid', {'source': request.reference}),
            ]
            extra = self._reports(project, steps, ctx)
        finally:
            shutil.rmtree(project, ignore_errors=True)
        return {**result, 'backend': 'ismail', 'ismail': extra}

    def presets(self) -> dict[str, Any]:
        presets = importlib.import_module(f'{self._module.__name__}.presets').PRESETS
        listed = [{'name': name, 'type': str(spec.get('type', 'synth')) if isinstance(spec, dict) else 'synth'} for name, spec in presets.items()]
        voices: list[dict[str, str]] = []
        try:
            for row in importlib.import_module(f'{self._module.__name__}.voices').available():
                name, origin, summary = (list(row) + ['', '', ''])[:3]
                voices.append({'name': str(name), 'family': str(origin), 'summary': str(summary)})
        except Exception as error:  # A broken voice folder still leaves the presets.
            log.warning('Listing Ismail voices failed: %s', error)
        return {'presets': listed, 'voices': voices}

    def generate(self, request: GenerateRequest, ctx: JobContext) -> dict[str, Any]:
        ctx.progress(0, 2, f'Ismail: making {request.name}')
        project = self._project(Tempo(request.bpm))
        try:
            name = _safe_name(request.name)
            description = self._ops['sound_make'](
                project,
                name=name,
                instrument=request.instrument,
                notes=request.notes,
                fx=list(request.fx) or None,
                tail_sec=request.tail_seconds,
                normalize=request.normalize,
                describe=True,
            )
            ctx.check()
            os.makedirs(request.out_dir, exist_ok=True)
            target = os.path.join(request.out_dir, f'{name}-{uuid.uuid4().hex[:8]}.wav')
            shutil.copyfile(os.path.join(project, 'sounds', f'{name}.wav'), target)
        except Cancelled:
            raise
        except Exception as error:
            # Ismail explains bad instruments and notes in plain words; pass them on.
            raise SidecarError('invalid_params' if type(error).__name__ in ('OpError', 'NotationError') else 'backend_error', str(error)) from error
        finally:
            shutil.rmtree(project, ignore_errors=True)
        ctx.progress(2, 2, 'Ismail: done')
        lines = str(description).splitlines()
        return {'path': target, 'name': request.name, 'summary': lines[0] if lines else '', 'description': '\n'.join(lines[1:])}

    def separate(self, request: SeparateRequest, ctx: JobContext) -> dict[str, Any]:
        if not self.separation:
            raise SidecarError('unavailable', 'Stem separation needs the Ismail stem separation add-on (PyTorch and Demucs).')
        separate = importlib.import_module(f'{self._module.__name__}.separate').separate
        out_dir = os.path.join(request.out_dir, uuid.uuid4().hex[:8])
        ctx.progress(0, 1, 'Ismail: separating stems (this can take minutes)')
        try:
            names = separate(request.path, out_dir, request.model)
        except Exception as error:
            shutil.rmtree(out_dir, ignore_errors=True)
            raise SidecarError('backend_error', f'Stem separation failed: {type(error).__name__}: {error}') from error
        # Demucs cannot stop part-way; a cancel during the run discards its output.
        if ctx.cancelled:
            shutil.rmtree(out_dir, ignore_errors=True)
            raise Cancelled()
        ctx.progress(1, 1, 'Ismail: done')
        return {'model': request.model, 'stems': [{'name': str(name), 'path': os.path.join(out_dir, f'{name}.wav')} for name in names]}
