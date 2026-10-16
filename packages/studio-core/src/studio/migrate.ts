import { type StudioProject, STUDIO_SCHEMA, STUDIO_VERSION, defaultMaster, defaultReturns } from './model'
import { StudioError } from './ops'

// Pure, versioned migrations for v2 projects. Each step upgrades one
// version; fixtures in migrate.test.ts pin the behavior.

type Migration = (project: Record<string, unknown>) => Record<string, unknown>

/** Index N upgrades version N+1 to N+2. Empty until version 2 exists. */
const MIGRATIONS: Migration[] = []

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export function migrateStudioProject(candidate: unknown): StudioProject {
  if (!isRecord(candidate) || candidate.schema !== STUDIO_SCHEMA) throw new StudioError('invalid', 'This is not a RE:BORN v2 project.')
  let version = typeof candidate.version === 'number' ? candidate.version : 0
  if (version < 1) throw new StudioError('invalid', 'This project has no valid version.')
  if (version > STUDIO_VERSION) throw new StudioError('invalid', 'This project was saved by a newer version of RE:BORN.')
  let value = candidate
  while (version < STUDIO_VERSION) {
    value = MIGRATIONS[version - 1](value)
    version += 1
  }
  const project = value as unknown as StudioProject
  if (!Array.isArray(project.tracks) || !isRecord(project.patterns) || !Array.isArray(project.clips)) throw new StudioError('invalid', 'The project is missing tracks, patterns, or clips.')
  // Fill fields that may be absent in hand-written or partially generated files.
  return {
    ...project,
    version: STUDIO_VERSION,
    revision: typeof project.revision === 'number' ? project.revision : 0,
    meter: project.meter ?? { numerator: 4, denominator: 4 },
    sampleRate: project.sampleRate === 48000 ? 48000 : 44100,
    returns: Array.isArray(project.returns) && project.returns.length ? project.returns : defaultReturns(),
    master: { ...defaultMaster(), ...(project.master ?? {}) },
    sections: project.sections ?? [],
    scenes: project.scenes ?? [],
    automation: project.automation ?? [],
    assets: project.assets ?? {},
    audit: project.audit ?? [],
    length: Math.max(1, project.length ?? 8),
  }
}
