import { describe, expect, test } from 'bun:test';
import type { FileSystemEntry, MachineFileSystemDirectoryResult } from '../src/shared/project-space-api';
import {
  collapseDeepestExpanded,
  completedPathValue,
  enteredPath,
  expansionFrontier,
  explorerBreadcrumbs,
  explorerPathQuery,
  explorerPathSuggestions,
  homePathLabel,
  isHiddenFileSystemName
} from '../src/features/project-desktop/components/machine-explorer-model';

const homePath = '/Users/oli';

function directory(name: string, path = `${homePath}/${name}`): FileSystemEntry {
  return { kind: 'directory', name, path };
}

function file(name: string, path = `${homePath}/${name}`): FileSystemEntry {
  return { kind: 'file', name, path };
}

function result(path: string, entries: FileSystemEntry[]): MachineFileSystemDirectoryResult {
  return { entries, path, status: 'success' };
}

describe('machine Explorer path search', () => {
  test('recognizes dot-prefixed entries as hidden', () => {
    expect(isHiddenFileSystemName('.worktrees')).toBe(true);
    expect(isHiddenFileSystemName('project-space')).toBe(false);
  });

  test('expands home labels and derives the directory that should be searched', () => {
    expect(enteredPath('~/projects', homePath)).toBe('/Users/oli/projects');
    expect(homePathLabel('/Users/oli/projects', homePath)).toBe('~/projects');
    expect(explorerPathQuery('', homePath, '/Users/oli/projects')).toEqual({
      directoryPath: '/Users/oli',
      nameQuery: ''
    });
    expect(explorerPathQuery('~', homePath, '/Users/oli/projects')).toEqual({
      directoryPath: '/Users/oli',
      nameQuery: ''
    });
    expect(explorerPathQuery('~/pro', homePath, '/Users/oli/projects')).toEqual({
      directoryPath: '/Users/oli',
      nameQuery: 'pro'
    });
    expect(explorerPathQuery('~/projects/', homePath, '/Users/oli')).toEqual({
      directoryPath: '/Users/oli/projects',
      nameQuery: ''
    });
    expect(explorerPathQuery('~/projects', homePath, '/Users/oli/projects')).toEqual({
      directoryPath: '/Users/oli/projects',
      nameQuery: ''
    });
  });

  test('ranks prefix matches before substring matches and keeps folders before files', () => {
    const entries = [
      file('project-notes.md'),
      directory('my-project'),
      directory('projects'),
      directory('.private')
    ];
    const suggestions = explorerPathSuggestions({
      nameQuery: 'pro',
      result: result(homePath, entries),
      showHidden: false
    });

    expect(suggestions.map((entry) => entry.name)).toEqual([
      'projects',
      'project-notes.md',
      'my-project'
    ]);
    expect(explorerPathSuggestions({
      nameQuery: '.p',
      result: result(homePath, entries),
      showHidden: false
    }).map((entry) => entry.name)).toEqual([]);
  });

  test('applies the hidden-items toggle to path suggestions', () => {
    const projectsPath = `${homePath}/projects`;
    const entries = [directory('.worktrees', `${projectsPath}/.worktrees`)];

    const suggestions = explorerPathSuggestions({
      nameQuery: 'work',
      result: result(projectsPath, entries),
      showHidden: true
    });

    expect(suggestions.map((entry) => entry.name)).toEqual(['.worktrees']);
    expect(completedPathValue(suggestions[0], homePath)).toBe('~/projects/.worktrees/');
    expect(explorerPathSuggestions({
      nameQuery: 'work',
      result: result(projectsPath, entries),
      showHidden: false
    }).map((entry) => entry.name)).not.toContain('.worktrees');
    expect(explorerPathSuggestions({
      nameQuery: '',
      result: result(projectsPath, entries),
      showHidden: true
    }).map((entry) => entry.name)).toContain('.worktrees');
  });

  test('Tab-style completion adds a slash only for folders', () => {
    expect(completedPathValue(directory('projects'), homePath)).toBe('~/projects/');
    expect(completedPathValue(file('notes.md'), homePath)).toBe('~/notes.md');
  });

  test('builds cumulative breadcrumbs and keeps the final file non-directory', () => {
    expect(explorerBreadcrumbs({ homePath, path: homePath })).toEqual([
      { isDirectory: true, label: '~', path: '/Users/oli' }
    ]);
    expect(explorerBreadcrumbs({
      homePath,
      path: '/Users/oli/projects/project-space/src'
    })).toEqual([
      { isDirectory: true, label: '~', path: '/Users/oli' },
      { isDirectory: true, label: 'projects', path: '/Users/oli/projects' },
      { isDirectory: true, label: 'project-space', path: '/Users/oli/projects/project-space' },
      { isDirectory: true, label: 'src', path: '/Users/oli/projects/project-space/src' }
    ]);
    expect(explorerBreadcrumbs({
      homePath,
      path: '/Users/oli/projects/project-space/README.md',
      selectedFile: true
    }).at(-1)).toEqual({
      isDirectory: false,
      label: 'README.md',
      path: '/Users/oli/projects/project-space/README.md'
    });
  });
});

describe('machine Explorer tree layers', () => {
  const roots = [directory('projects'), directory('Documents')];
  const projectChildren = [directory('project-space', '/Users/oli/projects/project-space')];

  test('expands only the next visible layer on each action', () => {
    const resultsByPath = new Map([
      ['/Users/oli/projects', result('/Users/oli/projects', projectChildren)]
    ]);
    const initial = expansionFrontier({
      expandedPaths: new Set(),
      resultsByPath,
      rootEntries: roots,
      showHidden: false
    });
    expect(initial).toEqual(['/Users/oli/projects', '/Users/oli/Documents']);

    const next = expansionFrontier({
      expandedPaths: new Set(initial),
      resultsByPath,
      rootEntries: roots,
      showHidden: false
    });
    expect(next).toEqual(['/Users/oli/projects/project-space']);
  });

  test('collapses the deepest expanded layer without closing its parents', () => {
    const resultsByPath = new Map([
      ['/Users/oli/projects', result('/Users/oli/projects', projectChildren)]
    ]);
    const expandedPaths = new Set([
      '/Users/oli/projects',
      '/Users/oli/Documents',
      '/Users/oli/projects/project-space'
    ]);
    const firstCollapse = collapseDeepestExpanded({
      expandedPaths,
      resultsByPath,
      rootEntries: roots,
      showHidden: false
    });
    expect([...firstCollapse]).toEqual(['/Users/oli/projects', '/Users/oli/Documents']);

    const secondCollapse = collapseDeepestExpanded({
      expandedPaths: firstCollapse,
      resultsByPath,
      rootEntries: roots,
      showHidden: false
    });
    expect([...secondCollapse]).toEqual([]);
  });
});
