// Drives the six RE:BORN v2 Phase 0 validation tasks through the prototype
// UI and captures screenshots at the three target widths.
// Start the prototype first: npm run proto -- --host 127.0.0.1
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.PROTO_URL ?? 'http://127.0.0.1:5174'
const OUT = 'artifacts/phase0'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ headless: true })
const errors = []
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

try {
  for (const [width, height] of [[1024, 700], [1440, 900], [1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    page.on('pageerror', (error) => errors.push(`${width}: ${error.message}`))
    page.on('console', (message) => message.type() === 'error' && errors.push(`${width}: ${message.text()}`))
    await page.goto(URL, { waitUntil: 'networkidle' })
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      center: Math.round(document.querySelector('.workspace').getBoundingClientRect().width),
    }))
    check(layout.scrollWidth <= width, `${width}: document scrolls horizontally (${layout.scrollWidth})`)
    check(layout.scrollHeight <= height, `${width}: document scrolls vertically (${layout.scrollHeight})`)
    check(layout.center >= 640, `${width}: center workspace is ${layout.center}px, below 640`)
    await page.screenshot({ path: `${OUT}/arrange-${width}.png` })
    await page.locator('.clip').first().click()
    await page.screenshot({ path: `${OUT}/clip-${width}.png` })
    await page.keyboard.press('3')
    await page.screenshot({ path: `${OUT}/mix-${width}.png` })
    await page.close()
  }

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  page.on('pageerror', (error) => errors.push(`flow: ${error.message}`))
  await page.goto(URL, { waitUntil: 'networkidle' })

  // 1. Create and edit a bass pattern.
  const lane = page.locator('.track-row').first().locator('.lane')
  const box = await lane.boundingBox()
  const ppb = await page.locator('.arrange').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--ppb')))
  await page.mouse.dblclick(box.x + ppb * 33.5, box.y + box.height / 2)
  for (const [row, column] of [[8, 0], [8, 4], [4, 6], [8, 8], [6, 10], [1, 12]]) {
    await page.locator('.note-grid .note-row').nth(row).locator('.cell').nth(column).click()
  }
  await page.getByRole('button', { name: 'Accent step 7' }).click()
  await page.screenshot({ path: `${OUT}/task1-pattern.png` })

  // 2. Insert eight bars between Build and Drop.
  await page.locator('.sections').hover()
  await page.getByRole('button', { name: 'Insert 8 bars at bar 17' }).click()
  check((await page.locator('.section-tag').allTextContents()).join(' ').includes('New 8'), 'insert: new section missing')
  await page.screenshot({ path: `${OUT}/task2-insert.png` })

  // 3. Make one repeated clip unique.
  await page.locator('.clip', { hasText: 'Squelch A' }).nth(2).click()
  await page.locator('.link-bar').getByRole('button', { name: 'Make unique' }).click()
  await page.screenshot({ path: `${OUT}/task3-unique.png` })

  // 4. Find the source of audible echo.
  await page.locator('body').press('3')
  await page.getByRole('button', { name: 'Why can I hear echo?' }).click()
  await page.locator('.trace-bus li.is-suspicious button').first().click()
  await page.screenshot({ path: `${OUT}/task4-echo.png` })

  // 5. Chop a break and record a four-bar pad performance.
  await page.locator('body').press('1')
  await page.getByRole('button', { name: 'Samples' }).click()
  await page.locator('.browser-item.sample').first().dragTo(page.locator('.track-row').last().locator('.lane'))
  await page.waitForTimeout(900)
  await page.getByRole('radio', { name: 'Equal 16' }).click()
  await page.getByRole('button', { name: /Slices.*pads/ }).click()
  await page.screenshot({ path: `${OUT}/task5-chop.png` })
  await page.locator('body').press('r')
  await page.locator('body').press('Space')
  for (const key of ['m', ',', '.', 'j', 'k', 'u', 'm', '7']) {
    await page.waitForTimeout(240)
    await page.keyboard.press(key)
  }
  await page.waitForTimeout(400)
  await page.locator('body').press('Space')
  await page.waitForTimeout(200)
  check(await page.locator('.clip', { hasText: 'Pad take' }).count() === 1, 'pads: recorded clip missing')
  await page.screenshot({ path: `${OUT}/task5-take.png` })

  // 6. Preview and partially accept an agent change.
  await page.keyboard.press('Control+k')
  await page.getByRole('textbox', { name: 'Command or agent request' }).fill('Why is there echo in the drop?')
  await page.keyboard.press('Enter')
  await page.locator('.proposal').waitFor()
  await page.keyboard.press('Escape')
  await page.screenshot({ path: `${OUT}/task6-preview.png` })
  await page.locator('.changes li').last().locator('input').uncheck()
  await page.getByRole('button', { name: /Apply 2 selected/ }).click()
  await page.screenshot({ path: `${OUT}/task6-applied.png` })

  const tasks = await page.locator('.status-tasks').textContent()
  check(tasks?.includes('6/6'), `tasks: expected 6/6, got "${tasks}"`)
  await page.locator('.status-tasks').click()
  await page.screenshot({ path: `${OUT}/tasks.png` })

  // Undo reverts the agent edit as one step.
  await page.locator('body').press('Control+z')
  const last = await page.locator('.status-last').textContent()
  check(!last?.startsWith('Agent'), `undo: agent edit still last (${last})`)
} finally {
  await browser.close()
}

if (errors.length) failures.push(...errors.map((e) => `console: ${e}`))
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log(`Phase 0 smoke passed. Screenshots in ${OUT}/`)
