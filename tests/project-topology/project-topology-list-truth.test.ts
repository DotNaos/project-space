import { describe, expect, test } from 'bun:test';
import { buildProjectTopology } from '../../src/features/project-topology/project-topology-model';
import {
  inventory,
  machine,
  project,
  snapshot
} from './project-topology-test-fixtures';

describe('project topology list identity truth', () => {
  test('blocks conflicting duplicate machine identities', () => {
    const offline = machine('machine-a', 'offline');
    const online = machine('machine-a', 'online');
    const result = buildProjectTopology(inventory({ machines: [offline, online] }));

    expect(result).toMatchObject({
      reason: 'Machine inventory returned conflicting records for the same machine identity.',
      state: 'blocked'
    });
  });

  test('deduplicates exact machine records', () => {
    const record = machine('machine-a');
    const result = snapshot(buildProjectTopology(inventory({
      machines: [record, structuredClone(record)]
    })));

    expect(result.summary.machineCount).toBe(1);
    expect(result.projects[0]!.machines).toHaveLength(1);
  });

  test('blocks conflicting duplicate project scopes', () => {
    const original = project('project-a', 'machine-a', '/projects/project-space');
    const conflict = { ...original, rootPath: '/projects/other-checkout' };
    const result = buildProjectTopology(inventory({ projects: [original, conflict] }));

    expect(result).toMatchObject({
      reason: 'Project inventory returned conflicting records for the same machine/project scope.',
      state: 'blocked'
    });
  });

  test('deduplicates exact project records', () => {
    const record = project('project-a', 'machine-a', '/projects/project-space');
    const result = snapshot(buildProjectTopology(inventory({
      projects: [record, structuredClone(record)]
    })));

    expect(result.summary.projectCount).toBe(1);
    expect(result.projects[0]!.projectRecords).toHaveLength(1);
  });
});
