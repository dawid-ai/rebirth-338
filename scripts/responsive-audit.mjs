import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  for (const width of [375, 600, 820, 1024, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 850 } })
    await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
    if (width === 375) {
      await page.screenshot({ path: 'artifacts/responsive-375.png' })
      await page.locator('.bass-machine').first().screenshot({ path: 'artifacts/bass-375.png' })
      await page.locator('.automation-editor').screenshot({ path: 'artifacts/automation-375.png' })
    }
    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector)
        if (!element) return null
        const rect = element.getBoundingClientRect()
        return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
      }
      return {
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: innerWidth,
        transport: box('.transport-panel'),
        bass: box('.bass-machine'),
        wave: box('.wave-designer'),
        drums: box('.drum-machine'),
        media: box('.media-bay'),
        mixer: box('.master-rack'),
        automation: box('.automation-editor'),
      }
    })
    console.log(width, layout)
    if (layout.documentWidth > width + 2) throw new Error(`Page overflows at ${width}px by ${layout.documentWidth - width}px`)
    for (const [name, rect] of Object.entries(layout)) {
      if (!rect || typeof rect !== 'object') continue
      if (rect.right > width + 2 || rect.left < -2) throw new Error(`${name} is clipped at ${width}px`)
    }
    await page.close()
  }
} finally {
  await browser.close()
}
