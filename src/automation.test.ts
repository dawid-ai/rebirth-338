import { describe, expect, it } from 'vitest'
import { applyChannelAutomation, automationValue, clearAutomationPosition, createDefaultProject, hydrateProject, setAutomationValue, shiftAutomationBars } from './model'

describe('channel automation', () => {
  it('layers global, bar and step settings without changing another channel or send', () => {
    let project = createDefaultProject()
    const bassTwoEcho = project.bass[1].delay
    project = setAutomationValue(project, 'bass-0', 'global', 0, 0, 'delay', 31)
    project = setAutomationValue(project, 'bass-0', 'bar', 2, 0, 'delay', 67)
    project = setAutomationValue(project, 'bass-0', 'step', 2, 4, 'delay', 93)
    project = setAutomationValue(project, 'bass-0', 'step', 2, 4, 'cutoff', 82)

    expect(project.bass[0].delay).toBe(31)
    expect(project.bass[1].delay).toBe(bassTwoEcho)
    expect(applyChannelAutomation(project, 1, 4).bass[0].delay).toBe(31)
    expect(applyChannelAutomation(project, 2, 3).bass[0].delay).toBe(67)
    expect(applyChannelAutomation(project, 2, 4).bass[0].delay).toBe(93)
    expect(applyChannelAutomation(project, 2, 5).bass[0].delay).toBe(67)
    expect(applyChannelAutomation(project, 2, 4).bass[0].cutoff).toBe(82)
    expect(project.bass[0].cutoff).not.toBe(82)

    const cleared = clearAutomationPosition(project, 'bass-0', 'step', 2, 4)
    expect(applyChannelAutomation(cleared, 2, 4).bass[0].delay).toBe(67)
  })

  it('persists machine, drum voice, and deck snapshots through hydration', () => {
    let project = createDefaultProject()
    project = setAutomationValue(project, 'drums-0', 'step', 0, 7, 'snare.tone', 88)
    project = setAutomationValue(project, 'deck-1', 'bar', 3, 0, 'filter', -40)
    const restored = hydrateProject(JSON.parse(JSON.stringify(project)))
    expect(automationValue(applyChannelAutomation(restored, 0, 7), 'drums-0', 'snare.tone')).toBe(88)
    expect(automationValue(applyChannelAutomation(restored, 3, 0), 'deck-1', 'filter')).toBe(-40)
    expect(restored.rhythms[0].drums.snare.tone).not.toBe(88)
  })

  it('moves automation with inserted and deleted song bars', () => {
    let project = setAutomationValue(createDefaultProject(), 'wave', 'step', 4, 6, 'cutoff', 91)
    project = shiftAutomationBars(project, 2, 1)
    expect(project.channelAutomation.wave?.steps['5:6']?.cutoff).toBe(91)
    project = shiftAutomationBars(project, 1, -1)
    expect(project.channelAutomation.wave?.steps['4:6']?.cutoff).toBe(91)
    project = shiftAutomationBars(project, 4, -1)
    expect(project.channelAutomation.wave?.steps['4:6']).toBeUndefined()
  })
})
