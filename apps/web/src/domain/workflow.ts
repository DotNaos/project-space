export type WorkflowStatus = 'planned' | 'active' | 'blocked' | 'done';

export interface Project {
  id: string;
  name: string;
  slug: string;
  rootPath: string;
  summary: string;
  currentIteration: number;
  sprints: Sprint[];
}

export interface Sprint {
  id: string;
  name: string;
  goal: string;
  status: WorkflowStatus;
  features: Feature[];
}

export interface Feature {
  id: string;
  name: string;
  summary: string;
  status: WorkflowStatus;
  tasks: Task[];
}

export interface Task {
  id: string;
  name: string;
  summary: string;
  status: WorkflowStatus;
  worktrees: Worktree[];
}

export interface Worktree {
  id: string;
  name: string;
  branchName: string;
  iterationBranchName: string;
  rootPath: string;
  status: 'planned' | 'ready' | 'active';
  issueDocuments: IssueDocument[];
}

export interface IssueDocument {
  id: string;
  title: string;
  path: string;
  summary: string;
  status: 'draft' | 'active' | 'done';
  checklist: IssueChecklistItem[];
}

export interface IssueChecklistItem {
  id: string;
  label: string;
  done: boolean;
}
