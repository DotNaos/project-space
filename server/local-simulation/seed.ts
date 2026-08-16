import { randomBytes } from 'node:crypto';

import { localSimulationSchema, type LocalSimulationState } from './state';

const issueNumber = 616;
const pullRequestNumber = 701;
const headSha = '6166166166166166166166166166166166166166';
const branchName = 'issue-616-offline-first-runtime';
const childBranchSha = '6176176176176176176176176176176176176176';
const nestedBranchSha = '6206206206206206206206206206206206206206';
const reviewBranchSha = '6236236236236236236236236236236236236236';
const mergedBranchSha = '6196196196196196196196196196196196196196';

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
        }, {
          commitSha: childBranchSha,
          isDefault: false,
          linkedIssueNumbers: [617],
          name: 'issue-617-environment-discovery'
        }, {
          commitSha: nestedBranchSha,
          isDefault: false,
          linkedIssueNumbers: [620],
          name: 'issue-620-provider-health'
        }, {
          commitSha: mergedBranchSha,
          isDefault: false,
          linkedIssueNumbers: [619],
          name: 'issue-619-document-runtime'
        }, {
          commitSha: reviewBranchSha,
          isDefault: false,
          linkedIssueNumbers: [623],
          name: 'issue-623-tree-coverage'
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
        body: 'Make Project Space usable with simulated APIs and isolated local data. This parent issue groups the work needed to make the local development flow trustworthy.',
        id: issueNumber,
        labels: ['enhancement', 'local-development'],
        number: issueNumber,
        state: 'open',
        subIssueProgress: { completed: 2, percentCompleted: 33, total: 6 },
        title: 'Add an offline-first development runtime',
        updatedAt: checkedAt,
        url: issueUrl
      }, {
        author: 'local-developer',
        body: 'Discover and classify the environments that are available to the project.',
        id: 617,
        labels: ['compute', 'enhancement'],
        number: 617,
        parentIssue: { number: issueNumber, title: 'Add an offline-first development runtime', url: issueUrl },
        state: 'open',
        title: 'Discover and classify environments',
        updatedAt: checkedAt,
        url: ''
      }, {
        author: 'local-developer',
        body: 'Keep provider connections visible without mixing their health with task state.',
        id: 618,
        labels: ['compute', 'security'],
        number: 618,
        parentIssue: { number: issueNumber, title: 'Add an offline-first development runtime', url: issueUrl },
        state: 'open',
        subIssueProgress: { completed: 1, percentCompleted: 50, total: 2 },
        title: 'Harden provider connection lifecycle',
        updatedAt: checkedAt,
        url: ''
      }, {
        author: 'local-developer',
        body: 'Document how developers can start and inspect the local runtime.',
        id: 619,
        labels: ['documentation'],
        number: 619,
        parentIssue: { number: issueNumber, title: 'Add an offline-first development runtime', url: issueUrl },
        state: 'closed',
        title: 'Document the local runtime',
        updatedAt: checkedAt,
        url: ''
      }, {
        author: 'local-developer',
        body: 'Expose a clear health state for each provider connection.',
        id: 620,
        labels: ['compute'],
        number: 620,
        parentIssue: { number: 618, title: 'Harden provider connection lifecycle', url: issueUrl },
        state: 'closed',
        title: 'Add provider health states',
        updatedAt: checkedAt,
        url: ''
      }, {
        author: 'local-developer',
        body: 'Make connection failures recoverable and visible to the operator.',
        id: 621,
        labels: ['compute', 'reliability'],
        number: 621,
        parentIssue: { number: 618, title: 'Harden provider connection lifecycle', url: issueUrl },
        state: 'open',
        title: 'Add connection recovery actions',
        updatedAt: checkedAt,
        url: ''
      }, {
        author: 'local-developer',
        body: 'Exercise the nested task tree with realistic task states.',
        id: 623,
        labels: ['testing', 'ui'],
        number: 623,
        parentIssue: { number: issueNumber, title: 'Add an offline-first development runtime', url: issueUrl },
        state: 'open',
        title: 'Cover the task hierarchy in the UI',
        updatedAt: checkedAt,
        url: ''
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
      }, {
        author: { login: 'Hecate' },
        baseBranch: 'main',
        checksStatus: 'passing',
        headBranch: 'issue-617-environment-discovery',
        headRefPresent: true,
        headRepositoryFullName: repository.fullName,
        headSha: childBranchSha,
        isCrossRepository: false,
        isDraft: true,
        linkedIssueNumbers: [617],
        number: 702,
        state: 'open',
        title: 'Discover and classify environments',
        updatedAt: checkedAt,
        url: pullRequestUrl
      }, {
        author: { login: 'Hecate' },
        baseBranch: 'main',
        checksStatus: 'passing',
        headBranch: 'issue-620-provider-health',
        headRefPresent: true,
        headRepositoryFullName: repository.fullName,
        headSha: nestedBranchSha,
        isCrossRepository: false,
        isDraft: false,
        linkedIssueNumbers: [620],
        number: 704,
        state: 'merged',
        title: 'Add provider health states',
        updatedAt: checkedAt,
        url: pullRequestUrl
      }, {
        author: { login: 'Hecate' },
        baseBranch: 'main',
        checksStatus: 'passing',
        headBranch: 'issue-619-document-runtime',
        headRefPresent: true,
        headRepositoryFullName: repository.fullName,
        headSha: mergedBranchSha,
        isCrossRepository: false,
        isDraft: false,
        linkedIssueNumbers: [619],
        number: 703,
        state: 'merged',
        title: 'Document the local runtime',
        updatedAt: checkedAt,
        url: pullRequestUrl
      }, {
        author: { login: 'Hecate' },
        baseBranch: 'main',
        checksStatus: 'pending',
        headBranch: 'issue-623-tree-coverage',
        headRefPresent: true,
        headRepositoryFullName: repository.fullName,
        headSha: reviewBranchSha,
        isCrossRepository: false,
        isDraft: false,
        linkedIssueNumbers: [623],
        number: 705,
        state: 'open',
        title: 'Cover the task hierarchy in the UI',
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
