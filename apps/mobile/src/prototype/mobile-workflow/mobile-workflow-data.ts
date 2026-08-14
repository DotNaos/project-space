export const MOBILE_WORKFLOW_SCENARIO_ID = 'mobile-workflow';

export const workflowPages = [
  'issue-list',
  'issue-map',
  'issue-detail',
  'codex',
  'worktree',
  'branch',
  'pull-request',
  'docs',
  'preview',
] as const;

export type WorkflowPage = (typeof workflowPages)[number];

export interface WorkflowIssue {
  number: number;
  status: 'active' | 'open';
  title: string;
}

export const workflowIssues: readonly WorkflowIssue[] = [
  { number: 300, status: 'active', title: 'Centralize machine readiness' },
  { number: 340, status: 'active', title: 'Shared remote App Server' },
  { number: 269, status: 'active', title: 'Codex task list and chat' },
  { number: 298, status: 'open', title: 'Changelog documentation' },
  { number: 305, status: 'open', title: 'Native mobile bootstrap' },
  { number: 231, status: 'open', title: 'Create issue action' },
  { number: 193, status: 'open', title: 'Machine resources' },
  { number: 175, status: 'open', title: 'Remote dev server' },
] as const;

export const workflowPageLabels: Record<WorkflowPage, string> = {
  'issue-list': 'Issues',
  'issue-map': 'Issue map',
  'issue-detail': 'Issue #300',
  codex: 'Codex · #300',
  worktree: 'Worktree',
  branch: 'Branch',
  'pull-request': 'Pull request #333',
  docs: 'Docs',
  preview: 'Preview review',
};

export const workflowNavItems: readonly {
  label: string;
  page: WorkflowPage;
}[] = [
  { label: 'Issues', page: 'issue-list' },
  { label: 'Issue map', page: 'issue-map' },
  { label: 'Codex', page: 'codex' },
  { label: 'Worktree', page: 'worktree' },
  { label: 'Branch', page: 'branch' },
  { label: 'Pull request', page: 'pull-request' },
  { label: 'Docs', page: 'docs' },
  { label: 'Preview review', page: 'preview' },
] as const;

export function isMobileWorkflowScenario(id: string | undefined) {
  return id === MOBILE_WORKFLOW_SCENARIO_ID;
}
