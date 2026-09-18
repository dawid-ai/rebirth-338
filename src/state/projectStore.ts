import { createDefaultProject, type ProjectState } from "../model";

const INDEX_KEY = "rebirth338:projects";
const PROJECT_PREFIX = "rebirth338:project:";
const ACTIVE_KEY = "rebirth338:active";

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `project-${Date.now().toString(36)}`;
}

function available(): boolean {
  return typeof localStorage !== "undefined";
}

export function listProjects(): ProjectSummary[] {
  if (!available()) return [];
  try {
    return JSON.parse(localStorage.getItem(INDEX_KEY) ?? "[]") as ProjectSummary[];
  } catch {
    return [];
  }
}

export function saveProject(project: ProjectState, id?: string): ProjectState {
  const saved = structuredClone(project);
  if (!available()) return saved;
  const projectId = id ?? localStorage.getItem(ACTIVE_KEY) ?? makeId();
  const updatedAt = new Date().toISOString();
  localStorage.setItem(`${PROJECT_PREFIX}${projectId}`, JSON.stringify(saved));
  const index = listProjects().filter((item) => item.id !== projectId);
  index.unshift({ id: projectId, name: saved.name, updatedAt });
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  localStorage.setItem(ACTIVE_KEY, projectId);
  return saved;
}

export function loadProject(id?: string): ProjectState | null {
  if (!available()) return null;
  const projectId = id ?? localStorage.getItem(ACTIVE_KEY);
  if (!projectId) return null;
  try {
    const parsed = JSON.parse(localStorage.getItem(`${PROJECT_PREFIX}${projectId}`) ?? "null");
    return parsed?.version === 1 ? (parsed as ProjectState) : null;
  } catch {
    return null;
  }
}

export function loadOrCreateProject(): ProjectState {
  return loadProject() ?? createDefaultProject();
}

export function deleteProject(id: string): void {
  if (!available()) return;
  localStorage.removeItem(`${PROJECT_PREFIX}${id}`);
  const index = listProjects().filter((item) => item.id !== id);
  localStorage.setItem(INDEX_KEY, JSON.stringify(index));
  if (localStorage.getItem(ACTIVE_KEY) === id) localStorage.removeItem(ACTIVE_KEY);
}

export function serializeProject(project: ProjectState): string {
  return JSON.stringify(project, null, 2);
}

export function parseProject(json: string): ProjectState {
  const value = JSON.parse(json) as ProjectState;
  if (!value || value.version !== 1 || !Array.isArray(value.bass)) {
    throw new Error("This is not a valid ReBirth 338 project file.");
  }
  return value;
}
