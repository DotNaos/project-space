import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

test('primary workspace flow never invents a local machine identity', () => {
  const sources = [
    read('src/features/project-desktop/components/project-home-overview.tsx'),
    read('src/features/project-desktop/components/project-repository-panel.tsx'),
    read('src/features/project-desktop/components/project-workspaces-panel.tsx'),
    read('src/features/project-desktop/hooks/use-project-worktree-discovery.ts')
  ].join('\n');

  expect(sources).not.toContain("|| 'local'");
  expect(sources).not.toContain('|| "local"');
  expect(sources).not.toContain('project.machineId');
  expect(sources).not.toContain('selectedMachineId');
  expect(sources).not.toContain('machineId:');
  expect(sources).not.toContain('discoverProjectWorktrees(project.id, project.machineId)');
});

test('primary workspace flow has no generic terminal endpoint', () => {
  const source = read('src/features/project-desktop/components/project-workspaces-panel.tsx');
  const gitPanel = read('src/features/project-desktop/components/worktree-git-client-panel.tsx');

  expect(source).not.toContain('runMachineTerminalCommand');
  expect(gitPanel).not.toContain('runMachineTerminalCommand');
  expect(gitPanel).not.toContain('createStatusCommand');
  expect(gitPanel).toContain('Open Compute');
  expect(gitPanel).toContain("'/settings'");
});
