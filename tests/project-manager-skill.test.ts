import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { validateTasksDocument } from '../plugins/project-space/skills/project-manager/scripts/validate-tasks';

const root = new URL('..', import.meta.url).pathname;

test('versioned Project Manager skill owns completion and Preview dogfooding', async () => {
  const skill = await readFile(`${root}plugins/project-space/skills/project-manager/SKILL.md`, 'utf8');
  const agents = await readFile(`${root}AGENTS.md`, 'utf8');
  expect(skill).toContain('version: 1.0.0');
  for (const phrase of [
    'main` is a read-only Project Manager surface',
    'gpt-5.6-luna` with high reasoning',
    'Keep at most three active implementation workers',
    'The Project Manager is the only task that communicates with the user',
    'every 30 minutes',
    'idle, interrupted, failed, timed-out, or completed worker turn is an event',
    'inspect the exact PR head',
    'exact-head Preview',
    'desktop and mobile sizes',
    'same worker task',
    'no Preview-compatible surface',
    'Normal authentication checks, CI and Preview gates',
    'project codex start --issue <number> --environment-id <id> --operation-id <id>',
    'Do not locally run',
    'f0d7b422',
  ]) {
    expect(skill).toContain(phrase);
  }
  for (const phrase of [
    'project worktree context --format json',
    'state=main',
    'state=owned',
    'state=foreign',
    'state=unmanaged',
    'fail-closed',
  ]) {
    expect(agents).toContain(phrase);
  }
});

test('TASKS template and validator preserve the three-worker and proof contract', async () => {
  const template = await readFile(`${root}plugins/project-space/skills/project-manager/templates/TASKS.md`, 'utf8');
  expect(validateTasksDocument(template)).toEqual([]);
  const activeRow = '| #001 | `<thread-id>` | `<Project>/<environment-id>` | `<branch>; <Project-managed path>` | `<operation-id>` | `gpt-5.6-luna/high` | `active` | `<explicit contract>` | `<sha>` | `<PR and CI>` | no Preview | `<pending>` |';
  const tooMany = template.replace(
    '| #000 | `<thread-id>` | `<Project>/<environment-id>` | `<branch>; <Project-managed path>` | `<operation-id>` | `gpt-5.6-luna/high` | `queued` | `<explicit contract>` | `<sha or pending>` | `<PR and CI>` | `<exact-head Preview/browser proof or recorded no Preview>` | `<pending>` |',
    activeRow,
  ) + `\n${activeRow.replace('#001', '#002')}\n${activeRow.replace('#001', '#003')}\n${activeRow.replace('#001', '#004')}`;
  expect(validateTasksDocument(tooMany).join('\n')).toContain('at most three active');

  const escalated = template.replace(
    '`gpt-5.6-luna/high`',
    '`gpt-5.6-orion/medium`',
  );
  expect(validateTasksDocument(escalated)).toEqual([]);
  expect(validateTasksDocument(escalated.replace('`gpt-5.6-orion/medium`', ''))).toContain(
    'each worker row must record a non-empty model/reasoning record',
  );
  expect(validateTasksDocument(escalated.replace('`gpt-5.6-orion/medium`', '`escalated`'))).toContain(
    'each worker row must record a non-empty model/reasoning record',
  );
});

test('workflow documentation repeats the no-Preview alternative', async () => {
  const docs = await readFile(`${root}docs/project-manager.md`, 'utf8');
  expect(docs).toContain('no Preview-compatible surface exists');
  expect(docs).toContain('desktop and mobile sizes');
  expect(docs).toContain('Normal authentication checks, CI and Preview gates');
  expect(docs).toContain('project codex start --issue <n> --environment-id <id> --operation-id <id>');
  expect(docs).toContain('f0d7b422');
});
