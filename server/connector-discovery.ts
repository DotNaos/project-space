import type {
  FullstackTemplateCheck,
  FullstackTemplateStatus,
  ProjectDiscoveryResult,
  ProjectNavigationItem,
  ProjectSpaceRecord
} from '../src/shared/project-space-api';

interface ConnectorSnapshot {
  generated_at?: string;
  machine?: {
    id?: string;
    hostname?: string;
    os?: string;
  };
  roots?: string[];
  projects?: ConnectorProject[];
}

interface ConnectorProject {
  fullstack_template?: ConnectorTemplateSignal;
  id?: string;
  name?: string;
  path?: string;
  relative_path?: string;
  worktree?: boolean;
}

interface ConnectorTemplateSignal {
  matched?: string[];
  missing?: string[];
  score?: number;
  status?: string;
}

function getApiBaseUrl() {
  return (
    process.env.PROJECT_SPACE_CONNECTOR_API_BASE_URL ??
    process.env.PROJECT_SPACE_PRIVATE_VPS_BASE_URL ??
    process.env.PRIVATE_VPS_PLATFORM_API_BASE_URL ??
    ''
  ).replace(/\/+$/, '');
}

async function readSnapshots(): Promise<ConnectorSnapshot[]> {
  const baseUrl = getApiBaseUrl();

  if (!baseUrl) {
    return [];
  }

  const response = await fetch(`${baseUrl}/api/v1/machines/snapshots`);

  if (!response.ok) {
    throw new Error(`Connector snapshot request failed with ${response.status}.`);
  }

  const payload = await response.json().catch(() => []);

  return Array.isArray(payload) ? payload : [];
}

function snapshotTime(snapshot: ConnectorSnapshot) {
  return Date.parse(snapshot.generated_at ?? '') || 0;
}

function selectSnapshots(snapshots: ConnectorSnapshot[]) {
  const preferredMachineID = process.env.PROJECT_SPACE_CONNECTOR_MACHINE_ID;
  const sortedSnapshots = snapshots
    .filter((snapshot) => snapshot.machine?.id && Array.isArray(snapshot.projects))
    .sort((left, right) => snapshotTime(right) - snapshotTime(left));

  if (preferredMachineID) {
    return sortedSnapshots.filter((snapshot) => snapshot.machine?.id === preferredMachineID);
  }

  return sortedSnapshots.slice(0, 1);
}

function toProjectRecord(
  snapshot: ConnectorSnapshot,
  project: ConnectorProject
): ProjectSpaceRecord | null {
  if (!project.path) {
    return null;
  }

  const machineID = snapshot.machine?.id ?? 'machine';
  const id = `${machineID}:${project.relative_path || project.path}`;

  return {
    fullstackTemplate: toTemplateCheck(project.fullstack_template),
    id,
    kind: project.worktree ? 'workspace' : 'standalone',
    name: project.name || project.relative_path || project.path,
    rootPath: project.path
  };
}

function toTemplateCheck(signal?: ConnectorTemplateSignal): FullstackTemplateCheck | undefined {
  if (!signal?.status) {
    return undefined;
  }

  return {
    matched: Array.isArray(signal.matched) ? signal.matched : [],
    missing: Array.isArray(signal.missing) ? signal.missing : [],
    score: Number.isFinite(signal.score) ? Number(signal.score) : 0,
    status: normalizeTemplateStatus(signal.status)
  };
}

function normalizeTemplateStatus(status: string): FullstackTemplateStatus {
  if (
    status === 'implemented' ||
    status === 'partial' ||
    status === 'template-source' ||
    status === 'not-detected'
  ) {
    return status;
  }

  return 'not-detected';
}

export async function loadConnectorProjectDiscovery(): Promise<ProjectDiscoveryResult | null> {
  const snapshots = selectSnapshots(await readSnapshots());
  const projects = snapshots.flatMap((snapshot) =>
    (snapshot.projects ?? [])
      .map((project) => toProjectRecord(snapshot, project))
      .filter((project): project is ProjectSpaceRecord => Boolean(project))
  );

  if (projects.length === 0) {
    return null;
  }

  const rootItems: ProjectNavigationItem[] = projects.map((project) => ({
    id: project.id,
    kind: 'project',
    label: project.name,
    projectId: project.id
  }));

  return {
    groups: [],
    projects: projects.sort((left, right) => left.name.localeCompare(right.name)),
    rootItems: rootItems.sort((left, right) => left.label.localeCompare(right.label)),
    rootPath: snapshots.flatMap((snapshot) => snapshot.roots ?? []).join(', ') || 'connector'
  };
}
