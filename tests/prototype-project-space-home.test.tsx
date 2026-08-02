import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ProjectSpaceHome,
  projectFixtures,
  projectSpaceShellBackground
} from '../apps/prototype/src/project-space-home';
import {
  ProjectFeaturePage,
  ProjectIssueDetailPage,
  prototypeIssueByNumber
} from '../apps/prototype/src/project-space-pages';
import {
  ProjectSidebar,
  projectPageGroups
} from '../apps/prototype/src/project-space-sidebar';
import {
  prototypeIssueColumns,
  prototypeIssues,
} from '../apps/prototype/src/project-space-pages/issue-fixtures';
import { filterAndSortPrototypeIssues } from '../apps/prototype/src/project-space-pages/issues';
import { BranchDetailView } from '../apps/prototype/src/project-space-pages/branch-detail';
import { prototypeBranches } from '../apps/prototype/src/project-space-pages/branch-fixtures';
import { filterPrototypeBranches } from '../apps/prototype/src/project-space-pages/branches-and-workspaces';

describe('project space home prototype', () => {
  test('uses one shell surface behind the sidebar and rounded main view', () => {
    expect(projectSpaceShellBackground('dark')).toBe('#151515');
    expect(projectSpaceShellBackground('light')).toBe('#efeee9');
    expect(projectFixtures).toHaveLength(10);
    expect(projectFixtures.some((project) => project.name === 'prototype-lab')).toBe(true);
  });

  test('keeps project context, workflow navigation, account, and idea composer together', () => {
    const html = renderToStaticMarkup(
      <ProjectSpaceHome scenario="ready" theme="dark" />
    );

    expect(html).toContain('data-testid="project-space-home"');
    expect(html).toContain('data-testid="mobile-main-card"');
    expect(html).toContain('data-testid="project-selector-trigger"');
    expect(html).toContain('data-testid="sidebar-account-bar"');
    expect(html).toContain('mb-3 shrink-0');
    expect(html).not.toContain('data-testid="sidebar-account-podium"');
    expect(html).toContain('aria-label="Project sidebar"');
    expect(html).toContain('hidden shrink-0 overflow-hidden');
    expect(html).toContain('@3xl:block w-72');
    expect(html).toContain('aria-label="Switch project, current project project-space"');
    expect(html).not.toContain('before:absolute');
    expect(html).toContain('project-space');
    expect(html).toContain('>Issues<');
    expect(html).toContain('>Branches<');
    expect(html).toContain('>Machines<');
    expect(html).toContain('>Chat<');
    expect(html).not.toContain('>Workspaces<');
    expect(html).not.toContain('>History<');
    expect(html).not.toContain('>Codex<');
    expect(html).toContain('>Template<');
    expect(html).toContain('>Deployments<');
    expect(html).toContain('>Oli<');
    expect(html).toContain('placeholder="Describe a feature or idea"');
    expect(html).not.toContain('#437 · Redesign the Project Space frontend');
  });

  test('keeps the same navigation in the empty preview', () => {
    const html = renderToStaticMarkup(
      <ProjectSpaceHome scenario="empty" theme="light" />
    );

    expect(html).toContain('>Overview<');
    expect(html).toContain('>Deployments<');
    expect(html).toContain('bg-[#f8f7f3]');
  });

  test('renders each navigation target as a distinct main page', () => {
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page="machines"
        projectName="project-space"
        scenario="ready"
      />
    );

    expect(html).toContain('<h1');
    expect(html).toContain('Machines</h1>');
    expect(html).toContain('os-pc');
    expect(html).not.toContain('Redesign the Project Space frontend');
  });

  test.each([
    ['overview', 'Current focus', 'Project pulse'],
    ['issues', 'Search issues', 'In progress'],
    ['branches', 'Search branches, PRs, or machines', '30 of 30 branches'],
    ['machines', 'Available destinations', 'os-pc'],
    ['chats', 'Search conversations', 'Tasks'],
    ['template', 'Template adherence', 'Fullstack template'],
    ['deployments', 'Pull request previews', 'Production'],
  ] as const)('gives the %s page its own working surface', (page, first, second) => {
    const html = renderToStaticMarkup(
      <ProjectFeaturePage
        page={page}
        projectName="project-space"
        scenario="ready"
      />
    );

    expect(html).toContain(first);
    expect(html).toContain(second);
  });

  test('keeps realistic branch volume searchable and filterable', () => {
    expect(prototypeBranches).toHaveLength(30);
    expect(prototypeBranches.some((branch) => branch.name === 'issue-437-redesign-the-project-space-frontend')).toBe(true);
    expect(filterPrototypeBranches({ branches: prototypeBranches, filter: 'Pull request', query: '' }).every((branch) => branch.pullRequest)).toBe(true);
    expect(filterPrototypeBranches({ branches: prototypeBranches, filter: 'Checked out', query: '' }).every((branch) => branch.workspaces.length > 0)).toBe(true);
    expect(filterPrototypeBranches({ branches: prototypeBranches, filter: 'All', query: 'os-pc' }).every((branch) => branch.workspaces.some((workspace) => workspace.machine === 'os-pc'))).toBe(true);
  });

  test('combines branch history, pull requests, and machine workspaces in one detail view', () => {
    const branch = prototypeBranches.find((candidate) => candidate.name.includes('437'))!;
    const html = renderToStaticMarkup(<BranchDetailView branch={branch} onBack={() => undefined} />);

    expect(html).toContain('>History<');
    expect(html).toContain('Machine workspaces');
    expect(html).toContain('Local');
    expect(html).toContain('os-pc');
    expect(html).toContain('os-yoga-unix');
    expect(html).toContain('aria-label="Open workspace on Local"');
    expect(html).toContain('aria-label="Open changes on Local"');
    expect(html).toContain('aria-label="Check out branch on os-yoga-unix"');
    expect(html).not.toContain('Not checked out');
    expect(html).toContain('No pull request');
    expect(html).not.toContain('Worktree ready');
    expect(html).not.toContain('3 changed files');
    expect(html).not.toContain('Git status available');
    expect(html).toContain('grid w-full grid-cols-2 gap-2');
  });

  test('offers board and list views that open the same issues', () => {
    const board = renderToStaticMarkup(
      <ProjectFeaturePage
        issueViewMode="board"
        page="issues"
        projectName="project-space"
        scenario="ready"
      />
    );
    const list = renderToStaticMarkup(
      <ProjectFeaturePage
        issueViewMode="list"
        page="issues"
        projectName="project-space"
        scenario="ready"
      />
    );

    expect(board).toContain('aria-label="Issue board"');
    expect(board).toContain('data-scroll-region="issue-board-horizontal"');
    expect(board.match(/data-scroll-region="issue-column"/g)).toHaveLength(3);
    expect(board).toContain('Backlog');
    expect(board).toContain('In progress');
    expect(board).toContain('Done');
    expect(board).not.toContain('>Ready<');
    expect(board).not.toContain('>Blocked<');
    expect(board).toContain('Open issue #437 on GitHub');
    expect(board).toContain('Open branch issue-437-redesign-the-project-space-frontend on GitHub');
    expect(board).toContain('Open pull request #420 on GitHub');
    expect(board).toContain('>#435<');
    expect(board).not.toContain('#435 · Merged');
    expect(board).not.toContain('Updated now');
    expect(board).not.toContain('Plan, track, and finish work without losing its delivery context.');
    expect(board).not.toContain('uppercase');
    expect(list).not.toContain('aria-label="Issue board"');
    expect(list).toContain('aria-label="Issue table"');
    expect(list).toContain('Filter by label');
    expect(list).toContain('Filter by development');
    expect(list).toContain('Development');
    expect(list).toContain('Open issue #437');
  });

  test('combines issue table filters and sorting', () => {
    const filtered = filterAndSortPrototypeIssues({
      development: 'Pull request',
      issues: prototypeIssues,
      label: 'ci',
      sortDescriptor: { column: 'issue', direction: 'ascending' },
    });

    expect(filtered.map((issue) => issue.number)).toEqual([419, 434]);
    expect(filterAndSortPrototypeIssues({
      development: 'All',
      issues: prototypeIssues,
      label: 'All',
      sortDescriptor: { column: 'updated', direction: 'descending' },
    }).map((issue) => issue.number)).toEqual([437, 426, 434, 419, 408, 398, 395]);
  });

  test('derives board progression from pull request state', () => {
    expect(prototypeIssueColumns.map((column) => column.id)).toEqual([
      'Backlog',
      'In progress',
      'Done',
    ]);
    expect(prototypeIssues.filter((issue) => issue.column === 'Backlog').every((issue) => !issue.pullRequest)).toBe(true);
    expect(prototypeIssues.filter((issue) => issue.column === 'In progress').every((issue) => issue.pullRequest?.state === 'Open')).toBe(true);
    expect(prototypeIssues.filter((issue) => issue.column === 'Done').every((issue) => issue.pullRequest?.state === 'Merged')).toBe(true);
  });

  test('renders an issue as a complete workflow detail view', () => {
    const issue = prototypeIssueByNumber(437);
    expect(issue).toBeDefined();
    const html = renderToStaticMarkup(
      <ProjectIssueDetailPage
        issue={issue!}
        onBack={() => undefined}
        projectName="project-space"
      />
    );

    expect(html).toContain('#437');
    expect(html).toContain('Open on GitHub');
    expect(html).toContain('Edit issue');
    expect(html).toContain('href="https://github.com/DotNaos/project-space/issues/437"');
    expect(html).toContain('>Issue</h2>');
    expect(html).toContain('Acceptance criteria');
    expect(html).toContain('Development workflow');
    expect(html).toContain('issue-437-redesign-the-project-space-frontend');
    expect(html).toContain('Create PR');
    expect(html).toContain('commented yesterday');
    expect(html).toContain('Use Markdown to format your comment');
    expect(html).toContain('Preview deployment');
    expect(html).toContain('Start development');
    expect(html).toContain('Run tests');
    expect(html).toContain('Details');
    expect(html).toContain('Add a comment');
    expect(html).toContain('Comment</button>');
    expect(html).toContain('Delivery state');
  });

  test('groups the desktop navigation and supports a compact sidebar', () => {
    expect(projectPageGroups.map((group) => group.label)).toEqual([
      'Workspace',
      'Project'
    ]);
    const expanded = renderToStaticMarkup(
      <ProjectSidebar
        activePage="issues"
        currentProject={projectFixtures[0]}
        onClose={() => undefined}
        onCollapsedChange={() => undefined}
        onNewIssue={() => undefined}
        onPageChange={() => undefined}
        onProjectSelect={() => undefined}
        portalContainer={null}
      />
    );
    const collapsed = renderToStaticMarkup(
      <ProjectSidebar
        activePage="issues"
        collapsed
        currentProject={projectFixtures[0]}
        onClose={() => undefined}
        onCollapsedChange={() => undefined}
        onNewIssue={() => undefined}
        onPageChange={() => undefined}
        onProjectSelect={() => undefined}
        portalContainer={null}
      />
    );

    expect(expanded).toContain('Collapse sidebar');
    expect(expanded).toContain('>Workspace<');
    expect(expanded).toContain('>Project<');
    expect(expanded).toContain('>Chat<');
    expect(expanded).not.toContain('>Codex<');
    expect(expanded).not.toContain('uppercase');
    expect(collapsed).toContain('Expand sidebar');
    expect(collapsed).not.toContain('>Workspace<');
    expect(collapsed).toContain('title="Issues"');
  });
});
