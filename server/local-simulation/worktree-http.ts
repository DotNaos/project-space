import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';

import type { WorktreeMaterializeRequest } from '../../src/shared/worktree-action-api';
import { readJson, writeJson } from '../project-space-http-response';
import type { LocalSimulationState } from './state';
import type { LocalSimulationStore } from './store';
import { checkedAt } from './views';

function worktreeId(branchName: string) {
  return `local-simulation-${branchName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

export async function handleLocalSimulationWorktreeRequest(options: {
  method: string;
  repositoryRoot: string;
  request: IncomingMessage;
  response: ServerResponse;
  state: LocalSimulationState;
  store: LocalSimulationStore;
  url: URL;
}) {
  const { method, repositoryRoot, request, response, state, store, url } = options;

  if (method === 'GET' && url.pathname === '/api/projects/worktrees') {
    writeJson(response, 200, {
      evidence: { checkedAt: checkedAt(), projectPath: repositoryRoot, source: 'local-simulation' },
      state: 'ready',
      worktrees: state.worktrees
    });
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/worktrees/materialize') {
    const payload = await readJson<WorktreeMaterializeRequest>(request);
    const result = await store.update((current) => {
      const branch = current.github.branches.find((candidate) => candidate.name === payload.branchName);
      if (!branch) {
        return {
          branchName: payload.branchName,
          checkedAt: checkedAt(),
          commitSha: '',
          lastError: 'The selected simulated branch does not exist.',
          machineId: payload.machineId,
          projectId: payload.projectId,
          state: 'error' as const
        };
      }

      const id = worktreeId(payload.branchName);
      const existing = current.worktrees.find((candidate) => candidate.id === id);
      if (!existing) {
        current.worktrees.push({
          branchName: payload.branchName,
          detached: false,
          headCommittedAt: checkedAt(),
          headSha: branch.commitSha,
          id,
          isBase: branch.isDefault,
          kind: 'project-managed',
          locked: false,
          name: payload.branchName,
          path: join(repositoryRoot, '.project', 'local-simulation-worktrees', payload.branchName),
          prunable: false,
          status: 'ready'
        });
      }

      return {
        branchName: payload.branchName,
        checkedAt: checkedAt(),
        commitSha: branch.commitSha,
        machineId: payload.machineId,
        projectId: payload.projectId,
        state: existing ? 'ready' as const : 'created' as const,
        worktreeId: id
      };
    });
    writeJson(response, 200, result);
    return true;
  }

  if (method === 'POST' && url.pathname === '/api/worktrees/setup/inspect') {
    const payload = await readJson<{ machineId: string; projectId: string; worktreeId: string }>(request);
    writeJson(response, 200, {
      capability: 'configured',
      checkedAt: checkedAt(),
      machineId: payload.machineId,
      projectId: payload.projectId,
      steps: [],
      worktreeId: payload.worktreeId
    });
    return true;
  }

  return false;
}
