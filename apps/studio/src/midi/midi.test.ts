import { describe, expect, it } from 'vitest'
import { type MidiTarget, bindControl, describeControl, lookupControl, parseMidi, unbindControl } from './midi'

const cutoff: MidiTarget = { kind: 'param', trackId: 'trk1', param: 'device.cutoff', label: 'Acid Cutoff' }
const play: MidiTarget = { kind: 'transport', action: 'play', label: 'Play' }

describe('parseMidi', () => {
  it('reads control changes with channel and normalized value', () => {
    expect(parseMidi([0xb0, 74, 127])).toEqual({ control: 'cc:1:74', kind: 'cc', value: 1 })
    expect(parseMidi([0xb9, 1, 0])).toEqual({ control: 'cc:10:1', kind: 'cc', value: 0 })
  })

  it('reads note-on and ignores note-off, velocity zero, and short messages', () => {
    expect(parseMidi([0x99, 36, 100])?.control).toBe('note:10:36')
    expect(parseMidi([0x80, 36, 100])).toBeNull()
    expect(parseMidi([0x90, 36, 0])).toBeNull()
    expect(parseMidi([0xf8])).toBeNull()
  })
})

describe('profiles', () => {
  it('keeps bindings separate per input', () => {
    const profiles = bindControl({}, 'Launch Control', 'cc:1:74', cutoff)
    expect(lookupControl(profiles, 'Launch Control', 'cc:1:74')).toEqual(cutoff)
    expect(lookupControl(profiles, 'Other', 'cc:1:74')).toBeUndefined()
  })

  it('moves a target to the newest control and replaces a reused control', () => {
    let profiles = bindControl({}, 'pad', 'cc:1:74', cutoff)
    profiles = bindControl(profiles, 'pad', 'cc:1:75', cutoff)
    expect(Object.keys(profiles.pad)).toEqual(['cc:1:75'])
    profiles = bindControl(profiles, 'pad', 'cc:1:75', play)
    expect(profiles.pad).toEqual({ 'cc:1:75': play })
  })

  it('removes one binding', () => {
    const profiles = unbindControl(bindControl({}, 'pad', 'note:1:60', play), 'pad', 'note:1:60')
    expect(profiles.pad).toEqual({})
  })
})

describe('describeControl', () => {
  it('names controls and notes', () => {
    expect(describeControl('cc:1:74')).toBe('CC 74 · ch 1')
    expect(describeControl('note:10:36')).toBe('C2 · ch 10')
  })
})
