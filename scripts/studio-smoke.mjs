// End-to-end check of the v2 studio against the Phase 2–4 exit criteria.
// Start the studio first: npx vite --config apps/studio/vite.config.ts --host 127.0.0.1
import { mkdirSync, readFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.STUDIO_URL ?? 'http://127.0.0.1:5175/?e2e&fresh'
const OUT = 'artifacts/studio-smoke'
mkdirSync(OUT, { recursive: true })
const failures = []
const errors = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required'] })
const state = (page, fn) => page.evaluate(fn)
// The browser panel shows rail buttons when collapsed and tabs when open.
async function browserTab(page, name) {
  const tab = page.getByRole('tab', { name })
  if (await tab.count()) await tab.click()
  else await page.getByRole('button', { name, exact: true }).click()
}

try {
  // Layout at three widths.
  for (const [width, height] of [[1024, 700], [1440, 900], [1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    await page.goto(URL, { waitUntil: 'networkidle' })
    const layout = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, center: Math.round(document.querySelector('.workspace').getBoundingClientRect().width) }))
    check(layout.sw <= width && layout.sh <= height, `${width}: the document scrolls (${layout.sw}×${layout.sh})`)
    check(layout.center >= 640, `${width}: center is ${layout.center}px`)
    await page.screenshot({ path: `${OUT}/layout-${width}.png` })
    await page.close()
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true })
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.goto(URL, { waitUntil: 'networkidle' })

  // First beat plays.
  await page.keyboard.press('Space')
  await page.waitForTimeout(1600)
  const playing = await state(page, () => ({ bar: window.__studio.engine.position(), level: window.__studio.engine.outputLevel() }))
  check(playing.bar > 0.3, `playhead did not move (${playing.bar})`)
  check(playing.level > 0.01, `no output level while playing (${playing.level})`)
  await page.keyboard.press('Space')

  // Phase 2: edit Acid, Wave, and drums without the legacy page.
  await page.locator('.track-head', { hasText: 'Acid 1' }).click()
  const cutoff = page.getByRole('slider', { name: 'Cutoff' }).first()
  await cutoff.focus()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowUp')
  const acid = await state(page, () => window.__studio.getState().project.tracks[0].device.cutoff)
  check(acid > 0.35, `Acid cutoff did not change (${acid})`)
  await page.locator('.track-head', { hasText: 'Wave' }).click()
  await page.getByRole('radio', { name: 'Saw' }).first().click()
  const wave = await state(page, () => window.__studio.getState().project.tracks[2].device.waveform)
  check(wave === 'sawtooth', `Wave waveform did not change (${wave})`)
  await page.locator('.clip', { hasText: 'Main beat' }).click()
  await page.getByRole('button', { name: 'SD step 5: off' }).click()
  const snare = await state(page, () => {
    const p = window.__studio.getState().project
    return p.patterns[p.clips[0].patternId].lanes.snare[4].on
  })
  check(snare === true, 'drum step did not toggle')
  await page.locator('.clip', { hasText: 'Acid line' }).click()
  await page.getByRole('button', { name: /C2 on step 2/ }).click()
  await page.screenshot({ path: `${OUT}/phase2-editing.png` })

  // Undo goes back through those edits one at a time.
  const before = await state(page, () => window.__studio.getState().past.length)
  await page.keyboard.press('Control+z')
  const after = await state(page, () => window.__studio.getState().past.length)
  check(after === before - 1, `undo did not remove one step (${before} → ${after})`)

  // Phase 3: import a v1 demo and rearrange it.
  await browserTab(page, 'Projects')
  await page.getByRole('button', { name: /ABYSSAL SIGNAL/ }).click()
  await page.waitForTimeout(300)
  const imported = await state(page, () => ({ tracks: window.__studio.getState().project.tracks.length, bars: window.__studio.getState().project.length }))
  check(imported.tracks >= 8 && imported.bars === 48, `demo import looks wrong ${JSON.stringify(imported)}`)
  await page.locator('.sections').hover()
  await page.getByRole('button', { name: 'Insert 8 bars at bar 17' }).click()
  const inserted = await state(page, () => ({ bars: window.__studio.getState().project.length, names: window.__studio.getState().project.sections.map((s) => s.name) }))
  check(inserted.bars === 56 && inserted.names.includes('New 8'), `insert time failed ${JSON.stringify(inserted)}`)
  const linked = page.locator('.clip:has(.link-badge)').first()
  await linked.click()
  await page.locator('.link-bar').getByRole('button', { name: 'Make unique' }).click()
  const uniqueLabel = await state(page, () => window.__studio.getState().past.at(-1)?.label)
  check(/unique/i.test(uniqueLabel ?? ''), `make unique not recorded (${uniqueLabel})`)
  await page.keyboard.press('2')
  await page.getByRole('button', { name: /^Launch / }).first().click()
  await page.waitForTimeout(600)
  const launched = await state(page, () => window.__studio.getState().transport)
  check(launched.playing && launched.launchedSceneId, 'scene launch did not start playback')
  await page.screenshot({ path: `${OUT}/phase3-build.png` })
  await page.keyboard.press('Space')
  await page.keyboard.press('1')

  // Phase 4: chop a break, record a pad take, place audio, analyze, export.
  await page.locator('.track-head', { hasText: /^Sampler/ }).first().click()
  await browserTab(page, 'Samples')
  await page.locator('.browser-item', { hasText: 'Amen break' }).dblclick()
  await page.waitForFunction(() => {
    const p = window.__studio.getState().project
    const sampler = p.tracks.find((t) => t.kind === 'sampler')
    return sampler?.device.source && sampler.device.source.slices.length > 2
  }, null, { timeout: 15000 })
  await page.screenshot({ path: `${OUT}/phase4-chop.png` })
  const clipsBefore = await state(page, () => window.__studio.getState().project.clips.length)
  await page.locator('body').press('r')
  await page.locator('body').press('Space')
  for (const key of ['m', ',', '.', 'j', 'k', 'u', 'm', '7']) {
    await page.waitForTimeout(180)
    await page.keyboard.press(key)
  }
  await page.waitForTimeout(300)
  await page.locator('body').press('Space')
  await page.waitForTimeout(300)
  const take = await state(page, () => {
    const p = window.__studio.getState().project
    const clip = p.clips.at(-1)
    return { clips: p.clips.length, hits: clip?.patternId ? p.patterns[clip.patternId]?.hits?.length : 0 }
  })
  check(take.clips === clipsBefore + 1 && take.hits >= 6, `pad take not recorded ${JSON.stringify(take)}`)
  await page.locator('body').press('r')

  await browserTab(page, 'Devices')
  await page.locator('.browser-item', { hasText: 'Audio Track' }).click()
  await browserTab(page, 'Samples')
  await page.locator('.browser-item', { hasText: 'Dusty drum loop' }).dblclick()
  await page.waitForTimeout(800)
  const audioClip = await state(page, () => window.__studio.getState().project.clips.some((c) => c.assetId === 'builtin:loop_breakbeat.ogg'))
  check(audioClip, 'audio clip was not placed')

  await page.keyboard.press('Escape')
  await page.keyboard.press('3')
  await page.getByRole('button', { name: 'Analyze mix' }).click()
  await page.locator('.an-table tbody tr').first().waitFor({ timeout: 90000 })
  const rows = await page.locator('.an-table tbody tr').count()
  check(rows >= 6, `analyzer shows ${rows} sections`)
  await page.screenshot({ path: `${OUT}/phase4-mix.png` })

  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const download = page.waitForEvent('download', { timeout: 180000 })
  await page.locator('.modal').getByRole('button', { name: 'Export' }).click()
  const file = `${OUT}/studio-export.wav`
  await (await download).saveAs(file)
  const wav = readFileSync(file)
  check(wav.subarray(0, 4).toString() === 'RIFF' && wav.length > 1_000_000, `export is not a valid WAV (${wav.length} bytes)`)

  check(errors.length === 0, `page errors: ${errors.slice(0, 5).join(' | ')}`)
} finally {
  await browser.close()
}

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`Studio smoke passed. Screenshots in ${OUT}/`)
