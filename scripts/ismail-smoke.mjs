// End-to-end check of the Ismail tools in the desktop app: install from the
// Generate tab, generate a sound, deep analysis with Ismail reports, stem
// separation as one undo step, and the same through the CLI.
//
// Opt-in: it installs Ismail into artifacts/ismail-e2e/user-data, which
// downloads about 650 MB (1.3 GB with ISMAIL_SMOKE_SEPARATION=1) unless pip's
// cache already has the packages. Run `npm run desktop:build` first.
import { _electron as electron } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const OUT = resolve('artifacts/ismail-e2e')
const USER_DATA = join(OUT, 'user-data')
const CLI = resolve('packages/cli/bin/reborn.mjs')
const SEPARATION = process.env.ISMAIL_SMOKE_SEPARATION === '1'
const INSTALL_TIMEOUT = 30 * 60_000
if (process.env.ISMAIL_SMOKE_KEEP !== '1') await rm(OUT, { recursive: true, force: true })
await mkdir(OUT, { recursive: true })

const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}
const until = async (predicate, message, timeout = 30_000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    // Errors marked fatal end the test at once; others mean "not yet".
    if (await predicate().catch((error) => { if (error?.fatal) throw error; return false })) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  failures.push(`timed out: ${message}`)
  return false
}
const cli = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: { ...process.env, REBORN_API_FILE: join(USER_DATA, 'api.json') }, encoding: 'utf8', timeout: 20 * 60_000 })

const app = await electron.launch({ args: ['apps/desktop'], env: { ...process.env, REBORN_E2E: '1', REBORN_USER_DATA: USER_DATA } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))
await page.waitForSelector('.transport')
const state = (fn, arg) => page.evaluate(fn, arg)
// A fresh profile may start with the browser collapsed to its icon rail.
const openGenerate = async () => {
  const tab = page.getByRole('tab', { name: 'Generate' })
  if (!(await tab.isVisible().catch(() => false))) await page.getByRole('button', { name: 'Generate', exact: true }).click()
  await tab.click()
}
const tracks = () => state(() => window.__studio.getState().project.tracks.map((t) => ({ id: t.id, name: t.name, kind: t.kind })))

