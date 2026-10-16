import { BrowserWindow, Menu, app, dialog, ipcMain, net, protocol, safeStorage, shell, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  IPC,
  PACKED_PROJECT_EXTENSION,
  PROJECT_DIRECTORY_EXTENSION,
  PROJECT_FILE,
  type DesktopAssetPayload,
  type JobUpdate,
  type LogLevel,
  type MenuEvent,
  type OpenedProject,
  type SaveProjectRequest,
  type SaveProjectResult,
  migrateProject,
  studio,
  projectDirectoryName,
} from '@reborn/studio-core'
import { AgentService } from './agent'
import { DeepAnalysis } from './deep-analysis'
import { ApiServer, type RenderedFile } from './api-server'
import { JobRunner } from './jobs'
import { packProjectDirectory, readProjectPath, unpackProject, writeAtomic, writeProjectDirectory } from './project-dir'
import { SessionStore } from './session'
import { checkForUpdates, startUpdates } from './updater'

const APP_ORIGIN = 'app://reborn'
const DEV_URL = process.argv.includes('--dev') ? (process.env.REBORN_DEV_URL ?? 'http://127.0.0.1:5175') : undefined
// The desktop edition runs the v2 studio; the v1 workstation stays on the web.
const RENDERER_DIRECTORY = app.isPackaged ? join(process.resourcesPath, 'studio') : resolve(__dirname, '../../studio/dist')
const SIDECAR_DIR = app.isPackaged ? join(process.resourcesPath, 'python', 'ismail-bridge') : resolve(__dirname, '../../../python/ismail-bridge')
const CLI_BUNDLE = app.isPackaged ? join(process.resourcesPath, 'cli', 'reborn.mjs') : resolve(__dirname, '../../../packages/cli/dist/reborn.mjs')
const E2E = process.env.REBORN_E2E === '1'

// The product name contains a colon, which Windows forbids in folder names,
// so the user-data folder gets an explicit name. The CLI looks here too.
app.setPath('userData', process.env.REBORN_USER_DATA ? resolve(process.env.REBORN_USER_DATA) : join(app.getPath('appData'), 'RE-BORN'))

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
])

let mainWindow: BrowserWindow | null = null
let session: SessionStore
let jobs: JobRunner
let edited = false
let closeConfirmed = false
let finishing = false
let api: ApiServer | null = null
let agent: AgentService
let deep: DeepAnalysis
const pendingRpc = new Map<string, { resolve: (reply: { status: number; body: unknown }) => void; timer: ReturnType<typeof setTimeout> }>()

function rendererRpc(route: 'status' | 'execute' | 'runtime', body: unknown, timeoutMs = 30_000): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    if (!mainWindow || mainWindow.webContents.isLoading()) return reject(new Error('The RE:BORN window is not ready.'))
    const id = randomUUID()
    const timer = setTimeout(() => {
      pendingRpc.delete(id)
      reject(new Error('The RE:BORN window did not answer in time.'))
    }, timeoutMs)
    pendingRpc.set(id, { resolve, timer })
    mainWindow.webContents.send(IPC.apiRequest, { id, route, body })
  })
}

async function writeRenderedFiles(files: RenderedFile[], target?: string): Promise<string[]> {
  const exports = join(app.getPath('music'), 'RE-BORN Exports')
  const single = files.length === 1 && target && /\.wav$/i.test(target)
  const directory = target && !single ? target : exports
  await mkdir(single ? resolve(target!, '..') : directory, { recursive: true })
  const paths: string[] = []
  for (const file of files) {
    const path = single ? target! : join(directory, basename(file.name))
    const data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data)
    await writeAtomic(path, data)
    paths.push(path)
  }
  log('info', `Wrote ${paths.length} rendered file(s): ${paths.join(', ')}`)
  return paths
}

const log = (level: LogLevel, message: string) => void session?.log(level, message)

// Test runs pass fixed paths instead of driving native dialogs.
const presetPath = (name: 'OPEN' | 'SAVE' | 'WAV' | 'PACK') => process.env[`REBORN_E2E_${name}_PATH`]

function isTrusted(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  const url = event.senderFrame?.url ?? ''
  return url.startsWith(`${APP_ORIGIN}/`) || (DEV_URL !== undefined && url.startsWith(DEV_URL))
}

