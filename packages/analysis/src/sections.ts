import { bandEnergies, type BandEnergies } from './bands'
import { integratedLoudness, levelSummary, truePeak } from './levels'
import { clamp, sliceChannels, type Channels } from './util'

/** True peak above this level in dBTP is reported as `clipping`. */
export const CLIPPING_TRUE_PEAK_DBTP = -0.1
/** `sub_buildup` fires when the 20-60 Hz share exceeds the 60-250 Hz share by more than this ratio. */
export const SUB_TO_BASS_MAX_RATIO = 1.5
/** Minimum 20-60 Hz share before `sub_buildup` can fire, so a small low end never triggers it. */
export const SUB_BUILDUP_MIN_SHARE = 0.2
/** `harshness` fires when 2-6 kHz holds more than this share of the spectrum. */
export const HARSH_MAX_SHARE = 0.2
/** `low_mid_mud` fires when 250-500 Hz holds more than this share of the spectrum. */
export const LOW_MID_MAX_SHARE = 0.25
/** `phase` fires when stereo correlation drops below this value. */
export const PHASE_MIN_CORRELATION = 0
/** `dc_offset` fires when any channel's mean exceeds this magnitude (linear, 0.01 is -40 dBFS). */
export const DC_OFFSET_MAX = 0.01
/** Spectral and phase warnings are suppressed for sections quieter than this RMS level in dBFS. */
export const WARNING_MIN_RMS_DB = -60

export type WarningCode = 'clipping' | 'sub_buildup' | 'harshness' | 'low_mid_mud' | 'phase' | 'dc_offset'

export interface SectionWarning {
  code: WarningCode
  message: string
  /** The measured value that crossed the threshold. */
  value: number
  threshold: number
}

export interface AnalysisRange {
  id: string
  /** Start in seconds. */
  start: number
  /** End in seconds; clamped to the signal length. */
  end: number
}

export interface RangeAnalysis {
  id: string
  start: number
  end: number
  peakDb: number
  truePeakDb: number
  rmsDb: number
  crestDb: number
  loudnessLufs: number
  bands: BandEnergies
  /** Stereo correlation, -1..1; mono input reads 1. */
  correlation: number
  /** Left minus right level in dB; mono input reads 0. */
  balanceDb: number
  /** Per-channel mean, linear. */
  dcOffset: number[]
  warnings: SectionWarning[]
}

const round = (value: number, digits = 2) => Number(value.toFixed(digits))

/** Level, loudness, spectral, and stereo diagnostics for each time range. */
export function analyzeRanges(channels: Channels, sampleRate: number, ranges: readonly AnalysisRange[]): RangeAnalysis[] {
  return ranges.map((range) => analyzeRange(channels, sampleRate, range))
}

function analyzeRange(channels: Channels, sampleRate: number, range: AnalysisRange): RangeAnalysis {
  const startSample = Math.round(Math.max(0, range.start) * sampleRate)
  const endSample = Math.max(startSample, Math.round(Math.max(0, range.end) * sampleRate))
  const section = sliceChannels(channels, startSample, endSample)
  const levels = levelSummary(section)
  const measured = {
    id: range.id,
    start: range.start,
    end: range.end,
    peakDb: levels.peakDb,
    truePeakDb: truePeak(section, sampleRate),
    rmsDb: levels.rmsDb,
    crestDb: levels.crestDb,
    loudnessLufs: integratedLoudness(section, sampleRate),
    bands: bandEnergies(section, sampleRate),
    correlation: levels.correlation,
    balanceDb: levels.balanceDb,
    dcOffset: levels.dcOffset,
  }
  return { ...measured, warnings: sectionWarnings(measured) }
}

/** Applies the documented thresholds to a finished range analysis. */
export function sectionWarnings(analysis: Omit<RangeAnalysis, 'warnings'>): SectionWarning[] {
  const warnings: SectionWarning[] = []
  const { bands } = analysis
  if (analysis.truePeakDb > CLIPPING_TRUE_PEAK_DBTP) {
    warnings.push({
      code: 'clipping',
      message: `True peak reaches ${round(analysis.truePeakDb)} dBTP, above ${CLIPPING_TRUE_PEAK_DBTP} dBTP.`,
      value: analysis.truePeakDb,
      threshold: CLIPPING_TRUE_PEAK_DBTP,
    })
  }
  const dc = analysis.dcOffset.reduce((max, value) => (Math.abs(value) > Math.abs(max) ? value : max), 0)
  if (Math.abs(dc) > DC_OFFSET_MAX) {
    warnings.push({
      code: 'dc_offset',
      message: `DC offset of ${round(dc, 4)} exceeds ${DC_OFFSET_MAX}.`,
      value: dc,
      threshold: DC_OFFSET_MAX,
    })
  }
  if (analysis.rmsDb < WARNING_MIN_RMS_DB) return warnings
  const subRatio = bands.sub.share / Math.max(bands.bass.share, 1e-9)
  if (bands.sub.share >= SUB_BUILDUP_MIN_SHARE && subRatio > SUB_TO_BASS_MAX_RATIO) {
    warnings.push({
      code: 'sub_buildup',
      message: `Sub (20-60 Hz) carries ${round(bands.sub.share * 100, 1)} % of the energy, ${round(clamp(subRatio, 0, 999), 1)}x the bass band.`,
      value: subRatio,
      threshold: SUB_TO_BASS_MAX_RATIO,
    })
  }
  if (bands.harsh.share > HARSH_MAX_SHARE) {
    warnings.push({
      code: 'harshness',
      message: `2-6 kHz carries ${round(bands.harsh.share * 100, 1)} % of the energy.`,
      value: bands.harsh.share,
      threshold: HARSH_MAX_SHARE,
    })
  }
  if (bands.lowMid.share > LOW_MID_MAX_SHARE) {
    warnings.push({
      code: 'low_mid_mud',
      message: `250-500 Hz carries ${round(bands.lowMid.share * 100, 1)} % of the energy.`,
      value: bands.lowMid.share,
      threshold: LOW_MID_MAX_SHARE,
    })
  }
  if (analysis.correlation < PHASE_MIN_CORRELATION) {
    warnings.push({
      code: 'phase',
      message: `Stereo correlation is ${round(analysis.correlation)}; the section partially cancels in mono.`,
      value: analysis.correlation,
      threshold: PHASE_MIN_CORRELATION,
    })
  }
  return warnings
}
