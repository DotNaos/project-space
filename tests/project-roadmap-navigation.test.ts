import { expect, mock, test } from 'bun:test';

mock.module('@/api/project-space-client', () => ({
  projectSpaceClient: {},
  refreshProjectSpaceAuthToken: () => null,
  resolveProjectSpaceApiBaseUrl: () => ''
}));
mock.module('@/api/codex-sessions-client', () => ({ createCodexSessionsClient: () => ({}) }));
mock.module('@/shared/project-space-api', () => ({ launcherAppLabels: {} }));

const { parseProjectRoute, routeForView } = await import(
  '../src/features/project-desktop/hooks/use-project-desktop'
);
const { roadmapRepositoryForProject } = await import(
  '../src/features/roadmap/use-roadmap-repository'
);
const { RoadmapRequestOrder, roadmapResultForRepository } = await import(
  '../src/features/roadmap/use-roadmap'
);

test('restores the Roadmap tab from its direct URL', () => {
  const route = routeForView('project', 'github:DotNaos/project-space', 'roadmap');
  expect(route).toBe('/projects/github%3ADotNaos%2Fproject-space/roadmap');
  expect(parseProjectRoute(route)).toMatchObject({
    projectId: 'github:DotNaos/project-space',
    projectTab: 'roadmap',
    view: 'project'
  });
  expect(parseProjectRoute(`${route}/`)).toMatchObject({ projectTab: 'roadmap' });
});

test('resolves a local project repository when Roadmap opens before the shell catalog is hydrated', () => {
  const repository = {
    defaultBranch: 'main',
    fullName: 'DotNaos/project-space',
    id: 42,
    isPrivate: true,
    name: 'project-space',
    owner: 'DotNaos',
    projectConfig: { status: 'managed' as const },
    url: 'https://github.com/DotNaos/project-space'
  };
  expect(roadmapRepositoryForProject(
    {
      id: 'local-project-space',
      kind: 'workspace',
      name: 'project-space',
      rootPath: '/Users/oli/projects/project-space'
    },
    {
      checkedAt: '2026-07-19T00:00:00.000Z',
      repositories: [repository],
      status: 'connected'
    }
  )).toEqual(repository);
});

test('never exposes a roadmap result under a different repository identity', () => {
  const result = { repository: { fullName: 'DotNaos/first', id: 1 } };
  expect(roadmapResultForRepository(
    { fullName: 'DotNaos/first', result: result as never },
    'DotNaos/second'
  )).toBeUndefined();
  expect(roadmapResultForRepository(
    { fullName: 'DotNaos/first', result: result as never },
    'DotNaos/first'
  )).toBe(result);
});

test('does not let an overlapping refresh replace a newer roadmap mutation', () => {
  const order = new RoadmapRequestOrder();
  const refreshBeforeSave = order.begin();
  order.begin();
  expect(order.isCurrent(refreshBeforeSave)).toBe(false);

  const refreshDuringSave = order.begin();
  order.begin();
  expect(order.isCurrent(refreshDuringSave)).toBe(false);
});
