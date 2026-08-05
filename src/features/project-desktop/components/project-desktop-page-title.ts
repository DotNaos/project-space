import type { ProjectSpaceRecord } from '@/shared/project-space-api';
import type { ProjectDetailTab, ProjectMainView } from '../hooks/use-project-desktop';

export const projectSpaceDefaultPageTitle = 'Project Space';

interface ProjectDesktopPageTitleOptions {
  mainView: ProjectMainView;
  project?: ProjectSpaceRecord;
  projectTab: ProjectDetailTab;
}

function selectedProjectLabel(project: ProjectSpaceRecord) {
  return project.github?.name.trim() || project.name.trim();
}

export function projectDesktopPageTitle({
  mainView,
  project,
  projectTab
}: ProjectDesktopPageTitleOptions) {
  if (mainView !== 'project' || projectTab !== 'codex' || !project) {
    return projectSpaceDefaultPageTitle;
  }

  const projectLabel = selectedProjectLabel(project);

  return projectLabel
    ? `Tasks · ${projectLabel} · ${projectSpaceDefaultPageTitle}`
    : projectSpaceDefaultPageTitle;
}
