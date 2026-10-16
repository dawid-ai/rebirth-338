import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ISMAIL_ARCHIVE, ensureEnvironment, findPython, installIsmail, SidecarError, SidecarSupervisor, venvPython, type CommandRunner, type SidecarOptions, type SidecarStatus } from './sidecar'

const bridgeDir = fileURLToPath(new URL('../../../python/ismail-bridge', import.meta.url))
const python = findPython()
const hasNumpy = python !== null && spawnSync(python.executable, ['-c', 'import numpy'], { windowsHide: true }).status === 0
const TEST_TIMEOUT = 30_000

// A stand-in sidecar for supervision tests: answers hello, never answers
// `slow`, blocks forever on `freeze`, and exits on `die`.
const FAKE_SIDECAR = `
import json, os, sys, time
if len(sys.argv) > 1 and sys.argv[1] == 'die-on-start':
    sys.exit(2)
def reply(request_id, result):
    print(json.dumps({'id': request_id, 'result': result}), flush=True)
for line in sys.stdin:
    message = json.loads(line)
    request_id, method = message['id'], message['method']
    if method == 'hello':
        reply(request_id, {'protocol': 2, 'backend': 'fake', 'pid': os.getpid()})
    elif method == 'slow':
        pass
    elif method == 'freeze':
        time.sleep(3600)
    elif method == 'die':
        sys.exit(3)
    elif method == 'cancel':
        reply(request_id, {'target': message['params']['target'], 'cancelled': False})
    elif method == 'shutdown':
        reply(request_id, {'ok': True})
        break
`

function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) pcm[i] = Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767)
  const data = Buffer.from(pcm.buffer)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  return Buffer.concat([header, data])
}

function sine(frequency: number, seconds: number, amplitude: number, sampleRate = 48_000): Float32Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < samples.length; i++) samples[i] = amplitude * Math.sin((2 * Math.PI * frequency * i) / sampleRate)
  return samples
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition.')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function rejection(promise: Promise<unknown>): Promise<SidecarError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SidecarError)
    return error as SidecarError
  }
  throw new Error('Expected the promise to reject.')
}

let root: string
const supervisors: SidecarSupervisor[] = []
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reborn-sidecar-'))
})
afterEach(async () => {
  await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.stop()))
  await rm(root, { recursive: true, force: true })
})

function supervise(options: Partial<SidecarOptions> = {}): { supervisor: SidecarSupervisor; statuses: SidecarStatus[]; logs: string[] } {
  const statuses: SidecarStatus[] = []
  const logs: string[] = []
  const supervisor = new SidecarSupervisor({
    python: python?.executable ?? 'python',
    cwd: bridgeDir,
    env: { REBORN_SIDECAR_BACKEND: 'builtin' },
    onLog: (line) => logs.push(line),
    onStatus: (status) => statuses.push(status),
    restartBackoffMs: 20,
    ...options,
  })
  supervisors.push(supervisor)
  return { supervisor, statuses, logs }
}

