import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDefaultProject, type DesktopAssetPayload } from '@reborn/studio-core'
import { packProjectDirectory, readProjectPath, unpackProject, writeProjectDirectory } from './project-dir'
import { SessionStore } from './session'
import { crc32, extractZip, readZipEntries, writeZip } from './zip'

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-desktop-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const bytes = (...values: number[]) => new Uint8Array(values).buffer
const asset = (id: string, data: ArrayBuffer, name = `${id}.wav`): DesktopAssetPayload => ({ id, kind: 'sample', name, mimeType: 'audio/wav', data })

describe('zip', () => {
  it('computes the standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  it('round-trips files and reports byte progress', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha')
    await writeFile(join(root, 'b.bin'), Buffer.from([1, 2, 3]))
    const progress: number[] = []
    const archive = join(root, 'out.zip')
    await writeZip(archive, [{ name: 'a.txt', file: join(root, 'a.txt') }, { name: 'nested/b.bin', file: join(root, 'b.bin') }], { onProgress: ({ completed }) => progress.push(completed) })
    expect((await readZipEntries(archive)).map((e) => e.name)).toEqual(['a.txt', 'nested/b.bin'])
    await extractZip(archive, join(root, 'x'))
    expect(await readFile(join(root, 'x', 'a.txt'), 'utf8')).toBe('alpha')
    expect([...(await readFile(join(root, 'x', 'nested', 'b.bin')))]).toEqual([1, 2, 3])
    expect(progress.at(-1)).toBe(8)
  })

  it('removes the partial file when cancelled', async () => {
    await writeFile(join(root, 'a.txt'), 'alpha')
    const controller = new AbortController()
    controller.abort()
    const archive = join(root, 'out.zip')
    await expect(writeZip(archive, [{ name: 'a.txt', file: join(root, 'a.txt') }], { signal: controller.signal })).rejects.toThrow(/cancelled/)
    expect(existsSync(archive) || existsSync(`${archive}.partial`)).toBe(false)
  })

  it('refuses entries that would escape the destination', async () => {
    await writeFile(join(root, 'evil.txt'), 'x')
    const archive = join(root, 'evil.zip')
    await writeZip(archive, [{ name: '../escaped.txt', file: join(root, 'evil.txt') }])
    await expect(extractZip(archive, join(root, 'dest'))).rejects.toThrow(/outside the project/)
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false)
  })
})

describe('project directories', () => {
  it('saves, reopens, and skips rewriting unchanged audio', async () => {
    const project = createDefaultProject()
    project.name = 'DIR TEST'
    const directory = join(root, 'Dir Test.reborn')
    const first = await writeProjectDirectory(directory, project, [asset('s1', bytes(1, 2, 3))], '2.0.0-test')
    expect(first).toMatchObject({ writtenAssets: 1, reusedAssets: 0 })
    const before = (await stat(join(directory, 'assets', 's1.wav'))).mtimeMs

    const second = await writeProjectDirectory(directory, project, [asset('s1', bytes(1, 2, 3))], '2.0.0-test')
    expect(second).toMatchObject({ writtenAssets: 0, reusedAssets: 1 })
    expect((await stat(join(directory, 'assets', 's1.wav'))).mtimeMs).toBe(before)

    const opened = await readProjectPath(directory)
    expect(opened.document.project.name).toBe('DIR TEST')
    expect(opened.assets.map((a) => [a.id, [...new Uint8Array(a.data)]])).toEqual([['s1', [1, 2, 3]]])
    expect(opened.missing).toEqual([])
  })

  it('keeps audio that is no longer referenced', async () => {
    const directory = join(root, 'Keep.reborn')
    await writeProjectDirectory(directory, createDefaultProject(), [asset('old', bytes(9))], 'test')
    await writeProjectDirectory(directory, createDefaultProject(), [], 'test')
    expect(existsSync(join(directory, 'assets', 'old.wav'))).toBe(true)
  })

  it('reports damaged or missing audio instead of loading it', async () => {
    const directory = join(root, 'Damaged.reborn')
    await writeProjectDirectory(directory, createDefaultProject(), [asset('a', bytes(1)), asset('b', bytes(2))], 'test')
    await writeFile(join(directory, 'assets', 'a.wav'), Buffer.from([7]))
    await rm(join(directory, 'assets', 'b.wav'))
    const opened = await readProjectPath(directory)
    expect(opened.assets).toEqual([])
    expect(opened.missing.sort()).toEqual(['a.wav', 'b.wav'])
  })

  it('opens a raw v1 export file', async () => {
    const file = join(root, 'old.rb338.json')
    await writeFile(file, JSON.stringify(createDefaultProject()))
    const opened = await readProjectPath(file)
    expect(opened.path).toBe(file)
    expect(opened.document.app.version).toBe('1.x')
  })

  it('packs and unpacks next to the archive without overwriting', async () => {
    const directory = join(root, 'Pack Me.reborn')
    await writeProjectDirectory(directory, createDefaultProject(), [asset('p', bytes(4, 5))], 'test')
    const archive = join(root, 'Pack Me.rebornpack')
    await packProjectDirectory(directory, archive)
    const entries = (await readZipEntries(archive)).map((e) => e.name)
    expect(entries[0]).toBe('project.json')
    expect(entries).toContain('assets/p.wav')
    const unpacked = await unpackProject(archive)
    expect(unpacked).toBe(join(root, 'Pack Me 2.reborn'))
    expect((await readProjectPath(unpacked)).assets).toHaveLength(1)
  })

  it('refuses to pack a folder that was never saved', async () => {
    await mkdir(join(root, 'Empty.reborn'))
    await expect(packProjectDirectory(join(root, 'Empty.reborn'), join(root, 'e.rebornpack'))).rejects.toThrow(/Save the project/)
  })
})

describe('session store', () => {
  it('offers recovery only after an unclean shutdown', async () => {
    const first = new SessionStore(root)
    await first.start()
    await first.writeRecovery(createDefaultProject(), 'C:/beats/a.reborn')
    // No finish(): the process "crashed".
    const second = new SessionStore(root)
    await second.start()
    const recovered = await second.takeRecovery()
    expect(recovered?.path).toBe('C:/beats/a.reborn')
    expect(await second.takeRecovery()).toBeNull()
    await second.finish()

    const third = new SessionStore(root)
    await third.start()
    expect(await third.takeRecovery()).toBeNull()
    await third.finish()
  })

  it('keeps recent projects unique, newest first, and drops missing paths', async () => {
    const store = new SessionStore(root)
    await store.start()
    const a = join(root, 'A.reborn')
    const b = join(root, 'B.reborn')
    await mkdir(a)
    await mkdir(b)
    await store.addRecent(a, 'A')
    await store.addRecent(b, 'B')
    await store.addRecent(a, 'A again')
    expect((await store.listRecent()).map((r) => r.name)).toEqual(['A again', 'B'])
    await rm(b, { recursive: true })
    expect((await store.listRecent()).map((r) => r.name)).toEqual(['A again'])
    await store.finish()
  })
})
