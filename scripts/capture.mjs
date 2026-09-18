import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const [width = 1440, height = 900] = process.argv.slice(2).map(Number)
const performance = process.argv.includes('performance')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 })
await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded', timeout: 10_000 })
await page.waitForSelector('.workstation-shell')
if (performance) {
  await page.getByRole('button', { name: 'LIVE', exact: true }).click()
  await page.waitForTimeout(2300)
}
await page.evaluate(() => document.fonts.ready)
await mkdir('artifacts', { recursive: true })
await page.screenshot({ path: `artifacts/reborn-${width}${performance ? '-performance' : ''}.png`, fullPage: true })
const summary = await page.evaluate(() => ({
  title: document.title,
  buttons: document.querySelectorAll('button').length,
  labels: document.querySelectorAll('label').length,
  width: document.documentElement.scrollWidth,
  height: document.documentElement.scrollHeight,
}))
console.log(JSON.stringify(summary))
await browser.close()
