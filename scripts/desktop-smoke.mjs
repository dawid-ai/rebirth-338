// End-to-end check of the Phase 1 desktop shell against the Phase 1 exit
// criterion: a project opens, plays, saves, and exports in the desktop build
// the same way it does on the web.
// Run `npm run desktop:build` first. Output goes to artifacts/desktop-e2e/.
import { _electron as electron, chromium } from 'playwright'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const OUT = resolve('artifacts/desktop-e2e')
const USER_DATA = join(OUT, 'user-data')
const PROJECT_DIR = join(OUT, 'Desktop Smoke.reborn')
const WAV = join(OUT, 'desktop-smoke.wav')
const PACK = join(OUT, 'Desktop Smoke.rebornpack')
const SAMPLE = resolve('apps/web/public/audio/starter/bd_808.ogg')
await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}
const env = {
  ...process.env,
  REBORN_E2E: '1',
  REBORN_USER_DATA: USER_DATA,
  REBORN_E2E_SAVE_PATH: PROJECT_DIR,
  REBORN_E2E_WAV_PATH: WAV,
  REBORN_E2E_PACK_PATH: PACK,
}

const until = async (predicate, message, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise((r) => setTimeout(r, 150))
  }
  failures.push(`timed out: ${message}`)
  return false
}

async function launch() {
  const app = await electron.launch({ args: ['apps/desktop'], env })
  const page = await app.firstWindow()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForSelector('.workstation-shell')
  const overview = page.getByRole('button', { name: 'OVERVIEW', exact: true })
  if (await overview.count()) await overview.click()
  const menu = (command, path) =>
    app.evaluate(({ BrowserWindow }, event) => BrowserWindow.getAllWindows()[0].webContents.send('menu:command', event), path ? { command, path } : { command })
  const title = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())
  return { app, page, errors, menu, title }
}

// Session 1: isolation, play, save, edit, export, pack, reopen.
let session = await launch()
{
  const { page, menu, title } = session
  const isolation = await page.evaluate(() => ({
    bridge: typeof window.reborn?.saveProject === 'function',
    require: typeof window.require,
    process: typeof window.process,
    origin: location.origin,
  }))
  check(isolation.bridge, 'desktop bridge missing')
  check(isolation.require === 'undefined' && isolation.process === 'undefined', `Node globals leaked into the page: ${JSON.stringify(isolation)}`)
  check(isolation.origin === 'app://reborn', `unexpected origin ${isolation.origin}`)
  check((await page.locator('.product-mark small').textContent())?.includes('DESKTOP EDITION'), 'edition label not set')

  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await until(async () => (await page.locator('.playing').count()) > 0, 'playhead to advance')
  await page.getByRole('button', { name: 'Pause', exact: true }).click()

  await page.locator('.sampler-bay input[type=file]').setInputFiles(SAMPLE)
  await page.waitForTimeout(800)
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.locator('.project-name input').fill('DESKTOP SMOKE')
  await page.keyboard.press('Escape')

  await menu('save')
  await until(() => existsSync(join(PROJECT_DIR, 'project.json')), 'project.json to be written')
  const document = JSON.parse(await readFile(join(PROJECT_DIR, 'project.json'), 'utf8'))
  check(document.format === 'reborn-project' && document.formatVersion === 1, 'project.json is not a v1 project document')
  check(document.project.name === 'DESKTOP SMOKE', `saved name is ${document.project.name}`)
  check(document.assets.length >= 1, 'user sample was not saved with the project')
  const assetFiles = existsSync(join(PROJECT_DIR, 'assets')) ? await readdir(join(PROJECT_DIR, 'assets')) : []
  check(assetFiles.some((file) => file.endsWith('.ogg')), `assets folder holds ${assetFiles.join(', ')}`)
  await until(async () => !(await title()).startsWith('•'), 'title to show the saved state')

  await page.locator('.unit-1 .bass-steps button').nth(3).click()
  await until(async () => (await title()).startsWith('•'), 'title to show unsaved edits')

  await menu('save')
  await until(async () => !(await title()).startsWith('•'), 'second save to clear the edited marker')
  const assetStat = await stat(join(PROJECT_DIR, 'assets', assetFiles[0]))

  await menu('export-wav')
  await until(() => existsSync(WAV), 'WAV export to be written', 120_000)

  await menu('pack')
  await until(() => existsSync(PACK), 'packed project to be written')
  const pack = await readFile(PACK)
  check(pack.subarray(0, 2).toString() === 'PK', 'packed project is not a ZIP archive')
  check(pack.includes(Buffer.from('assets/')), 'packed project is missing its assets')

  // Saving again must not rewrite unchanged audio.
  await page.locator('.unit-1 .bass-steps button').nth(5).click()
  await menu('save')
  await until(async () => !(await title()).startsWith('•'), 'third save to finish')
  check((await stat(join(PROJECT_DIR, 'assets', assetFiles[0]))).mtimeMs === assetStat.mtimeMs, 'unchanged audio was rewritten on save')

  await menu('new')
  await until(async () => (await title()).includes('NEW PROJECT') || !(await title()).includes('DESKTOP SMOKE'), 'new project to replace the open one')
  await menu('open-path', PROJECT_DIR)
  await until(async () => (await title()).includes('DESKTOP SMOKE'), 'reopened project title')
  await page.screenshot({ path: join(OUT, 'desktop-reopened.png') })

  // Unsaved edit, then a crash.
  await page.locator('.unit-1 .bass-steps button').nth(7).click()
  await page.waitForTimeout(2200)
  check(session.errors.length === 0, `page errors: ${session.errors.join(' | ')}`)
  // Simulate a crash. On Windows, kill the whole tree so no child keeps the profile locked.
  const pid = session.app.process().pid
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  else session.app.process().kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 1000))
}

