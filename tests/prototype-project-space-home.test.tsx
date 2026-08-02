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
import { prototypeIssues } from '../apps/prototype/src/project-space-pages/issue-fixtures';
import { filterAndSortPrototypeIssues } from '../apps/prototype/src/project-space-pages/issues';

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
    expect(html).toContain('data-testid="sidebar-account-podium"');
    expect(html).toContain('mx-4 p-2');
    expect(html).toContain('mb-4 rounded-full bg-current/[.06]');
    expect(html).toContain('aria-label="Project sidebar"');
    expect(html).toContain('hidden shrink-0 overflow-hidden');
    expect(html).toContain('@3xl:block w-72');
    expect(html).toContain('aria-label="Switch project, current project project-space"');
    expect(html).not.toContain('before:absolute');
    expect(html).toContain('rounded-full bg-current/[.06]');
    expect(html).toContain('project-space');
    expect(html).toContain('>Issues<');
    expect(html).toContain('>Branches<');
    expect(html).toContain('>Machines<');
    expect(html).toContain('>Workspaces<');
    expect(html).toContain('>Chats<');
    expect(html).toContain('>History<');
    expect(html).toContain('>Codex<');
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
    ['branches', 'Search branches', '1 ahead'],
    ['machines', 'Available destinations', 'os-pc'],
    ['workspaces', 'Search workspaces', 'Modified'],
    ['chats', 'Search chats', 'Frontend redesign'],
    ['history', 'Repository activity', '72c0f48'],
    ['codex', 'Project tasks', 'Working'],
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
    expect(board).toContain('Backlog');
    expect(board).toContain('In progress');
    expect(board).toContain('Updated now');
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
    }).map((issue) => issue.number)).toEqual([437, 426, 434, 419, 408, 431, 395]);
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
    expect(html).toContain('Description');
    expect(html).toContain('Development');
    expect(html).toContain('issue-437-redesign-the-project-space-frontend');
    expect(html).toContain('Delivery state');
  });

  test('groups the desktop navigation and supports a compact sidebar', () => {
    expect(projectPageGroups.map((group) => group.label)).toEqual([
      'Work',
      'Collaborate',
      'Operate'
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
    expect(expanded).toContain('>Work<');
    expect(expanded).toContain('>Collaborate<');
    expect(expanded).toContain('>Operate<');
    expect(expanded).not.toContain('uppercase');
    expect(collapsed).toContain('Expand sidebar');
    expect(collapsed).not.toContain('>Work<');
    expect(collapsed).toContain('title="Issues"');
  });
});
