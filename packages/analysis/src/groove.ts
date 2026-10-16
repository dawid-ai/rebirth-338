/**
 * Extracts a groove template from onset times: for each step position in a
 * bar, the average distance of nearby onsets from the straight grid, as a
 * fraction of one step (-0.5..0.5). Steps with no onsets get 0.
 */
export function extractGroove(onsets: readonly number[], bpm: number, stepsPerBar = 16): number[] {
  const stepSeconds = 60 / bpm / (stepsPerBar / 4)
  const sums = new Array<number>(stepsPerBar).fill(0)
  const counts = new Array<number>(stepsPerBar).fill(0)
  for (const time of onsets) {
    const position = time / stepSeconds
    const nearest = Math.round(position)
    const offset = position - nearest
    // Ignore onsets far from any step; they are fills or noise, not feel.
    if (Math.abs(offset) > 0.45) continue
    const step = ((nearest % stepsPerBar) + stepsPerBar) % stepsPerBar
    sums[step] += offset
    counts[step] += 1
  }
  return sums.map((sum, i) => (counts[i] ? Math.round((sum / counts[i]) * 1000) / 1000 || 0 : 0))
}
