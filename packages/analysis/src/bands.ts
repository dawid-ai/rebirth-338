import { SpectrumAnalyzer } from './fft'
import { channelLength, frameStarts, powerToDb, type Channels } from './util'

export type BandName = 'sub' | 'bass' | 'lowMid' | 'mid' | 'harsh' | 'air'

/** Band edges in hertz, lower edge inclusive. */
export const BANDS: Readonly<Record<BandName, readonly [number, number]>> = {
  sub: [20, 60],
  bass: [60, 250],
  lowMid: [250, 500],
  mid: [500, 2000],
  harsh: [2000, 6000],
  air: [6000, 20000],
}

export const BAND_NAMES: readonly BandName[] = ['sub', 'bass', 'lowMid', 'mid', 'harsh', 'air']

export interface BandEnergy {
  /** Average power in the band as dBFS RMS; a full-scale sine inside the band reads -3.01. */
  db: number
  /** Fraction of the 20 Hz to 20 kHz power that falls in this band, 0..1. */
  share: number
}

export type BandEnergies = Record<BandName, BandEnergy>

const BAND_FFT_SIZE = 4096
const MIN_BAND_FFT_SIZE = 256
// Long signals are sampled with at most this many evenly spaced frames per channel,
// which keeps a four-minute render cheap while staying representative.
const MAX_BAND_FRAMES = 64

function frameSizeFor(length: number): number {
  let size = BAND_FFT_SIZE
  while (size > MIN_BAND_FFT_SIZE && size > length) size >>= 1
  return size
}

/** Average spectral power per band from Hann-windowed FFT frames of every channel. */
export function bandEnergies(channels: Channels, sampleRate: number): BandEnergies {
  const powers: Record<BandName, number> = { sub: 0, bass: 0, lowMid: 0, mid: 0, harsh: 0, air: 0 }
  let frameTotal = 0
  const length = channelLength(channels)
  if (length > 0) {
    const analyzer = new SpectrumAnalyzer(frameSizeFor(length))
    const spectrum = new Float64Array(analyzer.binCount)
    const bandOfBin = new Int8Array(analyzer.binCount).fill(-1)
    for (let k = 1; k < analyzer.binCount; k += 1) {
      const frequency = analyzer.binFrequency(k, sampleRate)
      bandOfBin[k] = BAND_NAMES.findIndex((name) => frequency >= BANDS[name][0] && frequency < BANDS[name][1])
    }
    const sums = new Float64Array(BAND_NAMES.length)
    for (const channel of channels) {
      for (const start of frameStarts(channel.length, analyzer.size, MAX_BAND_FRAMES)) {
        analyzer.power(channel, start, spectrum)
        for (let k = 1; k < analyzer.binCount; k += 1) {
          const band = bandOfBin[k]
          if (band >= 0) sums[band] += spectrum[k]
        }
        frameTotal += 1
      }
    }
    BAND_NAMES.forEach((name, index) => {
      powers[name] = frameTotal > 0 ? sums[index] / frameTotal : 0
    })
  }
  const total = BAND_NAMES.reduce((sum, name) => sum + powers[name], 0)
  const energy = (name: BandName): BandEnergy => ({
    db: powerToDb(powers[name]),
    share: total > 0 ? powers[name] / total : 0,
  })
  return {
    sub: energy('sub'),
    bass: energy('bass'),
    lowMid: energy('lowMid'),
    mid: energy('mid'),
    harsh: energy('harsh'),
    air: energy('air'),
  }
}
