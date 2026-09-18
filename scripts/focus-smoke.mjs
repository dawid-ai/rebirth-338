import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  for (const width of [375, 600, 820, 920, 1024, 1180, 1280, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
    if (!await page.locator('.focus-workspace').count()) throw new Error('Focus view was not the default')
    if (!await page.locator('#bass-1').isVisible() || await page.locator('#bass-2').isVisible()) throw new Error(`Focus view did not isolate the selected machine: ${JSON.stringify(await page.evaluate(() => ({ module: document.querySelector('.focus-workspace')?.getAttribute('data-module'), parent: document.querySelector('#bass-2')?.parentElement?.className, bass1: getComputedStyle(document.querySelector('#bass-1')).display, bass2: getComputedStyle(document.querySelector('#bass-2')).display })))}`)
    if (width <= 1180) await page.getByRole('button', { name: 'CONTROLS / AUTOMATION' }).click()
    if (!await page.locator('.focus-inspector').isVisible()) throw new Error('Focused controls were not visible')
    if (width === 375) {
      await page.locator('.focus-command').scrollIntoViewIfNeeded()
      await page.screenshot({ path: 'artifacts/focus-mobile.png' })
    }
    if (width === 1440) {
      await page.locator('.focus-command').scrollIntoViewIfNeeded()
      await page.screenshot({ path: 'artifacts/focus-desktop.png' })
    }
    for (const [label, selector] of [['303·2', '#bass-2'], ['WAVE', '#wave-designer'], ['909', '#drum-909'], ['LIVE', '#performance-deck'], ['MEDIA', '#media-bay']]) {
      await page.getByRole('navigation', { name: 'Focus module' }).getByRole('button', { name: label, exact: true }).click()
      if (!await page.locator(selector).isVisible()) throw new Error(`${label} was not reachable in focus view`)
      if (label === 'MEDIA' && width === 1280) await page.screenshot({ path: 'artifacts/focus-media-1280.png' })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
      if (overflow > 2) throw new Error(`${label} overflows ${width}px viewport by ${overflow}px`)
    }
    await page.getByRole('button', { name: '808', exact: true }).last().click()
    if (!await page.locator('#drum-808').isVisible() || await page.locator('#bass-1').isVisible()) throw new Error('Focus rail did not switch machines')
    if (width <= 1180) await page.getByRole('button', { name: 'MACHINE', exact: true }).click()
    await page.locator('#drum-808 .drum-voices button').nth(1).click()
    if (await page.locator('.focus-inspector select[aria-label="Automation drum voice"]').inputValue() !== 'snare') throw new Error('Inspector did not follow the selected drum voice')
    await page.locator('#drum-808 .drum-step-bank button').first().click()
    if (width <= 1180) await page.getByRole('button', { name: 'CONTROLS / AUTOMATION' }).click()
    if (await page.locator('.focus-inspector .automation-scope button').last().getAttribute('aria-pressed') !== 'true') throw new Error('Selecting a key did not target step automation')
    await page.locator('.focus-inspector').getByRole('button', { name: 'GLOBAL BASE' }).click()
    if (width <= 1180) await page.getByRole('button', { name: 'MACHINE', exact: true }).click()
    await page.locator('#drum-808 .drum-step-bank button').first().click()
    if (width <= 1180) await page.getByRole('button', { name: 'CONTROLS / AUTOMATION' }).click()
    if (await page.locator('.focus-inspector .automation-scope button').last().getAttribute('aria-pressed') !== 'true') throw new Error('Clicking the same key again did not restore step context')
    await page.locator('.computer-keyboard').getByRole('button', { name: 'WAVE', exact: true }).click()
    if (!await page.locator('#wave-designer').isVisible() || await page.locator('#drum-808').isVisible()) throw new Error('Keyboard target did not follow the focus workspace')
    await page.getByRole('navigation', { name: 'Focus module' }).getByRole('button', { name: 'MIX', exact: true }).click()
    if (!await page.locator('.master-rack').isVisible() || !await page.locator('.export-button').isVisible()) throw new Error('Mix tab did not expose master controls and export')
    await page.getByRole('button', { name: 'OVERVIEW', exact: true }).click()
    if (!await page.locator('#bass-1').isVisible() || !await page.locator('#drum-808').isVisible()) throw new Error('Overview did not restore the full rack')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    if (overflow > 2) throw new Error(`${width}px layout overflows by ${overflow}px`)
    if (errors.length) throw new Error(`${width}px page errors: ${errors.join(', ')}`)
    console.log({ width, focusSwitch: true, stepContext: true, overview: true, overflow })
    await page.close()
  }
} finally {
  await browser.close()
}
