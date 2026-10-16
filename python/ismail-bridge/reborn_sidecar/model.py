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
class AnalyzeRequest:
    path: str
    sections: tuple[Section, ...] = ()
    bands: bool = True


@dataclass(frozen=True)
class CompareRequest:
    path: str
    reference: str


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
    return AnalyzeRequest(path=path, sections=tuple(sections), bands=bands)


def parse_compare(params: Mapping[str, Any]) -> CompareRequest:
    return CompareRequest(path=_existing_file(params, 'path'), reference=_existing_file(params, 'reference'))
