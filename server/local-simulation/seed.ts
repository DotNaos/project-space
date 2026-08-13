import { randomBytes } from 'node:crypto';

import { localSimulationSchema, type LocalSimulationState } from './state';

const issueNumber = 616;
const pullRequestNumber = 617;
const headSha = '6166166166166166166166166166166166166166';
const branchName = 'issue-616-offline-first-runtime';

export const localSimulationAvatarUrl =
  'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 64 64%22%3E%3Crect width=%2264%22 height=%2264%22 rx=%2232%22 fill=%22%232563eb%22/%3E%3Ctext x=%2232%22 y=%2241%22 text-anchor=%22middle%22 font-family=%22system-ui,sans-serif%22 font-size=%2230%22 font-weight=%22700%22 fill=%22white%22%3EH%3C/text%3E%3C/svg%3E';

export function createLocalSimulationSeed(rootPath: string, now = new Date()): LocalSimulationState {
  const checkedAt = now.toISOString();
  const repository = {
    defaultBranch: 'main',
    description: 'A coherent local copy of Project Space for offline development.',
    fullName: 'DotNaos/project-space',
    id: 616,
    name: 'project-space',
    owner: 'DotNaos'
  };
  const issueUrl = '';
  const pullRequestUrl = '';

  return {
    credentials: { sessionSigningKey: randomBytes(32).toString('base64url') },
    createdAt: checkedAt,
    devServer: { startedAt: checkedAt, state: 'running' },
    github: {
      branches: [
        { commitSha: '831e68d4eb68138d41abf6f8459c97f00ca8a74e', isDefault: true, name: 'main' },
        {
          commitSha: headSha,
          isDefault: false,
          linkedIssueNumbers: [issueNumber],
          name: branchName,
        }
      ],
      comments: {
        [String(issueNumber)]: [{
          author: 'Hecate',
          authorAvatarUrl: localSimulationAvatarUrl,
          body: 'The local simulation is running without external services.',
          createdAt: checkedAt,
          id: 1,
          updatedAt: checkedAt,
          url: ''
        }]
      },
      issues: [{
        author: 'local-developer',
        body: 'Make Project Space usable with simulated APIs and isolated local data.',
        id: issueNumber,
        labels: ['enhancement', 'local-development'],
        number: issueNumber,
        state: 'open',
        title: 'Add an offline-first development runtime',
        updatedAt: checkedAt,
        url: issueUrl
      }],
      pullRequests: [{
        author: { login: 'Hecate' },
        baseBranch: 'main',
        checksStatus: 'passing',
        headBranch: branchName,
        headRefPresent: true,
        headRepositoryFullName: repository.fullName,
        headSha,
        isCrossRepository: false,
        isDraft: true,
        linkedIssueNumbers: [issueNumber],
        number: pullRequestNumber,
        state: 'open',
        title: 'Add local simulation runtime',
        updatedAt: checkedAt,
        url: pullRequestUrl
      }],
      repository,
      workflowRuns: [{
        actor: 'Hecate',
        attempt: 1,
        branch: branchName,
        conclusion: 'success',
        createdAt: checkedAt,
        displayTitle: 'Local verification',
        event: 'local_simulation',
        headSha,
        id: 616001,
        kind: 'ci',
        name: 'Checks',
        runNumber: 1,
        runStartedAt: checkedAt,
        status: 'completed',
        updatedAt: checkedAt
      }]
    },
    machine: { id: 'local-simulation-machine', name: 'Local computer' },
    projectsState: {
      activeGroupId: '',
      pinnedProjectIds: ['github:DotNaos/project-space'],
      recentProjectIds: ['github:DotNaos/project-space'],
      selectedExplorerTarget: { kind: 'worktree', worktreeId: 'local-simulation-worktree' },
      selectedLauncherAppId: 'terminal',
      selectedProjectId: 'github:DotNaos/project-space'
    },
    revision: 1,
    scenario: 'active-development',
    schema: localSimulationSchema,
    updatedAt: checkedAt,
    worktrees: [{
      branchName,
      detached: false,
      headCommittedAt: checkedAt,
      headSha,
      id: 'local-simulation-worktree',
      isBase: false,
      kind: 'project-managed',
      locked: false,
      name: '#616 · Offline-first runtime',
      path: rootPath,
      prunable: false,
      status: 'ready'
    }]
  };
}

export const localSimulationIdentity = { branchName, headSha, issueNumber, pullRequestNumber };
