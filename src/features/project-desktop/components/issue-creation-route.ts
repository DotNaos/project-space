import {
  parseProjectRoute,
  routeForView
} from '../hooks/project-desktop-routing';

export function issueCreationPath(projectId: string) {
  return routeForView('project', projectId, 'issues', 'new');
}

export function issueListPath(projectId: string) {
  return routeForView('project', projectId, 'issues');
}

export function isIssueCreationPath(pathname: string, projectId: string) {
  const route = parseProjectRoute(pathname);

  return route.view === 'project'
    && route.projectId === projectId
    && route.projectTab === 'issues'
    && route.createIssue === true;
}
