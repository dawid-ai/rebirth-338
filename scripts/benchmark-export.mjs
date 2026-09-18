import { chromium } from 'playwright'

const url = process.argv[2] ?? 'http://127.0.0.1:5173/'
const requestedBars = Number(process.argv[3] ?? 48)
const browser = await chromium.launch({
  headless: true,
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
})
const page = await browser.newPage()
page.on('console', (message) => {
  if (message.type() === 'error' || message.text().startsWith('EXPORT_PROGRESS')) process.stderr.write(`${message.text()}\n`)
})
await page.goto(url, { waitUntil: 'networkidle' })
const result = await page.evaluate(async (bars) => {
  const model = await import('/src/model.ts')
  const demo = await import('/src/demo/dubstepDemo.ts')
  const audio = await import('/src/audio/engine.ts')
  const project = demo.createDubstepDemoProject(model.createDefaultProject())
  project.songChain = project.songChain.slice(0, bars)
  project.sampler.slots[0].steps[0] = 1

  const rate = 44_100
  const frames = Math.round(rate * 0.18)
  const wav = new ArrayBuffer(44 + frames * 2)
  const view = new DataView(wav)
  const write = (offset, value) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index))
  }
  write(0, 'RIFF'); view.setUint32(4, wav.byteLength - 8, true)
  write(8, 'WAVE'); write(12, 'fmt ')
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true)
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true)
  write(36, 'data'); view.setUint32(40, frames * 2, true)
  for (let index = 0; index < frames; index += 1) {
    view.setInt16(44 + index * 2, Math.sin(index / rate * Math.PI * 2 * 220) * 12_000, true)
  }

  const engine = new audio.GrooveEngine()
  await engine.loadSample(0, wav)
  const start = performance.now()
  const blob = await engine.exportWav(project, { onProgress: (done, total) => console.log(`EXPORT_PROGRESS ${done}/${total} ${Math.round(performance.now() - start)}ms`) })
  const milliseconds = performance.now() - start
  const pcm = new DataView(await blob.arrayBuffer())
  let maxPcm = 0
  let fullScaleSamples = 0
  for (let offset = 44; offset < pcm.byteLength; offset += 2) {
    const sample = Math.abs(pcm.getInt16(offset, true))
    maxPcm = Math.max(maxPcm, sample)
    if (sample >= 32767) fullScaleSamples += 1
  }
  engine.dispose()
  return { milliseconds, bytes: blob.size, bars: project.songChain.length, maxPcm, fullScaleSamples }
}, requestedBars)
process.stdout.write(`${JSON.stringify(result)}\n`)
await browser.close()
