import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ProjectSpaceHome,
  projectFixtures,
  projectSpaceShellBackground
} from '../apps/prototype/src/project-space-home';
import { ProjectFeaturePage } from '../apps/prototype/src/project-space-pages';

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
    expect(html).toContain('mx-4 mb-4 rounded-full');
    expect(html).toContain('aria-label="Project sidebar"');
    expect(html).toContain('hidden w-72 shrink-0');
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
});