describe.skipIf(!hasNumpy)('SidecarSupervisor with the real sidecar', () => {
  it('completes the hello handshake', async () => {
    const { supervisor, statuses } = supervise()
    await supervisor.start()
    expect(supervisor.status).toBe('ready')
    expect(statuses).toEqual(['starting', 'ready'])
    const hello = await supervisor.request<{ protocol: number; backend: string; capabilities: string[] }>('hello')
    expect(hello.protocol).toBe(2)
    expect(hello.backend).toBe('builtin')
    expect(hello.capabilities).toContain('analyze')
  }, TEST_TIMEOUT)

  it('analyzes a generated WAV file and reports progress', async () => {
    const path = join(root, 'tone.wav')
    await writeFile(path, encodeWav(sine(1000, 2, 0.5), 48_000))
    const { supervisor } = supervise()
    await supervisor.start()
    const progress: number[] = []
    const result = await supervisor.request<{ metrics: { peakDbfs: number; rmsDbfs: number; integratedLufs: number } }>('analyze', { path }, { onProgress: ({ completed }) => progress.push(completed) })
    expect(result.metrics.peakDbfs).toBeCloseTo(-6.02, 1)
    expect(result.metrics.rmsDbfs).toBeCloseTo(-9.03, 1)
    expect(Math.abs(result.metrics.integratedLufs - -9.03)).toBeLessThan(0.5)
    expect(progress.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT)

  it('maps sidecar errors to typed codes', async () => {
    const { supervisor } = supervise()
    await supervisor.start()
    expect((await rejection(supervisor.request('analyze', { path: join(root, 'missing.wav') }))).code).toBe('not_found')
    expect((await rejection(supervisor.request('analyze', {}))).code).toBe('invalid_params')
  }, TEST_TIMEOUT)

  it('cancels a running job through an AbortSignal', async () => {
    const path = join(root, 'long.wav')
    await writeFile(path, encodeWav(sine(80, 60, 0.5), 48_000))
    const { supervisor, logs } = supervise({ env: { REBORN_SIDECAR_BACKEND: 'builtin', REBORN_SIDECAR_THROTTLE_MS: '25' } })
    await supervisor.start()
    const controller = new AbortController()
    const pending = supervisor.request('analyze', { path }, { signal: controller.signal, onProgress: () => controller.abort() })
    expect((await rejection(pending)).code).toBe('cancelled')
    const pid = supervisor.pid
    const hello = await supervisor.request<{ backend: string }>('hello')
    expect(hello.backend).toBe('builtin')
    expect(supervisor.pid).toBe(pid)
    expect(logs.some((line) => line.includes('Traceback'))).toBe(false)
  }, TEST_TIMEOUT)
})

describe.skipIf(!python)('SidecarSupervisor supervision', () => {
  let fakeDir: string
  let fake: string
  beforeAll(async () => {
    fakeDir = await mkdtemp(join(tmpdir(), 'reborn-fake-sidecar-'))
    fake = join(fakeDir, 'fake_sidecar.py')
    writeFileSync(fake, FAKE_SIDECAR)
  })
  afterAll(async () => {
    await rm(fakeDir, { recursive: true, force: true })
  })

  it('times out a request without killing a responsive process', async () => {
    const { supervisor } = supervise({ args: [fake], pingTimeoutMs: 2000 })
    await supervisor.start()
    const pid = supervisor.pid
    const error = await rejection(supervisor.request('slow', {}, { timeoutMs: 200 }))
    expect(error.code).toBe('timeout')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(supervisor.status).toBe('ready')
    expect(supervisor.pid).toBe(pid)
    expect(await supervisor.request('hello')).toMatchObject({ backend: 'fake' })
  }, TEST_TIMEOUT)

  it('restarts a process that stops answering hello pings', async () => {
    const { supervisor, statuses } = supervise({ args: [fake], pingTimeoutMs: 300 })
    await supervisor.start()
    const pid = supervisor.pid
    expect((await rejection(supervisor.request('freeze', {}, { timeoutMs: 200 }))).code).toBe('timeout')
    await waitFor(() => statuses.includes('crashed') && supervisor.status === 'ready')
    expect(supervisor.pid).not.toBe(pid)
  }, TEST_TIMEOUT)

  it('rejects in-flight requests when the process crashes, then restarts it', async () => {
    const { supervisor, statuses } = supervise({ args: [fake] })
    await supervisor.start()
    const pid = supervisor.pid
    const slow = rejection(supervisor.request('slow', {}, { timeoutMs: 10_000 }))
    const error = await rejection(supervisor.request('die'))
    expect(error.code).toBe('crashed')
    expect((await slow).code).toBe('crashed')
    expect(statuses).toContain('crashed')
    await waitFor(() => supervisor.status === 'ready')
    expect(supervisor.pid).not.toBe(pid)
    expect(await supervisor.request('hello')).toMatchObject({ backend: 'fake' })
  }, TEST_TIMEOUT)

  it('queues requests sent while a restart is pending', async () => {
    const { supervisor } = supervise({ args: [fake], restartBackoffMs: 200 })
    await supervisor.start()
    await rejection(supervisor.request('die'))
    expect(supervisor.status).toBe('crashed')
    expect(await supervisor.request('hello', {}, { timeoutMs: 10_000 })).toMatchObject({ backend: 'fake' })
  }, TEST_TIMEOUT)

  it('becomes unavailable after too many restarts', async () => {
    const { supervisor, statuses } = supervise({ args: [fake, 'die-on-start'], maxRestarts: 2, restartBackoffMs: 10 })
    expect((await rejection(supervisor.start())).code).toBe('unavailable')
    expect(supervisor.status).toBe('unavailable')
    expect(statuses.filter((status) => status === 'starting')).toHaveLength(3)
    expect((await rejection(supervisor.request('hello'))).code).toBe('unavailable')
  }, TEST_TIMEOUT)

  it('rejects requests cleanly after stop()', async () => {
    const { supervisor, statuses } = supervise({ args: [fake] })
    await supervisor.start()
    const inFlight = rejection(supervisor.request('slow', {}, { timeoutMs: 10_000 }))
    await supervisor.stop()
    expect((await inFlight).code).toBe('stopped')
    expect(supervisor.status).toBe('stopped')
    expect(statuses.at(-1)).toBe('stopped')
    expect((await rejection(supervisor.request('hello'))).code).toBe('stopped')
    await supervisor.stop()
  }, TEST_TIMEOUT)
})

describe('SidecarSupervisor without Python', () => {
  it('rejects requests before start()', async () => {
    const { supervisor } = supervise()
    expect((await rejection(supervisor.request('hello'))).code).toBe('stopped')
  })

  it('reports a missing executable as unavailable', async () => {
    const { supervisor } = supervise({ python: join(root, 'no-such-python.exe') })
    expect((await rejection(supervisor.start())).code).toBe('unavailable')
    expect(supervisor.status).toBe('unavailable')
  }, TEST_TIMEOUT)
})

describe('findPython', () => {
  it('prefers REBORN_PYTHON and resolves the interpreter path', () => {
    const calls: string[] = []
    const found = findPython({ REBORN_PYTHON: 'C:/custom/python.exe' }, (command, args) => {
      calls.push(`${command} ${args.join(' ')}`)
      if (args.includes('--version')) return { status: 0, stdout: 'Python 3.11.9\n', stderr: '' }
      return { status: 0, stdout: 'C:\\custom\\python.exe\n', stderr: '' }
    })
    expect(found).toEqual({ executable: 'C:\\custom\\python.exe', version: '3.11.9' })
    expect(calls[0]).toBe('C:/custom/python.exe --version')
  })

  it('falls through launchers in order and returns null when none work', () => {
    const tried: string[] = []
    const none = findPython({}, (command, args) => {
      tried.push([command, ...args].join(' '))
      return { status: null, stdout: '', stderr: '', error: new Error('ENOENT') }
    })
    expect(none).toBeNull()
    expect(tried).toEqual(['py -3 --version', 'python --version', 'python3 --version'])

    const python2Only = findPython({}, (command, args) => {
      if (args.includes('-c')) return { status: 1, stdout: '', stderr: 'no sys' }
      return command === 'python3' ? { status: 0, stdout: 'Python 3.12.1', stderr: '' } : { status: 0, stdout: '', stderr: 'Python 2.7.18' }
    })
    expect(python2Only).toEqual({ executable: 'python3', version: '3.12.1' })
  })
})

describe('ensureEnvironment', () => {
  it('creates a venv and installs numpy, then skips on the next call', async () => {
    const calls: string[][] = []
    let numpyInstalled = false
    const run: CommandRunner = async (command, args, { onLine }) => {
      calls.push([command, ...args])
      if (args[0] === '-m' && args[1] === 'venv') {
        const interpreter = venvPython(args[2], 'win32')
        mkdirSync(dirname(interpreter), { recursive: true })
        writeFileSync(interpreter, '')
        onLine('created venv')
        return 0
      }
      if (args.includes('pip')) {
        numpyInstalled = true
        onLine('Successfully installed numpy-1.26.4')
        return 0
      }
      if (args[0] === '-c') return numpyInstalled ? 0 : 1
      return 1
    }
    const lines: string[] = []
    const first = await ensureEnvironment({ baseDir: root, python: 'py-test', run, platform: 'win32', onProgress: (line) => lines.push(line) })
    const interpreter = join(root, 'venv', 'Scripts', 'python.exe')
    expect(first).toEqual({ python: interpreter, created: true, installed: true })
    expect(existsSync(interpreter)).toBe(true)
    expect(calls[0]).toEqual(['py-test', '-m', 'venv', join(root, 'venv')])
    expect(calls[1]).toEqual([interpreter, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', 'numpy'])
    expect(lines).toContain('Successfully installed numpy-1.26.4')

    calls.length = 0
    const second = await ensureEnvironment({ baseDir: root, python: 'py-test', run, platform: 'win32' })
    expect(second).toEqual({ python: interpreter, created: false, installed: false })
    expect(calls).toEqual([[interpreter, '-c', 'import numpy']])
  })

  it('installs the pinned Ismail archive, with the separation extra on request', async () => {
    const interpreter = venvPython(join(root, 'venv'), 'win32')
    mkdirSync(dirname(interpreter), { recursive: true })
    writeFileSync(interpreter, '')
    const calls: string[][] = []
    const run: CommandRunner = async (command, args) => {
      calls.push([command, ...args])
      return 0
    }
    const result = await installIsmail({ baseDir: root, python: 'py-test', run, platform: 'win32', separation: true })
    expect(result).toMatchObject({ python: interpreter, installed: true })
    expect(ISMAIL_ARCHIVE).toMatch(/^https:\/\/github\.com\/newsbubbles\/ismail\/archive\/[0-9a-f]{40}\.zip$/)
    expect(calls).toContainEqual([interpreter, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-input', `ismail[separate] @ ${ISMAIL_ARCHIVE}`])
    expect(calls.at(-1)).toEqual([interpreter, '-c', 'import ismail.api, demucs'])
    const failing: CommandRunner = async (_command, args) => (args.includes('install') ? 1 : 0)
    // A first install starts before the data folder exists; commands run inside it.
    const fresh = join(root, 'not-yet', 'python')
    await rejection(installIsmail({ baseDir: fresh, python: 'py-test', run: failing, platform: 'win32' }))
    expect(existsSync(fresh)).toBe(true)
    const error = await rejection(installIsmail({ baseDir: root, python: 'py-test', run: failing, platform: 'win32' }))
    expect(error).toMatchObject({ code: 'unavailable', message: expect.stringContaining('Installing Ismail failed') })
  })

  it('reinstalls numpy into an existing venv that lacks it and reports failures', async () => {
    const interpreter = venvPython(join(root, 'venv'), 'linux')
    mkdirSync(dirname(interpreter), { recursive: true })
    writeFileSync(interpreter, '')
    const failing: CommandRunner = async () => 1
    const error = await rejection(ensureEnvironment({ baseDir: root, python: 'python3', run: failing, platform: 'linux' }))
    expect(error.code).toBe('unavailable')
    expect(error.message).toContain('Installing numpy failed')
  })
})
