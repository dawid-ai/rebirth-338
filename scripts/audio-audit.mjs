// Audio audit for the v2 engine (Phase 7 quality gates). Runs in Chromium
// against the studio dev server (port 5175):
//   1. Golden renders for every device and effect (fingerprints in
//      scripts/golden/audio.json; pass --update to rewrite them).
//   2. Offline parity: chunked and single-pass renders match per bar.
//   3. Live/offline parity: the live meter envelope must follow the offline
//      render of the same bars.
//   4. Migration: each v1 demo rendered by the v1 engine and, after import,
//      by the v2 engine must keep its length, loudness, and tonal balance.
//   5. Stress: a ten-minute project plays without drift or unbounded memory
//      growth (STRESS_SECONDS sets the sampled duration; default 30).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { chromium } from 'playwright'

const URL = process.env.STUDIO_URL ?? 'http://127.0.0.1:5175/?e2e&fresh'
const GOLDEN = 'scripts/golden/audio.json'
const update = process.argv.includes('--update') || !existsSync(GOLDEN)
const stressSeconds = Number(process.env.STRESS_SECONDS ?? 30)
const failures = []
const check = (ok, message) => {
  if (!ok) failures.push(message)
}

const browser = await chromium.launch({ headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--enable-precise-memory-info', '--js-flags=--expose-gc'] })
const page = await browser.newPage()
page.on('pageerror', (e) => failures.push(`page error: ${e.message}`))
await page.goto(URL, { waitUntil: 'networkidle' })
await page.waitForFunction(() => Boolean(window.__studio?.audit))

// 1. Golden renders ------------------------------------------------------------
const fingerprints = await page.evaluate(async () => {
  const { core, studioEngine, analysis } = window.__studio.audit
  const S = core.studio
  const ctx = new OfflineAudioContext(1, 44100, 44100)
  const sine = ctx.createBuffer(1, 22050, 44100)
  const data = sine.getChannelData(0)
  for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * 220 * i) / 44100) * Math.exp(-i / 6000) * 0.8
  const buffers = new Map([['sine', sine]])
  const build = (kind, commands, tweak = (p) => p) => {
    let p = S.emptyStudioProject('Golden')
    p.tempo = 120
    p.length = 1
    p = S.executeBatch(p, [{ type: 'track.add', params: { kind, name: 'T' } }]).project
    p = S.executeBatch(p, [{ type: 'mixer.set', params: { trackId: 'T', volume: 0 } }, ...commands]).project
    return tweak(p)
  }
  const scenarios = {
    'acid-classic': build('acid', [{ type: 'pattern.write', params: { trackId: 'T', steps: 'C2 . D#2! C3~ . G2 . . C2 . . A#1 . C2! . . .' } }]),
    'acid-designer': build('acid', [{ type: 'device.update', params: { trackId: 'T', source: 'designer', designerWaveform: 'triangle' } }, { type: 'pattern.write', params: { trackId: 'T', steps: 'C2 . D#2! C3~ . G2 . . C2 . . A#1 . C2! . . .' } }]),
    wave: build('wave', [{ type: 'pattern.write', params: { trackId: 'T', steps: 'C4 . . . E4 . . . G4 . . . C5 . . .' } }]),
    sampler: build('sampler', [], (p) => {
      p = S.executeBatch(p, [{ type: 'asset.add', params: { asset: { id: 'sine', name: 'sine', mimeType: 'audio/wav', bytes: 1, duration: 0.5, channels: 1, sampleRate: 44100, origin: { kind: 'generated', createdAt: '' } } } }]).project
      p = S.executeBatch(p, [{ type: 'sample.slice', params: { trackId: 'T', assetId: 'sine', slices: [0, 0.5], assignPads: true } }]).project
      const clip = S.executeBatch(p, [{ type: 'clip.create', params: { trackId: 'T', start: 0, length: 1 } }])
      p = clip.project
      return S.executeBatch(p, [{ type: 'pad.hit', params: { patternId: clip.results[0].patternId, step: 0, pad: 0 } }, { type: 'pad.hit', params: { patternId: clip.results[0].patternId, step: 8, pad: 1 } }]).project
    }),
    'delay-return': build('acid', [{ type: 'pattern.write', params: { trackId: 'T', steps: 'C3! . . . . . . . . . . . . . . .' } }, { type: 'send.set', params: { trackId: 'T', returnId: 'delay', level: 0.8 } }]),
    'reverb-return': build('acid', [{ type: 'pattern.write', params: { trackId: 'T', steps: 'C3! . . . . . . . . . . . . . . .' } }, { type: 'send.set', params: { trackId: 'T', returnId: 'reverb', level: 0.8 } }]),
  }
  for (const kit of ['808', '909']) {
    for (const voice of S.DRUM_VOICES) {
      scenarios[`drum-${kit}-${voice}`] = build('drum', [{ type: 'device.update', params: { trackId: 'T', kit } }, { type: 'pattern.write', params: { trackId: 'T', voice, steps: 'X...x...........' } }])
    }
  }
  const result = {}
  for (const [name, project] of Object.entries(scenarios)) {
    const rendered = await studioEngine.renderStudio(project, buffers, { tail: name.endsWith('return') ? 2.5 : 1 })
    const bands = analysis.bandEnergies(rendered.channels, rendered.sampleRate)
    // Return scenarios also fingerprint the wet tail after the dry note ends,
    // so a silent return fails even though the dry hit dominates the RMS.
    const tail = name.endsWith('return') ? { tailRmsDb: Math.round(analysis.rms(rendered.channels.map((c) => c.subarray(Math.round(0.37 * rendered.sampleRate), Math.round(0.9 * rendered.sampleRate)))) * 10) / 10 } : {}
    result[name] = {
      ...tail,
      rmsDb: Math.round(analysis.rms(rendered.channels) * 10) / 10,
      peakDb: Math.round(analysis.peak(rendered.channels) * 10) / 10,
      bands: Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, Math.round(v.share * 1000) / 1000])),
    }
  }
  return result
})
const silent = Object.entries(fingerprints).filter(([, f]) => f.rmsDb < -70 || (f.tailRmsDb !== undefined && f.tailRmsDb < -60)).map(([n]) => n)
check(silent.length === 0, `silent renders: ${silent.join(', ')}`)
if (update) {
  mkdirSync('scripts/golden', { recursive: true })
  writeFileSync(GOLDEN, `${JSON.stringify(fingerprints, null, 2)}\n`)
  console.log(`Wrote ${Object.keys(fingerprints).length} golden fingerprints to ${GOLDEN}`)
} else {
  const golden = JSON.parse(readFileSync(GOLDEN, 'utf8'))
  for (const [name, expected] of Object.entries(golden)) {
    const actual = fingerprints[name]
    if (!actual) {
      failures.push(`golden ${name}: no longer rendered`)
      continue
    }
    if (Math.abs(actual.rmsDb - expected.rmsDb) > 1) failures.push(`golden ${name}: RMS ${actual.rmsDb} dB, expected ${expected.rmsDb} ± 1`)
    if (expected.tailRmsDb !== undefined && !(Math.abs((actual.tailRmsDb ?? -200) - expected.tailRmsDb) <= 1.5)) failures.push(`golden ${name}: wet tail ${actual.tailRmsDb} dB, expected ${expected.tailRmsDb} ± 1.5`)
    if (Math.abs(actual.peakDb - expected.peakDb) > 1.5) failures.push(`golden ${name}: peak ${actual.peakDb} dB, expected ${expected.peakDb} ± 1.5`)
    const drift = Object.keys(expected.bands).reduce((sum, band) => sum + Math.abs((actual.bands[band] ?? 0) - expected.bands[band]), 0)
    if (drift > 0.08) failures.push(`golden ${name}: band balance moved by ${drift.toFixed(3)}`)
  }
  console.log(`Compared ${Object.keys(golden).length} golden renders.`)
}

