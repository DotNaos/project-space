import {
  Bot,
  FileCheck2,
  GitBranchPlus,
  GitGraph,
  LayoutDashboard,
  ListChecks,
  MessageSquareText,
  Rocket,
  Server
} from 'lucide-react';

import type { ProjectDetailTab } from '../hooks/use-project-desktop';

export const projectTabItems: Array<{
  icon: typeof LayoutDashboard;
  id: ProjectDetailTab;
  label: string;
}> = [
  { icon: LayoutDashboard, id: 'overview', label: 'Overview' },
  { icon: ListChecks, id: 'issues', label: 'Issues' },
  { icon: Server, id: 'machines', label: 'Machines' },
  { icon: GitBranchPlus, id: 'workspaces', label: 'Workspaces' },
  { icon: MessageSquareText, id: 'chat', label: 'Chat' },
  { icon: GitGraph, id: 'history', label: 'History' },
  { icon: Bot, id: 'codex', label: 'Codex' },
  { icon: FileCheck2, id: 'template', label: 'Template' },
  { icon: Rocket, id: 'deployments', label: 'Deployments' }
];
