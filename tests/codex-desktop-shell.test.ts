import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectShellLayout } from '../src/features/project-desktop/components/project-shell-layout';
import type { ProjectMainView } from '../src/features/project-desktop/hooks/project-desktop-routing';

const productViews: ProjectMainView[] = [
  'root',
  'chat',
  'codex',
  'topology',
  'machines',
  'machine',
  'projects',
  'project',
  'settings'
];

describe('Project desktop canonical shell', () => {
  test('uses one workspace sidebar layout for every product view', () => {
    for (const view of productViews) {
      expect(projectShellLayout(view, false, false)).toEqual({
        gridTemplateColumns: '288px minmax(0,1fr)',
        showCompactHeader: false,
        showWorkspaceSidebar: true
      });
      expect(projectShellLayout(view, true, false)).toEqual({
        gridTemplateColumns: 'minmax(0,1fr)',
        showCompactHeader: true,
        showWorkspaceSidebar: true
      });
    }
  });

  test('does not mount the removed legacy shell from the product root', () => {
    const source = readFileSync(
      join(import.meta.dir, '../src/features/project-desktop/components/project-desktop-shell.tsx'),
      'utf8'
    );

    expect(source).toContain('data-testid="canonical-project-sidebar"');
    expect(source).not.toContain('AppRail');
    expect(source).not.toContain('ContextPanel');
    expect(source).not.toContain('CompactUtilityBar');
    expect(source).not.toContain('MobileTabBar');
  });

  test('keeps release notes and durable information access in the canonical sidebar', () => {
    const shellSource = readFileSync(
      join(import.meta.dir, '../src/features/project-desktop/components/project-desktop-shell.tsx'),
      'utf8'
    );
    const sidebarSource = readFileSync(
      join(import.meta.dir, '../src/features/project-desktop/components/project-workspace-sidebar.tsx'),
      'utf8'
    );

    expect(shellSource).toContain('useReleaseChangelog');
    expect(shellSource).toContain('<ReleaseChangelogDialog');
    expect(sidebarSource).toContain('<ReleaseChangelogCard');
    expect(sidebarSource).toContain('<InformationMenu');
    expect(sidebarSource).toContain('<AccountMenu');
    expect(sidebarSource).not.toContain('app-rail');
  });

  test('keeps task creation and confirmed Codex task navigation inside the SPA', () => {
    const shellSource = readFileSync(
      join(import.meta.dir, '../src/features/project-desktop/components/project-desktop-shell.tsx'),
      'utf8'
    );
    const developmentSource = readFileSync(
      join(import.meta.dir, '../src/features/project-desktop/components/issue-development-session.tsx'),
      'utf8'
    );
    const prototypeSource = readFileSync(
      join(import.meta.dir, '../src/features/project-desktop/components/pull-request-prototype-action.tsx'),
      'utf8'
    );

    expect(shellSource).toContain('requestIssueCreation');
    expect(shellSource).not.toContain("window.location.assign(`${routeForView('project'");
    expect(developmentSource).toContain('onOpenCodex({');
    expect(developmentSource).not.toContain('window.location.assign(codexSessionRoute');
    expect(prototypeSource).toContain('onOpenCodex({');
    expect(prototypeSource).not.toContain('window.location.assign(task.canonicalTaskUrl)');
  });
});