// 2. Offline parity: chunked vs single pass ------------------------------------
// Web Audio automation is not sample-exact across start offsets, so chunked
// and single-pass renders cannot match bit for bit. They must match per bar
// in loudness and tonal balance, and chunk seams must not click.
const offline = await page.evaluate(async () => {
  const { core, studioEngine, analysis } = window.__studio.audit
  const project = core.studio.createDefaultStudioProject('Parity')
  const a = await studioEngine.renderStudio(project, new Map(), { chunkBars: 1 })
  const b = await studioEngine.renderStudio(project, new Map(), { chunkBars: 64 })
  const barSeconds = (60 / project.tempo) * 4
  const ranges = Array.from({ length: project.length }, (_, bar) => ({ id: String(bar), start: bar * barSeconds, end: (bar + 1) * barSeconds }))
  const ra = analysis.analyzeRanges(a.channels, a.sampleRate, ranges)
  const rb = analysis.analyzeRanges(b.channels, b.sampleRate, ranges)
  let maxLoudness = 0
  let maxBalance = 0
  for (let i = 0; i < ranges.length; i += 1) {
    if (ra[i].loudnessLufs < -60) continue
    maxLoudness = Math.max(maxLoudness, Math.abs(ra[i].loudnessLufs - rb[i].loudnessLufs))
    maxBalance = Math.max(maxBalance, Object.keys(ra[i].bands).reduce((sum, k) => sum + Math.abs(ra[i].bands[k].share - rb[i].bands[k].share), 0))
  }
  // A click shows as a sample-to-sample jump far above the signal's own.
  const jump = (ch, from, to) => {
    let max = 0
    for (let i = Math.max(1, from); i < to; i += 1) max = Math.max(max, Math.abs(ch[i] - ch[i - 1]))
    return max
  }
  let seamExcess = 0
  for (let bar = 1; bar < project.length; bar += 1) {
    const at = Math.round(bar * barSeconds * a.sampleRate)
    for (let c = 0; c < 2; c += 1) {
      const chunked = jump(a.channels[c], at - 64, at + 64)
      const single = jump(b.channels[c], at - 64, at + 64)
      seamExcess = Math.max(seamExcess, chunked - single)
    }
  }
  return { lengths: [a.channels[0].length, b.channels[0].length], maxLoudness, maxBalance, seamExcess }
})
check(offline.lengths[0] === offline.lengths[1], `chunked and single-pass lengths differ ${offline.lengths}`)
check(offline.maxLoudness < 0.5, `chunked render loudness differs by ${offline.maxLoudness.toFixed(2)} LU in a bar (limit 0.5)`)
check(offline.maxBalance < 0.05, `chunked render tonal balance differs by ${offline.maxBalance.toFixed(3)} in a bar (limit 0.05)`)
check(offline.seamExcess < 0.005, `a chunk seam steps ${offline.seamExcess.toFixed(4)} more than the single-pass render there (limit 0.005)`)
console.log(`Offline parity: per-bar loudness within ${offline.maxLoudness.toFixed(2)} LU, balance within ${offline.maxBalance.toFixed(3)}, worst seam step ${offline.seamExcess.toFixed(5)} above the single-pass render.`)
// 3. Live vs offline envelope ----------------------------------------------------
const live = await page.evaluate(async () => {
  const { engine } = window.__studio
  const { studioEngine } = window.__studio.audit
  const project = window.__studio.getState().project
  const samples = []
  engine.seek(0)
  await engine.play(0)
  const started = performance.now()
  while (performance.now() - started < 8500) {
    await new Promise((r) => setTimeout(r, 40))
    samples.push([engine.position(), engine.outputLevel()])
  }
  engine.stop()
  const rendered = await studioEngine.renderStudio(project, engine.assetBuffers(), { from: 0, to: 4, tail: 0.5 })
  const barSeconds = (60 / project.tempo) * 4
  const offlineLevel = (bar) => {
    const end = Math.floor(bar * barSeconds * rendered.sampleRate)
    const start = Math.max(0, end - 2048)
    let sum = 0
    for (let c = 0; c < 2; c += 1) for (let i = start; i < end; i += 1) sum += rendered.channels[c][i] ** 2
    return Math.min(1, Math.sqrt(sum / Math.max(1, (end - start) * 2)) * 3.2)
  }
  const pairs = samples.filter(([bar]) => bar > 0.1 && bar < 3.9).map(([bar, level]) => [level, offlineLevel(bar)])
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length)
  const lx = pairs.map((p) => p[0])
  const ox = pairs.map((p) => p[1])
  const mx = mean(lx)
  const my = mean(ox)
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < pairs.length; i += 1) {
    cov += (lx[i] - mx) * (ox[i] - my)
    vx += (lx[i] - mx) ** 2
    vy += (ox[i] - my) ** 2
  }
  return { samples: pairs.length, correlation: cov / Math.sqrt(vx * vy || 1), meanLive: mx, meanOffline: my }
})
check(live.samples > 40, `too few live samples (${live.samples})`)
check(live.correlation > 0.6, `live and offline envelopes disagree (correlation ${live.correlation.toFixed(2)})`)
check(Math.abs(live.meanLive - live.meanOffline) < 0.12, `live and offline levels differ (${live.meanLive.toFixed(3)} vs ${live.meanOffline.toFixed(3)})`)
console.log(`Live/offline: ${live.samples} samples, correlation ${live.correlation.toFixed(2)}, mean level ${live.meanLive.toFixed(3)} vs ${live.meanOffline.toFixed(3)}.`)

