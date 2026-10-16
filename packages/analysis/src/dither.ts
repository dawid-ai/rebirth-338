import { channelLength, createRandom, type Channels } from './util'

export type WavBitDepth = 16 | 24

export interface WavEncodeOptions {
  /** Adds TPDF dither before 16-bit quantization; 24-bit output is never dithered. */
  dither?: boolean
  /** PRNG seed, so the same input and seed always produce identical bytes. Defaults to 1. */
  seed?: number
}

export interface WavHeader {
  channels: number
  sampleRate: number
  bitDepth: number
  /** Audio format tag; 1 is integer PCM. */
  format: number
  /** Sample frames in the data chunk. */
  frames: number
  /** Byte offset of the first sample. */
  dataOffset: number
  dataBytes: number
}

const HEADER_BYTES = 44

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
}

/** Interleaved little-endian PCM WAV with a canonical 44-byte header. */
export function encodeWav(channels: Channels, sampleRate: number, bitDepth: WavBitDepth, options: WavEncodeOptions = {}): ArrayBuffer {
  if (channels.length === 0) throw new Error('encodeWav: at least one channel is required')
  const frames = channelLength(channels)
  const bytesPerSample = bitDepth / 8
  const blockAlign = channels.length * bytesPerSample
  const dataBytes = frames * blockAlign
  const buffer = new ArrayBuffer(HEADER_BYTES + dataBytes)
  const view = new DataView(buffer)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  const scale = bitDepth === 16 ? 32768 : 8388608
  const min = -scale
  const max = scale - 1
  const random = options.dither && bitDepth === 16 ? createRandom(options.seed ?? 1) : null
  const bytes = new Uint8Array(buffer)
  let offset = HEADER_BYTES
  for (let frame = 0; frame < frames; frame += 1) {
    for (const channel of channels) {
      const sample = frame < channel.length ? channel[frame] : 0
      let scaled = Number.isFinite(sample) ? sample * scale : 0
      // TPDF dither: the difference of two uniform values spans +-1 LSB with a triangular density,
      // which decorrelates quantization error from the signal.
      if (random) scaled += random() - random()
      const value = Math.min(max, Math.max(min, Math.round(scaled)))
      bytes[offset] = value & 0xff
      bytes[offset + 1] = (value >> 8) & 0xff
      if (bitDepth === 24) bytes[offset + 2] = (value >> 16) & 0xff
      offset += bytesPerSample
    }
  }
  return buffer
}

/** Walks the RIFF chunks and returns the format and data location. */
export function decodeWavHeader(buffer: ArrayBuffer): WavHeader {
  const view = new DataView(buffer)
  const ascii = (offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
  if (buffer.byteLength < 12 || ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') throw new Error('decodeWavHeader: not a RIFF/WAVE file')
  let format = 0
  let channels = 0
  let sampleRate = 0
  let bitDepth = 0
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const id = ascii(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ') {
      format = view.getUint16(body, true)
      channels = view.getUint16(body + 2, true)
      sampleRate = view.getUint32(body + 4, true)
      bitDepth = view.getUint16(body + 14, true)
    } else if (id === 'data') {
      if (channels === 0) throw new Error('decodeWavHeader: data chunk precedes fmt chunk')
      const dataBytes = Math.min(size, buffer.byteLength - body)
      const frames = Math.floor(dataBytes / (channels * (bitDepth / 8)))
      return { channels, sampleRate, bitDepth, format, frames, dataOffset: body, dataBytes }
    }
    // Chunks are padded to an even size.
    offset = body + size + (size % 2)
  }
  throw new Error('decodeWavHeader: no data chunk')
}

/** Decodes 16- or 24-bit integer PCM into planar float channels. */
export function decodeWav(buffer: ArrayBuffer): { sampleRate: number; channels: Float32Array[] } {
  const header = decodeWavHeader(buffer)
  if (header.format !== 1 || (header.bitDepth !== 16 && header.bitDepth !== 24)) {
    throw new Error(`decodeWav: unsupported format ${header.format} at ${header.bitDepth} bits`)
  }
  const bytes = new Uint8Array(buffer)
  const bytesPerSample = header.bitDepth / 8
  const scale = header.bitDepth === 16 ? 32768 : 8388608
  const channels = Array.from({ length: header.channels }, () => new Float32Array(header.frames))
  let offset = header.dataOffset
  for (let frame = 0; frame < header.frames; frame += 1) {
    for (const channel of channels) {
      let value = bytes[offset] | (bytes[offset + 1] << 8)
      if (bytesPerSample === 3) value |= bytes[offset + 2] << 16
      // Sign-extend from the sample's bit depth.
      const shift = 32 - header.bitDepth
      channel[frame] = ((value << shift) >> shift) / scale
      offset += bytesPerSample
    }
  }
  return { sampleRate: header.sampleRate, channels }
}
