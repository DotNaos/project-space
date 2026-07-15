export type ProjectSpacePrimaryDestination = 'chat' | 'home' | 'projects';
export type ProjectHomeView = 'map' | 'summary';

export interface ProjectSpacePrimaryNavigationItem {
  destination: ProjectSpacePrimaryDestination;
  label: string;
}

export const projectSpacePrimaryNavigation: readonly ProjectSpacePrimaryNavigationItem[] = [
  { destination: 'home', label: 'Home' },
  { destination: 'chat', label: 'Chat' },
  { destination: 'projects', label: 'Projects' }
];

export const defaultProjectHomeView: ProjectHomeView = 'summary';

export type ProjectChatTarget =
  | { kind: 'lead' }
  | { kind: 'project-lead'; projectId: string; projectLabel: string }
  | {
      kind: 'agent';
      projectId: string;
      projectLabel: string;
      taskId: string;
      taskLabel: string;
    };

export interface ProjectChatCrumb {
  id: string;
  label: string;
  target: ProjectChatTarget;
}

export function projectChatBreadcrumbs(target: ProjectChatTarget): ProjectChatCrumb[] {
  const lead: ProjectChatCrumb = {
    id: 'lead',
    label: 'Lead',
    target: { kind: 'lead' }
  };
  if (target.kind === 'lead') return [lead];

  const project: ProjectChatCrumb = {
    id: `project:${target.projectId}`,
    label: target.projectLabel,
    target: {
      kind: 'project-lead',
      projectId: target.projectId,
      projectLabel: target.projectLabel
    }
  };
  if (target.kind === 'project-lead') return [lead, project];

  return [lead, project, {
    id: `agent:${target.taskId}`,
    label: target.taskLabel,
    target
  }];
}

export type LegacyProjectSpaceView =
  | 'chat'
  | 'codex'
  | 'machine'
  | 'machines'
  | 'project'
  | 'projects'
  | 'root'
  | 'settings'
  | 'topology';

export type ProjectSpaceViewPlacement =
  | { destination: 'chat'; layer: 'agent' | 'lead' }
  | { destination: 'home'; view: ProjectHomeView }
  | { destination: 'projects'; context?: 'machines' }
  | { destination: 'settings'; section?: 'machines-and-connectors' };

export function projectSpaceViewPlacement(view: LegacyProjectSpaceView): ProjectSpaceViewPlacement {
  if (view === 'topology') return { destination: 'home', view: 'map' };
  if (view === 'root') return { destination: 'home', view: 'summary' };
  if (view === 'chat') return { destination: 'chat', layer: 'lead' };
  if (view === 'codex') return { destination: 'chat', layer: 'agent' };
  if (view === 'machine' || view === 'machines') {
    return { destination: 'projects', context: 'machines' };
  }
  if (view === 'settings') {
    return { destination: 'settings', section: 'machines-and-connectors' };
  }
  return { destination: 'projects' };
}
