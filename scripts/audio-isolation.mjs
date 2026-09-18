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
    project.bass.forEach((voice) => {
      voice.delay = 0
      voice.reverb = 0
      voice.steps = Array.from({ length: 16 }, (_, index) => ({
        active: index === 0, note: 48, accent: false, slide: false, octave: 0,
      }))
    })
    project.delayMix = 0
    project.reverbMix = 0
    project.performance.beatRepeatMix = 100
    project.performance.beatRepeatDecay = 85
    project.performance.beatRepeatDivision = 4
    const engine = new GrooveEngine()
    const render = async (effectsEnabled, beatRepeat, bassIndex = 0, echoMix = 0, reverbMix = 0) => {
      project.effectsEnabled = effectsEnabled
      project.performance.beatRepeat = beatRepeat
      project.delayMix = echoMix
      project.reverbMix = reverbMix
      project.bass.forEach((voice, index) => { voice.solo = index === bassIndex })
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
      return { attack: rms(0.06, 0.1), earlyTail: rms(0.18, 0.3), tail: rms(0.48, 0.75) }
    }
    return {
      dry: await render(false, false),
      bypassedRepeat: await render(false, true),
      audibleRepeat: await render(true, true),
      bass01Dry: await render(true, false, 0),
      bass01Echo: await render(true, false, 0, 70),
      bass01Reverb: await render(true, false, 0, 0, 70),
      bass02Dry: await render(true, false, 1),
      bass02Echo: await render(true, false, 1, 70),
      bass02Reverb: await render(true, false, 1, 0, 70),
      bass01Bypassed: await render(false, false, 0, 70, 70),
    }
  })
  console.log('BASS_01_C3_ISOLATION', levels)
  if (levels.dry.attack < 0.001) throw new Error('Isolated C3 note was not audible')
  if (levels.bypassedRepeat.tail > levels.dry.tail * 1.5 + 0.0005) throw new Error('Beat Repeat leaked through All Echo FX OFF')
  if (levels.audibleRepeat.tail < levels.bypassedRepeat.tail * 3 + 0.001) throw new Error('Beat Repeat control case produced no repeats')
  for (const name of ['bass01', 'bass02']) {
    if (levels[`${name}Echo`].earlyTail < levels[`${name}Dry`].earlyTail * 3 + 0.001) throw new Error(`${name} received no global echo with channel send at zero`)
    if (levels[`${name}Reverb`].tail < levels[`${name}Dry`].tail * 3 + 0.00015) throw new Error(`${name} received no global reverb with channel send at zero`)
  }
  if (levels.bass01Bypassed.tail > levels.bass01Dry.tail * 1.5 + 0.0005) throw new Error('Global FX bypass leaked echo or reverb')
} finally {
  await browser.close()
}
