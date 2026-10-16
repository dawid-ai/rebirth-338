import { seeded } from './curves'

/** Encodes PCM WAV. 16-bit output gets seeded TPDF dither unless disabled. */
export function encodeWav(channels: readonly Float32Array[], sampleRate: number, bitDepth: 16 | 24 = 16, options: { dither?: boolean; seed?: number } = {}): ArrayBuffer {
  const count = Math.max(1, Math.min(2, channels.length))
  const frames = Math.min(...channels.slice(0, count).map((c) => c.length))
  const bytes = bitDepth / 8
  const output = new ArrayBuffer(44 + frames * count * bytes)
  const view = new DataView(output)
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, output.byteLength - 8, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, count, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * count * bytes, true)
  view.setUint16(32, count * bytes, true)
  view.setUint16(34, bitDepth, true)
  text(36, 'data')
  view.setUint32(40, frames * count * bytes, true)
  const dither = bitDepth === 16 && options.dither !== false
  const random = seeded(options.seed ?? 1)
  const full = bitDepth === 16 ? 0x7fff : 0x7fffff
  let offset = 44
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      let sample = channels[channel][frame]
      if (dither) sample += (random() + random() - 1) / full
      const value = Math.max(-full - 1, Math.min(full, Math.round(sample * full)))
      if (bitDepth === 16) view.setInt16(offset, value, true)
      else {
        view.setUint8(offset, value & 0xff)
        view.setUint8(offset + 1, (value >> 8) & 0xff)
        view.setUint8(offset + 2, (value >> 16) & 0xff)
      }
      offset += bytes
    }
  }
  return output
}
