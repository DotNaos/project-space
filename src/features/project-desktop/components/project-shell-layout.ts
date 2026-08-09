import type { ProjectMainView } from '../hooks/project-desktop-routing';

export interface ProjectShellLayout {
  gridTemplateColumns: string;
  showCompactHeader: boolean;
  showWorkspaceSidebar: true;
}

export function projectShellLayout(
  _view: ProjectMainView,
  isCompact: boolean,
  isSidebarCollapsed: boolean
): ProjectShellLayout {
  return {
    gridTemplateColumns: isCompact
      ? 'minmax(0,1fr)'
      : `${isSidebarCollapsed ? 64 : 288}px minmax(0,1fr)`,
    showCompactHeader: isCompact,
    showWorkspaceSidebar: true
  };
}
