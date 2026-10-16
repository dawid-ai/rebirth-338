import { usageError } from './errors'

// A small argument parser. Flags are `--name value`, `--name=value`, or a bare
// boolean `--name`. `--` ends flag parsing so values that look like flags
// (for example a drum lane "--x---x-") can still be passed.

export type FlagKind = 'boolean' | 'string'
export type FlagSpec = Record<string, FlagKind>

export interface ExtraFlag {
  name: string
  value: string | undefined
}

export interface ParsedArgs {
  positionals: string[]
  flags: Record<string, string | boolean>
  /** Flags not in the spec, collected when `allowUnknown` is set. */
  extra: ExtraFlag[]
}

const FLAG = /^--([a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)*)(?:=(.*))?$/s

export function isFlag(token: string): boolean {
  return token === '-h' || FLAG.test(token)
}

export function parseArgs(argv: readonly string[], spec: FlagSpec, options: { allowUnknown?: boolean } = {}): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: {}, extra: [] }
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') {
      parsed.positionals.push(...argv.slice(index + 1))
      break
    }
    if (token === '-h') {
      parsed.flags.help = true
      continue
    }
    const match = FLAG.exec(token)
    if (!match) {
      parsed.positionals.push(token)
      continue
    }
    const [, name, inline] = match
    const kind = spec[name]
    if (kind === 'boolean') {
      if (inline !== undefined && !['true', 'false'].includes(inline)) throw usageError(`--${name} does not take a value.`)
      parsed.flags[name] = inline !== 'false'
    } else if (kind === 'string') {
      const value = inline ?? argv[index + 1]
      if (value === undefined) throw usageError(`--${name} needs a value.`)
      if (inline === undefined) index++
      parsed.flags[name] = value
    } else if (options.allowUnknown) {
      // Unknown flags take the next token as their value unless it is a flag.
      const next = argv[index + 1]
      const value = inline ?? (next !== undefined && !isFlag(next) && next !== '--' ? next : undefined)
      if (inline === undefined && value !== undefined) index++
      parsed.extra.push({ name, value })
    } else {
      throw usageError(`Unknown option --${name}.`)
    }
  }
  return parsed
}

/** Returns the first token that is not a global flag or a global flag's value. */
export function findCommand(argv: readonly string[], globals: FlagSpec): { index: number; name: string } | null {
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (token === '--') return argv[index + 1] === undefined ? null : { index: index + 1, name: argv[index + 1] }
    const match = FLAG.exec(token)
    if (match) {
      if (globals[match[1]] === 'string' && match[2] === undefined) index++
      continue
    }
    if (token === '-h') continue
    return { index, name: token }
  }
  return null
}
