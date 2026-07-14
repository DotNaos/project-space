const STORAGE_PREFIX = 'project-space:issue-creation-uncertainty:v1:';
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export interface IssueCreationUncertaintyRecord {
  body: string;
  operationId: string;
  repositoryKey: string;
  selectedLabels: readonly string[];
  title: string;
}

interface IssueCreationUncertaintyStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

function storageKey(repositoryKey: string) {
  return `${STORAGE_PREFIX}${repositoryKey}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsedRecord(value: unknown): IssueCreationUncertaintyRecord | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'body,operationId,repositoryKey,selectedLabels,title') return null;
  if (
    typeof value.body !== 'string'
    || value.body.length > 65_536
    || typeof value.operationId !== 'string'
    || !UUID_V4_PATTERN.test(value.operationId)
    || typeof value.repositoryKey !== 'string'
    || !REPOSITORY_PATTERN.test(value.repositoryKey)
    || !Array.isArray(value.selectedLabels)
    || value.selectedLabels.length > 100
    || value.selectedLabels.some(
      (label) => typeof label !== 'string' || !label.trim() || label.length > 100
    )
    || typeof value.title !== 'string'
    || !value.title.trim()
    || value.title.length > 512
  ) {
    return null;
  }

  return {
    body: value.body,
    operationId: value.operationId.toLowerCase(),
    repositoryKey: value.repositoryKey,
    selectedLabels: Array.from(new Set(value.selectedLabels as string[])),
    title: value.title
  };
}

function browserSessionStorage(): IssueCreationUncertaintyStorage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function loadIssueCreationUncertainty(
  repositoryKey: string,
  storage: IssueCreationUncertaintyStorage | null = browserSessionStorage()
) {
  if (!storage || !REPOSITORY_PATTERN.test(repositoryKey)) return null;

  try {
    const raw = storage.getItem(storageKey(repositoryKey));
    if (!raw) return null;
    const record = parsedRecord(JSON.parse(raw));
    if (!record || record.repositoryKey !== repositoryKey) {
      storage.removeItem(storageKey(repositoryKey));
      return null;
    }
    return record;
  } catch {
    try {
      storage.removeItem(storageKey(repositoryKey));
    } catch {
      // Session storage may become unavailable after the first access.
    }
    return null;
  }
}

export function saveIssueCreationUncertainty(
  record: IssueCreationUncertaintyRecord,
  storage: IssueCreationUncertaintyStorage | null = browserSessionStorage()
) {
  const normalized = parsedRecord(record);
  if (!storage || !normalized) return false;

  try {
    storage.setItem(storageKey(normalized.repositoryKey), JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function clearIssueCreationUncertainty(
  repositoryKey: string,
  operationId?: string,
  storage: IssueCreationUncertaintyStorage | null = browserSessionStorage()
) {
  if (!storage || !REPOSITORY_PATTERN.test(repositoryKey)) return false;

  try {
    if (operationId) {
      const current = loadIssueCreationUncertainty(repositoryKey, storage);
      if (!current || current.operationId !== operationId.toLowerCase()) return false;
    }
    storage.removeItem(storageKey(repositoryKey));
    return true;
  } catch {
    return false;
  }
}
