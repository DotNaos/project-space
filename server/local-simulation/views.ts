import { localSimulationIdentity } from './seed';
import type { LocalSimulationState } from './state';

export const localSimulationCsp = [
  "default-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'"
].join('; ');

export function checkedAt() {
  return new Date().toISOString();
}

export function projectRecord(state: LocalSimulationState, rootPath: string) {
  const repository = state.github.repository;
  return {
    gitStatus: {
      branchName: localSimulationIdentity.branchName,
      changed: 0,
      hasUnstagedChanges: false,
      staged: 0,
      unstaged: 0,
      untracked: 0
    },
    github: {
      ...repository,
      isPrivate: true,
      projectConfig: { projectYaml: true, status: 'complete', templateLock: true },
      url: ''
    },
    id: `github:${repository.fullName}`,
    kind: 'workspace',
    machineId: state.machine.id,
    name: repository.name,
    projectctl: { hasGoals: true, hasLock: true, hasProject: true, status: 'managed' },
    rootPath
  };
}

export function connectorOverview(state: LocalSimulationState, rootPath: string) {
  return {
    machines: [{
      connector: {
        capabilities: ['dev-servers.v1', 'worktrees.v1', 'codex-sessions.v1'],
        installCommand: '',
        lastSeen: checkedAt(),
        serviceName: 'local-simulation',
        status: 'online'
      },
      environment: { kind: process.platform === 'darwin' ? 'macos' : 'linux', label: 'Local' },
      id: state.machine.id,
      kind: 'local-simulation',
      name: state.machine.name,
      network: { localName: 'localhost' },
      primaryUser: 'local-developer',
      roles: ['development'],
      sourcePath: rootPath
    }],
    machinesRepo: { exists: true, path: rootPath },
    physicalMachines: [{ connectorIds: [state.machine.id], id: 'local-computer', name: 'Local computer' }],
    tailscale: { connected: false, installed: false, ips: [], peersOnline: 0, serveOrigins: [] }
  };
}

export function devServerOverview(state: LocalSimulationState) {
  const now = checkedAt();
  const worktree = state.worktrees[0]!;
  const running = state.devServer.state === 'running';
  return {
    access: 'owner',
    machineId: state.machine.id,
    projectId: `github:${state.github.repository.fullName}`,
    servers: [{
      capability: 'configured',
      checkedAt: now,
      ...(running ? { localPort: 1355, localUrl: '/', startedAt: state.devServer.startedAt } : {}),
      machineId: state.machine.id,
      projectId: `github:${state.github.repository.fullName}`,
      runTarget: 'dev',
      serverId: 'dev',
      serverLabel: 'Project Space',
      state: running ? 'running' : 'stopped',
      verifiedAt: now,
      worktreeId: worktree.id
    }],
    settings: {
      allowedHosts: [],
      machineId: state.machine.id,
      preferredWorktreeId: worktree.id,
      projectId: `github:${state.github.repository.fullName}`,
      runTarget: 'dev'
    }
  };
}
