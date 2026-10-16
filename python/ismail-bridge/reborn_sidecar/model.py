"""Typed request objects and parameter validation shared by all backends."""

from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Any, Mapping

from .errors import SidecarError


@dataclass(frozen=True)
class Section:
    id: str
    start: float
    end: float


@dataclass(frozen=True)
class Tempo:
    """The song grid, so tempo-aware backends number bars the way RE:BORN does."""

    bpm: float
    beats_per_bar: int = 4
    offset_seconds: float = 0.0


@dataclass(frozen=True)
class AnalyzeRequest:
    path: str
    sections: tuple[Section, ...] = ()
    bands: bool = True
    tempo: Tempo | None = None


@dataclass(frozen=True)
class CompareRequest:
    path: str
    reference: str
    tempo: Tempo | None = None


@dataclass(frozen=True)
class SeparateRequest:
    path: str
    out_dir: str
    model: str = 'htdemucs'


@dataclass(frozen=True)
class GenerateRequest:
    name: str
    instrument: str | dict[str, Any]
    out_dir: str
    notes: str = '0 C4 1'
    fx: tuple[dict[str, Any], ...] = ()
    tail_seconds: float = 1.0
    bpm: float = 120.0
    normalize: bool = True


def _existing_file(params: Mapping[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value:
        raise SidecarError('invalid_params', f'"{key}" must be a non-empty string.')
    if not os.path.isfile(value):
        raise SidecarError('not_found', f'File not found: {value}')
    return value


def _seconds(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SidecarError('invalid_params', f'"{name}" must be a number of seconds.')
    number = float(value)
    if not math.isfinite(number) or number < 0:
        raise SidecarError('invalid_params', f'"{name}" must be a finite, non-negative number.')
    return number


def _tempo(params: Mapping[str, Any]) -> Tempo | None:
    raw = params.get('tempo')
    if raw is None:
        return None
    if not isinstance(raw, dict):
        raise SidecarError('invalid_params', '"tempo" must be an object.')
    bpm = raw.get('bpm')
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not 20 <= float(bpm) <= 400:
        raise SidecarError('invalid_params', '"tempo.bpm" must be a number from 20 to 400.')
    beats = raw.get('beatsPerBar', 4)
    if isinstance(beats, bool) or not isinstance(beats, int) or not 1 <= beats <= 16:
        raise SidecarError('invalid_params', '"tempo.beatsPerBar" must be an integer from 1 to 16.')
    offset = _seconds(raw.get('offsetSeconds', 0.0), 'tempo.offsetSeconds')
    return Tempo(float(bpm), beats, offset)


def _directory(params: Mapping[str, Any], key: str) -> str:
    value = params.get(key)
    if not isinstance(value, str) or not value or not os.path.isabs(value):
        raise SidecarError('invalid_params', f'"{key}" must be an absolute folder path.')
    return value


def _text(params: Mapping[str, Any], key: str, default: str | None = None, limit: int = 4000) -> str:
    value = params.get(key, default)
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise SidecarError('invalid_params', f'"{key}" must be a non-empty string of at most {limit} characters.')
    return value


def parse_analyze(params: Mapping[str, Any]) -> AnalyzeRequest:
    path = _existing_file(params, 'path')
    bands = params.get('bands', True)
    if not isinstance(bands, bool):
        raise SidecarError('invalid_params', '"bands" must be a boolean.')
    raw_sections = params.get('sections', [])
    if raw_sections is None:
        raw_sections = []
    if not isinstance(raw_sections, list):
        raise SidecarError('invalid_params', '"sections" must be an array.')
    sections: list[Section] = []
    for index, raw in enumerate(raw_sections):
        if not isinstance(raw, dict):
            raise SidecarError('invalid_params', f'sections[{index}] must be an object.')
        section_id = raw.get('id')
        if not isinstance(section_id, str) or not section_id:
            raise SidecarError('invalid_params', f'sections[{index}].id must be a non-empty string.')
        start = _seconds(raw.get('start'), f'sections[{index}].start')
        end = _seconds(raw.get('end'), f'sections[{index}].end')
        if end <= start:
            raise SidecarError('invalid_params', f'sections[{index}].end must be greater than start.')
        sections.append(Section(section_id, start, end))
    return AnalyzeRequest(path=path, sections=tuple(sections), bands=bands, tempo=_tempo(params))


def parse_compare(params: Mapping[str, Any]) -> CompareRequest:
    return CompareRequest(path=_existing_file(params, 'path'), reference=_existing_file(params, 'reference'), tempo=_tempo(params))


def parse_separate(params: Mapping[str, Any]) -> SeparateRequest:
    model = _text(params, 'model', 'htdemucs', 64)
    if not model.replace('_', '').isalnum():
        raise SidecarError('invalid_params', '"model" must be a Demucs model name such as htdemucs.')
    return SeparateRequest(path=_existing_file(params, 'path'), out_dir=_directory(params, 'outDir'), model=model)


def parse_generate(params: Mapping[str, Any]) -> GenerateRequest:
    name = _text(params, 'name', None, 80)
    instrument = params.get('instrument')
    if isinstance(instrument, str):
        if not instrument.strip():
            raise SidecarError('invalid_params', '"instrument" must be a preset name or an instrument object.')
    elif not isinstance(instrument, dict):
        raise SidecarError('invalid_params', '"instrument" must be a preset name or an instrument object.')
    fx = params.get('fx', [])
    if fx is None:
        fx = []
    if not isinstance(fx, list) or not all(isinstance(item, dict) for item in fx):
        raise SidecarError('invalid_params', '"fx" must be an array of effect objects.')
    tail = _seconds(params.get('tailSeconds', 1.0), 'tailSeconds')
    if tail > 30:
        raise SidecarError('invalid_params', '"tailSeconds" must be at most 30.')
    bpm = params.get('bpm', 120.0)
    if isinstance(bpm, bool) or not isinstance(bpm, (int, float)) or not 20 <= float(bpm) <= 400:
        raise SidecarError('invalid_params', '"bpm" must be a number from 20 to 400.')
    normalize = params.get('normalize', True)
    if not isinstance(normalize, bool):
        raise SidecarError('invalid_params', '"normalize" must be a boolean.')
    return GenerateRequest(
        name=name.strip(),
        instrument=instrument,
        out_dir=_directory(params, 'outDir'),
        notes=_text(params, 'notes', '0 C4 1'),
        fx=tuple(fx),
        tail_seconds=tail,
        bpm=float(bpm),
        normalize=normalize,
    )
