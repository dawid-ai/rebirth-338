import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('.workstation-shell')
  if (!await page.getByText('by DAWID.AI', { exact: true }).count()) throw new Error('Brand credit did not update')

  await page.evaluate(() => window.scrollTo(0, 650))
  const scrollBefore = await page.evaluate(() => window.scrollY)
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.waitForFunction(() => Number(document.querySelector('.digital-readout strong')?.textContent) >= 2, { timeout: 6000 })
  const scrollAfter = await page.evaluate(() => window.scrollY)
  if (Math.abs(scrollAfter - scrollBefore) > 40) throw new Error(`Song advanced but page jumped from ${scrollBefore} to ${scrollAfter}`)
  await page.getByRole('button', { name: 'Stop', exact: true }).click()

  const openProjects = () => page.getByRole('button', { name: 'Projects', exact: true }).click()
  const chooseDemo = async (id) => {
    await openProjects()
    await page.getByLabel('DEMO SONG').selectOption(id)
    await page.getByRole('button', { name: 'LOAD SELECTED DEMO' }).click()
    return page.evaluate(() => JSON.parse(localStorage.getItem('reborn338.autosave')))
  }
  const matrix = await chooseDemo('matrix')
  if (matrix.songChain.length !== 32 || matrix.tempo !== 112) throw new Error('Matrix tribute did not load its arrangement and sound')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await page.getByRole('slider', { name: 'Global drive' }).fill('88')
  await page.locator('.bass-machine.unit-1 .synth-controls input[type="range"]').first().fill('83')
  await page.getByRole('slider', { name: 'Performance crossfader' }).fill('-66')
  const edited = await page.evaluate(() => JSON.parse(localStorage.getItem('reborn338.autosave')))
  if (edited.masterDrive !== 88 || edited.bass[0].cutoff !== 83 || edited.crossfader !== -66) throw new Error('Sound edits were not captured')

  const blood = await chooseDemo('blood')
  if (blood.songChain.length !== 40 || blood.tempo !== 132 || blood.masterDrive === 88) throw new Error('Blood Rave tribute retained prior song settings')
  if (await page.getByRole('button', { name: 'Play', exact: true }).count() !== 1) throw new Error('Loading a song did not stop the old transport')
  const matrixAgain = await chooseDemo('matrix')
  if (JSON.stringify(matrixAgain) !== JSON.stringify(matrix)) throw new Error('Reloading the same demo did not restore its full original snapshot')

  await page.getByRole('slider', { name: 'Global drive' }).fill('57')
  await openProjects()
  await page.getByRole('button', { name: 'SAVE CURRENT PROJECT' }).click()
  const saved = await page.evaluate(() => {
    const [{ id }] = JSON.parse(localStorage.getItem('rebirth338:projects'))
    return { id, snapshot: JSON.parse(localStorage.getItem(`rebirth338:project:${id}`)) }
  })
  await page.getByRole('button', { name: 'Close projects' }).click()
  await chooseDemo('blood')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  await openProjects()
  await page.locator('.saved-list > div button:first-child').first().click()
  const restored = await page.evaluate(() => JSON.parse(localStorage.getItem('reborn338.autosave')))
  if (JSON.stringify(restored) !== JSON.stringify(saved.snapshot)) throw new Error('Saved project did not restore every setting and song cue')
  if (await page.getByRole('button', { name: 'Play', exact: true }).count() !== 1) throw new Error('Loading a saved project did not stop old playback')
  const rendered = await page.evaluate(async () => {
    const { createDemoProject } = await import('/src/demo/catalog.ts')
    const { GrooveEngine } = await import('/src/audio/engine.ts')
    const engine = new GrooveEngine()
    const result = []
    for (const id of ['matrix', 'blood']) {
      const wav = await engine.exportWav(createDemoProject(id), { bars: 2 })
      const pcm = new DataView(await wav.arrayBuffer())
      let energy = 0
      let count = 0
      for (let offset = 44; offset < pcm.byteLength; offset += 128) {
        const sample = pcm.getInt16(offset, true) / 32768
        energy += sample * sample
        count += 1
      }
      result.push({ id, rms: Math.sqrt(energy / count), bytes: pcm.byteLength })
    }
    return result
  })
  if (rendered.some((item) => item.rms < 0.001 || item.bytes < 100_000)) throw new Error(`A demo did not render audible audio: ${JSON.stringify(rendered)}`)
  if (errors.length) throw new Error(errors.join('; '))
  console.log(JSON.stringify({ scrollBefore, scrollAfter, demoBars: [48, matrix.songChain.length, blood.songChain.length], savedProject: saved.id, rendered, pageErrors: errors.length }))
} finally {
  await browser.close()
}