// 4. Migration: v1 engine vs v2 after import ----------------------------------------
const migration = await page.evaluate(async () => {
  const { core, studioEngine, analysis, v1Engine } = window.__studio.audit
  const results = []
  for (const demo of core.demoCatalog) {
    const v1 = core.createDemoProject(demo.id)
    const legacy = new v1Engine.GrooveEngine()
    for (let i = 0; i < v1.sampler.slots.length; i += 1) {
      const id = v1.sampler.slots[i].assetId
      if (!id?.startsWith('builtin:')) continue
      const blob = await (await fetch(`/audio/starter/${id.slice(8)}`)).blob()
      await legacy.loadSample(i, blob)
    }
    const wav = await (await legacy.exportWav(v1)).arrayBuffer()
    legacy.dispose()
    const decodeContext = new OfflineAudioContext(2, 1, 44100)
    const decoded = await decodeContext.decodeAudioData(wav)
    const v1Channels = [decoded.getChannelData(0), decoded.getChannelData(1)]
    const { project } = core.studio.importV1Project(v1)
    const buffers = new Map()
    for (const id of Object.keys(project.assets)) {
      if (!id.startsWith('builtin:')) continue
      const bytes = await (await fetch(`/audio/starter/${id.slice(8)}`)).arrayBuffer()
      buffers.set(id, await decodeContext.decodeAudioData(bytes))
    }
    const rendered = await studioEngine.renderStudio(project, buffers)
    const measure = (channels, sampleRate, seconds) => {
      const r = analysis.analyzeRanges(channels, sampleRate, [{ id: 'm', start: 0, end: seconds }])[0]
      return { lufs: r.loudnessLufs, bands: Object.fromEntries(Object.entries(r.bands).map(([k, v]) => [k, v.share])) }
    }
    const seconds = rendered.musicalSeconds
    const a = measure(v1Channels, decoded.sampleRate, seconds)
    const b = measure(rendered.channels, rendered.sampleRate, seconds)
    const balance = Object.keys(a.bands).reduce((sum, k) => sum + Math.abs(a.bands[k] - b.bands[k]), 0)
    results.push({ demo: demo.id, v1Seconds: decoded.duration, v2Seconds: rendered.channels[0].length / rendered.sampleRate, musicalSeconds: seconds, lufs: [a.lufs, b.lufs], balance })
  }
  return results
})
for (const m of migration) {
  check(m.v1Seconds >= m.musicalSeconds && m.v2Seconds >= m.musicalSeconds, `${m.demo}: a render is shorter than the song`)
  check(Math.abs(m.lufs[0] - m.lufs[1]) <= 3, `${m.demo}: loudness moved from ${m.lufs[0].toFixed(1)} to ${m.lufs[1].toFixed(1)} LUFS (limit ±3 LU)`)
  check(m.balance <= 0.3, `${m.demo}: tonal balance moved by ${m.balance.toFixed(2)} (limit 0.3)`)
  console.log(`Migration ${m.demo}: ${m.lufs[0].toFixed(1)} → ${m.lufs[1].toFixed(1)} LUFS, balance change ${m.balance.toFixed(2)}.`)
}

