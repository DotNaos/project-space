import { describe, expect, test } from 'bun:test';

import {
  projectMachineId,
  resolvedProjectMachineId
} from '../src/shared/project-machine-identity';
import type { ProjectSpaceRecord } from '../src/shared/project-space-api';

function project(overrides: Partial<ProjectSpaceRecord> = {}): ProjectSpaceRecord {
  return {
    id: 'connector-project:b3MtbWFjYm9vaw:cHJvamVjdC1zcGFjZQ',
    kind: 'standalone',
    machineId: 'os-macbook',
    name: 'project-space',
    rootPath: '/Users/oli/projects/project-space',
    ...overrides
  };
}

describe('project machine identity', () => {
  test('uses authoritative connector ownership instead of a synthetic ID namespace', () => {
    expect(projectMachineId(project())).toBe('os-macbook');
    expect(resolvedProjectMachineId(project(), 'local-mac')).toBe('os-macbook');
  });

  test('keeps legacy project IDs readable when explicit ownership is absent', () => {
    expect(projectMachineId(project({ id: 'legacy-mac:project-space', machineId: undefined }))).toBe(
      'legacy-mac'
    );
    expect(resolvedProjectMachineId(project({ id: 'local:project-space', machineId: undefined }), 'local-mac')).toBe(
      'local-mac'
    );
  });

  test('does not treat unscoped GitHub records as connector-owned', () => {
    expect(projectMachineId(project({ id: 'github:DotNaos/project-space', kind: 'github', machineId: undefined }))).toBe(
      'local'
    );
  });
});
