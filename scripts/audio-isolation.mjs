import { chromium } from 'playwright'

const browser = await chromium.launch({ headless: true })
try {
  const page = await browser.newPage()
  await page.goto('http://127.0.0.1:5173', { waitUntil: 'domcontentloaded' })
  const levels = await page.evaluate(async () => {
    const { createDefaultProject } = await import('/src/model.ts')
    const { createDubstepDemoProject } = await import('/src/demo/dubstepDemo.ts')
    const { GrooveEngine } = await import('/src/audio/engine.ts')
    const project = createDubstepDemoProject(createDefaultProject())
    project.mode = 'pattern'
    project.bass[0].solo = true
    project.bass[0].steps = Array.from({ length: 16 }, (_, index) => ({
      active: index === 0, note: 48, accent: false, slide: false, octave: 0,
    }))
    project.delayMix = 0
    project.reverbMix = 0
    project.performance.beatRepeatMix = 100
    project.performance.beatRepeatDecay = 85
    project.performance.beatRepeatDivision = 4
    const engine = new GrooveEngine()
    const render = async (effectsEnabled, beatRepeat) => {
      project.effectsEnabled = effectsEnabled
      project.performance.beatRepeat = beatRepeat
      const wav = await engine.exportWav(project, { bars: 1 })
      const pcm = new DataView(await wav.arrayBuffer())
      const rms = (start, end) => {
        let sum = 0
        let samples = 0
        for (let frame = Math.floor(start * 44_100); frame < Math.floor(end * 44_100); frame += 1) {
          const value = pcm.getInt16(44 + frame * 4, true) / 32768
          sum += value * value
          samples += 1
        }
        return Math.sqrt(sum / samples)
      }
      return { attack: rms(0.06, 0.1), tail: rms(0.48, 0.75) }
    }
    return {
      dry: await render(false, false),
      bypassedRepeat: await render(false, true),
      audibleRepeat: await render(true, true),
    }
  })
  console.log('BASS_01_C3_ISOLATION', levels)
  if (levels.dry.attack < 0.001) throw new Error('Isolated C3 note was not audible')
  if (levels.bypassedRepeat.tail > levels.dry.tail * 1.5 + 0.0005) throw new Error('Beat Repeat leaked through All Echo FX OFF')
  if (levels.audibleRepeat.tail < levels.bypassedRepeat.tail * 3 + 0.001) throw new Error('Beat Repeat control case produced no repeats')
} finally {
  await browser.close()
}