try {
  // Install from the Generate tab, the way a person does.
  await openGenerate()
  const install = page.getByRole('button', { name: 'Install Ismail' })
  if (await install.isVisible().catch(() => false)) {
    await install.click()
    console.log('Installing Ismail…')
  }
  const installFailed = () => page.locator('.browser-note.is-error').isVisible()
  await until(async () => {
    if (await installFailed()) throw Object.assign(new Error(`Ismail install failed: ${await page.locator('.browser-note.is-error').innerText()}`), { fatal: true })
    return page.getByRole('combobox', { name: 'Ismail instrument' }).isVisible()
  }, 'Ismail install and presets', INSTALL_TIMEOUT)
  await page.screenshot({ path: join(OUT, 'generate-tab.png') })

  // Generate with nothing selected: a new audio track.
  await state(() => window.__studio.audit.store.select({ kind: 'none' }))
  const before = (await tracks()).length
  await page.getByRole('combobox', { name: 'Ismail instrument' }).selectOption('preset:acid_bass')
  await page.getByRole('button', { name: /^Generate / }).click()
  await until(async () => (await tracks()).length === before + 1, 'generated sound on a new track', 120_000)
  const generated = await state(() => {
    const s = window.__studio.getState()
    const track = s.project.tracks.at(-1)
    const clip = s.project.clips.find((c) => c.trackId === track.id)
    const asset = clip && s.project.assets[clip.assetId]
    return { track: track.name, kind: track.kind, origin: asset?.origin, duration: asset?.duration, loaded: Boolean(clip && window.__studio.engine.buffer(clip.assetId)), clipId: clip?.id, past: s.past.length }
  })
  check(generated.kind === 'audio' && generated.origin?.kind === 'generated' && generated.origin?.source?.startsWith('ismail:acid_bass') && generated.duration > 0.1 && generated.loaded, `generated sound ${JSON.stringify(generated)}`)
  await until(() => page.locator('.ismail-report').isVisible(), 'timbre report')

  // Generating into a selected Sampler loads it there instead.
  const sampler = (await tracks()).find((t) => t.kind === 'sampler')
  if (sampler) {
    await state((id) => window.__studio.audit.store.select({ kind: 'track', trackId: id }), sampler.id)
    await page.getByRole('combobox', { name: 'Ismail instrument' }).selectOption('preset:kick')
    await page.getByRole('button', { name: /^Generate / }).click()
    await until(() => state((id) => window.__studio.getState().project.tracks.find((t) => t.id === id).device.source?.assetId?.startsWith('ast_') && window.__studio.getState().project.assets[window.__studio.getState().project.tracks.find((t) => t.id === id).device.source.assetId].origin.kind === 'generated', sampler.id), 'generated kick in the sampler', 120_000)
  }

  // Deep analysis attaches Ismail's reports.
  await page.locator('body').press('3')
  await page.getByRole('button', { name: 'Deep analysis' }).click()
  await until(() => page.locator('.deep-report').count().then((n) => n >= 3), 'Ismail reports in deep analysis', 180_000)
  const reports = await page.locator('.deep-report summary').allInnerTexts()
  check(reports.some((r) => /Sections and key/.test(r)) && reports.some((r) => /Chords/.test(r)), `deep analysis reports ${JSON.stringify(reports)}`)
  await page.locator('.deep-report').first().locator('summary').click()
  await page.screenshot({ path: join(OUT, 'deep-analysis-ismail.png') })

  // The CLI and API reach the same tools.
  check(/acid_bass\s+synth/.test(cli('presets')), 'reborn presets lists acid_bass')
  const viaCli = cli('generate', 'pluck', '0 C3 0.5; 0.5 G3 0.5', '--name', 'CLI pluck', '--bar', '5', '--wait')
  check(/^Generated CLI pluck on track trk_/.test(viaCli), `reborn generate output ${viaCli}`)
  const cliTrack = await state(() => {
    const s = window.__studio.getState()
    const track = s.project.tracks.find((t) => t.name === 'CLI pluck')
    return { found: Boolean(track), start: s.project.clips.find((c) => c.trackId === track?.id)?.start, origin: s.past.at(-1)?.origin }
  })
  check(cliTrack.found && cliTrack.start === 4 && cliTrack.origin === 'script', `CLI generation ${JSON.stringify(cliTrack)}`)

  if (SEPARATION) {
    await page.locator('body').press('1')
    await openGenerate()
    const add = page.getByRole('button', { name: 'Add stem separation' })
    if (await add.isVisible().catch(() => false)) {
      await add.click()
      console.log('Installing stem separation…')
      await until(() => page.getByText(/Select an audio clip, a deck/).isVisible(), 'separation install', INSTALL_TIMEOUT)
    }
    // Separate the generated clip from the inspector: four tracks, one undo step.
    await state((clipId) => window.__studio.audit.store.select({ kind: 'clip', clipId }), generated.clipId)
    const count = (await tracks()).length
    const past = await state(() => window.__studio.getState().past.length)
    await page.getByRole('button', { name: 'Separate stems' }).click()
    await until(async () => (await tracks()).length === count + 4, 'four stem tracks', 20 * 60_000)
    const stems = await state((clipId) => {
      const s = window.__studio.getState()
      const source = s.project.clips.find((c) => c.id === clipId)
      const added = s.project.tracks.slice(-4)
      return { names: added.map((t) => t.name), aligned: added.every((t) => s.project.clips.some((c) => c.trackId === t.id && c.start === source.start && c.length === source.length)), steps: s.past.length }
    }, generated.clipId)
    check(stems.names.join(',').match(/drums.*bass.*other.*vocals/) && stems.aligned && stems.steps === past + 1, `separated stems ${JSON.stringify(stems)}`)
    await page.screenshot({ path: join(OUT, 'separated.png') })
    cli('undo')
    await until(async () => (await tracks()).length === count, 'one undo removes every stem')
    const viaSeparate = cli('separate', '--clip', generated.clipId, '--wait')
    check(/Separated into new audio tracks:\n\s+drums/.test(viaSeparate), `reborn separate output ${viaSeparate}`)
  } else console.log('Skipping stem separation. Set ISMAIL_SMOKE_SEPARATION=1 to install and test it.')

  check(errors.length === 0, `page errors: ${errors.join(' | ')}`)
} finally {
  await app.close()
}

if (failures.length) {
  console.error(`Ismail smoke test failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}
console.log(`Ismail smoke test passed${SEPARATION ? ' (with stem separation)' : ''}. Screenshots in ${OUT}.`)
