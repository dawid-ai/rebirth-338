import type { ApiEvent, ApiStatus, CommandInfo, JobState } from '@reborn/studio-core/api'

// Human-readable output. Machine output (`--json`) prints the API's own JSON.

export function formatStatus(status: ApiStatus): string {
  const lines = [`${status.app} ${status.version} (API ${status.api})`]
  const p = status.project
  lines.push(p ? `Project: ${p.name}, revision ${p.revision}, ${p.bars} bars at ${p.tempo} BPM, ${p.path ?? 'not saved yet'}` : 'Project: none open')
  lines.push(`Transport: ${status.transport.playing ? 'playing' : 'stopped'} at bar ${status.transport.bar}`)
  lines.push(`Clients: ${status.clients}`)
  lines.push(`Direct agent edits: ${status.directAgentEdits ? 'on' : 'off (agent changes become proposals)'}`)
  return lines.join('\n')
}

export function formatCommands(commands: readonly CommandInfo[]): string {
  const width = Math.max(...commands.map((c) => c.type.length))
  const block = (title: string, list: readonly CommandInfo[]) => [title, ...list.map((c) => `  ${c.type.padEnd(width)}  ${c.summary}`)].join('\n')
  const reads = commands.filter((c) => !c.mutates)
  const edits = commands.filter((c) => c.mutates)
  return [block('Read commands:', reads), block('Edit commands:', edits), 'Run one with `reborn run <type> --param value`. `reborn commands --json` prints parameter schemas.'].join('\n\n')
}

export function formatJob(job: JobState): string {
  const progress = job.total > 0 ? ` ${job.completed}/${job.total}` : ''
  return `${job.kind}${progress} ${job.status}${job.message ? `: ${job.message}` : ''}`
}

export function formatEvent(event: ApiEvent): string {
  switch (event.type) {
    case 'project':
      return `project    revision ${event.revision} by ${event.origin}: ${event.label}`
    case 'job':
      return `job        ${event.job.id} ${formatJob(event.job)}`
    case 'transport':
      return `transport  ${event.playing ? 'playing' : 'stopped'} at bar ${event.bar}`
    case 'proposal':
      return `proposal   ${event.id} ${event.status}`
    default:
      return compact(event)
  }
}

/** Collects file paths from a render or save result of unknown shape. */
export function extractPaths(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(extractPaths)
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  const keys = ['path', 'outputPath', 'file', 'paths', 'outputPaths', 'files', 'stems']
  return keys.filter((key) => key in record).flatMap((key) => extractPaths(record[key]))
}

/** A compact, line-per-key report for analysis results. */
export function formatReport(value: unknown, indent = ''): string {
  if (value === null || value === undefined) return `${indent}(no result)`
  if (typeof value !== 'object') return `${indent}${String(value)}`
  if (Array.isArray(value)) return value.map((item) => (isPlain(item) ? `${indent}- ${String(item)}` : `${indent}- ${compact(item)}`)).join('\n')
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => {
      if (isPlain(item)) return `${indent}${key}: ${formatNumber(item)}`
      if (Array.isArray(item) && item.every(isPlain)) return `${indent}${key}: ${item.map(formatNumber).join(', ')}`
      return `${indent}${key}: ${compact(item)}`
    })
    .join('\n')
}

const isPlain = (value: unknown) => value === null || ['string', 'number', 'boolean'].includes(typeof value)
const formatNumber = (value: unknown) => (typeof value === 'number' && !Number.isInteger(value) ? String(Math.round(value * 1000) / 1000) : String(value))

export const compact = (value: unknown) => JSON.stringify(value) ?? 'null'
export const pretty = (value: unknown) => JSON.stringify(value, null, 2) ?? 'null'
