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
  'src/features/project-tasks/project-task-detail.tsx'
];

describe('primary project UI Connector retirement boundary', () => {
  test('cannot request the retired Connector overview endpoint', () => {
    const source = primaryProjectUiFiles
      .map((path) => readFileSync(join(import.meta.dir, '..', path), 'utf8'))
      .join('\n');

    expect(source).not.toContain('/api/connectors/overview');
    expect(source).not.toContain('getConnectorOverview');
  });

  test('keeps task execution behind the canonical runtime notice', () => {
    const taskDetail = readFileSync(
      join(import.meta.dir, '..', 'src/features/project-tasks/project-task-detail.tsx'),
      'utf8'
    );

    expect(taskDetail).toContain('WorkspaceRuntimeNotice');
    expect(taskDetail).not.toContain('IssueDevelopmentSession');
    expect(taskDetail).not.toContain('IssueDevelopmentPipeline');
    expect(taskDetail).not.toContain('ConnectorOverviewResult');
  });
});
