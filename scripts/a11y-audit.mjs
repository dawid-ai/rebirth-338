// Accessibility audit of the studio with axe-core. Fails on serious or
// critical violations. Start the studio dev server first (port 5175).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.STUDIO_URL ?? 'http://127.0.0.1:5175/?e2e&fresh'
const axe = readFileSync('node_modules/axe-core/axe.min.js', 'utf8')
mkdirSync('artifacts/a11y', { recursive: true })
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(URL, { waitUntil: 'networkidle' })

const scenes = [
  ['arrange', async () => {}],
  ['clip selected', async () => page.locator('.clip').first().click()],
  ['track selected', async () => page.locator('.track-head').first().click()],
  ['build', async () => page.keyboard.press('2')],
  ['mix', async () => page.keyboard.press('3')],
  ['perform', async () => page.keyboard.press('4')],
  ['help', async () => { await page.keyboard.press('1'); await page.keyboard.press('F1') }],
  ['palette', async () => { await page.keyboard.press('Escape'); await page.locator('.modal-backdrop').click({ position: { x: 5, y: 5 } }).catch(() => {}); await page.keyboard.press('Control+k') }],
  ['agent', async () => { await page.keyboard.press('Escape'); await page.getByRole('button', { name: /^Agent/ }).click() }],
]
const report = []
for (const [name, act] of scenes) {
  await act()
  await page.waitForTimeout(300)
  // Measure contrast after enter transitions settle, not mid-fade.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity))
  await page.addScriptTag({ content: axe })
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, { resultTypes: ['violations'], rules: { region: { enabled: false } } })
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 4).map((n) => `${n.target.join(' ')} (${n.any[0]?.message ?? n.failureSummary})`), count: v.nodes.length }))
  })
  report.push({ scene: name, violations: result })
}
await browser.close()
writeFileSync('artifacts/a11y/report.json', JSON.stringify(report, null, 2))
const serious = report.flatMap((r) => r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({ scene: r.scene, ...v })))
const byRule = new Map()
for (const v of serious) byRule.set(v.id, [...(byRule.get(v.id) ?? []), v])
for (const [id, list] of byRule) console.log(`${id} (${list[0].impact}): ${list[0].help} — ${list.map((v) => `${v.scene}: ${v.count}`).join(', ')}\n  e.g. ${list[0].nodes.join(' | ')}`)
if (serious.length) process.exit(1)
console.log('Accessibility audit passed: no serious or critical violations.')
