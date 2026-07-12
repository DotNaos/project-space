import { describe, expect, test } from 'bun:test';
import {
  createWorktreeActionService,
  type WorktreeActionServiceOptions
} from '../server/worktree-action-service';
import type {
  ConnectorWorktreeActionResult,
  ConnectorWorktreeActionTrustedRequest
} from '../server/connector-worktree-action-contract';

const commit = 'a'.repeat(40),
  digest = 'b'.repeat(64);
function harness(member = true, failures = false) {
  const calls: Array<{
    request: ConnectorWorktreeActionTrustedRequest;
    userId: string;
  }> = [];
  const project = {
    id: 'project-machine-1',
    machineId: 'machine-1',
    name: 'project-space',
    rootPath: '/home/oli/projects/project-space',
    kind: 'github' as const,
    github: {
      defaultBranch: 'main',
      fullName: 'DotNaos/project-space',
      id: 42,
      isPrivate: true,
      name: 'project-space',
      owner: 'DotNaos',
      projectConfig: {
        projectYaml: true,
        status: 'complete' as const,
        templateLock: true
      },
      url: 'https://github.com/DotNaos/project-space'
    }
  };
  const backend: WorktreeActionServiceOptions['backend'] = {
    async getConnectorOverview() {
      return {
        machines: [
          {
            connector: { installCommand: '', status: 'online' },
            id: 'machine-1',
            kind: 'connector',
            name: 'OS PC',
            network: {},
            roles: [],
            sourcePath: 'connector-hub'
          }
        ],
        machinesRepo: { exists: false, path: '' },
        tailscale: {
          connected: false,
          installed: false,
          ips: [],
          peersOnline: 0,
          serveOrigins: []
        }
      };
    },
    async getGitHubCatalog() {
      return {
        checkedAt: new Date().toISOString(),
        repositories: [project.github],
        status: 'connected'
      };
    },
    async getGitHubRepositoryDetails() {
      return {
        branches: [{ commitSha: commit, isDefault: false, name: 'feature/remote-dev' }],
        checkedAt: new Date().toISOString(),
        issues: [],
        pullRequests: [],
        status: 'connected'
      };
    },
    async loadProjectDiscovery() {
      return {
        groups: [],
        projects: [project],
        rootItems: [],
        rootPath: '/home/oli/projects',
        structureViolations: []
      };
    },
    async loadProjectWorktrees() {
      return [
        {
          branchName: 'feature/remote-dev',
          detached: false,
          headSha: commit,
          id: 'wt_111111111111111111111111',
          isBase: false,
          kind: 'project-managed',
          locked: false,
          name: 'remote dev',
          path: '/home/oli/projects/.worktrees/project-space/feature/remote-dev',
          prunable: false,
          status: 'ready'
        }
      ] as never;
    }
  };
  const connector = {
    async run(
      _operation: ConnectorWorktreeActionTrustedRequest['operation'],
      request: ConnectorWorktreeActionTrustedRequest,
      actor: { generation: number; userId: string }
    ): Promise<ConnectorWorktreeActionResult> {
      calls.push({ request, userId: actor.userId });
      if (request.operation === 'materialize')
        return failures
          ? {
              branchName: request.branchName,
              checkedAt: new Date().toISOString(),
              commitSha: request.commitSha,
              generation: actor.generation,
              lastError: 'failed at /home/oli/private with ghp_secretvalue',
              machineId: request.machineId,
              operation: 'materialize',
              projectId: request.projectId,
              state: 'error'
            }
          : {
              branchName: request.branchName,
              checkedAt: new Date().toISOString(),
              commitSha: request.commitSha,
              generation: actor.generation,
              machineId: request.machineId,
              operation: 'materialize',
              projectId: request.projectId,
              projectPath: '/home/oli/projects/project-space',
              state: 'created',
              worktreePath: '/home/oli/projects/.worktrees/project-space/feature/remote-dev'
            };
      return {
        capability: failures ? 'unavailable' : 'configured',
        checkedAt: new Date().toISOString(),
        generation: actor.generation,
        ...(failures ? { lastError: 'read /home/oli/private: Bearer token-secret' } : {}),
        machineId: request.machineId,
        operation: request.operation,
        projectId: request.projectId,
        steps: [
          {
            checkedAt: new Date().toISOString(),
            commitSha: commit,
            declarationDigest: digest,
            ...(failures ? { lastError: 'exec /home/oli/private ghp_secretvalue' } : {}),
            setupStepId: 'install',
            state: failures ? 'failed' : 'required'
          }
        ],
        worktreeId: request.worktreeId
      };
    }
  };
  const service = createWorktreeActionService({
    backend,
    connector,
    database: {
      isConfigured: () => true,
      async readMachineMembership() {
        return member ? { machineId: 'machine-1', role: 'owner', userId: 'user-a' } : null;
      }
    },
    userId: () => 'user-a'
  });
  return { calls, service };
}