// 5. Stress: ten-minute project ---------------------------------------------------
const stress = await page.evaluate(async (seconds) => {
  const { core, store } = window.__studio.audit
  const { engine } = window.__studio
  let project = core.studio.createDefaultStudioProject('Stress')
  project = { ...project, tempo: 120 }
  const commands = project.clips.map((c) => ({ type: 'clip.resize', params: { clipId: c.id, length: 300 - c.start } }))
  project = core.studio.executeBatch(project, commands).project
  store.loadProject(project, { path: null, savedRevision: null })
  await new Promise((r) => setTimeout(r, 200))
  const barSeconds = 2
  globalThis.gc?.()
  const heapStart = performance.memory?.usedJSHeapSize ?? 0
  await engine.play(0)
  const t0 = performance.now()
  const p0 = engine.position()
  let maxDriftMs = 0
  while (performance.now() - t0 < seconds * 1000) {
    await new Promise((r) => setTimeout(r, 1000))
    const expected = p0 + (performance.now() - t0) / 1000 / barSeconds
    maxDriftMs = Math.max(maxDriftMs, Math.abs(engine.position() - expected) * barSeconds * 1000)
  }
  engine.stop()
  globalThis.gc?.()
  await new Promise((r) => setTimeout(r, 500))
  const heapEnd = performance.memory?.usedJSHeapSize ?? 0
  return { length: project.length, maxDriftMs, heapGrowthMb: (heapEnd - heapStart) / 1048576 }
}, stressSeconds)
check(stress.length >= 300, `stress project is ${stress.length} bars`)
check(stress.maxDriftMs < 60, `scheduler drifted ${stress.maxDriftMs.toFixed(1)} ms over ${stressSeconds} s`)
check(stress.heapGrowthMb < 64, `heap grew ${stress.heapGrowthMb.toFixed(1)} MB over ${stressSeconds} s`)
console.log(`Stress: ${stress.length} bars, max drift ${stress.maxDriftMs.toFixed(1)} ms, heap growth ${stress.heapGrowthMb.toFixed(1)} MB over ${stressSeconds} s.`)

await browser.close()
if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Audio audit passed.')
