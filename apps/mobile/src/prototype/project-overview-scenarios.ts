import type {
  ProjectInventory,
  ProjectInventoryItem,
} from '../data/project-inventory';
import type { PrototypeTheme } from './prototype-state';

export interface ProjectOverviewPrototypeScenario {
  accountLabel: string;
  description: string;
  errorMessage: string | null;
  id: string;
  inventory: ProjectInventory;
  isRefreshing: boolean;
  label: string;
  sourceLabel: string;
  theme: PrototypeTheme;
}

const generatedAt = '2026-07-27T10:00:00.000Z';

function project(
  input: Partial<ProjectInventoryItem> &
    Pick<ProjectInventoryItem, 'category' | 'name' | 'relativePath'>
): ProjectInventoryItem {
  return {
    branch: 'main',
    dirty: false,
    lastCommit: 'Refine the focused prototype experience',
    path: `/workspace/${input.relativePath}`,
    remote: `https://github.com/DotNaos/${input.name}.git`,
    scripts: ['dev', 'test'],
    stack: ['React', 'TypeScript'],
    updatedAt: generatedAt,
    ...input,
  };
}

const populatedProjects: ProjectInventoryItem[] = [
  project({
    branch: 'issue-356-prototype-canvases',
    category: 'Product',
    dirty: true,
    name: 'project-space',
    relativePath: 'project-space',
    stack: ['React', 'React Native', 'Go'],
  }),
  project({
    category: 'Product',
    name: 'design-space',
    relativePath: 'design-space',
    stack: ['React', 'Vite'],
  }),
  project({
    branch: 'feature/voice',
    category: 'Agents',
    name: 'agent-companion',
    relativePath: 'agent-companion',
    stack: ['React Native', 'Swift'],
  }),
  project({
    category: 'Tools',
    name: 'moodle',
    relativePath: 'school/tools/moodle',
    stack: ['Go'],
  }),
];

function inventory(projects: ProjectInventoryItem[]): ProjectInventory {
  return {
    generatedAt,
    projects,
    projectsRoot: '/workspace',
  };
}

const longProjects = Array.from({ length: 18 }, (_, index) =>
  project({
    branch: index % 3 === 0 ? `feature/prototype-state-${index + 1}` : 'main',
    category: ['Agents', 'Product', 'Tools'][index % 3]!,
    dirty: index % 4 === 0,
    lastCommit:
      index % 2 === 0
        ? 'Exercise a deliberately long commit message to verify wrapping, truncation, and scrolling'
        : 'Update representative fixture data',
    name: `sample-project-${String(index + 1).padStart(2, '0')}`,
    relativePath: `examples/a-very-long-project-directory-${index + 1}`,
    stack: index % 2 === 0
      ? ['React Native', 'TypeScript', 'Expo']
      : ['Go', 'PostgreSQL'],
  })
);

const baseScenario = {
  accountLabel: 'prototype@example.test',
  errorMessage: null,
  isRefreshing: false,
  sourceLabel: 'Mocked PR scenario',
} as const;

export const PROJECT_OVERVIEW_PROTOTYPE_SCENARIOS: readonly ProjectOverviewPrototypeScenario[] = [
  {
    ...baseScenario,
    description: 'Representative projects with mixed stacks and changes.',
    id: 'populated',
    inventory: inventory(populatedProjects),
    label: 'Populated',
    theme: 'light',
  },
  {
    ...baseScenario,
    description: 'No projects have been discovered yet.',
    id: 'empty',
    inventory: inventory([]),
    label: 'Empty',
    theme: 'light',
  },
  {
    ...baseScenario,
    description: 'A refresh is currently in progress.',
    id: 'loading',
    inventory: inventory(populatedProjects),
    isRefreshing: true,
    label: 'Loading',
    theme: 'light',
  },
  {
    ...baseScenario,
    description: 'The latest refresh failed while cached data remains visible.',
    errorMessage: 'The mocked inventory request could not be completed.',
    id: 'error',
    inventory: inventory(populatedProjects),
    label: 'Error',
    theme: 'light',
  },
  {
    ...baseScenario,
    description: 'Long names and enough rows to exercise inner scrolling.',
    id: 'long-content',
    inventory: inventory(longProjects),
    label: 'Long content',
    theme: 'light',
  },
  {
    ...baseScenario,
    description: 'The populated scenario with the light application theme.',
    id: 'light-theme',
    inventory: inventory(populatedProjects),
    label: 'Light theme',
    theme: 'light',
  },
  {
    ...baseScenario,
    description: 'The populated scenario with the dark application theme.',
    id: 'dark-theme',
    inventory: inventory(populatedProjects),
    label: 'Dark theme',
    theme: 'dark',
  },
] as const;

export const DEFAULT_PROJECT_OVERVIEW_SCENARIO_ID =
  PROJECT_OVERVIEW_PROTOTYPE_SCENARIOS[0]!.id;

export function projectOverviewPrototypeScenario(id: string | undefined) {
  return PROJECT_OVERVIEW_PROTOTYPE_SCENARIOS.find(
    (scenario) => scenario.id === id
  );
}