// Session 2: crash recovery, then a clean quit.
session = await launch()
{
  const { page, title } = session
  await until(async () => (await page.locator('.toast').textContent().catch(() => ''))?.includes('RECOVERED'), 'recovery notice after crash')
  await until(async () => (await title()).startsWith('•') && (await title()).includes('DESKTOP SMOKE'), 'recovered project marked as edited')
  check(session.errors.length === 0, `page errors after recovery: ${session.errors.join(' | ')}`)
  await session.app.close()
  check(!existsSync(join(USER_DATA, 'session.lock')), 'clean quit left the session lock behind')
  check(!existsSync(join(USER_DATA, 'recovery', 'current.json')), 'clean quit left a recovery snapshot behind')
  const log = await readFile(join(USER_DATA, 'logs', 'reborn.log'), 'utf8')
  check(log.includes('after an unclean shutdown') && log.includes('Session ended cleanly'), 'log is missing session lifecycle entries')
}

// Web parity: the same saved project exports a WAV of identical length.
{
  const document = JSON.parse(await readFile(join(PROJECT_DIR, 'project.json'), 'utf8'))
  const raw = join(OUT, 'desktop-smoke.rb338.json')
  await writeFile(raw, JSON.stringify(document.project))
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.workstation-shell')
  await page.getByRole('button', { name: 'OVERVIEW', exact: true }).click()
  await page.getByRole('button', { name: 'Projects', exact: true }).click()
  await page.locator('.projects-popover input[type=file]').setInputFiles(raw)
  await page.waitForTimeout(500)
  const download = page.waitForEvent('download', { timeout: 120_000 })
  await page.getByRole('button', { name: /EXPORT .* WAV/ }).click()
  const webWav = join(OUT, 'web-smoke.wav')
  await (await download).saveAs(webWav)
  await browser.close()
  const [desktopBytes, webBytes] = await Promise.all([readFile(WAV), readFile(webWav)])
  const header = (bytes) => ({ riff: bytes.toString('ascii', 0, 4), channels: bytes.readUInt16LE(22), rate: bytes.readUInt32LE(24), bits: bytes.readUInt16LE(34), size: bytes.length })
  const a = header(desktopBytes)
  const b = header(webBytes)
  check(a.riff === 'RIFF' && JSON.stringify(a) === JSON.stringify(b), `WAV mismatch: desktop ${JSON.stringify(a)} vs web ${JSON.stringify(b)}`)
  console.log(`WAV parity: ${JSON.stringify(a)}`)
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`Desktop smoke passed. Output in ${OUT}`)