describe('worktree action service', () => {
  test('materializes only an exact catalog branch and returns discovery stable ID', async () => {
    const { calls, service } = harness();
    const result = await service.materialize({
      branchName: 'feature/remote-dev',
      machineId: 'machine-1',
      projectId: 'project-machine-1'
    });
    expect(result.worktreeId).toBe('wt_111111111111111111111111');
    expect(result).not.toHaveProperty('worktreePath');
    expect(calls[0]?.request).toMatchObject({
      repositoryFullName: 'DotNaos/project-space',
      commitSha: commit
    });
    await expect(
      service.materialize({
        branchName: 'attacker/path',
        machineId: 'machine-1',
        projectId: 'project-machine-1'
      })
    ).rejects.toThrow('selected GitHub branch');
  });
  test('requires membership before connector execution', async () => {
    const { calls, service } = harness(false);
    await expect(
      service.materialize({
        branchName: 'feature/remote-dev',
        machineId: 'machine-1',
        projectId: 'project-machine-1'
      })
    ).rejects.toThrow('do not have access');
    expect(calls).toHaveLength(0);
  });
  test('binds setup run to an inspected declared step fingerprint', async () => {
    const { calls, service } = harness();
    const result = await service.runSetup({
      machineId: 'machine-1',
      projectId: 'project-machine-1',
      setupStepId: 'install',
      worktreeId: 'wt_111111111111111111111111'
    });
    expect(result.steps[0]).toMatchObject({
      setupStepId: 'install',
      commitSha: commit,
      declarationDigest: digest
    });
    expect(calls[1]?.request).toMatchObject({
      operation: 'setup.run',
      setupStepId: 'install',
      expectedHeadSha: commit,
      declarationDigest: digest,
      worktreeId: 'wt_111111111111111111111111'
    });
    await expect(
      service.runSetup({
        machineId: 'machine-1',
        projectId: 'project-machine-1',
        setupStepId: 'arbitrary',
        worktreeId: 'wt_111111111111111111111111'
      })
    ).rejects.toThrow('not declared');
  });
  test('never exposes connector paths or credentials in browser-facing errors', async () => {
    const { service } = harness(true, true);
    const materialized = await service.materialize({
      branchName: 'feature/remote-dev',
      machineId: 'machine-1',
      projectId: 'project-machine-1'
    });
    const setup = await service.inspectSetup({
      machineId: 'machine-1',
      projectId: 'project-machine-1',
      worktreeId: 'wt_111111111111111111111111'
    });
    expect(JSON.stringify({ materialized, setup })).not.toContain('/home/oli');
    expect(JSON.stringify({ materialized, setup })).not.toContain('ghp_');
    expect(JSON.stringify({ materialized, setup })).not.toContain('token-secret');
    expect(setup.steps[0]?.lastError).toBe('Setup step failed.');
  });
});
