import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'
import { once } from 'node:events'

// Store-only ZIP (no compression) for Pack Project. Audio is already
// compressed, so deflate would cost time for little gain, and a stored
// archive needs no third-party dependency.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(data: Uint8Array, previous = 0): number {
  let crc = ~previous >>> 0
  for (let i = 0; i < data.length; i += 1) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  return ~crc >>> 0
}

export interface ZipSource {
  /** Path inside the archive, with forward slashes. */
  name: string
  file: string
}

export interface ZipProgress {
  completed: number
  total: number
}

interface CentralEntry {
  name: Buffer
  crc: number
  size: number
  offset: number
}

const MAX_STORED = 0xffffffff

async function fileCrc(file: string, signal?: AbortSignal): Promise<number> {
  let crc = 0
  for await (const chunk of createReadStream(file)) {
    if (signal?.aborted) throw new DOMException('Packing was cancelled.', 'AbortError')
    crc = crc32(chunk as Buffer, crc)
  }
  return crc
}

/** Writes `sources` to `output` atomically. Progress counts bytes. */
export async function writeZip(output: string, sources: ZipSource[], options: { signal?: AbortSignal; onProgress?: (progress: ZipProgress) => void } = {}): Promise<void> {
  const sizes = await Promise.all(sources.map(async (source) => (await stat(source.file)).size))
  if (sizes.some((size) => size >= MAX_STORED)) throw new Error('A file is too large for this archive format (4 GB limit).')
  const total = sizes.reduce((sum, size) => sum + size, 0)
  const temporary = `${output}.partial`
  const stream = createWriteStream(temporary)
  const central: CentralEntry[] = []
  let offset = 0
  let completed = 0
  const write = async (buffer: Buffer) => {
    if (!stream.write(buffer)) await once(stream, 'drain')
    offset += buffer.length
  }
  try {
    for (let index = 0; index < sources.length; index += 1) {
      const { name, file } = sources[index]
      const size = sizes[index]
      const crc = await fileCrc(file, options.signal)
      const nameBytes = Buffer.from(name, 'utf8')
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(0x0800, 6)
      header.writeUInt16LE(0, 8)
      header.writeUInt32LE(crc, 14)
      header.writeUInt32LE(size, 18)
      header.writeUInt32LE(size, 22)
      header.writeUInt16LE(nameBytes.length, 26)
      central.push({ name: nameBytes, crc, size, offset })
      await write(header)
      await write(nameBytes)
      for await (const chunk of createReadStream(file)) {
        if (options.signal?.aborted) throw new DOMException('Packing was cancelled.', 'AbortError')
        await write(chunk as Buffer)
        completed += (chunk as Buffer).length
        options.onProgress?.({ completed, total })
      }
    }
    const centralStart = offset
    for (const entry of central) {
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50, 0)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt16LE(0x0800, 8)
      record.writeUInt16LE(0, 10)
      record.writeUInt32LE(entry.crc, 16)
      record.writeUInt32LE(entry.size, 20)
      record.writeUInt32LE(entry.size, 24)
      record.writeUInt16LE(entry.name.length, 28)
      record.writeUInt32LE(entry.offset, 42)
      await write(record)
      await write(entry.name)
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(offset - centralStart, 12)
    end.writeUInt32LE(centralStart, 16)
    await write(end)
    stream.end()
    await once(stream, 'finish')
    await rename(temporary, output)
  } catch (error) {
    // Windows keeps the file locked until the stream has closed.
    if (!stream.closed) {
      stream.destroy()
      await once(stream, 'close').catch(() => undefined)
    }
    await rm(temporary, { force: true, maxRetries: 5, retryDelay: 50 })
    throw error
  }
}

export interface ZipEntry {
  name: string
  offset: number
  size: number
  crc: number
}

/** Lists the entries of a stored ZIP written by `writeZip`. */
export async function readZipEntries(archive: string): Promise<ZipEntry[]> {
  const handle = await open(archive, 'r')
  try {
    const { size } = await handle.stat()
    const tailLength = Math.min(size, 22 + 0xffff)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, size - tailLength)
    const endAt = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (endAt < 0) throw new Error('This file is not a packed RE:BORN project.')
    const count = tail.readUInt16LE(endAt + 10)
    const centralSize = tail.readUInt32LE(endAt + 12)
    const centralStart = tail.readUInt32LE(endAt + 16)
    const central = Buffer.alloc(centralSize)
    await handle.read(central, 0, centralSize, centralStart)
    const entries: ZipEntry[] = []
    let cursor = 0
    for (let i = 0; i < count; i += 1) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) throw new Error('The packed project is damaged.')
      if (central.readUInt16LE(cursor + 10) !== 0) throw new Error('The packed project uses compression this version cannot read.')
      const crc = central.readUInt32LE(cursor + 16)
      const entrySize = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const localOffset = central.readUInt32LE(cursor + 42)
      const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength)
      const local = Buffer.alloc(30)
      await handle.read(local, 0, 30, localOffset)
      const dataOffset = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
      entries.push({ name, offset: dataOffset, size: entrySize, crc })
      cursor += 46 + nameLength + extraLength + commentLength
    }
    return entries
  } finally {
    await handle.close()
  }
}

/** Extracts a stored ZIP into `destination`, refusing paths that escape it. */
export async function extractZip(archive: string, destination: string): Promise<void> {
  const entries = await readZipEntries(archive)
  const data = await readFile(archive)
  const root = normalize(destination + sep)
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue
    const target = normalize(join(destination, entry.name))
    if (!target.startsWith(root)) throw new Error(`Refusing to extract ${entry.name} outside the project.`)
    const bytes = data.subarray(entry.offset, entry.offset + entry.size)
    if (crc32(bytes) !== entry.crc) throw new Error(`${entry.name} is damaged in the packed project.`)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
}