function handle<Args extends unknown[], Result>(channel: string, listener: (...args: Args) => Promise<Result>) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrusted(event)) throw new Error('Untrusted sender.')
    try {
      return await listener(...(args as Args))
    } catch (error) {
      log('error', `${channel} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
      throw error
    }
  })
}

function sendMenu(event: MenuEvent) {
  mainWindow?.webContents.send(IPC.menu, event)
}

function sendJob(update: JobUpdate) {
  mainWindow?.webContents.send(IPC.jobUpdate, update)
}

// IPC may deliver binary data as an ArrayBuffer or a typed-array view.
function toArrayBuffer(data: unknown): ArrayBuffer | null {
  if (data instanceof ArrayBuffer) return data
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  return null
}

const isProjectDirectory = (path: string) => existsSync(join(path, PROJECT_FILE)) && statSync(path).isDirectory()

async function chooseProjectFolder(): Promise<string | null> {
  const preset = presetPath('OPEN')
  if (preset) return preset
  const result = await dialog.showOpenDialog(mainWindow!, { title: 'Open project folder', buttonLabel: 'Open project', properties: ['openDirectory'] })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function chooseProjectFile(): Promise<string | null> {
  const preset = presetPath('OPEN')
  if (preset) return preset
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open project file',
    properties: ['openFile'],
    filters: [{ name: 'RE:BORN projects', extensions: ['rebornpack', 'json'] }],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
}

async function chooseSaveDirectory(name: string): Promise<string | null> {
  const preset = presetPath('SAVE')
  const chosen = preset ?? (await dialog.showSaveDialog(mainWindow!, {
    title: 'Save project',
    buttonLabel: 'Save project',
    defaultPath: join(app.getPath('documents'), projectDirectoryName(name)),
    filters: [{ name: 'RE:BORN project folder', extensions: ['reborn'] }],
  })).filePath
  if (!chosen) return null
  const directory = extname(chosen).toLowerCase() === PROJECT_DIRECTORY_EXTENSION ? chosen : `${chosen}${PROJECT_DIRECTORY_EXTENSION}`
  if (existsSync(directory) && !preset) {
    if (!isProjectDirectory(directory)) {
      await dialog.showMessageBox(mainWindow!, { type: 'error', message: 'That folder is not a RE:BORN project.', detail: 'Choose a new name so existing files are not mixed into the project.' })
      return null
    }
    const { response } = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      buttons: ['Cancel', 'Save into it'],
      defaultId: 0,
      cancelId: 0,
      message: `${basename(directory)} already exists.`,
      detail: 'Saving replaces its project.json and adds any new audio. Existing audio files are kept.',
    })
    if (response !== 1) return null
  }
  return directory
}

async function openProject(requested?: string): Promise<OpenedProject | null> {
  let path = requested ?? (await chooseProjectFolder())
  if (!path) return null
  if (extname(path).toLowerCase() === PACKED_PROJECT_EXTENSION) {
    path = await unpackProject(path)
    log('info', `Unpacked project to ${path}.`)
  }
  const opened = await readProjectPath(path)
  if (isProjectDirectory(opened.path)) await session.addRecent(opened.path, opened.document.studio?.name ?? opened.document.project?.name ?? 'Untitled')
  await buildMenu()
  log('info', `Opened ${opened.path} (${opened.assets.length} assets, ${opened.missing.length} missing).`)
  return opened
}

async function saveProject(request: SaveProjectRequest): Promise<SaveProjectResult | null> {
  const content = request.studio ? { studio: studio.migrateStudioProject(request.studio) } : { project: migrateProject(request.project) }
  const projectName = content.studio?.name ?? content.project?.name ?? 'Untitled'
  const assets: DesktopAssetPayload[] = []
  for (const asset of request.assets ?? []) {
    const data = toArrayBuffer(asset?.data)
    if (typeof asset?.id === 'string' && data) assets.push({ ...asset, data })
  }
  const reuse = !request.saveAs && request.path && isProjectDirectory(request.path)
  const directory = reuse ? request.path! : await chooseSaveDirectory(projectName)
  if (!directory) return null
  const result = await writeProjectDirectory(directory, content, assets, app.getVersion())
  await session.addRecent(directory, projectName)
  await buildMenu()
  log('info', `Saved ${directory} (${result.writtenAssets} written, ${result.reusedAssets} unchanged).`)
  return { path: directory, ...result }
}

async function packProject(path: string): Promise<{ jobId: string } | null> {
  if (!isProjectDirectory(path)) throw new Error('Save the project to a folder before packing it.')
  const preset = presetPath('PACK')
  const output = preset ?? (await dialog.showSaveDialog(mainWindow!, {
    title: 'Pack project',
    defaultPath: join(resolve(path, '..'), `${basename(path, PROJECT_DIRECTORY_EXTENSION)}${PACKED_PROJECT_EXTENSION}`),
    filters: [{ name: 'Packed RE:BORN project', extensions: ['rebornpack'] }],
  })).filePath
  if (!output) return null
  const jobId = jobs.start('pack', async ({ signal, progress }) => {
    await packProjectDirectory(path, output, { signal, onProgress: ({ completed, total }) => progress(completed, total) })
    return output
  })
  return { jobId }
}

async function saveWav(input: unknown, suggestedName: string): Promise<string | null> {
  const data = toArrayBuffer(input)
  if (!data) throw new Error('Expected WAV data.')
  const preset = presetPath('WAV')
  const target = preset ?? (await dialog.showSaveDialog(mainWindow!, {
    title: 'Export WAV',
    defaultPath: join(app.getPath('music'), basename(suggestedName || 'export.wav')),
    filters: [{ name: 'WAV audio', extensions: ['wav'] }],
  })).filePath
  if (!target) return null
  await writeAtomic(target, new Uint8Array(data))
  log('info', `Exported WAV to ${target} (${data.byteLength} bytes).`)
  return target
}

async function buildMenu() {
  const recent = await session.listRecent()
  const item = (label: string, command: MenuEvent['command'], accelerator?: string): MenuItemConstructorOptions => ({ label, accelerator, click: () => sendMenu({ command }) })
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        item('New Project', 'new', 'CmdOrCtrl+N'),
        {
          label: 'Open Project Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const path = await chooseProjectFolder()
            if (path) sendMenu({ command: 'open-path', path })
          },
        },
        {
          label: 'Open Packed or v1 File…',
          accelerator: 'CmdOrCtrl+Shift+O',
          click: async () => {
            const path = await chooseProjectFile()
            if (path) sendMenu({ command: 'open-path', path })
          },
        },
        {
          label: 'Open Recent',
          submenu: recent.length
            ? recent.map((entry) => ({ label: `${entry.name}  —  ${entry.path}`, click: () => sendMenu({ command: 'open-path', path: entry.path }) }))
            : [{ label: 'No recent projects', enabled: false }],
        },
        { type: 'separator' },
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'save-as', 'CmdOrCtrl+Shift+S'),
        item('Pack Project…', 'pack'),
        { type: 'separator' },
        item('Export WAV…', 'export-wav', 'CmdOrCtrl+E'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [item('Undo', 'undo', 'CmdOrCtrl+Z'), item('Redo', 'redo', 'CmdOrCtrl+Shift+Z'), { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(DEV_URL || !app.isPackaged ? ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Open Log Folder',
          click: () => void shell.openPath(join(app.getPath('userData'), 'logs')),
        },
        {
          label: 'Check for Updates',
          click: async () => {
            const message = await checkForUpdates((m) => log('info', m))
            await dialog.showMessageBox(mainWindow!, { type: 'info', message })
          },
        },
        { label: `RE:BORN ${app.getVersion()}`, enabled: false },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function registerIpc() {
  handle(IPC.agentSettings, () => agent.settings())
  handle(IPC.agentSetSettings, (patch: Parameters<AgentService['update']>[0]) => agent.update(patch ?? {}))
  handle(IPC.agentComplete, (request: Parameters<AgentService['complete']>[0]) => agent.complete(request))
  handle(IPC.agentRunCli, async (prompt: string) => {
    if (!api) throw new Error('The local API is not running, so the Claude CLI cannot reach RE:BORN.')
    if (!existsSync(CLI_BUNDLE)) throw new Error('The reborn MCP bundle is missing. Run npm run cli:build.')
    return agent.runCli(String(prompt), { command: process.execPath, args: [CLI_BUNDLE, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', REBORN_API_FILE: api.file } }, app.getPath('temp'))
  })
  handle(IPC.apiClients, async () => api?.clientCount() ?? 0)
  const bytes = (data: unknown) => {
    const buffer = toArrayBuffer(data)
    if (!buffer) throw new Error('Expected WAV data.')
    return new Uint8Array(buffer)
  }
  handle(IPC.deepAnalyze, (request: { wav: unknown; sections: { id: string; start: number; end: number }[] }) => deep.analyze(bytes(request?.wav), Array.isArray(request?.sections) ? request.sections : []))
  handle(IPC.deepCompare, async (request: { wav: unknown }) => {
    const preset = process.env.REBORN_E2E_REFERENCE_PATH
    const chosen = preset ?? (await dialog.showOpenDialog(mainWindow!, { title: 'Choose a reference track', properties: ['openFile'], filters: [{ name: 'WAV audio', extensions: ['wav'] }] })).filePaths[0]
    if (!chosen) return null
    return deep.compare(bytes(request?.wav), chosen)
  })
  handle(IPC.deepStatus, async () => deep.status())
  ipcMain.on(IPC.deepCancel, (event) => {
    if (isTrusted(event)) deep.cancel()
  })
  ipcMain.on(IPC.apiResponse, (event, response: { id: string; status: number; body: unknown }) => {
    if (!isTrusted(event)) return
    const pending = pendingRpc.get(response?.id)
    if (!pending) return
    clearTimeout(pending.timer)
    pendingRpc.delete(response.id)
    pending.resolve({ status: Number(response.status) || 500, body: response.body })
  })
  ipcMain.on(IPC.apiEvent, (event, payload) => {
    if (isTrusted(event)) api?.emit(payload)
  })
  handle(IPC.version, async () => app.getVersion())
  handle(IPC.openProject, (path?: string) => openProject(typeof path === 'string' ? path : undefined))
  handle(IPC.saveProject, (request: SaveProjectRequest) => saveProject(request))
  handle(IPC.listRecent, () => session.listRecent())
  handle(IPC.packProject, (path: string) => packProject(String(path)))
  handle(IPC.cancelJob, async (id: string) => jobs.cancel(String(id)))
  handle(IPC.saveWav, (data: unknown, name: string) => saveWav(data, String(name ?? 'export.wav')))
  handle(IPC.takeRecovery, () => session.takeRecovery())
  ipcMain.on(IPC.writeRecovery, (event, state: { project?: unknown; studio?: unknown; path: unknown }) => {
    if (!isTrusted(event)) return
    try {
      const content = state?.studio ? { studio: studio.migrateStudioProject(state.studio) } : { project: migrateProject(state?.project) }
      void session.writeRecovery(content, typeof state?.path === 'string' ? state.path : null)
    } catch (error) {
      log('warn', `Ignored invalid recovery snapshot: ${String(error)}`)
    }
  })
  ipcMain.on(IPC.documentState, (event, state: { title: unknown; edited: unknown }) => {
    if (!isTrusted(event) || !mainWindow) return
    edited = state?.edited === true
    const title = String(state?.title ?? 'Untitled').slice(0, 120)
    mainWindow.setTitle(`${edited ? '• ' : ''}${title} — RE:BORN`)
    mainWindow.setDocumentEdited(edited)
  })
  ipcMain.on(IPC.log, (event, level: LogLevel, message: unknown) => {
    if (!isTrusted(event)) return
    log(level === 'error' || level === 'warn' ? level : 'info', `[renderer] ${String(message)}`)
  })
}

function registerProtocol() {
  const root = normalize(RENDERER_DIRECTORY + sep)
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url)
    const relative = decodeURIComponent(pathname === '/' ? '/index.html' : pathname)
    const file = normalize(join(RENDERER_DIRECTORY, relative))
    if (!file.startsWith(root) || !existsSync(file)) return new Response('Not found', { status: 404 })
    return net.fetch(pathToFileURL(file).toString())
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: '#080a0a',
    title: 'RE:BORN',
    show: false,
    icon: app.isPackaged ? undefined : join(__dirname, '../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN) && !(DEV_URL && url.startsWith(DEV_URL))) event.preventDefault()
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('error', `Renderer exited: ${details.reason} (${details.exitCode}).`)
    if (details.reason !== 'clean-exit' && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload()
  })
  mainWindow.on('close', (event) => {
    if (!edited || closeConfirmed || E2E) return
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Cancel', 'Close without saving'],
      defaultId: 0,
      cancelId: 0,
      message: 'This project has unsaved changes.',
      detail: 'Use File › Save to keep them in the project folder.',
    })
    if (choice === 1) closeConfirmed = true
    else event.preventDefault()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  void mainWindow.loadURL(DEV_URL ?? `${APP_ORIGIN}/index.html${E2E ? '?e2e' : ''}`)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    session = new SessionStore(app.getPath('userData'))
    await session.start()
    jobs = new JobRunner(sendJob, (message) => log('info', message))
    process.on('uncaughtException', (error) => log('error', `Main process error: ${error.stack ?? error.message}`))
    agent = new AgentService(app.getPath('userData'), safeStorage)
    deep = new DeepAnalysis({
      sidecarDir: SIDECAR_DIR,
      dataDir: app.getPath('userData'),
      log: (line) => log('info', line),
      onProgress: (completed, total, message) => sendJob({ id: 'deep-analysis', kind: 'analysis', status: 'running', completed, total, message }),
    })
    if (E2E) Object.assign(globalThis, { __rebornDeep: deep })
    registerProtocol()
    registerIpc()
    await buildMenu()
    createWindow()
    startUpdates((message) => log('info', message))
    if (process.env.REBORN_API !== 'off') {
      api = new ApiServer({ directory: app.getPath('userData'), version: app.getVersion(), rpc: { request: rendererRpc }, writeFiles: writeRenderedFiles, log: (message) => log('info', message), port: process.env.REBORN_API_PORT ? Number(process.env.REBORN_API_PORT) : undefined })
      await api.start().catch((error) => {
        log('error', `Local API failed to start: ${String(error)}`)
        api = null
      })
    }
  })

  app.on('window-all-closed', () => app.quit())

  app.on('will-quit', (event) => {
    if (finishing) return
    finishing = true
    event.preventDefault()
    jobs?.cancelAll()
    void Promise.allSettled([api?.stop(), deep?.stop(), session.finish()]).finally(() => app.exit(0))
  })
}
