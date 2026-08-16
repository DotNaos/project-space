import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

const primaryProjectUiFiles = [
  'src/features/project-desktop/components/project-desktop-shell.tsx',
  'src/features/project-desktop/components/project-main-panel.tsx',
  'src/features/project-desktop/components/project-detail.tsx',
  'src/features/project-desktop/hooks/use-project-desktop.ts',
  'src/features/project-desktop/hooks/use-project-desktop-lifecycle.ts',
  'src/features/project-tasks/project-tasks-experience.tsx',
  'src/features/project-tasks/project-task-detail.tsx',
  'src/features/project-desktop/components/issue-codex-work-list.tsx',
  'src/features/project-desktop/components/use-issue-codex-host-wake.ts',
  'src/features/project-desktop/components/issue-codex-start-dialog.tsx'
];

describe('primary project UI Connector retirement boundary', () => {
  test('cannot request the retired Connector overview endpoint', () => {
    const source = primaryProjectUiFiles
      .map((path) => readFileSync(join(import.meta.dir, '..', path), 'utf8'))
      .join('\n');

    expect(source).not.toContain('/api/connectors/overview');
    expect(source).not.toContain('getConnectorOverview');
  });

  test('renders task execution and pipeline status without the retired Connector hierarchy', () => {
    const taskDetail = [
      'src/features/project-tasks/project-task-detail.tsx',
      'src/features/project-tasks/project-task-runner-panel.tsx',
      'src/features/project-tasks/project-task-pipeline-panel.tsx'
    ].map((path) => readFileSync(join(import.meta.dir, '..', path), 'utf8')).join('\n');

    expect(taskDetail).toContain('ProjectTaskRunnerPanel');
    expect(taskDetail).toContain('ProjectTaskPipelinePanel');
    expect(taskDetail).not.toContain('Open Compute');
    expect(taskDetail).not.toContain('href="/settings"');
    expect(taskDetail).not.toContain('IssueDevelopmentSession');
    expect(taskDetail).not.toContain('IssueDevelopmentPipeline');
    expect(taskDetail).not.toContain('ConnectorOverviewResult');
  });

  test('does not request legacy inventory or machine power from Issue Codex flows', () => {
    const source = [
      'src/features/project-desktop/components/issue-codex-work-list.tsx',
      'src/features/project-desktop/components/use-issue-codex-host-wake.ts',
      'src/features/project-desktop/components/issue-codex-start-dialog.tsx'
    ]
      .map((path) => readFileSync(join(import.meta.dir, '..', path), 'utf8'))
      .join('\n');

    expect(source).not.toContain('getConnectorOverview');
    expect(source).not.toContain('/api/connectors/overview');
    expect(source).not.toContain('getMachinePowerStatus');
    expect(source).not.toContain('requestMachinePower');
    expect(source).toContain('Open Compute');
    expect(source).toContain("href={computeHref}");
  });
});
