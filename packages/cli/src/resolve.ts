import { CliError, EXIT, usageError } from './errors'

// Resolves the loose references people type ("acid-1", "808.kick",
// "cutoff 62") into the IDs and units the command registry expects.

export interface TrackRef {
  id: string
  name: string
  kind?: string
}

export interface ParamInfo {
  id: string
  label?: string
  min: number
  max: number
  unit?: string
  value?: number
}

export const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** Matches by ID, then name (any case), then slug, so "acid-1" finds "Acid 1". */
export function findTrack(tracks: readonly TrackRef[], ref: string): TrackRef | null {
  const exact = tracks.find((t) => t.id === ref) ?? tracks.find((t) => t.name.toLowerCase() === ref.toLowerCase())
  if (exact) return exact
  const key = slug(ref)
  if (!key) return null
  const matches = tracks.filter((t) => slug(t.name) === key)
  if (matches.length > 1) throw usageError(`"${ref}" matches several tracks: ${matches.map((t) => t.name).join(', ')}. Use the track ID.`)
  return matches[0] ?? null
}

export function requireTrackRef(tracks: readonly TrackRef[], ref: string): TrackRef {
  const track = findTrack(tracks, ref)
  if (!track) throw noTrack(tracks, ref)
  return track
}

const noTrack = (tracks: readonly TrackRef[], ref: string) =>
  new CliError(`No track "${ref}".`, EXIT.generic, 'not_found', tracks.length ? `Tracks: ${tracks.map((t) => t.name).join(', ')}.` : 'The project has no tracks.')

/**
 * Splits "<track>.<rest>" where the track name may itself contain dots.
 * Prefers the longest track reference that resolves.
 */
export function splitTarget(tracks: readonly TrackRef[], target: string, options: { restRequired: boolean }): { track: TrackRef; rest: string | null } {
  if (!options.restRequired) {
    const whole = findTrack(tracks, target)
    if (whole) return { track: whole, rest: null }
  }
  const parts = target.split('.')
  for (let cut = parts.length - 1; cut >= 1; cut--) {
    const track = findTrack(tracks, parts.slice(0, cut).join('.'))
    if (track) return { track, rest: parts.slice(cut).join('.') }
  }
  if (options.restRequired && parts.length < 2) throw usageError(`"${target}" needs the form <track>.<param>, for example "Acid 1".device.cutoff or acid-1.cutoff.`)
  throw noTrack(tracks, parts.length > 1 ? parts.slice(0, -1).join('.') : target)
}

/** Finds a parameter by full ID, then `device.<name>`, then a unique ID suffix. */
export function resolveParam(params: readonly ParamInfo[], trackName: string, name: string): ParamInfo {
  const lower = name.toLowerCase()
  const byId = (id: string) => params.find((p) => p.id.toLowerCase() === id)
  const found = byId(lower) ?? byId(`device.${lower}`)
  if (found) return found
  const suffix = params.filter((p) => p.id.toLowerCase().endsWith(`.${lower}`))
  if (suffix.length === 1) return suffix[0]
  if (suffix.length > 1) throw usageError(`"${name}" is ambiguous on ${trackName}: ${suffix.map((p) => p.id).join(', ')}.`)
  const near = params.filter((p) => p.id.toLowerCase().includes(lower)).slice(0, 8)
  throw new CliError(`${trackName} has no parameter "${name}".`, EXIT.generic, 'not_found', near.length ? `Did you mean ${near.map((p) => p.id).join(', ')}?` : 'Run `reborn run track.get --trackId <track>` to list its parameters.')
}

/**
 * Parses a value in the parameter's units. For 0..1 parameters, "62%" and
 * any value above 1 are read as percentages.
 */
export function parseParamValue(param: ParamInfo, text: string): number {
  const percent = text.trim().endsWith('%')
  const raw = Number(percent ? text.trim().slice(0, -1) : text)
  if (!Number.isFinite(raw)) throw usageError(`"${text}" is not a number.`)
  const unitRange = param.min === 0 && param.max === 1
  const value = unitRange && (percent || raw > 1) ? raw / 100 : raw
  if (value < param.min || value > param.max) {
    throw usageError(`${param.id} takes ${param.min}..${param.max}${unitRange ? ' (or 0..100%)' : ''}; got ${text}.`)
  }
  return value
}

/** Parses "1:16", "9", or "9:" into 1-based bars. */
export function parseBars(text: string): { from?: number; to?: number } {
  const match = /^(\d+)?(?::(\d+)?)?$/.exec(text.trim())
  if (!match || (!match[1] && !match[2])) throw usageError(`--bars takes FROM:TO in 1-based bars, for example 1:16; got "${text}".`)
  const from = match[1] ? Number(match[1]) : undefined
  const to = match[2] ? Number(match[2]) : text.includes(':') ? undefined : from
  if (from === 0 || to === 0) throw usageError('Bars start at 1.')
  if (from !== undefined && to !== undefined && to < from) throw usageError(`--bars ${text} ends before it starts.`)
  return { ...(from !== undefined && { from }), ...(to !== undefined && { to }) }
}

export interface JsonSchemaProperty {
  type?: string
}

/** Converts a `--name value` flag into the type the command schema expects. */
export function coerceParam(command: string, name: string, raw: string | undefined, property: JsonSchemaProperty | undefined): unknown {
  const type = property?.type
  if (type === 'boolean') {
    if (raw === undefined) return true
    const lower = raw.toLowerCase()
    if (['true', 'yes', 'on', '1'].includes(lower)) return true
    if (['false', 'no', 'off', '0'].includes(lower)) return false
    throw usageError(`${command}: --${name} takes true or false; got "${raw}".`)
  }
  if (raw === undefined) throw usageError(`${command}: --${name} needs a value.`)
  if (type === 'number' || type === 'integer') {
    const value = Number(raw)
    if (raw.trim() === '' || !Number.isFinite(value)) throw usageError(`${command}: --${name} takes a number; got "${raw}".`)
    return value
  }
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(raw)
    } catch {
      throw usageError(`${command}: --${name} takes JSON; got "${raw}".`)
    }
  }
  return raw
}
