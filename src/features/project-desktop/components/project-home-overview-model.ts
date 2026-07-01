import type {
  FullstackTemplateStatus,
  GitHubCatalogRepository,
  GitHubProjectConfigStatus,
  ProjectSpaceRecord,
  ProjectWorktreeRecord
} from '@/shared/project-space-api';

export interface LocalMatch {
  machineId: string;
  project: ProjectSpaceRecord;
}

export interface MatrixRow {
  id: string;
  isLocalOnly: boolean;
  localMatches: LocalMatch[];
  repo?: GitHubCatalogRepository;
  title: string;
}

export interface BranchChipRecord {
  isBase: boolean;
  name: string;
}

export const templateStatusLabels: Record<FullstackTemplateStatus, string> = {
  implemented: 'ok',
  partial: 'partial',
  'not-detected': 'missing',
  'template-source': 'template'
};

export function getMachineId(project: ProjectSpaceRecord) {
  return project.id.includes(':') ? project.id.slice(0, project.id.indexOf(':')) : 'local';
}

export function getProjectMachineId(project: ProjectSpaceRecord, localMachineId: string) {
  const machineId = getMachineId(project);
  return machineId === 'local' ? localMachineId : machineId;
}

export function getTemplateStatus(project: ProjectSpaceRecord): FullstackTemplateStatus {
  return project.fullstackTemplate?.status ?? 'not-detected';
}

export function basename(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

export function isVisibleLocalProject(project: ProjectSpaceRecord) {
  if (project.kind === 'github') {
    return false;
  }

  const projectFolder = basename(project.rootPath);

  return !projectFolder.startsWith('.') && !projectFolder.endsWith('.worktrees');
}

export function normalizeKey(value: string) {
  return value.trim().replace(/^@/, '').toLowerCase();
}

export function matchesQuery(values: Array<string | undefined>, query: string) {
  const normalizedQuery = normalizeKey(query);

  if (!normalizedQuery) {
    return true;
  }

  return values.some((value) => normalizeKey(value ?? '').includes(normalizedQuery));
}

function projectKeys(project: ProjectSpaceRecord) {
  const name = normalizeKey(project.name);
  const rootName = normalizeKey(basename(project.rootPath));
  const keys = new Set([name, rootName]);

  if (name.includes('/')) {
    keys.add(name.split('/').at(-1) ?? name);
  }

  return keys;
}

export function projectMatchesRepo(project: ProjectSpaceRecord, repo: GitHubCatalogRepository) {
  const keys = projectKeys(project);
  const fullName = normalizeKey(repo.fullName);
  const name = normalizeKey(repo.name);

  return keys.has(fullName) || keys.has(name);
}

export function isBaseBranchName(branchName: string, defaultBranch?: string) {
  const normalizedBranch = normalizeKey(branchName);
  const normalizedDefault = defaultBranch ? normalizeKey(defaultBranch) : '';

  return (
    (normalizedDefault && normalizedBranch === normalizedDefault) ||
    normalizedBranch === 'main' ||
    normalizedBranch === 'master'
  );
}

export function branchesFromWorktrees(
  worktrees: ProjectWorktreeRecord[],
  defaultBranch?: string
): BranchChipRecord[] {
  const branches = new Map<string, BranchChipRecord>();

  for (const worktree of worktrees) {
    const branchName = worktree.branchName?.trim();

    if (!branchName) {
      continue;
    }

    branches.set(branchName, {
      isBase: isBaseBranchName(branchName, defaultBranch),
      name: branchName
    });
  }

  return Array.from(branches.values()).sort((left, right) => {
    if (left.isBase !== right.isBase) {
      return left.isBase ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export function mergeBranchChips(
  defaultBranch: string | undefined,
  branchGroups: BranchChipRecord[][]
) {
  const branches = new Map<string, BranchChipRecord>();

  if (defaultBranch) {
    branches.set(defaultBranch, {
      isBase: true,
      name: defaultBranch
    });
  }

  for (const group of branchGroups) {
    for (const branch of group) {
      const existing = branches.get(branch.name);

      branches.set(branch.name, {
        isBase: existing?.isBase || branch.isBase || isBaseBranchName(branch.name, defaultBranch),
        name: branch.name
      });
    }
  }

  return Array.from(branches.values()).sort((left, right) => {
    if (left.isBase !== right.isBase) {
      return left.isBase ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

export function configChipClass(status: GitHubProjectConfigStatus | FullstackTemplateStatus) {
  if (status === 'complete' || status === 'implemented' || status === 'template-source') {
    return 'text-emerald-300';
  }

  if (status === 'partial') {
    return 'text-amber-300';
  }

  return 'text-neutral-500';
}

export function formatLastSeen(value?: string) {
  if (!value) {
    return 'not seen';
  }

  const timestamp = Date.parse(value);

  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));

  if (minutes < 1) {
    return 'now';
  }

  if (minutes < 60) {
    return `${minutes}m`;
  }

  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

export function installScriptUrl() {
  if (typeof window === 'undefined') {
    return '/connector/install.sh';
  }

  return `${window.location.origin}/connector/install.sh`;
}
